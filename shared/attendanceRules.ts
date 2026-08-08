import { DateTime } from 'luxon';

// Attendance maths, shared so the UI can PREVIEW what the server will decide.
//
// Read that sentence carefully: this file is a mirror of the server's logic,
// not a replacement for it. The client may compute "Terlambat 12 menit" to
// show a badge; the value that gets stored is always the one the server
// computed from the SERVER's clock. Nothing here is ever trusted as input.

export interface ShiftDef {
  startTime: string;      // "09:00" wall-clock in `timezone`
  endTime: string;        // "17:00"
  timezone: string;
  breakMinutes: number;
  graceMinutes: number;
  workdays: number[];     // ISO weekdays, 1 = Monday
  overtimeRule: string;   // none | after_shift | manual
}

export type AttendanceStatus =
  | 'ontime' | 'late' | 'early_leave' | 'absent' | 'leave' | 'holiday' | 'auto_closed';

export const STATUS_LABELS: Record<AttendanceStatus, string> = {
  ontime: 'Tepat waktu',
  late: 'Terlambat',
  early_leave: 'Pulang cepat',
  absent: 'Tidak hadir',
  leave: 'Cuti',
  holiday: 'Libur',
  auto_closed: 'Ditutup otomatis',
};

// The shift's start/end as real instants on the local date of `at`.
export function shiftBounds(shift: ShiftDef, at: Date): { start: DateTime; end: DateTime } {
  const local = DateTime.fromJSDate(at, { zone: shift.timezone });
  const [sh, sm] = shift.startTime.split(':').map(Number);
  const [eh, em] = shift.endTime.split(':').map(Number);
  const start = local.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  let end = local.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  // A shift that ends "before" it starts crosses midnight (e.g. 22:00–06:00).
  if (end <= start) end = end.plus({ days: 1 });
  return { start, end };
}

export function isWorkday(shift: ShiftDef, at: Date): boolean {
  return shift.workdays.includes(DateTime.fromJSDate(at, { zone: shift.timezone }).weekday);
}

// Late/on-time is DERIVED from the shift + grace, never typed in by anyone.
// 5 minutes late with graceMinutes: 10 → ontime. 15 late → late.
export function lateMinutes(shift: ShiftDef, clockIn: Date): number {
  const { start } = shiftBounds(shift, clockIn);
  const diff = Math.floor(DateTime.fromJSDate(clockIn).diff(start, 'minutes').minutes);
  return diff > shift.graceMinutes ? diff : 0;
}

export function clockInStatus(shift: ShiftDef, clockIn: Date): AttendanceStatus {
  return lateMinutes(shift, clockIn) > 0 ? 'late' : 'ontime';
}

export function earlyLeaveMinutes(shift: ShiftDef, clockOut: Date): number {
  const { end } = shiftBounds(shift, clockOut);
  const diff = Math.floor(end.diff(DateTime.fromJSDate(clockOut), 'minutes').minutes);
  return diff > 0 ? diff : 0;
}

export interface WorkTotals { workMinutes: number; overtimeMinutes: number }

// Worked time excludes the unpaid break; overtime only counts past the shift's
// end, and only when the shift's rule allows it.
export function computeTotals(shift: ShiftDef, clockIn: Date, clockOut: Date): WorkTotals {
  const raw = Math.max(0, Math.floor((clockOut.getTime() - clockIn.getTime()) / 60000));
  const worked = Math.max(0, raw - shift.breakMinutes);
  let overtime = 0;
  if (shift.overtimeRule === 'after_shift') {
    const { end } = shiftBounds(shift, clockIn);
    const past = Math.floor(DateTime.fromJSDate(clockOut).diff(end, 'minutes').minutes);
    overtime = past > 0 ? past : 0;
  }
  return { workMinutes: worked, overtimeMinutes: overtime };
}

// Final status once the day is closed.
export function finalStatus(shift: ShiftDef, clockIn: Date, clockOut: Date, autoClosed: boolean): AttendanceStatus {
  if (autoClosed) return 'auto_closed';
  if (lateMinutes(shift, clockIn) > 0) return 'late';
  if (earlyLeaveMinutes(shift, clockOut) > 0) return 'early_leave';
  return 'ontime';
}

// The work DAY a moment belongs to, as 00:00 UTC of the local date. Using a
// plain UTC day would put a 23:00 WIB clock-in on the wrong date.
export function workDayOf(at: Date, zone: string): Date {
  const local = DateTime.fromJSDate(at, { zone });
  return new Date(Date.UTC(local.year, local.month - 1, local.day));
}

// ─── Geofence ───────────────────────────────────────────────────────

export interface Geofence { lat: number; lng: number; radiusM: number }
export interface Coords { lat: number; lng: number; accuracyM?: number }

// Haversine distance in metres.
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Reject a GPS fix too fuzzy to mean anything. Accepting a 500 m-accurate
// point against a 100 m fence would make the fence theatre.
export const MAX_ACCURACY_M = 100;

export type GeofenceResult =
  | { ok: true }
  | { ok: false; reason: 'no_location' | 'poor_accuracy' | 'outside'; distanceM?: number };

export function checkGeofence(fence: Geofence | null, coords: Coords | null): GeofenceResult {
  if (!fence) return { ok: true };
  if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return { ok: false, reason: 'no_location' };
  if (coords.accuracyM != null && coords.accuracyM > MAX_ACCURACY_M) return { ok: false, reason: 'poor_accuracy' };
  const d = distanceM(coords, fence);
  return d <= fence.radiusM ? { ok: true } : { ok: false, reason: 'outside', distanceM: Math.round(d) };
}

// How long a stored clock-in/out coordinate lives before the sweep wipes it.
// Locations are point-in-time proof of presence, not a movement archive.
export const LOCATION_RETENTION_DAYS = 90;

// ─── Who may see whose attendance ───────────────────────────────────
// Deliberately NOT part of canWorkspace(): this depends on the relationship
// between two people, not on a role alone. Peers can never see each other.
export function canViewAttendanceOf(
  viewer: { id: string; workspaceRole: 'admin' | 'member' },
  target: { id: string; managerId?: string | null },
): boolean {
  if (viewer.id === target.id) return true;            // your own record
  if (viewer.workspaceRole === 'admin') return true;   // audit-logged at the call site
  return target.managerId === viewer.id;               // your direct reports
}

// Productivity Analytics' Individual tier uses the exact same self/admin/
// direct-manager rule as attendance (Bagian B.1) — same relationship, not
// attendance-specific, so it's reused under a clearer name rather than
// duplicated.
export const canViewAnalyticsOf = canViewAttendanceOf;
