# Member List Online/Offline Split + In-List Leave Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `ParticipantPanel.tsx` show the whole organization split into Online/Offline (grouped by work status), and let an admin (or the requester's manager) approve/reject a pending cuti/izin request inline from that list, with every workspace admin getting a Lark DM the moment a request is submitted.

**Architecture:** Two new read-only GET endpoints (`/api/org/members`, `/api/attendance/leaves/status-today`) feed `ParticipantPanel.tsx`'s existing socket-driven online list with an offline roster and leave-status badges. The existing `POST /api/attendance/leaves` and `POST /api/attendance/leaves/:id/decide` routes are reused as-is for creation/decision — decide gets zero server-side changes; create gets one addition (a Lark DM fan-out).

**Tech Stack:** Express + Prisma (server), React + Zustand (client), no test framework in this repo — `npm run typecheck --workspace=server` / `--workspace=client` is the verification gate for every task. There is no local dev Postgres/server confirmed running this session; live smoke-testing happens after the user deploys (standing operating rhythm for this repo), not before — each task's "Verify" step is a typecheck, and Task 5 is the deploy-and-observe pass.

## Global Constraints

- `GET /api/org/members` and `GET /api/attendance/leaves/status-today` are **NOT** admin-gated — any authenticated org member can call them (only `authenticateToken`, no `requireWorkspace`).
- `POST /api/attendance/leaves/:id/decide` stays exactly as-is — gated by the existing `canApprove()` (workspace admin OR the requester's direct manager), not touched by this plan.
- Every new/modified Prisma query must be scoped to `req.organizationId`, matching this codebase's existing multi-tenant convention (see the "Multi-tenant Fase 2" comments already in `attendanceAdmin.ts`).
- The Lark DM fan-out is fire-and-forget (`void sendUserDm(...)`) — it must never block or fail the leave-creation request, and an admin with no `larkOpenId` is silently excluded via the query's `where` clause, not caught after the fact.
- The existing WorkMode dropdown (free-pick "Cuti" status) is **not** touched or removed. The Cuti/Izin badge this plan adds is driven only by an `approved` `Leave` row covering today — it coexists with, and never overrides, the dropdown.
- The Lark-backed `client/src/components/ui/LeavePanel.tsx` system is **not** touched.
- No new Prisma models or migrations — `Leave`/`LeaveType` already cover everything this plan needs.
- `docs/` (including this plan file and the design spec) and `SS AN.docx` are never committed in this repo — every `git add` in this plan is scoped to the exact source files listed, never `-A` or `docs/`.

---

### Task 1: `GET /api/org/members` endpoint

**Files:**
- Create: `server/src/routes/orgMembers.ts`
- Modify: `server/src/index.ts:40` (import), `server/src/index.ts:278` (mount)
- Modify: `client/src/services/api.ts` (add `OrgMember` interface + `api.getOrgMembers()`)

**Interfaces:**
- Produces: `GET /api/org/members` → `{ members: { id: string; displayName: string; workspaceRole: 'admin' | 'member' }[] }`, ordered by `displayName` ascending, `active: true` only, scoped to `req.organizationId`.
- Produces (client): `api.getOrgMembers(): Promise<{ members: OrgMember[] }>` where `OrgMember = { id: string; displayName: string; workspaceRole: 'admin' | 'member' }`.

- [ ] **Step 1: Create the route file**

```ts
// server/src/routes/orgMembers.ts
import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const orgMembers = Router();

// GET /api/org/members — the full org roster, open to any authenticated
// member (not admin-gated, unlike admin.ts's GET /admin/members, which
// includes email/department/manager and is workspace-admin only). This is
// just id/name/role, needed by ParticipantPanel.tsx to render the
// "Offline" section — everyone in the org NOT currently connected via
// socket right now.
orgMembers.get('/org/members', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const users = await prisma.user.findMany({
      where: { organizationId: req.organizationId, active: true },
      select: { id: true, displayName: true, workspaceRole: true },
      orderBy: { displayName: 'asc' },
    });
    return res.json({ members: users });
  } catch (err) {
    console.error('[orgMembers] list error:', err);
    return res.status(500).json({ error: 'Gagal memuat anggota organisasi' });
  }
});

export default orgMembers;
```

- [ ] **Step 2: Register the route in `server/src/index.ts`**

Current (line 40):
```ts
import attendanceAdminRoutes from './routes/attendanceAdmin';
```

New:
```ts
import attendanceAdminRoutes from './routes/attendanceAdmin';
import orgMembersRoutes from './routes/orgMembers';
```

Current (line 278):
```ts
app.use('/api', attendanceAdminRoutes);
```

New:
```ts
app.use('/api', attendanceAdminRoutes);
app.use('/api', orgMembersRoutes);
```

- [ ] **Step 3: Add the client method to `client/src/services/api.ts`**

Add this interface near the file's other simple interfaces (e.g. right above `export const api = {` at line 284):

```ts
export interface OrgMember { id: string; displayName: string; workspaceRole: 'admin' | 'member' }
```

Current end of the `api` object (line 763-765):
```ts
  getDMMessages: (conversationId: string, before?: string) =>
    request<{ messages: ChannelMessage[] }>(`/dms/${conversationId}/messages${before ? `?before=${before}` : ''}`),
};
```

New:
```ts
  getDMMessages: (conversationId: string, before?: string) =>
    request<{ messages: ChannelMessage[] }>(`/dms/${conversationId}/messages${before ? `?before=${before}` : ''}`),

  getOrgMembers: () => request<{ members: OrgMember[] }>('/org/members'),
};
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=server` — Expected: no errors.
Run: `npm run typecheck --workspace=client` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/orgMembers.ts server/src/index.ts client/src/services/api.ts
git commit -m "feat: add GET /api/org/members endpoint for the member-list offline roster"
```

---

### Task 2: `GET /api/attendance/leaves/status-today` + Lark DM fan-out on create

**Files:**
- Modify: `server/src/routes/attendanceAdmin.ts:1-11` (import `sendUserDm`), `:255-263` (Lark DM addition), insert new route after line 306 (right after the existing `GET /attendance/leaves` handler, before `canApprove`)
- Modify: `client/src/components/Attendance/api.ts` (add `LeaveStatusTodayDto` + `attendanceApi.statusToday()`)

**Interfaces:**
- Consumes: `sendUserDm(openId: string, text: string, organizationId: string): Promise<string | null>` from `../lib/larkIm` (already exported, unchanged).
- Consumes: `canApprove(prisma, approverId: string, subjectId: string): Promise<boolean>` — already defined in this same file at line 309 (hoisted function declaration, callable from a route registered earlier in the file).
- Produces: `GET /api/attendance/leaves/status-today` → `{ pending: PendingLeaveDto[], activeToday: ActiveLeaveDto[] }` where `PendingLeaveDto = { id: string; userId: string; typeName: string; startDate: string; endDate: string; reason: string; canDecide: boolean }` and `ActiveLeaveDto = { id: string; userId: string; typeName: string }`.
- Produces (client): `attendanceApi.statusToday(): Promise<LeaveStatusTodayDto>` where `LeaveStatusTodayDto = { pending: PendingLeaveDto[]; activeToday: ActiveLeaveDto[] }` (same shapes, dates as ISO strings after JSON round-trip).

- [ ] **Step 1: Import `sendUserDm`**

Current (`server/src/routes/attendanceAdmin.ts`, line 1-8):
```ts
import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { ShiftDef, computeTotals, finalStatus, canViewAttendanceOf } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireWorkspace, resolveWorkspaceRole } from '../lib/workspace';
import { writeAudit, clientIp } from '../lib/audit';
import { rateLimit } from '../middleware/rateLimit';
import { findUserInOrg, findShiftInOrg, findLeaveTypeInOrg } from '../lib/orgScope';
```

New:
```ts
import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { ShiftDef, computeTotals, finalStatus, canViewAttendanceOf } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireWorkspace, resolveWorkspaceRole } from '../lib/workspace';
import { writeAudit, clientIp } from '../lib/audit';
import { rateLimit } from '../middleware/rateLimit';
import { findUserInOrg, findShiftInOrg, findLeaveTypeInOrg } from '../lib/orgScope';
import { sendUserDm } from '../lib/larkIm';
```

- [ ] **Step 2: Add the Lark DM fan-out to the leave-create route**

Current (line 255-264):
```ts
    if (type.requiresApproval) {
      // Multi-tenant Fase 2 — fallback approver fan-out was workspace-wide
      // with no org filter, so a leave request could page another
      // company's admins.
      const approvers = me?.managerId ? [me.managerId] : (await prisma.user.findMany({ where: { workspaceRole: 'admin', active: true, organizationId: req.organizationId }, select: { id: true } })).map((u) => u.id);
      for (const a of approvers) {
        await prisma.notification.create({ data: { recipientId: a, kind: 'workspace', body: `${me?.displayName ?? 'Seseorang'} mengajukan ${type.name}.` } });
      }
    }
    return res.status(201).json({ leave });
```

New:
```ts
    if (type.requiresApproval) {
      // Multi-tenant Fase 2 — fallback approver fan-out was workspace-wide
      // with no org filter, so a leave request could page another
      // company's admins.
      const approvers = me?.managerId ? [me.managerId] : (await prisma.user.findMany({ where: { workspaceRole: 'admin', active: true, organizationId: req.organizationId }, select: { id: true } })).map((u) => u.id);
      for (const a of approvers) {
        await prisma.notification.create({ data: { recipientId: a, kind: 'workspace', body: `${me?.displayName ?? 'Seseorang'} mengajukan ${type.name}.` } });
      }

      // Per the room admin — the Lark DM always goes to EVERY workspace
      // admin, independent of `approvers` above (which is just the
      // manager when one is set). Fire-and-forget: never blocks/fails
      // leave creation; an admin with no larkOpenId linked is silently
      // excluded by the where clause itself, not caught after the fact.
      const larkAdmins = await prisma.user.findMany({
        where: { workspaceRole: 'admin', active: true, organizationId: req.organizationId, larkOpenId: { not: null } },
        select: { larkOpenId: true },
      });
      const fmt = (d: Date) => d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric' });
      const rangeLabel = startDate.getTime() === endDate.getTime() ? fmt(startDate) : `${fmt(startDate)} - ${fmt(endDate)}`;
      for (const a of larkAdmins) {
        void sendUserDm(a.larkOpenId!, `${me?.displayName ?? 'Seseorang'} mengajukan ${type.name} (${rangeLabel}). Buka MeetKai untuk approve/tolak.`, req.organizationId);
      }
    }
    return res.status(201).json({ leave });
```

- [ ] **Step 3: Add the `status-today` route**

Insert this new route right after the closing `});` of the existing `GET /attendance/leaves` handler (line 306) and before the `canApprove` function (line 309):

```ts
// GET /api/attendance/leaves/status-today — open to any authenticated org
// member (NOT admin-gated, unlike the ?mine=false approver view above):
// ParticipantPanel.tsx needs everyone to be able to see who's pending or on
// approved leave today, not just approvers. Only the decide action itself
// (POST .../decide below) stays gated. `canDecide` is computed per pending
// row with the exact same canApprove() the decide route checks, so the UI
// never offers an Acc/Tolak pair the server would then reject.
aa.get('/attendance/leaves/status-today', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const pendingRows = await prisma.leave.findMany({
      where: { status: 'pending', user: { organizationId: req.organizationId } },
      include: { type: true },
      orderBy: { createdAt: 'asc' },
    });
    const pending = await Promise.all(pendingRows.map(async (l) => ({
      id: l.id,
      userId: l.userId,
      typeName: l.type.name,
      startDate: l.startDate,
      endDate: l.endDate,
      reason: l.reason,
      canDecide: await canApprove(prisma, req.userId!, l.userId),
    })));

    // WIB "today" as a UTC-midnight Date — same convention startDate/
    // endDate were stored with in POST /attendance/leaves above (the
    // client sends a plain date string, parsed as UTC midnight).
    const todayWib = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }));
    const activeRows = await prisma.leave.findMany({
      where: {
        status: 'approved',
        user: { organizationId: req.organizationId },
        startDate: { lte: todayWib },
        endDate: { gte: todayWib },
      },
      include: { type: true },
    });
    const activeToday = activeRows.map((l) => ({ id: l.id, userId: l.userId, typeName: l.type.name }));

    return res.json({ pending, activeToday });
  } catch (err) {
    console.error('[attendance] status-today error:', err);
    return res.status(500).json({ error: 'Gagal memuat status cuti' });
  }
});
```

- [ ] **Step 4: Add the client method to `client/src/components/Attendance/api.ts`**

Add this interface near the file's other DTO interfaces (right after `QuotaDto` at line 42):

```ts
export interface PendingLeaveDto { id: string; userId: string; typeName: string; startDate: string; endDate: string; reason: string; canDecide: boolean }
export interface ActiveLeaveDto { id: string; userId: string; typeName: string }
export interface LeaveStatusTodayDto { pending: PendingLeaveDto[]; activeToday: ActiveLeaveDto[] }
```

Current (line 68-73):
```ts
  leaveTypes: () => req<{ types: LeaveTypeDto[] }>('/attendance/leave-types'),
  myLeaves: () => req<{ leaves: LeaveDto[]; quota: QuotaDto[] }>('/attendance/leaves'),
  pendingLeaves: () => req<{ leaves: LeaveDto[] }>('/attendance/leaves?mine=false'),
  requestLeave: (body: { typeId: string; startDate: string; endDate: string; halfDay: boolean; reason: string }) =>
    req<{ leave: LeaveDto }>('/attendance/leaves', { method: 'POST', body: JSON.stringify(body) }),
  decideLeave: (id: string, status: 'approved' | 'rejected', note?: string) =>
    req<{ leave: LeaveDto }>(`/attendance/leaves/${id}/decide`, { method: 'POST', body: JSON.stringify({ status, note }) }),
```

New:
```ts
  leaveTypes: () => req<{ types: LeaveTypeDto[] }>('/attendance/leave-types'),
  myLeaves: () => req<{ leaves: LeaveDto[]; quota: QuotaDto[] }>('/attendance/leaves'),
  pendingLeaves: () => req<{ leaves: LeaveDto[] }>('/attendance/leaves?mine=false'),
  statusToday: () => req<LeaveStatusTodayDto>('/attendance/leaves/status-today'),
  requestLeave: (body: { typeId: string; startDate: string; endDate: string; halfDay: boolean; reason: string }) =>
    req<{ leave: LeaveDto }>('/attendance/leaves', { method: 'POST', body: JSON.stringify(body) }),
  decideLeave: (id: string, status: 'approved' | 'rejected', note?: string) =>
    req<{ leave: LeaveDto }>(`/attendance/leaves/${id}/decide`, { method: 'POST', body: JSON.stringify({ status, note }) }),
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace=server` — Expected: no errors.
Run: `npm run typecheck --workspace=client` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/attendanceAdmin.ts client/src/components/Attendance/api.ts
git commit -m "feat: add leave status-today endpoint and Lark DM to admins on new leave requests"
```

---

### Task 3: `ParticipantPanel.tsx` — online/offline split with WorkMode grouping

**Files:**
- Modify: `client/src/data/presence.ts` (add `PARTICIPANT_GROUP_ORDER`)
- Modify: `client/src/components/ui/ParticipantPanel.tsx` (fetch org members + leave status; restructure the member list into collapsible Online/Offline sections; add read-only leave badges)

**Interfaces:**
- Consumes: `api.getOrgMembers()` (Task 1), `attendanceApi.statusToday()` (Task 2), `PARTICIPANT_GROUP_ORDER: WorkMode[]` (this task).
- Produces: a `refetchLeaveStatus: () => void` closure inside `ParticipantPanel` — Task 4 wires this as the post-decide refresh callback (kept in this task's scope since it's the same fetch effect being introduced here, not new surface for Task 4 to invent).

- [ ] **Step 1: Add the grouping order to `client/src/data/presence.ts`**

Current end of file (line 44-45):
```ts
export const LOGIN_STATUSES = ['wfo', 'wfh', 'wfa', 'cuti', 'in_meeting'] as const;
```

New:
```ts
export const LOGIN_STATUSES = ['wfo', 'wfh', 'wfa', 'cuti', 'in_meeting'] as const;

// Member-list grouping order (ParticipantPanel.tsx's Online section) — WFO/
// WFH/WFA cluster first since that's the split the room admin most wants at
// a glance, then every other status. Deliberately separate from
// MANUAL_STATUSES above (the STATUS dropdown's own order) — reordering one
// must never silently reorder the other.
export const PARTICIPANT_GROUP_ORDER: WorkMode[] = ['wfo', 'wfh', 'wfa', 'available', 'in_meeting', 'focus', 'lunch', 'break', 'away', 'cuti'];
```

- [ ] **Step 2: Add imports to `ParticipantPanel.tsx`**

Current (line 1-8):
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CameraVideoFill, PersonWalking, MagnetFill, ChatDotsFill, PersonDashFill, X, ThreeDotsVertical, Headphones, HandIndexThumbFill, MegaphoneFill, MicMuteFill, GeoAltFill, Search, VolumeMuteFill, VolumeUpFill, FlagFill } from 'react-bootstrap-icons';
import { roleAtLeast, Role, WorkMode } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { PRESENCE_LABEL, PRESENCE_EMOJI } from '@/data/presence';
import { Tooltip } from '@/components/ui/Tooltip';
import { showConfirm } from '@/stores/modalStore';
```

New:
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CameraVideoFill, PersonWalking, MagnetFill, ChatDotsFill, PersonDashFill, X, ThreeDotsVertical, Headphones, HandIndexThumbFill, MegaphoneFill, MicMuteFill, GeoAltFill, Search, VolumeMuteFill, VolumeUpFill, FlagFill, ChevronDown, ChevronRight } from 'react-bootstrap-icons';
import { roleAtLeast, Role, WorkMode } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { PRESENCE_LABEL, PRESENCE_EMOJI, PARTICIPANT_GROUP_ORDER } from '@/data/presence';
import { Tooltip } from '@/components/ui/Tooltip';
import { showConfirm } from '@/stores/modalStore';
import { api, OrgMember } from '@/services/api';
import { attendanceApi, PendingLeaveDto, ActiveLeaveDto } from '@/components/Attendance/api';
```

- [ ] **Step 3: Add state + fetch effect inside `ParticipantPanel`**

Current (line 109-122):
```ts
  const playerRecords = useGameStore((s) => s.playerRecords);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const followInfo = useGameStore((s) => s.followInfo);
  const followerUserIds = useGameStore((s) => s.followerUserIds);
  const localSpeaking = useGameStore((s) => s.localSpeaking);
  const speakingPlayers = useGameStore((s) => s.speakingPlayers);
  const localRole = useGameStore((s) => s.localRole);
  const masterAdminUserId = useGameStore((s) => s.masterAdminUserId);
  const adminPlayerIds = useGameStore((s) => s.adminPlayerIds);
  const staffPlayerIds = useGameStore((s) => s.staffPlayerIds);
  const mutedUserIds = useGameStore((s) => s.mutedUserIds);
  const muteUser = useGameStore((s) => s.muteUser);
  const unmuteUser = useGameStore((s) => s.unmuteUser);
```

New:
```ts
  const playerRecords = useGameStore((s) => s.playerRecords);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const localUserId = useGameStore((s) => s.localUserId);
  const followInfo = useGameStore((s) => s.followInfo);
  const followerUserIds = useGameStore((s) => s.followerUserIds);
  const localSpeaking = useGameStore((s) => s.localSpeaking);
  const speakingPlayers = useGameStore((s) => s.speakingPlayers);
  const localRole = useGameStore((s) => s.localRole);
  const masterAdminUserId = useGameStore((s) => s.masterAdminUserId);
  const adminPlayerIds = useGameStore((s) => s.adminPlayerIds);
  const staffPlayerIds = useGameStore((s) => s.staffPlayerIds);
  const mutedUserIds = useGameStore((s) => s.mutedUserIds);
  const muteUser = useGameStore((s) => s.muteUser);
  const unmuteUser = useGameStore((s) => s.unmuteUser);

  // Org roster (for the Offline section) + leave status (pending/approved
  // badges, both sections) — fetched once per panel-open, not polled (an
  // admin gets a live Lark DM for new requests; a decide action refetches
  // this directly, see refetchLeaveStatus below and Task 4).
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [leaveStatus, setLeaveStatus] = useState<{ pending: PendingLeaveDto[]; activeToday: ActiveLeaveDto[] }>({ pending: [], activeToday: [] });
  const [onlineOpen, setOnlineOpen] = useState(true);
  const [offlineOpen, setOfflineOpen] = useState(true);
  const refetchLeaveStatus = useCallback(() => {
    attendanceApi.statusToday().then(setLeaveStatus).catch(() => {});
  }, []);
  useEffect(() => {
    if (!open) return;
    api.getOrgMembers().then((r) => setOrgMembers(r.members)).catch(() => {});
    refetchLeaveStatus();
  }, [open, refetchLeaveStatus]);
```

- [ ] **Step 4: Compute grouping/offline data, right after `filteredRemotePlayers`**

Current (line 155-166):
```ts
  const [query, setQuery] = useState('');
  const filteredRemotePlayers = query.trim()
    ? remotePlayers.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    : remotePlayers;
  const handleLocate = useCallback((playerId: string) => {
    useGameStore.getState().setLocateRequest(playerId);
    onClose();
  }, [onClose]);

  const videoActive = remotePlayers.filter((p) => remoteStreams.has(p.id));
  const videoThumbs = videoActive.slice(0, MAX_VIDEO_THUMBS);
  const videoOverflowCount = videoActive.length - videoThumbs.length;
```

New:
```ts
  const [query, setQuery] = useState('');
  const filteredRemotePlayers = query.trim()
    ? remotePlayers.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    : remotePlayers;
  const handleLocate = useCallback((playerId: string) => {
    useGameStore.getState().setLocateRequest(playerId);
    onClose();
  }, [onClose]);

  const videoActive = remotePlayers.filter((p) => remoteStreams.has(p.id));
  const videoThumbs = videoActive.slice(0, MAX_VIDEO_THUMBS);
  const videoOverflowCount = videoActive.length - videoThumbs.length;

  // Offline section — every org member NOT currently connected (by userId).
  // orgMembers already arrives sorted alphabetically by the server, so no
  // client-side sort is needed after filtering.
  const onlineUserIds = new Set<string>();
  if (localUserId) onlineUserIds.add(localUserId);
  for (const p of remotePlayers) if (p.userId) onlineUserIds.add(p.userId);
  const offlineMembers = orgMembers.filter((m) => !onlineUserIds.has(m.id));
  const filteredOfflineMembers = query.trim()
    ? offlineMembers.filter((m) => m.displayName.toLowerCase().includes(query.trim().toLowerCase()))
    : offlineMembers;

  // Leave badges — keyed by userId for O(1) lookup per row.
  const activeTodayByUserId = new Map(leaveStatus.activeToday.map((l) => [l.userId, l]));
  const pendingByUserId = new Map(leaveStatus.pending.map((l) => [l.userId, l]));

  // Online section grouping — WFO/WFH/WFA first, then everything else, per
  // PARTICIPANT_GROUP_ORDER. Within a group, existing insertion order is
  // kept (unchanged behavior — this wasn't something the room admin asked
  // to change).
  const onlineGroups = new Map<WorkMode, typeof filteredRemotePlayers>();
  for (const status of PARTICIPANT_GROUP_ORDER) onlineGroups.set(status, []);
  for (const p of filteredRemotePlayers) {
    const status = p.workMode ?? 'available';
    (onlineGroups.get(status) ?? onlineGroups.get('available')!).push(p);
  }
```

- [ ] **Step 5: Add a `CollapsibleSection` helper component**

Add this new function right before `ParticipantThumb` at the end of the file (after `ParticipantRow`'s closing `}` at line 597):

```tsx
function CollapsibleSection({ title, count, open, onToggle, children }: { title: string; count: number; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 cursor-pointer hover:text-gray-600 dark:hover:text-gray-300"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {title} ({count})
      </button>
      {open && <div className="space-y-1 mt-1">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 6: Add the read-only `OfflineMemberRow` component**

Add this new function right after `CollapsibleSection`:

```tsx
function OfflineMemberRow({ name, leaveBadge, pendingBadge }: { name: string; leaveBadge?: ActiveLeaveDto; pendingBadge?: PendingLeaveDto }) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-gray-50/50 dark:bg-gray-800/50">
      <span className="text-gray-500 dark:text-gray-400 text-xs truncate">{name}</span>
      <div className="flex items-center gap-1 shrink-0">
        {leaveBadge && (
          <span title={leaveBadge.typeName} className="text-[9px] font-semibold px-1 py-px rounded bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300">
            🌴 {leaveBadge.typeName}
          </span>
        )}
        {pendingBadge && (
          <span title={`Menunggu approval: ${pendingBadge.typeName}`} className="text-[9px] font-semibold px-1 py-px rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
            Menunggu approval
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Simplify the header count (avoid duplicating it with the new section headers)**

`CollapsibleSection` (Step 5) already shows "Online (N)" / "Offline (N)" — the existing top-bar `{totalOnline} online` would otherwise show the same online count twice. Drop it from the top bar rather than add a second "M offline" span next to it.

Current (line 185-198):
```tsx
          <div className="p-3 border-b border-purple-100 dark:border-gray-700 flex items-center justify-between">
            <span className="text-gray-900 dark:text-gray-100 text-sm font-medium">Participants</span>
            <div className="flex items-center gap-2">
              <span className="text-gray-400 dark:text-gray-500 text-xs">{totalOnline} online</span>
              <Tooltip label="Tutup" detail="Tutup panel Peserta.">
                <button
                  onClick={onClose}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
                >
                  <X size={14} />
                </button>
              </Tooltip>
            </div>
          </div>
```

New:
```tsx
          <div className="p-3 border-b border-purple-100 dark:border-gray-700 flex items-center justify-between">
            <span className="text-gray-900 dark:text-gray-100 text-sm font-medium">Participants</span>
            <Tooltip label="Tutup" detail="Tutup panel Peserta.">
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
              >
                <X size={14} />
              </button>
            </Tooltip>
          </div>
```

- [ ] **Step 8: Restructure the member list render**

Current (line 226-275):
```tsx
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            <ParticipantRow
              name={localPlayer.name}
              color={localPlayer.color}
              handRaised={localPlayer.handRaised}
              workMode={localPlayer.workMode}
              awayReason={localPlayer.awayReason}
              spotlightActive={localPlayer.spotlightActive}
              micMuted={isMicMuted}
              speaking={localSpeaking}
              role={localRole}
              isLocal
              inCall={false}
              followerCount={followerUserIds.length}
            />
            {filteredRemotePlayers.length === 0 && query.trim() && (
              <p className="px-2 py-3 text-xs text-gray-400 text-center">Tidak ada yang cocok dengan "{query.trim()}".</p>
            )}
            {filteredRemotePlayers.map((p) => (
              <ParticipantRow
                key={p.id}
                name={p.name}
                color={p.color}
                handRaised={p.handRaised}
                workMode={p.workMode}
                awayReason={p.awayReason}
                spotlightActive={p.spotlightActive}
                micMuted={p.micMuted}
                speaking={speakingPlayers.has(p.id)}
                role={roleOf(p.userId)}
                isLocal={false}
                inCall={remoteStreams.has(p.id)}
                isFollowingThem={!!p.userId && followInfo?.targetUserId === p.userId}
                onFollow={p.userId ? () => emitFollowRequest(p.userId!) : undefined}
                onUnfollow={emitFollowUnfollow}
                onSummon={isGuest ? undefined : () => emitSummonUser(p.name)}
                onSlap={isGuest ? undefined : () => emitSlap(p.name)}
                isMuted={!!p.userId && mutedUserIds.has(p.userId)}
                onToggleMute={p.userId ? () => (mutedUserIds.has(p.userId!) ? unmuteUser(p.userId!) : muteUser(p.userId!)) : undefined}
                onMessage={p.userId && !p.isGuest && onStartDm ? () => onStartDm(p.userId!) : undefined}
                onReport={isGuest || !p.userId || !onReport ? undefined : () => onReport(p.userId!, p.name)}
                isGuest={p.isGuest}
                onKick={canKick && p.userId && emitKick ? () => emitKick(p.userId!) : undefined}
                onForceMute={canForceMute && p.userId && emitForceMute && !p.micMuted ? () => emitForceMute(p.userId!) : undefined}
                onForcePull={canForcePull && p.userId && emitForcePull ? () => emitForcePull(p.userId!) : undefined}
                onSpotlight={canSpotlight && p.userId && emitSpotlight ? () => emitSpotlight(p.userId!, !p.spotlightActive) : undefined}
                onLocate={isGuest ? undefined : () => handleLocate(p.id)}
              />
            ))}
          </div>
```

New:
```tsx
          <div className="flex-1 overflow-y-auto p-2 space-y-3">
            <CollapsibleSection title="Online" count={totalOnline} open={onlineOpen} onToggle={() => setOnlineOpen((v) => !v)}>
              <ParticipantRow
                name={localPlayer.name}
                color={localPlayer.color}
                handRaised={localPlayer.handRaised}
                workMode={localPlayer.workMode}
                awayReason={localPlayer.awayReason}
                spotlightActive={localPlayer.spotlightActive}
                micMuted={isMicMuted}
                speaking={localSpeaking}
                role={localRole}
                isLocal
                inCall={false}
                followerCount={followerUserIds.length}
                leaveBadge={localUserId ? activeTodayByUserId.get(localUserId) : undefined}
                pendingBadge={localUserId ? pendingByUserId.get(localUserId) : undefined}
              />
              {filteredRemotePlayers.length === 0 && query.trim() && (
                <p className="px-2 py-3 text-xs text-gray-400 text-center">Tidak ada yang cocok dengan "{query.trim()}".</p>
              )}
              {PARTICIPANT_GROUP_ORDER.flatMap((status) => onlineGroups.get(status)!).map((p) => (
                <ParticipantRow
                  key={p.id}
                  name={p.name}
                  color={p.color}
                  handRaised={p.handRaised}
                  workMode={p.workMode}
                  awayReason={p.awayReason}
                  spotlightActive={p.spotlightActive}
                  micMuted={p.micMuted}
                  speaking={speakingPlayers.has(p.id)}
                  role={roleOf(p.userId)}
                  isLocal={false}
                  inCall={remoteStreams.has(p.id)}
                  isFollowingThem={!!p.userId && followInfo?.targetUserId === p.userId}
                  onFollow={p.userId ? () => emitFollowRequest(p.userId!) : undefined}
                  onUnfollow={emitFollowUnfollow}
                  onSummon={isGuest ? undefined : () => emitSummonUser(p.name)}
                  onSlap={isGuest ? undefined : () => emitSlap(p.name)}
                  isMuted={!!p.userId && mutedUserIds.has(p.userId)}
                  onToggleMute={p.userId ? () => (mutedUserIds.has(p.userId!) ? unmuteUser(p.userId!) : muteUser(p.userId!)) : undefined}
                  onMessage={p.userId && !p.isGuest && onStartDm ? () => onStartDm(p.userId!) : undefined}
                  onReport={isGuest || !p.userId || !onReport ? undefined : () => onReport(p.userId!, p.name)}
                  isGuest={p.isGuest}
                  onKick={canKick && p.userId && emitKick ? () => emitKick(p.userId!) : undefined}
                  onForceMute={canForceMute && p.userId && emitForceMute && !p.micMuted ? () => emitForceMute(p.userId!) : undefined}
                  onForcePull={canForcePull && p.userId && emitForcePull ? () => emitForcePull(p.userId!) : undefined}
                  onSpotlight={canSpotlight && p.userId && emitSpotlight ? () => emitSpotlight(p.userId!, !p.spotlightActive) : undefined}
                  onLocate={isGuest ? undefined : () => handleLocate(p.id)}
                  leaveBadge={p.userId ? activeTodayByUserId.get(p.userId) : undefined}
                  pendingBadge={p.userId ? pendingByUserId.get(p.userId) : undefined}
                />
              ))}
            </CollapsibleSection>
            <CollapsibleSection title="Offline" count={offlineMembers.length} open={offlineOpen} onToggle={() => setOfflineOpen((v) => !v)}>
              {filteredOfflineMembers.length === 0 && (
                <p className="px-2 py-3 text-xs text-gray-400 text-center">
                  {query.trim() ? `Tidak ada yang cocok dengan "${query.trim()}".` : 'Semua anggota sedang online.'}
                </p>
              )}
              {filteredOfflineMembers.map((m) => (
                <OfflineMemberRow
                  key={m.id}
                  name={m.displayName}
                  leaveBadge={activeTodayByUserId.get(m.id)}
                  pendingBadge={pendingByUserId.get(m.id)}
                />
              ))}
            </CollapsibleSection>
          </div>
```

- [ ] **Step 9: Thread the two new optional props through `ParticipantRow`**

Current props destructuring (line 282-309):
```tsx
function ParticipantRow({
  name,
  color,
  handRaised,
  workMode,
  awayReason,
  spotlightActive,
  micMuted,
  speaking,
  role,
  isLocal,
  inCall,
  followerCount,
  isFollowingThem,
  onFollow,
  onUnfollow,
  onSummon,
  onSlap,
  isMuted,
  onToggleMute,
  onMessage,
  onReport,
  onKick,
  onForceMute,
  onForcePull,
  onSpotlight,
  onLocate,
  isGuest,
}: {
```

New:
```tsx
function ParticipantRow({
  name,
  color,
  handRaised,
  workMode,
  awayReason,
  spotlightActive,
  micMuted,
  speaking,
  role,
  isLocal,
  inCall,
  followerCount,
  isFollowingThem,
  onFollow,
  onUnfollow,
  onSummon,
  onSlap,
  isMuted,
  onToggleMute,
  onMessage,
  onReport,
  onKick,
  onForceMute,
  onForcePull,
  onSpotlight,
  onLocate,
  isGuest,
  leaveBadge,
  pendingBadge,
}: {
```

Add these two prop types right before the closing `}` of the props type (after `isGuest?: boolean;` at line 388):

Current:
```ts
  isGuest?: boolean;
}) {
```

New:
```ts
  isGuest?: boolean;
  // Approved-leave badge for today (see Task 2's status-today endpoint) —
  // shown instead of the normal workMode emoji when present. Coexists with
  // the free-pick WorkMode dropdown; never derived from it.
  leaveBadge?: ActiveLeaveDto;
  // A still-undecided cuti/izin request for this person — visible to
  // every viewer as a plain badge; Task 4 adds the Acc/Tolak buttons.
  pendingBadge?: PendingLeaveDto;
}) {
```

- [ ] **Step 10: Render the badges, replacing the workMode emoji when a leave badge is present**

Current (line 463-473):
```tsx
      <div className="flex items-center gap-1 shrink-0">
        {/* Live presence cues, glanceable per row — same signals shown over
            the avatar (raise-hand ✋, presence badge) and video tile (speaking 🔊). */}
        {spotlightActive && <MegaphoneFill title="Spotlight aktif — terdengar/terlihat seluruh room" size={11} className="text-amber-500 shrink-0" />}
        {handRaised && <img src="/assets/img/raise-hand-icon.png" alt="" title="Hand raised" className="w-3 h-2.5 animate-bounce shrink-0" />}
        {workMode === 'focus' && <Headphones title="Fokus (jangan diganggu)" size={12} className="text-purple-500 shrink-0" />}
        {workMode && workMode !== 'focus' && (
          <span title={PRESENCE_LABEL[workMode]} className="text-[11px] leading-none shrink-0">
            {workMode === 'available' ? '' : PRESENCE_EMOJI[workMode]}
          </span>
        )}
```

New:
```tsx
      <div className="flex items-center gap-1 shrink-0">
        {/* Live presence cues, glanceable per row — same signals shown over
            the avatar (raise-hand ✋, presence badge) and video tile (speaking 🔊). */}
        {spotlightActive && <MegaphoneFill title="Spotlight aktif — terdengar/terlihat seluruh room" size={11} className="text-amber-500 shrink-0" />}
        {handRaised && <img src="/assets/img/raise-hand-icon.png" alt="" title="Hand raised" className="w-3 h-2.5 animate-bounce shrink-0" />}
        {leaveBadge ? (
          // Approved leave for today wins over the workMode badge — more
          // specific/HR-real signal than a free-pick dropdown status.
          <span title={leaveBadge.typeName} className="text-[9px] font-semibold px-1 py-px rounded bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300 shrink-0">
            🌴 {leaveBadge.typeName}
          </span>
        ) : (
          <>
            {workMode === 'focus' && <Headphones title="Fokus (jangan diganggu)" size={12} className="text-purple-500 shrink-0" />}
            {workMode && workMode !== 'focus' && (
              <span title={PRESENCE_LABEL[workMode]} className="text-[11px] leading-none shrink-0">
                {workMode === 'available' ? '' : PRESENCE_EMOJI[workMode]}
              </span>
            )}
          </>
        )}
        {pendingBadge && (
          <span title={`Menunggu approval: ${pendingBadge.typeName}`} className="text-[9px] font-semibold px-1 py-px rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 shrink-0">
            Menunggu approval
          </span>
        )}
```

- [ ] **Step 11: Typecheck**

Run: `npm run typecheck --workspace=client` — Expected: no errors. Fix any prop-mismatch errors surfaced (e.g. if `react-bootstrap-icons` doesn't export `ChevronDown`/`ChevronRight` under those exact names — check `node_modules/react-bootstrap-icons/dist/index.d.ts` if this fails and substitute the correct export names).

- [ ] **Step 12: Commit**

```bash
git add client/src/data/presence.ts client/src/components/ui/ParticipantPanel.tsx
git commit -m "feat: split member list into online/offline sections with WorkMode grouping and leave badges"
```

---

### Task 4: Inline Acc/Tolak for pending leave requests

**Files:**
- Modify: `client/src/components/ui/ParticipantPanel.tsx` (wire `onApproveLeave`/`onRejectLeave` for `canDecide` pending rows, in both `ParticipantRow` and `OfflineMemberRow`)

**Interfaces:**
- Consumes: `attendanceApi.decideLeave(id: string, status: 'approved' | 'rejected', note?: string): Promise<{ leave: LeaveDto }>` (already exists, unchanged), `refetchLeaveStatus` (Task 3).
- Consumes: `showConfirm` from `@/stores/modalStore` (already imported in this file, used by the existing Kick/Force-Mute/Force-Pull confirm dialogs — same pattern).

- [ ] **Step 1: Add a decide handler inside `ParticipantPanel`**

Add this right after the `refetchLeaveStatus` definition from Task 3, Step 3:

```ts
  const decideLeave = useCallback(async (leaveId: string, status: 'approved' | 'rejected') => {
    try {
      await attendanceApi.decideLeave(leaveId, status);
    } catch {
      // decideLeave's own req() helper already surfaces a thrown Error with
      // a server-provided message; a toast/global error surface isn't wired
      // here, so this is a silent no-op on failure — refetch below will
      // just show the request still pending, which is an honest reflection
      // of "the decide didn't take."
    }
    refetchLeaveStatus();
  }, [refetchLeaveStatus]);
```

- [ ] **Step 2: Pass `onApproveLeave`/`onRejectLeave` to both row types**

In the `CollapsibleSection title="Online"` block from Task 3 Step 7, add two props to BOTH the local `ParticipantRow` and the mapped remote `ParticipantRow`. Current local row's `pendingBadge` line:
```tsx
                pendingBadge={localUserId ? pendingByUserId.get(localUserId) : undefined}
```
New:
```tsx
                pendingBadge={localUserId ? pendingByUserId.get(localUserId) : undefined}
                onApproveLeave={localUserId && pendingByUserId.get(localUserId)?.canDecide ? () => decideLeave(pendingByUserId.get(localUserId)!.id, 'approved') : undefined}
                onRejectLeave={localUserId && pendingByUserId.get(localUserId)?.canDecide ? () => decideLeave(pendingByUserId.get(localUserId)!.id, 'rejected') : undefined}
```

Current remote row's `pendingBadge` line:
```tsx
                  pendingBadge={p.userId ? pendingByUserId.get(p.userId) : undefined}
```
New:
```tsx
                  pendingBadge={p.userId ? pendingByUserId.get(p.userId) : undefined}
                  onApproveLeave={p.userId && pendingByUserId.get(p.userId)?.canDecide ? () => decideLeave(pendingByUserId.get(p.userId!)!.id, 'approved') : undefined}
                  onRejectLeave={p.userId && pendingByUserId.get(p.userId)?.canDecide ? () => decideLeave(pendingByUserId.get(p.userId!)!.id, 'rejected') : undefined}
```

In the `CollapsibleSection title="Offline"` block, current `OfflineMemberRow` usage:
```tsx
                <OfflineMemberRow
                  key={m.id}
                  name={m.displayName}
                  leaveBadge={activeTodayByUserId.get(m.id)}
                  pendingBadge={pendingByUserId.get(m.id)}
                />
```
New:
```tsx
                <OfflineMemberRow
                  key={m.id}
                  name={m.displayName}
                  leaveBadge={activeTodayByUserId.get(m.id)}
                  pendingBadge={pendingByUserId.get(m.id)}
                  onApproveLeave={pendingByUserId.get(m.id)?.canDecide ? () => decideLeave(pendingByUserId.get(m.id)!.id, 'approved') : undefined}
                  onRejectLeave={pendingByUserId.get(m.id)?.canDecide ? () => decideLeave(pendingByUserId.get(m.id)!.id, 'rejected') : undefined}
                />
```

- [ ] **Step 3: Add the two new props + buttons to `ParticipantRow`**

Add to the props destructuring (after `pendingBadge,` from Task 3 Step 8):
```ts
  pendingBadge,
  onApproveLeave,
  onRejectLeave,
}: {
```

Add to the props type (after `pendingBadge?: PendingLeaveDto;` from Task 3 Step 8):
```ts
  pendingBadge?: PendingLeaveDto;
  // Present only when this viewer is allowed to decide THIS row's pending
  // request (workspace admin or the requester's direct manager — see
  // canDecide on PendingLeaveDto, computed server-side). Undefined (not a
  // disabled button) for every other viewer, same "hide, don't disable"
  // convention as onKick/onForceMute above.
  onApproveLeave?: () => void;
  onRejectLeave?: () => void;
}) {
```

Update the pending-badge render block from Task 3 Step 9 — current:
```tsx
        {pendingBadge && (
          <span title={`Menunggu approval: ${pendingBadge.typeName}`} className="text-[9px] font-semibold px-1 py-px rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 shrink-0">
            Menunggu approval
          </span>
        )}
```
New:
```tsx
        {pendingBadge && !onApproveLeave && (
          <span title={`Menunggu approval: ${pendingBadge.typeName}`} className="text-[9px] font-semibold px-1 py-px rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 shrink-0">
            Menunggu approval
          </span>
        )}
        {pendingBadge && onApproveLeave && onRejectLeave && (
          <span className="flex items-center gap-1 shrink-0">
            <span title={pendingBadge.typeName} className="text-[9px] font-semibold text-amber-700 dark:text-amber-300">
              {pendingBadge.typeName}:
            </span>
            <button
              onClick={async () => { if (await showConfirm(`Setujui pengajuan ${pendingBadge.typeName} dari ${name}?`)) onApproveLeave(); }}
              className="text-[9px] font-semibold px-1.5 py-px rounded bg-emerald-500 hover:bg-emerald-600 text-white cursor-pointer"
            >
              Acc
            </button>
            <button
              onClick={async () => { if (await showConfirm(`Tolak pengajuan ${pendingBadge.typeName} dari ${name}?`, { danger: true })) onRejectLeave(); }}
              className="text-[9px] font-semibold px-1.5 py-px rounded bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 text-gray-700 dark:text-gray-200 cursor-pointer"
            >
              Tolak
            </button>
          </span>
        )}
```

- [ ] **Step 4: Add the same props + buttons to `OfflineMemberRow`**

Current (Task 3, Step 6):
```tsx
function OfflineMemberRow({ name, leaveBadge, pendingBadge }: { name: string; leaveBadge?: ActiveLeaveDto; pendingBadge?: PendingLeaveDto }) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-gray-50/50 dark:bg-gray-800/50">
      <span className="text-gray-500 dark:text-gray-400 text-xs truncate">{name}</span>
      <div className="flex items-center gap-1 shrink-0">
        {leaveBadge && (
          <span title={leaveBadge.typeName} className="text-[9px] font-semibold px-1 py-px rounded bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300">
            🌴 {leaveBadge.typeName}
          </span>
        )}
        {pendingBadge && (
          <span title={`Menunggu approval: ${pendingBadge.typeName}`} className="text-[9px] font-semibold px-1 py-px rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
            Menunggu approval
          </span>
        )}
      </div>
    </div>
  );
}
```

New:
```tsx
function OfflineMemberRow({ name, leaveBadge, pendingBadge, onApproveLeave, onRejectLeave }: {
  name: string;
  leaveBadge?: ActiveLeaveDto;
  pendingBadge?: PendingLeaveDto;
  onApproveLeave?: () => void;
  onRejectLeave?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-gray-50/50 dark:bg-gray-800/50">
      <span className="text-gray-500 dark:text-gray-400 text-xs truncate">{name}</span>
      <div className="flex items-center gap-1 shrink-0">
        {leaveBadge && (
          <span title={leaveBadge.typeName} className="text-[9px] font-semibold px-1 py-px rounded bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300">
            🌴 {leaveBadge.typeName}
          </span>
        )}
        {pendingBadge && !onApproveLeave && (
          <span title={`Menunggu approval: ${pendingBadge.typeName}`} className="text-[9px] font-semibold px-1 py-px rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
            Menunggu approval
          </span>
        )}
        {pendingBadge && onApproveLeave && onRejectLeave && (
          <span className="flex items-center gap-1">
            <span title={pendingBadge.typeName} className="text-[9px] font-semibold text-amber-700 dark:text-amber-300">
              {pendingBadge.typeName}:
            </span>
            <button
              onClick={async () => { if (await showConfirm(`Setujui pengajuan ${pendingBadge.typeName} dari ${name}?`)) onApproveLeave(); }}
              className="text-[9px] font-semibold px-1.5 py-px rounded bg-emerald-500 hover:bg-emerald-600 text-white cursor-pointer"
            >
              Acc
            </button>
            <button
              onClick={async () => { if (await showConfirm(`Tolak pengajuan ${pendingBadge.typeName} dari ${name}?`, { danger: true })) onRejectLeave(); }}
              className="text-[9px] font-semibold px-1.5 py-px rounded bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 text-gray-700 dark:text-gray-200 cursor-pointer"
            >
              Tolak
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace=client` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/ui/ParticipantPanel.tsx
git commit -m "feat: let admins/managers approve or reject leave requests inline in the member list"
```

---

### Task 5: Deploy and verify live

This repo has no local dev Postgres/server confirmed running this session — live verification happens after the user deploys, per this repo's standing operating rhythm (implement → typecheck → deploy on explicit request → verify against production logs/UI).

**Files:** none — this task is verification only.

- [ ] **Step 1: Confirm all four prior tasks are committed**

Run: `git log --oneline -8` — Expected: 4 commits from Tasks 1-4, most recent first.

- [ ] **Step 2: Push and deploy**

Only after the user explicitly says "deploy" (this repo's standing trigger word — never deploy unprompted):
```bash
git push origin main
```
Then run this repo's `./deploy/deploy.sh` on the VPS via SSH (server files changed, so this needs a full `server`+`nginx` rebuild — the script handles both).

- [ ] **Step 3: Smoke test — member list split**

Open KaiSpace as any logged-in member, open the Participants panel. Expected: two collapsible sections, "Online (N)" and "Offline (N)", both expanded by default; Online rows grouped WFO → WFH → WFA → everything else; Offline lists every other org member alphabetically.

- [ ] **Step 4: Smoke test — leave request → Lark DM → inline approval**

As a non-admin test account, submit a leave request via the existing Attendance → Cuti panel (pick any `LeaveType`, including "Izin" if already created via Admin → Pengaturan Absensi — create it first if it doesn't exist yet). Expected: every workspace admin with a linked Lark account receives a DM within a few seconds. As an admin, open the Participants panel — the requester's row (online or offline) shows a "Menunggu approval" badge with Acc/Tolak buttons. Click Acc. Expected: badge flips to the leave type's 🌴 badge (if today falls in the request's date range) or disappears (if the range doesn't cover today), and the requester's own Attendance panel reflects "approved".

- [ ] **Step 5: Report results to the user in Bahasa Indonesia**, per this session's standing rhythm — confirm what was tested, what worked, and flag anything that needs a follow-up fix.
