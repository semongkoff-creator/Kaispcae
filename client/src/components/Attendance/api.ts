import { AttendanceStatus } from '@virtualmeet/shared';

const API_BASE = '/api';

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('vm_token');
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...((options.headers as Record<string, string>) || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Gagal: ${res.status}`);
  }
  return res.json();
}

export interface TodayShift {
  id: string; name: string; startTime: string; endTime: string; timezone: string;
  graceMinutes: number; breakMinutes: number; workdays: number[]; hasGeofence: boolean;
}
export interface AttendanceRecordDto {
  id: string; date: string; clockIn: string | null; clockOut: string | null;
  status: AttendanceStatus; workMinutes: number; overtimeMinutes: number; note?: string | null;
}
export interface TodayDto {
  serverNow: string;
  shift: TodayShift | null;
  isWorkday: boolean;
  record: AttendanceRecordDto | null;
}
export interface LeaveTypeDto { id: string; name: string; quotaPerYear: number; paid: boolean; requiresApproval: boolean }
export interface LeaveDto {
  id: string; typeId: string; startDate: string; endDate: string; halfDay: boolean; reason: string;
  status: 'pending' | 'approved' | 'rejected'; decisionNote?: string | null;
  type: LeaveTypeDto; user?: { id: string; displayName: string };
}
export interface QuotaDto { typeId: string; name: string; quotaPerYear: number; used: number; remaining: number }
export interface CorrectionDto {
  id: string; recordId: string; reason: string; status: 'pending' | 'approved' | 'rejected';
  requestedClockIn: string | null; requestedClockOut: string | null; createdAt: string;
  user?: { id: string; displayName: string };
  record?: { date: string; clockIn: string | null; clockOut: string | null };
}
export interface Coords { lat?: number; lng?: number; accuracyM?: number }

export const attendanceApi = {
  today: () => req<TodayDto>('/attendance/today'),
  clockIn: (coords: Coords) => req<{ id: string; clockIn: string; status: AttendanceStatus; message: string }>(
    '/attendance/clock-in', { method: 'POST', body: JSON.stringify(coords) },
  ),
  clockOut: (coords: Coords) => req<{ id: string; clockOut: string; status: AttendanceStatus; workMinutes: number; overtimeMinutes: number; message: string }>(
    '/attendance/clock-out', { method: 'POST', body: JSON.stringify(coords) },
  ),
  records: (from?: Date, to?: Date, userId?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from.toISOString());
    if (to) qs.set('to', to.toISOString());
    if (userId) qs.set('userId', userId);
    return req<{ records: AttendanceRecordDto[] }>(`/attendance/records?${qs}`);
  },

  leaveTypes: () => req<{ types: LeaveTypeDto[] }>('/attendance/leave-types'),
  myLeaves: () => req<{ leaves: LeaveDto[]; quota: QuotaDto[] }>('/attendance/leaves'),
  pendingLeaves: () => req<{ leaves: LeaveDto[] }>('/attendance/leaves?mine=false'),
  requestLeave: (body: { typeId: string; startDate: string; endDate: string; halfDay: boolean; reason: string }) =>
    req<{ leave: LeaveDto }>('/attendance/leaves', { method: 'POST', body: JSON.stringify(body) }),
  decideLeave: (id: string, status: 'approved' | 'rejected', note?: string) =>
    req<{ leave: LeaveDto }>(`/attendance/leaves/${id}/decide`, { method: 'POST', body: JSON.stringify({ status, note }) }),

  myCorrections: () => req<{ corrections: CorrectionDto[] }>('/attendance/corrections'),
  pendingCorrections: () => req<{ corrections: CorrectionDto[] }>('/attendance/corrections?mine=false'),
  requestCorrection: (body: { recordId: string; requestedClockIn?: string; requestedClockOut?: string; reason: string }) =>
    req<{ id: string; status: string }>('/attendance/corrections', { method: 'POST', body: JSON.stringify(body) }),
  decideCorrection: (id: string, status: 'approved' | 'rejected') =>
    req<{ status: string }>(`/attendance/corrections/${id}/decide`, { method: 'POST', body: JSON.stringify({ status }) }),
};

// Ask the browser for a fix, but never block clock-in on it when the shift
// doesn't need one — the server decides whether location is required.
export function getCoords(timeoutMs = 10000): Promise<Coords> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve({}); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}
