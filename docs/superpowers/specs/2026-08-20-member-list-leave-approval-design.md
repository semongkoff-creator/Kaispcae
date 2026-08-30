# Member List Online/Offline Split + In-List Leave Approval — Design

## Goal

Let anyone opening the member list (`ParticipantPanel.tsx`) see the whole
organization split into Online / Offline, grouped and ordered by work
status, and let an admin approve or reject a pending cuti/izin request
directly from that list — with Lark DM-ing every workspace admin the moment
someone submits a request.

## Context

Two independent leave systems already exist in this codebase:

- **Lark-backed** (`client/src/components/ui/LeavePanel.tsx`) — approval
  happens inside Lark itself; MeetKai only polls and displays status. Not
  used by this feature.
- **DB-backed** (`client/src/components/Attendance/LeavePanel.tsx` +
  `attendanceAdmin.ts`'s `Leave`/`LeaveType` Prisma models) — request →
  `pending` → admin approves/rejects inside MeetKai. **This is the system
  this feature builds on.** "Izin" is not a separate concept from "cuti" —
  it's just another `LeaveType` row (e.g. `name: "Izin"`), created via the
  existing admin UI (`admin/AttendanceSettings.tsx`) exactly like any other
  leave type. No new type/table for it.

`shared/types/index.ts`'s `WorkMode` union (`available | in_meeting | focus
| lunch | away | wfh | wfo | wfa | cuti | break`) is unrelated to this
feature and is left untouched — it's the free-form status a user picks
themselves from the STATUS dropdown at any time, no approval involved. The
Cuti/Izin badge this feature adds to the member list is driven **only** by
an `approved` `Leave` row covering today's date, never by the WorkMode
dropdown value. A user can still manually set WorkMode to "Cuti" from the
dropdown (unrelated, unchanged); the member list won't show a Cuti/Izin
badge for that unless a real approved `Leave` record backs it.

## Part 1 — Member list: Online / Offline split

### Data source

`ParticipantPanel.tsx` currently only ever sees connected players
(`playerRecords`, socket-presence-driven) — there is no existing concept of
"organization members who aren't in the room." This feature adds:

- **New endpoint** `GET /api/org/members` (any authenticated org member, not
  admin-gated — this is a read of names/roles/avatars, not sensitive data).
  Returns every active user in `req.organizationId`: `{ id, displayName,
  avatarConfig, workspaceRole, role }` — same shape of data already exposed
  admin-only via `admin.ts`'s member list, just without the admin gate and
  trimmed to what the panel needs.
- Client fetches this once per panel-open (not polled), merges with the
  live `playerRecords` from the socket store by `userId`.

### Sections

**Online** — everyone present in `playerRecords` right now (unchanged
source). Grouped by `WorkMode`, group order: `wfo → wfh → wfa → ` then
every other status in existing dropdown order (`available, in_meeting,
focus, lunch, break, away, cuti`). Within a group, existing behavior
(insertion order) is kept — no further sort needed, this isn't something
the room admin asked to change.

**Offline** — every org member from `GET /api/org/members` whose `id` is
NOT in the current `playerRecords` (by `userId`). Sorted alphabetically by
`displayName`. No WorkMode badge shown (irrelevant once offline) **except**
a Cuti/Izin badge when today falls inside an `approved` `Leave` row for
that user (see Part 2's query) — that's the one status meaningful enough to
surface even while offline.

Both sections are separate collapsible groups (reusing whatever
disclosure/accordion pattern the Sidebar already uses elsewhere in this
file), **both expanded by default**.

### Header count

Existing `totalOnline` count stays as-is (already accurate: connected
players). A second, new "X offline" count is added next to it, computed
from the offline list's length.

## Part 2 — Leave request + in-list approval + Lark notification

### Requesting (unchanged)

`Attendance/LeavePanel.tsx`'s existing form (pick `LeaveType` — including
"Izin" once an admin creates that type — date range, reason) stays exactly
as-is. `POST /api/attendance/leaves` (`attendanceAdmin.ts:247`) stays
exactly as-is for the create/quota-check/`Leave` row/in-app-`Notification`
logic — **one addition**: right after the existing `approvers` loop that
writes in-app `Notification` rows (`attendanceAdmin.ts:260-262`), add a
Lark DM fan-out:

```ts
// NEW — Lark DM to every workspace admin, independent of the in-app
// `approvers` list above (which may be just the requester's manager).
// Per the room admin, Lark notification always goes to every admin
// regardless of who the actual approver is.
const admins = await prisma.user.findMany({
  where: { workspaceRole: 'admin', active: true, organizationId: req.organizationId, larkOpenId: { not: null } },
  select: { larkOpenId: true },
});
for (const admin of admins) {
  // Best-effort — never blocks or fails the leave creation itself.
  void sendUserDm(admin.larkOpenId!, `${me?.displayName ?? 'Seseorang'} mengajukan ${type.name} (${formatDateRangeId(startDate, endDate)}). Cek di MeetKai untuk approve/tolak.`, req.organizationId);
}
```

An admin with no `larkOpenId` (never linked Lark) is silently excluded from
the `where` clause — no error, no fallback in-app notice beyond the
existing in-app `Notification` row that already goes out for actual
approvers.

### One status query, shared by both badge types

**New endpoint** `GET /api/attendance/leaves/status-today` — open to any
authenticated org member (NOT admin-gated; matches "di member ketahuan
siapa yang ... udah izin apa belum" — everyone should be able to see who's
pending/on leave, only the decide action below is admin-only). Scoped to
`req.organizationId` like every other route here. Returns two arrays:

```ts
{
  pending: { id, userId, typeName, startDate, endDate, reason }[],   // every status:'pending' Leave in the org
  activeToday: { id, userId, typeName }[],                            // every status:'approved' Leave whose [startDate,endDate] contains today (WIB)
}
```

`ParticipantPanel.tsx` fetches this once per panel-open, alongside
`GET /api/org/members` (not polled — an admin already gets the Lark DM for
real-time awareness of new requests; the panel itself refetches after a
decide action, see below).

### Approving from the member list

- For a member row whose `userId` appears in `pending`, render a small
  "Menunggu approval: {typeName}" badge, visible to every viewer. If the
  viewer is a workspace admin, two inline buttons — **Acc** / **Tolak** —
  call the *existing* `POST /api/attendance/leaves/:id/decide`
  (`attendanceAdmin.ts:316`, unchanged, already admin-gated) with
  `{status: 'approved'|'rejected'}`. On success, refetch
  `status-today` (or optimistically patch local state) so the badge flips
  to Cuti/Izin (or clears, on reject) without a full panel reload.
- A non-admin viewer sees the same "Menunggu approval" badge with no
  buttons.

### Showing the approved badge

For a member row whose `userId` appears in `activeToday`, show a Cuti/Izin
badge (using that entry's `typeName`) **instead of** their WorkMode group
placement while online (edge case: if they're somehow both connected AND
on approved leave today — e.g. checked in briefly — the leave badge wins,
since that's the more specific/HR-real signal), and as the offline-section
badge described in Part 1 while offline.

## Out of scope (explicitly, to keep this change bounded)

- The WorkMode dropdown's own free-form "Cuti" option — unchanged, coexists
  with this feature without integration.
- The Lark-backed `LeavePanel.tsx` system — untouched.
- Any change to who is allowed to approve (manager-first-else-admins) —
  unchanged; only the Lark DM's recipient list is "all admins" per the room
  admin's explicit choice, independent of the approver-resolution logic.
- Historical/past leave display in the member list — only *today's* status
  matters for this feature; past/future leave browsing already exists
  elsewhere (the requester's own `Leave` history in `LeavePanel.tsx`).
