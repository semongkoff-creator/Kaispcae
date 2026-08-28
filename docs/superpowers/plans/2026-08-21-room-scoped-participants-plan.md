# Room-Scoped Participant List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Participant Panel's org-wide "Offline" list with a room-scoped one — only members who have ever been active in the CURRENT room (and aren't online in it right now), matching how "Online" already works.

**Architecture:** `GET /org/members` is replaced by `GET /rooms/:slug/participants` — **not** `/rooms/:slug/members`, since that path and the client function name `getRoomMembers` are ALREADY TAKEN by a different, already-shipped feature (`server/src/routes/roomMembers.ts`, the group-chat "add members" picker, backed by approved `RoomMember` rows — completely unrelated to this plan, must not be touched). This was discovered mid-implementation by an earlier Task 1 attempt (which correctly reverted and escalated instead of guessing); this plan version uses non-colliding names throughout. The new handler mirrors the exact room-resolution/access-check pattern the sibling route `GET /rooms/:slug/channels` already uses (`findRoomInOrg` + `canAccessRoomChat`), just at a free path. It queries `StatusInterval` for every distinct `userId` that has ever had a row for this room's slug, then fetches those `User` rows (same fields as today). A new index on `StatusInterval` makes that per-room lookup efficient (the two existing indexes are both keyed on `userId` first, neither serves a `WHERE roomSlug = ?` query). The client adds `getRoomParticipants(roomSlug)` (a new name, since `getRoomMembers` already exists for the unrelated picker), threads a new `roomSlug` prop into `ParticipantPanel`, and passes it through from `App.tsx` (which already has a `roomSlug` variable in scope).

**Tech Stack:** Express, Prisma (Postgres), React/TypeScript. No new dependency.

## Global Constraints

- "Room membership" for this feature = has this user ever had a `StatusInterval` row for this specific `roomSlug` — NOT any new persistent membership concept, NOT `User.createdAt`, NOT anything else.
- The Offline list is REPLACED entirely with this room-scoped version — no toggle/tab kept for an org-wide view.
- A room with zero historical `StatusInterval` activity must show an empty Offline list, not an error — this is a correct, expected state.
- The "Online" derivation (already room-scoped via live socket data in `ParticipantPanel.tsx`) must not change at all.
- The response shape (`{ members: [{id, displayName, workspaceRole, lastSeenAt}] }`) must stay identical to today — only the row-set is filtered differently server-side; no client-side type changes beyond the function/prop rename.
- Follow the exact same room-resolution and access-check pattern already used by the sibling `GET /rooms/:slug/channels` route — do not invent a new pattern.
- No new client dependency.
- Guests remain unaffected (no `User` row, already excluded from this query family) — no guest-handling code needed.

---

### Task 1: Server — `GET /rooms/:slug/participants` (room-scoped), replacing `GET /org/members`

**⚠️ Naming note (read before starting):** `server/src/routes/roomMembers.ts` ALREADY EXISTS — a 1061-line, unrelated file (room join/queue/zone routes) that already defines `GET /rooms/:slug/members` for a completely different, already-shipped feature (the group-chat "add members" picker, backed by approved `RoomMember` rows, response shape `{id, displayName, email, role}`). It is already imported in `server/src/index.ts` as `roomMemberRoutes` (singular "Member") and mounted at `app.use('/api', roomMemberRoutes)`. **Do not touch, rename, or overwrite `server/src/routes/roomMembers.ts` — it is unrelated to this task.** This task creates a DIFFERENT file (`roomParticipants.ts`) at a DIFFERENT path (`/rooms/:slug/participants`) specifically to avoid any collision with it. Before writing anything, run `ls server/src/routes/roomMembers.ts` and `grep -n "roomMembers\|roomParticipants" server/src/index.ts` yourself to confirm you understand which file is which.

**Files:**
- Modify: `server/prisma/schema.prisma` (`StatusInterval` model — add an index)
- Create: `server/prisma/migrations/20260821210000_add_status_interval_room_slug_index/migration.sql`
- Rename: `server/src/routes/orgMembers.ts` → `server/src/routes/roomParticipants.ts` (a NEW filename, distinct from the pre-existing `roomMembers.ts` — the file's only route is no longer org-scoped, and a stale filename here would mislead the next reader)
- Modify: `server/src/index.ts` (update the one import + one `app.use` line for the OLD `orgMembersRoutes` import only — do not touch the existing, unrelated `roomMemberRoutes` import/mount)

**Interfaces:**
- Consumes: `findRoomInOrg(prisma: PrismaClient, slug: string, organizationId: string | undefined)` from `server/src/lib/orgScope.ts` (returns the `Room` row or `null`) and `canAccessRoomChat(prisma: PrismaClient, room: {id, ownerId, isPublic, organizationId}, userId: string, organizationId: string | undefined): Promise<boolean>` from `server/src/lib/chatAccess.ts` — both already exist, used as-is, no changes to either.
- Produces: `GET /api/rooms/:slug/participants` → `{ members: Array<{ id: string; displayName: string; workspaceRole: 'admin' | 'member'; lastSeenAt: number | null }> }` — Task 2's client code consumes this. (The response's own JSON key stays `members` for continuity with the old `/org/members` shape — only the URL path changed to avoid the collision; this is not `{participants: [...]}`.)

- [ ] **Step 1: Add an index to `StatusInterval` for per-room lookups**

Open `server/prisma/schema.prisma`. Find the `StatusInterval` model (currently lines 1722-1742):

```prisma
model StatusInterval {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation("StatusIntervalUser", fields: [userId], references: [id], onDelete: Cascade)
  roomSlug  String
  // available_focus | in_meeting | quick_chat | busy | away | offline
  status    String
  // v2 Bagian B.4's "voluntary call-join rate" needs to know WHICH zone an
  // in_meeting interval happened in (a Zone's `type` — see shared/types
  // index.ts — is the closest available voluntary-vs-required signal).
  // Populated from WORK_MODE_CHANGE's own zoneId payload field when
  // present; null for the JOIN_ROOM-opened initial 'available' interval
  // (no zone context at that point) and for any client that doesn't send
  // one.
  zoneId    String?
  startedAt DateTime
  endedAt   DateTime?

  @@index([userId, startedAt])
  @@index([userId, endedAt])
}
```

Both existing indexes are keyed on `userId` first — neither helps a `WHERE roomSlug = ?` lookup, which specs/2026-08-21-room-scoped-participants-design.md's whole feature depends on running efficiently every time a Participant Panel opens. Add a third index, right after the existing two:

```prisma
  @@index([userId, startedAt])
  @@index([userId, endedAt])
  @@index([roomSlug, userId])
```

(The rest of the model is unchanged.)

- [ ] **Step 2: Create the migration**

Create `server/prisma/migrations/20260821210000_add_status_interval_room_slug_index/migration.sql` with exactly this content:

```sql
-- specs/2026-08-21-room-scoped-participants-design.md — GET /rooms/:slug/participants
-- (replacing GET /org/members) needs "every distinct userId that has ever had
-- a StatusInterval row for this roomSlug." StatusInterval's two existing
-- indexes are both keyed on userId first, so neither serves a WHERE roomSlug
-- lookup — this index makes that query efficient, and also covers the
-- DISTINCT userId projection directly (no need to touch the base table rows).

CREATE INDEX "StatusInterval_roomSlug_userId_idx" ON "StatusInterval"("roomSlug", "userId");
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate --schema=server/prisma/schema.prisma`

Expected: `✔ Generated Prisma Client` with no errors. As with this session's earlier migrations, this does not apply the migration to any database (no live local Postgres in this environment) — the SQL above is hand-verified by reading it against the schema, and applies automatically on deploy via `deploy/deploy.sh`'s `prisma migrate deploy` step.

- [ ] **Step 4: Rename `orgMembers.ts` to `roomParticipants.ts` and rewrite its route**

First, confirm you're not about to touch the wrong file: run `ls server/src/routes/roomMembers.ts` (should already exist, unrelated, DO NOT MODIFY) and `ls server/src/routes/orgMembers.ts` (should exist, small, this is the ONE you're renaming).

Read the full current content of `server/src/routes/orgMembers.ts` (it is short — one route, plus its two imports and the router setup/export). Create a NEW file `server/src/routes/roomParticipants.ts` with this content, then delete `server/src/routes/orgMembers.ts`:

```ts
import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { findRoomInOrg } from '../lib/orgScope';
import { canAccessRoomChat } from '../lib/chatAccess';

const roomParticipants = Router();

// GET /api/rooms/:slug/participants — specs/2026-08-21-room-scoped-participants-design.md.
// Replaces the old org-wide GET /org/members: "participant of this room"
// means has EVER had a StatusInterval row for this room's slug (i.e. has
// actually been active here before), not "is in the organization" — someone
// active only in a DIFFERENT room of the same org no longer shows up here at
// all. Feeds ParticipantPanel.tsx's "Offline" section; "Online" is derived
// entirely client-side from live socket data and doesn't call this route.
//
// Deliberately NOT named/pathed `/rooms/:slug/members` — that path already
// belongs to routes/roomMembers.ts's group-chat "add members" picker (a
// different concept: currently-approved RoomMember rows, not activity
// history). Do not merge with or rename that route; it's a separate,
// unrelated, already-shipped feature.
roomParticipants.get('/rooms/:slug/participants', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!(await canAccessRoomChat(prisma, room, req.userId!, req.organizationId))) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    const intervals = await prisma.statusInterval.findMany({
      where: { roomSlug: room.slug },
      select: { userId: true },
      distinct: ['userId'],
    });
    const userIds = intervals.map((i) => i.userId);
    if (userIds.length === 0) return res.json({ members: [] });

    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, organizationId: req.organizationId, active: true },
      select: { id: true, displayName: true, workspaceRole: true, lastSeenAt: true },
      orderBy: { displayName: 'asc' },
    });
    // specs/2026-08-21-last-seen-offline-members-design.md — Prisma's Date is
    // converted to epoch milliseconds explicitly here (rather than relying on
    // JSON.stringify's default Date->ISO-string behavior), matching this
    // codebase's existing numeric-timestamp convention for client-facing
    // fields (e.g. larkApproval.ts's submittedAt).
    const members = users.map((u) => ({ ...u, lastSeenAt: u.lastSeenAt ? u.lastSeenAt.getTime() : null }));
    return res.json({ members });
  } catch (err) {
    console.error('[roomParticipants] list error:', err);
    return res.status(500).json({ error: 'Gagal memuat anggota room' });
  }
});

export default roomParticipants;
```

Notes on this rewrite, so you understand why it looks like this:
- The response's JSON key is `members` (matching the old `/org/members` shape, for continuity) even though the URL path and export/variable names say "participants" — only the URL path changed to dodge the collision described above; the response shape itself is unaffected.
- `findRoomInOrg` returning `null` (room doesn't exist, or exists in a different organization) → `404`, exactly mirroring `server/src/routes/chat.ts`'s `GET /rooms/:slug/channels` handler.
- `canAccessRoomChat` is reused as-is even though its name says "chat" — read its body in `server/src/lib/chatAccess.ts:22-43`: it's a generic "may this user access this room at all" check (org match, then public/owner/global-admin/`RoomMember` row), nothing chat-specific in its logic. In practice this route is only ever called by a client that is ALREADY inside the room (see Task 2), so this branch is effectively unreachable today — it exists so this endpoint isn't a silent way to enumerate a private room's roster from outside it.
- The `userIds.length === 0` early return avoids an unnecessary `User.findMany({ where: { id: { in: [] }, ... } })` call for a brand-new room with no history — Prisma would just return `[]` for that anyway, but returning early makes the "genuinely empty, not an error" case explicit and skips a DB round-trip.

- [ ] **Step 5: Update the router import in `server/src/index.ts`**

Find this line (currently line 41):

```ts
import orgMembersRoutes from './routes/orgMembers';
```

Replace it with:

```ts
import roomParticipantsRoutes from './routes/roomParticipants';
```

Find this line (currently line 281):

```ts
app.use('/api', orgMembersRoutes);
```

Replace it with:

```ts
app.use('/api', roomParticipantsRoutes);
```

**Do not touch any other line in `index.ts`** — specifically, leave the pre-existing, unrelated `import roomMemberRoutes, { setMembersIo } from './routes/roomMembers';` (around line 31) and its `app.use('/api', roomMemberRoutes);` (around line 260) completely alone; they belong to the different, already-shipped group-picker feature. (The mount prefix `/api` for your new router is unchanged from today's `/org/members` registration; your new route's full path is `/api/rooms/:slug/participants`.)

- [ ] **Step 6: Typecheck the server workspace**

Run: `npm run typecheck --workspace=server`

Expected: no errors. Slow on this machine (3-5+ minutes) — wait for it, don't cut it short.

- [ ] **Step 7: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260821210000_add_status_interval_room_slug_index server/src/routes/roomParticipants.ts server/src/index.ts
git rm server/src/routes/orgMembers.ts
git commit -m "feat: replace org-wide GET /org/members with room-scoped GET /rooms/:slug/participants"
```

(`git rm` stages the deletion of the old file; `git add` on the new one stages its creation — both are needed since this is a rename-by-recreate, not a `git mv`.)

---

### Task 2: Client — wire `roomSlug` through to the new endpoint

**Files:**
- Modify: `client/src/services/api.ts` (the `getOrgMembers` function)
- Modify: `client/src/components/ui/ParticipantPanel.tsx` (`ParticipantPanelProps`, the fetch `useEffect`)
- Modify: `client/src/App.tsx` (the `<ParticipantPanel .../>` call site)

**Interfaces:**
- Consumes: `GET /rooms/:slug/participants` from Task 1 (same response shape as the old `GET /org/members`, just filtered differently server-side).
- Produces: `api.getRoomParticipants(roomSlug: string): Promise<{ members: OrgMember[] }>` — this task's own new client function; nothing downstream of this plan consumes it further.

**⚠️ Naming note (read before starting):** `client/src/services/api.ts` ALREADY EXPORTS a function called `getRoomMembers(slug)` (around line 500-503) for a different, unrelated feature (the group-chat "add members" picker, hitting `/rooms/${slug}/members`, returning `{id, displayName, email, role}`). Do not touch, rename, or overwrite it. This task adds a NEW, differently-named function `getRoomParticipants`, replacing the OLD `getOrgMembers` (which is being removed, not the unrelated `getRoomMembers`).

- [ ] **Step 1: Replace `getOrgMembers` with `getRoomParticipants`, pointed at the new route**

Open `client/src/services/api.ts`. Find this line (currently line 802):

```ts
  getOrgMembers: () => request<{ members: OrgMember[] }>('/org/members'),
```

Replace it with (mirroring the exact `getChannels` pattern already in this same file at line 772: `getChannels: (slug: string) => request<{ channels: Channel[] }>(\`/rooms/${slug}/channels\`)`):

```ts
  getRoomParticipants: (roomSlug: string) => request<{ members: OrgMember[] }>(`/rooms/${roomSlug}/participants`),
```

(This is a different property name — `getRoomParticipants`, not `getRoomMembers` — so it cannot collide with the pre-existing `getRoomMembers` elsewhere in this same object literal; both will coexist.)

- [ ] **Step 2: Add `roomSlug` to `ParticipantPanelProps`**

Open `client/src/components/ui/ParticipantPanel.tsx`. Find the `ParticipantPanelProps` interface (starts around line 37). Add a new field near the top of the interface, right after `remoteStreams: Map<string, MediaStream>;`:

```ts
interface ParticipantPanelProps {
  remoteStreams: Map<string, MediaStream>;
  // specs/2026-08-21-room-scoped-participants-design.md — the room this
  // panel is showing participants FOR. Threaded through to
  // api.getRoomParticipants so the "Offline" section only shows members who
  // have actually been active in THIS room before, not the whole organization.
  roomSlug: string;
```

(every other existing field in the interface is unchanged, just shifted down by these new lines).

- [ ] **Step 3: Destructure `roomSlug` and pass it through the fetch effect**

In the same file, find the function's destructured props (the line reading something like `export function ParticipantPanel({ remoteStreams, isMicMuted, isGuest, ... }: ParticipantPanelProps) {`) and add `roomSlug` to that destructuring list, right after `remoteStreams`.

Then find the existing fetch `useEffect` (currently lines 165-169):

```ts
  useEffect(() => {
    if (!open) return;
    api.getOrgMembers().then((r) => setOrgMembers(r.members)).catch(() => {});
    refetchLeaveStatus();
  }, [open, refetchLeaveStatus]);
```

Replace it with:

```ts
  useEffect(() => {
    if (!open) return;
    api.getRoomParticipants(roomSlug).then((r) => setOrgMembers(r.members)).catch(() => {});
    refetchLeaveStatus();
  }, [open, roomSlug, refetchLeaveStatus]);
```

(`roomSlug` is added to the dependency array so switching rooms while the panel happens to stay mounted re-fetches the correct room's roster — matching this codebase's existing convention of listing every value an effect actually reads.)

- [ ] **Step 4: Pass `roomSlug` from `App.tsx`'s call site**

Open `client/src/App.tsx`. Find the `<ParticipantPanel .../>` call site (currently line 2464, one long line). Add `roomSlug={roomSlug}` to its props — `roomSlug` is already an in-scope variable in this component (the enclosing `Game` function's own prop, already passed to sibling components on nearby lines such as `SoundboardPanel`, `LarkSyncPanel`, and `JoinRequestPanel`). Insert it right after `remoteStreams={remoteStreams}` in that line, so the call site becomes (only the inserted prop is new; every other prop on that line is unchanged):

```tsx
<ParticipantPanel remoteStreams={remoteStreams} roomSlug={roomSlug} isMicMuted={isMicMuted} isGuest={isGuest} localAccountName={currentUser.name} emitFollowRequest={emitFollowRequest} emitFollowUnfollow={emitFollowUnfollow} emitSummonUser={emitSummonUser} emitSlap={emitSlap} onStartDm={channelChat.startDm} onReport={(userId, name) => setReportTarget({ userId, name })} emitKick={emitKick} emitForceMute={emitForceMute} emitForcePull={emitForcePull} emitSpotlight={emitSpotlight} open={activePanel === 'participants'} onToggle={() => openPanel('participants')} onClose={closePanel} />
```

- [ ] **Step 5: Typecheck the client workspace**

Run: `npm run typecheck --workspace=client`

Expected: no errors. Slow (3-5+ minutes) — wait for it.

- [ ] **Step 6: Typecheck the server workspace (confirms nothing else broke)**

Run: `npm run typecheck --workspace=server`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/services/api.ts client/src/components/ui/ParticipantPanel.tsx client/src/App.tsx
git commit -m "feat: scope the Offline participant list to the current room"
```

---

## Final Verification

- [ ] `npm run typecheck --workspace=server` passes.
- [ ] `npm run typecheck --workspace=client` passes.
- [ ] `git log --oneline -2` shows exactly the 2 commits from Tasks 1-2, in order.
- [ ] Grep the whole repo (`server/src`, `client/src`) for `getOrgMembers` and `/org/members` — zero matches should remain.
- [ ] Confirm `server/src/routes/orgMembers.ts` no longer exists and `server/src/routes/roomParticipants.ts` does — and that the PRE-EXISTING, unrelated `server/src/routes/roomMembers.ts` (the group-chat picker) is byte-for-byte untouched (`git diff --stat` should show zero changes to it).
- [ ] Confirm `client/src/services/api.ts` still has its pre-existing, unrelated `getRoomMembers` function completely untouched, alongside the new `getRoomParticipants`.

## Manual Testing After Deploy

1. **Room-scoped inclusion:** a user who has been active in Room A before, is now offline, shows up in Room A's Offline list.
2. **Room-scoped exclusion:** that SAME user does NOT show up in Room B's Offline list if they've never been active in Room B.
3. **Empty room, no error:** a brand-new room with zero historical activity shows an empty Offline list — not an error toast, not a stuck loading state.
4. **Online list unaffected:** the Online list (already room-scoped via live socket data, untouched by this plan) still works correctly.
5. **Timestamp rendering intact:** "Terakhir masuk X yang lalu (tanggal, jam)" / "Belum pernah masuk" still render correctly for whichever members appear in a room's now-filtered Offline list.
6. **Access check reachability:** confirm whether a logged-in user can ever have `ParticipantPanel` open for a room they lack access to (in practice, entering a room they can't access should already be blocked upstream of this panel ever rendering) — if genuinely unreachable, note that in the report rather than contriving an artificial test for it.
7. **Guests unaffected:** a guest still never appears in this list at all (no `User` row).
