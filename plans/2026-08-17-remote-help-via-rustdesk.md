# Minta Bantuan Remote (via RustDesk) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a consent-gated "Minta bantuan remote" flow to KaiSpace — request → real-time approve/decline → one-time RustDesk ID/password relay → visible active-session banner with a "Selesai" control on both sides. KaiSpace never performs, proxies, or records any remote-control traffic; RustDesk (external, native, already installed by the user) does 100% of the actual remote control.

**Architecture:** Mirrors this codebase's existing Follow feature almost exactly — a new independent socket handler (`remoteHelpHandler.ts`) with its own in-memory pending/active maps (no new DB table), a new block of `SocketEvents` + payload types in `shared/types/index.ts`, `writeAudit()` calls at request/decide/end, and client wiring that reuses the existing `PendingRequestToast.tsx` component plus two small new components for the active-session banner and the one-time credential form.

**Tech Stack:** TypeScript, Express + Socket.IO (server), React + Zustand (client), Prisma/Postgres (audit log only — no new tables).

## Global Constraints

- Any user can request remote help from any other user; any user can be asked — no role/department restriction (confirmed via clarifying question).
- The target's approval is always required and real-time; no silent/forced/admin-observer path may ever be added to this feature.
- The RustDesk ID+password string the target submits must never be written to Postgres, `localStorage`, or `sessionStorage` — it exists only in server memory for the duration of one relay, then is gone.
- One active remote-help session per target at a time — a second request to an already-helped target is rejected before any prompt is shown to the target.
- Every request, decision, and session end is recorded via `writeAudit()` (`server/src/lib/audit.ts`) with `targetType: 'remoteHelpSession'` — the audit record captures who/when only, never the credential string.
- KaiSpace's "Selesai" control ends KaiSpace's own tracking/notification only — it cannot and must not claim to disconnect the underlying RustDesk session. UI copy must say so explicitly.
- Follow this repo's own verification convention: no formal test framework exists here — every task is verified via `npm run typecheck` + `npm run build`, plus a real throwaway `npx tsx` script driving the actual local dev server (client :5173, server :3001) and local Postgres, deleted after use.

---

## Task 1: Shared types + server-side consent handshake, credential relay, audit

**Files:**
- Modify: `shared/types/index.ts` (add `SocketEvents` members + payload interfaces, near the existing `FOLLOW_*` block)
- Create: `server/src/socket/remoteHelpHandler.ts`
- Modify: `server/src/index.ts` (register the new handler)
- Test: `server/scripts/verify-remote-help.temp.ts` (throwaway, deleted at the end of this task)

**Interfaces:**
- Produces (consumed by Task 2): `SocketEvents.REMOTE_HELP_REQUEST | REMOTE_HELP_INCOMING | REMOTE_HELP_RESPOND | REMOTE_HELP_RESULT | REMOTE_HELP_CREDENTIAL | REMOTE_HELP_END`; types `RemoteHelpRequestPayload { requestId: string; actorUserId: string; actorName: string }`, `RemoteHelpRespondPayload { requestId: string; accept: boolean }`, `RemoteHelpResultPayload { targetName: string; accepted: boolean; reason?: 'declined' | 'timeout' | 'offline' | 'busy' }`, `RemoteHelpCredentialPayload { credential: string }`, `RemoteHelpEndPayload { endedByName: string }`. `REMOTE_HELP_REQUEST`'s own emit payload is inline `{ targetUserId: string }` (no dedicated type — mirrors `FOLLOW_REQUEST`'s own convention).

- [ ] **Step 1: Add SocketEvents + payload types**

In `shared/types/index.ts`, immediately after the existing `FOLLOWER_CHANGED = 'follow:follower_changed',` line (part of the Follow block), add:

```ts
  // Minta Bantuan Remote (specs/2026-08-17-remote-help-via-rustdesk-design.md)
  // — KaiSpace only brokers the consent handshake and a one-time credential
  // relay for an out-of-app RustDesk remote-help session; it never performs
  // any remote control itself. Same consent shape as Follow/Summon: REQUEST
  // asks the server to start a request, relayed to the target as INCOMING,
  // the target's accept/decline comes back as RESPOND, and the requester
  // (the helper) learns the outcome via RESULT. Once accepted, the target
  // submits their own RustDesk ID+password once via CREDENTIAL — relayed
  // straight to the helper's socket only, never stored anywhere. Either
  // side ends the (KaiSpace-tracked) session at any time via END — this
  // ends KaiSpace's own bookkeeping/notification only, never the actual
  // RustDesk connection, which only RustDesk's own client can end.
  REMOTE_HELP_REQUEST = 'remotehelp:request',
  REMOTE_HELP_INCOMING = 'remotehelp:incoming',
  REMOTE_HELP_RESPOND = 'remotehelp:respond',
  REMOTE_HELP_RESULT = 'remotehelp:result',
  REMOTE_HELP_CREDENTIAL = 'remotehelp:credential',
  REMOTE_HELP_END = 'remotehelp:end',
```

Then, immediately after the existing `FollowResultPayload` interface (right after its closing `}`), add:

```ts
// Remote-help consent — same shape as Follow's, plus a 'busy' reason (the
// target already has an active remote-help session with someone else).
export interface RemoteHelpRequestPayload {
  requestId: string;
  actorUserId: string;
  actorName: string;
}

export interface RemoteHelpRespondPayload {
  requestId: string;
  accept: boolean;
}

export interface RemoteHelpResultPayload {
  targetName: string;
  accepted: boolean;
  reason?: 'declined' | 'timeout' | 'offline' | 'busy';
}

// The target's own RustDesk ID+password, relayed once to the helper's
// socket only — the server never persists this string anywhere (see
// remoteHelpHandler.ts's REMOTE_HELP_CREDENTIAL handler).
export interface RemoteHelpCredentialPayload {
  credential: string;
}

// Sent to whichever party did NOT click "Selesai" (or disconnected), so
// their banner can clear with a clear reason instead of just vanishing.
export interface RemoteHelpEndPayload {
  endedByName: string;
}
```

- [ ] **Step 2: Create the server handler**

Create `server/src/socket/remoteHelpHandler.ts`:

```ts
import { randomUUID } from 'crypto';
import { isUserInLockedZone } from './zoneLock';
import { zoneIdOfSocket } from './zoneHandler';
import { Server, Socket } from 'socket.io';
import {
  SocketEvents,
  CONSENT_REQUEST_TIMEOUT_MS,
  RemoteHelpRespondPayload,
  RemoteHelpCredentialPayload,
} from '@virtualmeet/shared';
import { getPlayerName } from './roomHandler';
import { getPlayers } from '../store/roomStore';
import { getPrisma } from '../lib/prisma';
import { writeAudit } from '../lib/audit';

// Minta Bantuan Remote (specs/2026-08-17-remote-help-via-rustdesk-design.md)
// — KaiSpace only brokers consent + a one-time credential relay for an
// out-of-app RustDesk session; it never performs remote control itself.
// Same "own uid/room mapping, don't reach into roomHandler.ts's private
// maps" decoupling precedent as followHandler.ts — see that file's own doc
// comment for why.

interface ActiveRemoteHelp {
  targetUid: string;
  targetName: string;
  helperUid: string;
  helperName: string;
  startedAt: number;
}

// targetUid -> ActiveRemoteHelp. Keyed by target (not room) since "who's
// helping whom" isn't room-scoped the way Follow's positional trailing is
// — this also enforces the one-active-session-per-target rule for free (a
// second REQUEST to an already-helped target is rejected before any prompt
// is shown — see findActiveByParticipant below).
const activeByTarget = new Map<string, ActiveRemoteHelp>();

interface PendingRemoteHelp {
  requestId: string;
  helperUid: string;
  helperName: string;
  targetUid: string;
  timeout: ReturnType<typeof setTimeout>;
}
// Keyed by requestId, same reasoning as followHandler.ts's pendingFollows:
// a target can have more than one person ask around the same time even
// though only one can end up active.
const pendingByRequestId = new Map<string, PendingRemoteHelp>();

const uidToSocket = new Map<string, string>();
const socketToUid = new Map<string, string>();
const socketToRoom = new Map<string, string>();

function findActiveByParticipant(uid: string): ActiveRemoteHelp | undefined {
  for (const rec of activeByTarget.values()) {
    if (rec.targetUid === uid || rec.helperUid === uid) return rec;
  }
  return undefined;
}

function clearPendingByHelper(helperUid: string): void {
  for (const [id, rec] of pendingByRequestId) {
    if (rec.helperUid === helperUid) {
      clearTimeout(rec.timeout);
      pendingByRequestId.delete(id);
    }
  }
}

export function registerRemoteHelpHandlers(io: Server, socket: Socket): void {
  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string, _playerName?: string, _avatarConfig?: unknown, userId?: string) => {
    const room = roomId || 'main-office';
    const uid = (socket.data as { userId?: string }).userId || userId || socket.id;
    try {
      const dbRoom = await getPrisma().room.findUnique({ where: { slug: room }, select: { organizationId: true } });
      if (!dbRoom || dbRoom.organizationId !== (socket.data as { organizationId?: string }).organizationId) return;
    } catch (e) {
      console.error('[remoteHelp] org check failed:', e);
      return;
    }
    uidToSocket.set(uid, socket.id);
    socketToUid.set(socket.id, uid);
    socketToRoom.set(socket.id, room);
  });

  socket.on(SocketEvents.REMOTE_HELP_REQUEST, async (data: { targetUserId: string }) => {
    const room = socketToRoom.get(socket.id); if (!room) return;
    const helperUid = socketToUid.get(socket.id); if (!helperUid) return;
    const targetUid = data?.targetUserId;
    if (!targetUid || targetUid === helperUid) return;

    const targetSocketId = uidToSocket.get(targetUid);
    if (!targetSocketId) {
      socket.emit('admin:error', { message: 'User not found or offline' });
      return;
    }

    // One active remote-help session per target — a second requester is
    // told plainly instead of silently queued or silently dropped.
    if (findActiveByParticipant(targetUid)) {
      socket.emit(SocketEvents.REMOTE_HELP_RESULT, { targetName: getPlayerName(targetSocketId), accepted: false, reason: 'busy' });
      return;
    }

    if (isUserInLockedZone(room, targetUid, zoneIdOfSocket(targetSocketId))) {
      socket.emit('admin:error', { message: 'Orang itu sedang di zona terkunci — tidak bisa diminta bantuan sekarang.' });
      return;
    }

    const players = await getPlayers(room);
    if (players.find((p) => p.id === targetSocketId)?.workMode === 'focus') {
      socket.emit('admin:error', { message: `${getPlayerName(targetSocketId)} sedang dalam mode Focus — tidak bisa diminta bantuan sekarang.` });
      return;
    }

    clearPendingByHelper(helperUid);
    const requestId = randomUUID();
    const helperName = getPlayerName(socket.id);
    const timeout = setTimeout(() => {
      pendingByRequestId.delete(requestId);
      socket.emit(SocketEvents.REMOTE_HELP_RESULT, { targetName: getPlayerName(targetSocketId), accepted: false, reason: 'timeout' });
    }, CONSENT_REQUEST_TIMEOUT_MS);
    pendingByRequestId.set(requestId, { requestId, helperUid, helperName, targetUid, timeout });
    io.to(targetSocketId).emit(SocketEvents.REMOTE_HELP_INCOMING, { requestId, actorUserId: helperUid, actorName: helperName });
    void writeAudit(getPrisma(), { actorId: helperUid, action: 'remoteHelp:request', targetType: 'remoteHelpSession', targetUserId: targetUid, meta: { requestId } });
  });

  socket.on(SocketEvents.REMOTE_HELP_RESPOND, (data: RemoteHelpRespondPayload) => {
    const respondingUid = socketToUid.get(socket.id); if (!respondingUid) return;
    const pending = pendingByRequestId.get(data?.requestId);
    if (!pending || pending.targetUid !== respondingUid) return;
    clearTimeout(pending.timeout);
    pendingByRequestId.delete(pending.requestId);

    const helperSocketId = uidToSocket.get(pending.helperUid);
    const targetName = getPlayerName(socket.id);

    void writeAudit(getPrisma(), {
      actorId: respondingUid, action: 'remoteHelp:decide', targetType: 'remoteHelpSession',
      targetUserId: pending.helperUid, meta: { requestId: pending.requestId, accepted: data.accept },
    });

    if (!data.accept) {
      if (helperSocketId) io.to(helperSocketId).emit(SocketEvents.REMOTE_HELP_RESULT, { targetName, accepted: false, reason: 'declined' });
      return;
    }

    // Race guard: the target could accept two different pending requests in
    // quick succession (clicking Terima on both toasts before either
    // resolves) — clearPendingByHelper only dedupes on the HELPER side at
    // request time, so this closes the one-active-session rule at the
    // moment of accept too.
    if (findActiveByParticipant(pending.targetUid)) {
      if (helperSocketId) io.to(helperSocketId).emit(SocketEvents.REMOTE_HELP_RESULT, { targetName, accepted: false, reason: 'busy' });
      return;
    }

    activeByTarget.set(pending.targetUid, {
      targetUid: pending.targetUid, targetName,
      helperUid: pending.helperUid, helperName: pending.helperName,
      startedAt: Date.now(),
    });
    if (helperSocketId) io.to(helperSocketId).emit(SocketEvents.REMOTE_HELP_RESULT, { targetName, accepted: true });
  });

  // Target relays their own RustDesk ID+password to the helper — once,
  // straight through, never written anywhere server-side beyond this one
  // emit. See the design spec's Security & privacy section.
  socket.on(SocketEvents.REMOTE_HELP_CREDENTIAL, (data: RemoteHelpCredentialPayload) => {
    const uid = socketToUid.get(socket.id); if (!uid) return;
    const active = activeByTarget.get(uid);
    if (!active || active.targetUid !== uid) return; // only the target may submit credentials
    const credential = typeof data?.credential === 'string' ? data.credential.slice(0, 500) : '';
    if (!credential) return;
    const helperSocketId = uidToSocket.get(active.helperUid);
    if (helperSocketId) io.to(helperSocketId).emit(SocketEvents.REMOTE_HELP_CREDENTIAL, { credential });
  });

  socket.on(SocketEvents.REMOTE_HELP_END, () => {
    const uid = socketToUid.get(socket.id); if (!uid) return;
    const active = findActiveByParticipant(uid);
    if (!active) return;
    activeByTarget.delete(active.targetUid);
    const endedByName = getPlayerName(socket.id);
    const otherUid = active.targetUid === uid ? active.helperUid : active.targetUid;
    const otherSocketId = uidToSocket.get(otherUid);
    if (otherSocketId) io.to(otherSocketId).emit(SocketEvents.REMOTE_HELP_END, { endedByName });
    void writeAudit(getPrisma(), {
      actorId: uid, action: 'remoteHelp:end', targetType: 'remoteHelpSession',
      targetUserId: otherUid, meta: { reason: 'explicit' },
    });
  });

  socket.on(SocketEvents.DISCONNECT, () => {
    const uid = socketToUid.get(socket.id);
    if (uid) {
      // Any pending (unanswered) request involving this uid, either side.
      for (const [id, rec] of pendingByRequestId) {
        if (rec.helperUid === uid) {
          clearTimeout(rec.timeout);
          pendingByRequestId.delete(id);
        } else if (rec.targetUid === uid) {
          clearTimeout(rec.timeout);
          pendingByRequestId.delete(id);
          const helperSocketId = uidToSocket.get(rec.helperUid);
          if (helperSocketId) io.to(helperSocketId).emit(SocketEvents.REMOTE_HELP_RESULT, { targetName: getPlayerName(socket.id), accepted: false, reason: 'offline' });
        }
      }
      // An active session where either side disconnects ends the same as
      // an explicit REMOTE_HELP_END, just with a different audit reason.
      const active = findActiveByParticipant(uid);
      if (active) {
        activeByTarget.delete(active.targetUid);
        const otherUid = active.targetUid === uid ? active.helperUid : active.targetUid;
        const otherSocketId = uidToSocket.get(otherUid);
        if (otherSocketId) io.to(otherSocketId).emit(SocketEvents.REMOTE_HELP_END, { endedByName: getPlayerName(socket.id) });
        void writeAudit(getPrisma(), {
          actorId: uid, action: 'remoteHelp:end', targetType: 'remoteHelpSession',
          targetUserId: otherUid, meta: { reason: 'disconnect' },
        });
      }
    }
    if (uid) uidToSocket.delete(uid);
    socketToUid.delete(socket.id);
    socketToRoom.delete(socket.id);
  });
}
```

- [ ] **Step 3: Register the handler**

In `server/src/index.ts`, add the import next to the existing `registerFollowHandlers` import:

```ts
import { registerRemoteHelpHandlers } from './socket/remoteHelpHandler';
```

Then add the call immediately after `registerFollowHandlers(io, socket);` inside the same `if (!isGuest) { ... }` block (guests get no consent-social features, same as Follow/Summon):

```ts
      registerFollowHandlers(io, socket);
      registerRemoteHelpHandlers(io, socket);
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: all three workspaces (`shared`, `client`, `server`) pass with no errors.

- [ ] **Step 5: Live verification script**

Create `server/scripts/verify-remote-help.temp.ts` (temporary — delete after this task, per this repo's standing convention):

```ts
// Temporary verification script — DELETE after Task 1 is confirmed working.
// Run against the real local dev server (must already be running on :3001)
// and real local Postgres: npx tsx server/scripts/verify-remote-help.temp.ts
import { io as ioClient, Socket } from 'socket.io-client';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { SocketEvents } from '@virtualmeet/shared';

const prisma = new PrismaClient();
const API = 'http://localhost:3001';

async function makeUser(email: string, name: string, orgId: string) {
  const passwordHash = await bcrypt.hash('testpass123', 10);
  const user = await prisma.user.create({
    data: { email, displayName: name, passwordHash, organizationId: orgId, workspaceRole: 'member' },
  });
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'testpass123' }),
  });
  const { token } = await res.json();
  return { user, token };
}

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(API, { auth: { token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function waitFor<T>(s: Socket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    s.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

async function main() {
  const org = await prisma.organization.findFirst({ where: { slug: 'kaitech' } }) ?? await prisma.organization.findFirstOrThrow();
  const room = await prisma.room.findFirst({ where: { organizationId: org.id } }) ?? (() => { throw new Error('no room found for org'); })();

  const { user: helperUser, token: helperToken } = await makeUser(`verify-helper-${Date.now()}@test.local`, 'Verify Helper', org.id);
  const { user: targetUser, token: targetToken } = await makeUser(`verify-target-${Date.now()}@test.local`, 'Verify Target', org.id);
  const { user: thirdUser, token: thirdToken } = await makeUser(`verify-third-${Date.now()}@test.local`, 'Verify Third', org.id);

  const helperSock = await connectSocket(helperToken);
  const targetSock = await connectSocket(targetToken);
  const thirdSock = await connectSocket(thirdToken);

  helperSock.emit(SocketEvents.JOIN_ROOM, room.slug, 'Verify Helper', {}, helperUser.id);
  targetSock.emit(SocketEvents.JOIN_ROOM, room.slug, 'Verify Target', {}, targetUser.id);
  thirdSock.emit(SocketEvents.JOIN_ROOM, room.slug, 'Verify Third', {}, thirdUser.id);
  await new Promise((r) => setTimeout(r, 500)); // let JOIN_ROOM land on both handlers

  // 1. Happy path: request -> incoming -> accept -> result -> credential -> end
  const incomingP = waitFor<{ requestId: string }>(targetSock, SocketEvents.REMOTE_HELP_INCOMING);
  helperSock.emit(SocketEvents.REMOTE_HELP_REQUEST, { targetUserId: targetUser.id });
  const incoming = await incomingP;
  console.log('[OK] target received REMOTE_HELP_INCOMING', incoming);

  const resultP = waitFor<{ accepted: boolean }>(helperSock, SocketEvents.REMOTE_HELP_RESULT);
  targetSock.emit(SocketEvents.REMOTE_HELP_RESPOND, { requestId: incoming.requestId, accept: true });
  const result = await resultP;
  if (!result.accepted) throw new Error('expected accepted:true');
  console.log('[OK] helper received REMOTE_HELP_RESULT accepted:true');

  const credP = waitFor<{ credential: string }>(helperSock, SocketEvents.REMOTE_HELP_CREDENTIAL);
  targetSock.emit(SocketEvents.REMOTE_HELP_CREDENTIAL, { credential: '123456789 testpass' });
  const cred = await credP;
  if (cred.credential !== '123456789 testpass') throw new Error('credential mismatch');
  console.log('[OK] helper received REMOTE_HELP_CREDENTIAL, string matches, never touched Postgres');

  // 2. Busy path: third user requests target while target is still "active" with helper
  const busyResultP = waitFor<{ accepted: boolean; reason?: string }>(thirdSock, SocketEvents.REMOTE_HELP_RESULT);
  thirdSock.emit(SocketEvents.REMOTE_HELP_REQUEST, { targetUserId: targetUser.id });
  const busyResult = await busyResultP;
  if (busyResult.accepted || busyResult.reason !== 'busy') throw new Error('expected busy rejection');
  console.log('[OK] third requester correctly rejected with reason:busy while target is active');

  // 3. End path
  const endP = waitFor<{ endedByName: string }>(targetSock, SocketEvents.REMOTE_HELP_END);
  helperSock.emit(SocketEvents.REMOTE_HELP_END);
  const end = await endP;
  console.log('[OK] target received REMOTE_HELP_END', end);

  // 4. Decline path
  const incoming2P = waitFor<{ requestId: string }>(targetSock, SocketEvents.REMOTE_HELP_INCOMING);
  helperSock.emit(SocketEvents.REMOTE_HELP_REQUEST, { targetUserId: targetUser.id });
  const incoming2 = await incoming2P;
  const declineResultP = waitFor<{ accepted: boolean; reason?: string }>(helperSock, SocketEvents.REMOTE_HELP_RESULT);
  targetSock.emit(SocketEvents.REMOTE_HELP_RESPOND, { requestId: incoming2.requestId, accept: false });
  const declineResult = await declineResultP;
  if (declineResult.accepted || declineResult.reason !== 'declined') throw new Error('expected declined');
  console.log('[OK] decline path correct');

  // 5. Confirm audit trail
  const auditRows = await prisma.auditLog.findMany({
    where: { targetType: 'remoteHelpSession', OR: [{ actorId: helperUser.id }, { actorId: targetUser.id }] },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`[OK] ${auditRows.length} audit rows written:`, auditRows.map((r) => r.action));
  if (!auditRows.some((r) => r.action === 'remoteHelp:request')) throw new Error('missing request audit row');
  if (!auditRows.some((r) => r.action === 'remoteHelp:decide')) throw new Error('missing decide audit row');
  if (!auditRows.some((r) => r.action === 'remoteHelp:end')) throw new Error('missing end audit row');
  for (const row of auditRows) {
    if (row.meta && JSON.stringify(row.meta).includes('123456789')) throw new Error('credential leaked into audit meta!');
  }
  console.log('[OK] no credential string found in any audit meta');

  helperSock.disconnect(); targetSock.disconnect(); thirdSock.disconnect();
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: helperUser.id }, { actorId: targetUser.id }, { actorId: thirdUser.id }] } });
  await prisma.user.deleteMany({ where: { id: { in: [helperUser.id, targetUser.id, thirdUser.id] } } });
  await prisma.$disconnect();
  console.log('\nAll checks passed. Test users and audit rows cleaned up.');
}

main().catch(async (err) => {
  console.error('VERIFICATION FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
```

Run: `npx tsx server/scripts/verify-remote-help.temp.ts` (with the local dev server already running on :3001 via `npm run dev:server`)
Expected: all `[OK]` lines print, ending with "All checks passed." — confirms the happy path, the one-active-session-per-target guard, the end path, the decline path, and that the full audit trail is written with no credential leakage.

- [ ] **Step 6: Delete the temporary script and commit**

```bash
rm server/scripts/verify-remote-help.temp.ts
git add shared/types/index.ts server/src/socket/remoteHelpHandler.ts server/src/index.ts
git commit -m "Add remote-help consent handshake + credential relay + audit (server)"
```

---

## Task 2: Client UI — player card button, consent toast, active-session banner, credential form

**Files:**
- Modify: `client/src/components/ui/PlayerCard.tsx`
- Create: `client/src/components/ui/RemoteHelpBanner.tsx`
- Create: `client/src/components/ui/RemoteHelpCredentialForm.tsx`
- Modify: `client/src/stores/gameStore.ts`
- Modify: `client/src/hooks/useSocket.ts`
- Modify: `client/src/App.tsx`

**Interfaces:**
- Consumes (from Task 1): `SocketEvents.REMOTE_HELP_REQUEST | REMOTE_HELP_INCOMING | REMOTE_HELP_RESPOND | REMOTE_HELP_RESULT | REMOTE_HELP_CREDENTIAL | REMOTE_HELP_END`, and the `RemoteHelpRequestPayload`/`RemoteHelpRespondPayload`/`RemoteHelpResultPayload`/`RemoteHelpCredentialPayload`/`RemoteHelpEndPayload` types, all from `@virtualmeet/shared`.
- Produces: no further consumers — this is the top of the client stack for this feature.

- [ ] **Step 1: Add gameStore state**

In `client/src/stores/gameStore.ts`, find the existing Follow-related state block (`incomingFollowRequest` / `setIncomingFollowRequest` / `followResult` / `setFollowResult`, both in the interface and the store initializer) and add, directly after each:

In the store's interface/type declaration, after `setFollowResult: (result: FollowResultPayload | null) => void;`:
```ts
  incomingRemoteHelpRequest: RemoteHelpRequestPayload | null;
  setIncomingRemoteHelpRequest: (req: RemoteHelpRequestPayload | null) => void;
  remoteHelpResult: RemoteHelpResultPayload | null;
  setRemoteHelpResult: (result: RemoteHelpResultPayload | null) => void;
  // Active session, tracked identically on both sides — `role` says whether
  // THIS client is the one being helped (sees the credential form) or the
  // one helping (waits for the credential to arrive). null = no active
  // session. Cleared on REMOTE_HELP_END from either side, or when this
  // client itself clicks "Selesai".
  activeRemoteHelp: { role: 'target' | 'helper'; otherName: string } | null;
  setActiveRemoteHelp: (v: { role: 'target' | 'helper'; otherName: string } | null) => void;
  // The credential the TARGET typed in, once relayed — read once by the
  // HELPER's own UI to display it, then the string is not needed again.
  // Never localStorage/sessionStorage (see design spec's Security section).
  receivedRemoteHelpCredential: string | null;
  setReceivedRemoteHelpCredential: (v: string | null) => void;
```

Add the matching import at the top of the file (alongside the existing `FollowInfo, FollowRequestPayload, FollowResultPayload` import from `@virtualmeet/shared`):
```ts
  RemoteHelpRequestPayload, RemoteHelpResultPayload,
```

And in the store's initial-state/creator object, after the existing `followResult: null, setFollowResult: (result) => set({ followResult: result }),`:
```ts
  incomingRemoteHelpRequest: null,
  setIncomingRemoteHelpRequest: (req) => set({ incomingRemoteHelpRequest: req }),
  remoteHelpResult: null,
  setRemoteHelpResult: (result) => set({ remoteHelpResult: result }),
  activeRemoteHelp: null,
  setActiveRemoteHelp: (v) => set({ activeRemoteHelp: v }),
  receivedRemoteHelpCredential: null,
  setReceivedRemoteHelpCredential: (v) => set({ receivedRemoteHelpCredential: v }),
```

- [ ] **Step 2: Wire socket listeners and emit callbacks**

In `client/src/hooks/useSocket.ts`, immediately after the existing block:
```ts
    socket.on(SocketEvents.FOLLOW_RESULT, (data: FollowResultPayload) => {
      useGameStore.getState().setFollowResult(data);
    });
```
add:
```ts
    // Minta Bantuan Remote — same consent shape as Follow above.
    socket.on(SocketEvents.REMOTE_HELP_INCOMING, (data: RemoteHelpRequestPayload) => {
      useGameStore.getState().setIncomingRemoteHelpRequest(data);
    });
    socket.on(SocketEvents.REMOTE_HELP_RESULT, (data: RemoteHelpResultPayload) => {
      useGameStore.getState().setRemoteHelpResult(data);
      // Accepted means THIS client is the helper — the target's own client
      // sets its half of activeRemoteHelp optimistically on accept-click
      // instead (see App.tsx), same "clear pending state on my own action
      // without waiting for a round trip" convention every other
      // accept/decline flow in this codebase already uses.
      if (data.accepted) useGameStore.getState().setActiveRemoteHelp({ role: 'helper', otherName: data.targetName });
    });
    socket.on(SocketEvents.REMOTE_HELP_CREDENTIAL, (data: RemoteHelpCredentialPayload) => {
      useGameStore.getState().setReceivedRemoteHelpCredential(data.credential);
    });
    socket.on(SocketEvents.REMOTE_HELP_END, (data: RemoteHelpEndPayload) => {
      // addActivity is the same lightweight one-off notice mechanism this
      // file already uses for INTERACTIVE_API_CALL_RESULT/
      // DOOR_AREA_UNLOCKED_NOTICE — reused here so whoever did NOT click
      // "Selesai" themselves still learns who ended the session, instead of
      // the banner just silently vanishing.
      useGameStore.getState().addActivity(`Sesi bantuan remote diakhiri oleh ${data.endedByName}.`);
      useGameStore.getState().setActiveRemoteHelp(null);
      useGameStore.getState().setReceivedRemoteHelpCredential(null);
    });
```

Add `RemoteHelpRequestPayload, RemoteHelpResultPayload, RemoteHelpCredentialPayload, RemoteHelpEndPayload` to this file's existing `@virtualmeet/shared` type import list.

Then, immediately after the existing:
```ts
  const emitFollowRespond = useCallback((requestId: string, accept: boolean) => {
    socketRef.current?.emit(SocketEvents.FOLLOW_RESPOND, { requestId, accept });
  }, []);
```
add:
```ts
  const emitRemoteHelpRequest = useCallback((targetUserId: string) => {
    socketRef.current?.emit(SocketEvents.REMOTE_HELP_REQUEST, { targetUserId });
  }, []);

  const emitRemoteHelpRespond = useCallback((requestId: string, accept: boolean) => {
    socketRef.current?.emit(SocketEvents.REMOTE_HELP_RESPOND, { requestId, accept });
  }, []);

  const emitRemoteHelpCredential = useCallback((credential: string) => {
    socketRef.current?.emit(SocketEvents.REMOTE_HELP_CREDENTIAL, { credential });
  }, []);

  const emitRemoteHelpEnd = useCallback(() => {
    socketRef.current?.emit(SocketEvents.REMOTE_HELP_END);
  }, []);
```

Find this hook's return statement (where `emitFollowRequest`, `emitFollowRespond`, `emitFollowUnfollow` etc. are exported) and add `emitRemoteHelpRequest, emitRemoteHelpRespond, emitRemoteHelpCredential, emitRemoteHelpEnd` to it.

- [ ] **Step 3: Add the PlayerCard button**

In `client/src/components/ui/PlayerCard.tsx`, add to `PlayerCardProps` (after `onCopyOutfit?: () => void;`):
```ts
  onRequestRemoteHelp?: () => void;
```

Add to the import line (alongside `XLg, ChatDotsFill, PersonWalking, ArrowRepeat`):
```ts
  Display,
```
(the `Display` icon from `react-bootstrap-icons`, for a screen/remote-control visual cue distinct from the existing icons)

Add to the destructured props list (after `onCopyOutfit,`):
```ts
  onRequestRemoteHelp,
```

Add the button itself, inside the `flex flex-col gap-1` block, after the existing Copy Outfit button:
```tsx
        {onRequestRemoteHelp && (
          <button
            onClick={onRequestRemoteHelp}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-800 cursor-pointer"
          >
            <Display size={13} className="text-purple-600 dark:text-purple-400" /> Minta Bantuan Remote
          </button>
        )}
```

- [ ] **Step 4: Create the active-session banner**

Create `client/src/components/ui/RemoteHelpBanner.tsx`:

```tsx
import { Display, XLg } from 'react-bootstrap-icons';

interface RemoteHelpBannerProps {
  role: 'target' | 'helper';
  otherName: string;
  onEnd: () => void;
}

// Shown to BOTH sides of an active remote-help session (see App.tsx —
// rendered whenever gameStore's activeRemoteHelp is non-null). "Selesai"
// ends KaiSpace's own tracking/notification only — it cannot and does not
// claim to disconnect the underlying RustDesk session, which only
// RustDesk's own native client can do. That limit is stated in the copy
// itself so nobody mistakes this for a real kill-switch.
export function RemoteHelpBanner({ role, otherName, onEnd }: RemoteHelpBannerProps) {
  return (
    <div className="fixed top-16 right-4 z-50 w-72 bg-purple-600/95 text-white rounded-xl shadow-lg px-3.5 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <Display size={14} />
        {role === 'target' ? `Sedang dibantu remote oleh ${otherName}` : `Sedang membantu remote ${otherName}`}
      </div>
      <p className="text-[11px] text-purple-100 leading-snug">
        Tombol ini menghentikan pencatatan di KaiSpace saja — untuk memutus koneksi RustDesk, gunakan tombol disconnect di aplikasi RustDesk itu sendiri.
      </p>
      <button
        onClick={onEnd}
        className="self-end flex items-center gap-1 px-3 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-xs font-medium cursor-pointer transition-colors"
      >
        <XLg size={11} /> Selesai
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Create the credential form**

Create `client/src/components/ui/RemoteHelpCredentialForm.tsx`:

```tsx
import { useState } from 'react';
import { Display } from 'react-bootstrap-icons';

interface RemoteHelpCredentialFormProps {
  helperName: string;
  onSubmit: (credential: string) => void;
}

// Shown ONLY to the target, once, right after they approve a remote-help
// request. This is the entire "KaiSpace as a door" mechanism: KaiSpace
// never generates or knows a RustDesk ID/password — the target types their
// own in here, it is relayed to the helper exactly once, and this
// component's own local state is the only place it ever lives client-side
// (never localStorage/sessionStorage — see the design spec's Security
// section). The field clears itself immediately after submit.
export function RemoteHelpCredentialForm({ helperName, onSubmit }: RemoteHelpCredentialFormProps) {
  const [value, setValue] = useState('');
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <div className="fixed top-32 right-4 z-50 w-72 bg-white/95 dark:bg-gray-900/95 rounded-xl shadow-lg px-3.5 py-3 text-xs text-gray-600 dark:text-gray-300">
        Terkirim ke {helperName}.
      </div>
    );
  }

  return (
    <div className="fixed top-32 right-4 z-50 w-72 bg-white/95 dark:bg-gray-900/95 rounded-xl shadow-lg px-3.5 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-semibold text-gray-800 dark:text-gray-100">
        <Display size={14} className="text-purple-600 dark:text-purple-400" />
        Buka RustDesk, kirim ID+password kamu
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="mis. 123 456 789  password"
        className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs text-gray-800 dark:text-gray-100 outline-none focus:border-purple-400"
      />
      <button
        onClick={() => {
          if (!value.trim()) return;
          onSubmit(value.trim());
          setValue('');
          setSent(true);
        }}
        className="self-end px-3 py-1 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium cursor-pointer transition-colors"
      >
        Kirim
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Wire everything in App.tsx**

Add imports (alongside the existing `PendingRequestToast` import and icon imports):
```ts
import { RemoteHelpBanner } from './components/ui/RemoteHelpBanner';
import { RemoteHelpCredentialForm } from './components/ui/RemoteHelpCredentialForm';
```
(add `Display` to the existing `react-bootstrap-icons` import line used for `PersonWalking`/`MagnetFill`/etc.)

Read the needed store fields and emit callbacks (alongside the existing `const followResult = useGameStore((s) => s.followResult);` and the destructuring of `emitFollowRequest` etc. from `useSocket`):
```ts
  const incomingRemoteHelpRequest = useGameStore((s) => s.incomingRemoteHelpRequest);
  const remoteHelpResult = useGameStore((s) => s.remoteHelpResult);
  const activeRemoteHelp = useGameStore((s) => s.activeRemoteHelp);
  const receivedRemoteHelpCredential = useGameStore((s) => s.receivedRemoteHelpCredential);
```
(and add `emitRemoteHelpRequest, emitRemoteHelpRespond, emitRemoteHelpCredential, emitRemoteHelpEnd` to wherever this component destructures the other `emit*` callbacks from the `useSocket` hook's return value)

Clear `remoteHelpResult` on a timer the same way `followResult` already is — find the existing effect:
```ts
  const followResult = useGameStore((s) => s.followResult);
  useEffect(() => {
    if (!followResult) return;
    ...
  }, [followResult]);
```
and add an identical effect for `remoteHelpResult` right after it (same timeout duration and `setFollowResult(null)`-style clear, calling `useGameStore.getState().setRemoteHelpResult(null)` instead).

Wire the new PlayerCard prop — in the existing `<PlayerCard ... />` block (around the `onCopyOutfit` prop), add:
```tsx
          onRequestRemoteHelp={
            playerCardTarget.player.userId
              ? () => { emitRemoteHelpRequest(playerCardTarget.player.userId!); setPlayerCardTarget(null); }
              : undefined
          }
```

Add the consent toast — immediately after the existing `{incomingFollowRequest && (...)}` block:
```tsx
        {incomingRemoteHelpRequest && (
          <PendingRequestToast
            icon={<Display size={13} className="text-purple-600" />}
            message={<><span className="font-medium">{incomingRemoteHelpRequest.actorName}</span> minta bantuan remote (RustDesk)</>}
            onAccept={() => {
              emitRemoteHelpRespond(incomingRemoteHelpRequest.requestId, true);
              useGameStore.getState().setIncomingRemoteHelpRequest(null);
              useGameStore.getState().setActiveRemoteHelp({ role: 'target', otherName: incomingRemoteHelpRequest.actorName });
            }}
            onDecline={() => {
              emitRemoteHelpRespond(incomingRemoteHelpRequest.requestId, false);
              useGameStore.getState().setIncomingRemoteHelpRequest(null);
            }}
          />
        )}
```

Add the result pill — immediately after the existing `{followResult && (...)}` block:
```tsx
        {remoteHelpResult && (
          <div className="bg-purple-600/90 text-white text-xs font-semibold px-4 py-2 rounded-full shadow-lg pointer-events-none inline-flex items-center gap-1.5">
            <Display size={13} />
            {remoteHelpResult.accepted
              ? `${remoteHelpResult.targetName} accepted your remote-help request`
              : remoteHelpResult.reason === 'busy'
                ? `${remoteHelpResult.targetName} is already being helped by someone else`
                : `${remoteHelpResult.targetName} ${describeConsentDecline(remoteHelpResult.reason === 'busy' ? undefined : remoteHelpResult.reason)} your remote-help request`}
          </div>
        )}
```

Finally, render the banner and (target-only) credential form — anywhere else in the component's JSX tree, outside the toast-stack `<div>` (e.g. immediately after it closes), since these are positioned `fixed` independently:
```tsx
      {activeRemoteHelp && (
        <RemoteHelpBanner
          role={activeRemoteHelp.role}
          otherName={activeRemoteHelp.otherName}
          onEnd={() => { emitRemoteHelpEnd(); useGameStore.getState().setActiveRemoteHelp(null); useGameStore.getState().setReceivedRemoteHelpCredential(null); }}
        />
      )}
      {activeRemoteHelp?.role === 'target' && !receivedRemoteHelpCredential && (
        <RemoteHelpCredentialForm
          helperName={activeRemoteHelp.otherName}
          onSubmit={(credential) => emitRemoteHelpCredential(credential)}
        />
      )}
      {activeRemoteHelp?.role === 'helper' && receivedRemoteHelpCredential && (
        <div className="fixed top-32 right-4 z-50 w-72 bg-white/95 dark:bg-gray-900/95 rounded-xl shadow-lg px-3.5 py-3 text-xs text-gray-800 dark:text-gray-100">
          <div className="font-semibold mb-1">ID+password dari {activeRemoteHelp.otherName}:</div>
          <div className="font-mono bg-gray-100 dark:bg-gray-800 rounded px-2 py-1.5 select-all">{receivedRemoteHelpCredential}</div>
        </div>
      )}
```

- [ ] **Step 7: Typecheck and build**

Run: `npm run typecheck && npm run build --workspace=@virtualmeet/client`
Expected: no errors. (No live browser verification is possible in this environment — no browser-automation tool is available this session. This step is typecheck/build only; a real click-through smoke test with two logged-in browser sessions must be done manually before this feature is considered fully verified — flag this clearly when reporting the task done.)

- [ ] **Step 8: Commit**

```bash
git add client/src/components/ui/PlayerCard.tsx client/src/components/ui/RemoteHelpBanner.tsx client/src/components/ui/RemoteHelpCredentialForm.tsx client/src/stores/gameStore.ts client/src/hooks/useSocket.ts client/src/App.tsx
git commit -m "Add remote-help UI: player card button, consent toast, active-session banner, credential form"
```

---

## Final Verification Gate

- [ ] Both tasks' reviews are clean (no unresolved Critical/Important findings).
- [ ] `npm run typecheck` passes for all three workspaces.
- [ ] `npm run build --workspace=@virtualmeet/client` succeeds.
- [ ] Task 1's live socket-level verification script passed (happy path, busy-rejection, end, decline, audit trail with no credential leakage).
- [ ] Explicitly flagged to the user: Task 2's client UI has NOT been click-tested in a real browser (no browser-automation tool available this session) — a manual two-person (or two-browser-session) smoke test is needed before this ships to production, covering: button appears on player card → toast appears for target → accept shows banner on both sides + credential form on target's side → submitted credential appears on helper's side → Selesai clears both sides → decline/timeout/busy paths show the right message.
