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
