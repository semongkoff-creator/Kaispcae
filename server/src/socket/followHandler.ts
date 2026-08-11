import { randomUUID } from 'crypto';
import { isUserInLockedZone } from './zoneLock';
import { zoneIdOfSocket } from './zoneHandler';
import { Server, Socket } from 'socket.io';
import { SocketEvents, FollowInfo, CONSENT_REQUEST_TIMEOUT_MS, FollowRespondPayload } from '@virtualmeet/shared';
import { getPlayerName } from './roomHandler';
import { getPlayers } from '../store/roomStore';
import { getPrisma } from '../lib/prisma';

// Follow (spec §3) — auto-move a follower's avatar to trail a target
// player. The actual per-frame trailing movement is entirely client-side
// (client/src/components/canvas/GameCanvas.tsx's useMovement.moveToward
// call): the follower's own client already receives the target's live
// position via the normal PLAYER_MOVED broadcast every other client gets,
// so there's no need for the server to compute/push position updates
// itself. This handler only owns the *relationship* — who follows whom,
// validated server-side (never trust a client's own claim of "I'm
// following X" for anything security-sensitive), and its lifecycle
// (circular-follow rejection, standby-on-disconnect, reactivate-on-reconnect).
//
// This module tracks its own uid/room mappings rather than reaching into
// roomHandler.ts's private maps — same "small deliberate duplication for
// decoupling" precedent as findSpawnPixel existing in both roomHandler.ts
// and shared/defaultRoomLayout.ts. getPlayerName is the one thing reused
// via export, since it's keyed by socket id which this module already tracks.

interface FollowRecord {
  followerId: string; // follower's uid
  targetId: string; // target's uid
  status: 'active' | 'standby';
}

// room -> followerUid -> FollowRecord
const roomFollows = new Map<string, Map<string, FollowRecord>>();

function getRoomFollows(room: string): Map<string, FollowRecord> {
  if (!roomFollows.has(room)) roomFollows.set(room, new Map());
  return roomFollows.get(room)!;
}

// uid <-> socket.id, populated from this module's own JOIN_ROOM listener
// (mirrors roomHandler.ts's identical derivation of `uid`).
const uidToSocket = new Map<string, string>();
const socketToUid = new Map<string, string>();
const socketToRoom = new Map<string, string>();

// Follow now requires the target's consent before the relationship is
// created. Keyed by requestId rather than by follower/target alone —
// unlike Summon (one target, one pending slot), a target can legitimately
// have several different people asking to follow them at once, so it can't
// be keyed by target either.
interface PendingFollow {
  requestId: string;
  followerUid: string;
  followerName: string;
  targetUid: string;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingFollows = new Map<string, PendingFollow>();

// A follower can only have one outstanding (unanswered) request at a time —
// asking someone new supersedes whatever they hadn't heard back on yet.
function clearPendingFollowByFollower(followerUid: string): void {
  for (const [id, rec] of pendingFollows) {
    if (rec.followerUid === followerUid) {
      clearTimeout(rec.timeout);
      pendingFollows.delete(id);
    }
  }
}

function broadcastFollowerChange(io: Server, room: string, targetUid: string): void {
  const follows = getRoomFollows(room);
  const followerUserIds = Array.from(follows.values())
    .filter((f) => f.targetId === targetUid && f.status === 'active')
    .map((f) => f.followerId);
  io.to(room).emit(SocketEvents.FOLLOWER_CHANGED, { targetUserId: targetUid, followerUserIds });
}

function sendFollowInfo(io: Server, followerUid: string, rec: FollowRecord | null): void {
  const followerSocketId = uidToSocket.get(followerUid);
  if (!followerSocketId) return;
  if (!rec) {
    io.to(followerSocketId).emit(SocketEvents.FOLLOW_UPDATED, null);
    return;
  }
  const targetSocketId = uidToSocket.get(rec.targetId);
  const info: FollowInfo = {
    targetUserId: rec.targetId,
    targetName: targetSocketId ? getPlayerName(targetSocketId) : 'Unknown',
    status: rec.status,
  };
  io.to(followerSocketId).emit(SocketEvents.FOLLOW_UPDATED, info);
}

export function registerFollowHandlers(io: Server, socket: Socket): void {
  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string, _playerName?: string, _avatarConfig?: unknown, userId?: string) => {
    const room = roomId || 'main-office';
    const uid = (socket.data as { userId?: string }).userId || userId || socket.id;
    // Multi-tenant Fase 3 — this module registers its own independent
    // JOIN_ROOM listener (see mediaHandler.ts's comment on why roomHandler.ts
    // rejecting a cross-org join doesn't stop this one from also running).
    // uidToSocket/socketToUid/socketToRoom deliberately only populate AFTER
    // this passes — every FOLLOW_* handler below trusts them.
    try {
      const dbRoom = await getPrisma().room.findUnique({ where: { slug: room }, select: { organizationId: true } });
      if (!dbRoom || dbRoom.organizationId !== (socket.data as { organizationId?: string }).organizationId) return;
    } catch (e) {
      console.error('[follow] org check failed:', e);
      return;
    }
    uidToSocket.set(uid, socket.id);
    socketToUid.set(socket.id, uid);
    socketToRoom.set(socket.id, room);

    // Reactivate: if anyone was following this uid and got parked in
    // 'standby' (see handleDisconnect below), resume now that they're back.
    const follows = getRoomFollows(room);
    let anyReactivated = false;
    for (const [followerUid, rec] of follows) {
      if (rec.targetId === uid && rec.status === 'standby') {
        rec.status = 'active';
        anyReactivated = true;
        sendFollowInfo(io, followerUid, rec);
      }
    }
    if (anyReactivated) broadcastFollowerChange(io, room, uid);
  });

  // Starts a pending request rather than following immediately — the
  // target has to accept via FOLLOW_RESPOND below before the relationship
  // actually exists.
  socket.on(SocketEvents.FOLLOW_REQUEST, async (data: { targetUserId: string }) => {
    const room = socketToRoom.get(socket.id); if (!room) return;
    const followerUid = socketToUid.get(socket.id); if (!followerUid) return;
    const targetUid = data?.targetUserId;
    if (!targetUid || targetUid === followerUid) return;

    // Someone in a locked zone is in a closed meeting: they can't be followed.
    // Otherwise "follow" would be a side door into a room you were refused.
    const lockedTargetSocket = [...socketToUid.entries()].find(([, uid]) => uid === targetUid)?.[0];
    if (lockedTargetSocket && isUserInLockedZone(room, targetUid, zoneIdOfSocket(lockedTargetSocket))) {
      socket.emit('admin:error', { message: 'Orang itu sedang di zona terkunci — tidak bisa diikuti.' });
      return;
    }

    const follows = getRoomFollows(room);

    // Circular follow guard: reject if the target is already actively
    // following ME (A<->B stacking would otherwise both avatars trying to
    // trail each other with no stable position).
    const targetsFollow = follows.get(targetUid);
    if (targetsFollow && targetsFollow.targetId === followerUid && targetsFollow.status === 'active') {
      socket.emit('admin:error', { message: 'This user is already following you' });
      return;
    }

    // Target must currently be an online, tracked player in this room.
    const targetSocketId = uidToSocket.get(targetUid);
    if (!targetSocketId) {
      socket.emit('admin:error', { message: 'User not found or offline' });
      return;
    }

    // A3 — respect Focus/DND (mirrors Summon): don't ping someone who's in
    // Focus mode; reject the request with a clear reason to the follower.
    const players = await getPlayers(room);
    if (players.find((p) => p.id === targetSocketId)?.workMode === 'focus') {
      socket.emit('admin:error', { message: `${getPlayerName(targetSocketId)} sedang dalam mode Focus — tidak bisa diikuti sekarang.` });
      return;
    }

    clearPendingFollowByFollower(followerUid);
    const requestId = randomUUID();
    const followerName = getPlayerName(socket.id);
    const timeout = setTimeout(() => {
      pendingFollows.delete(requestId);
      socket.emit(SocketEvents.FOLLOW_RESULT, { targetName: getPlayerName(targetSocketId), accepted: false, reason: 'timeout' });
    }, CONSENT_REQUEST_TIMEOUT_MS);
    pendingFollows.set(requestId, { requestId, followerUid, followerName, targetUid, timeout });
    io.to(targetSocketId).emit(SocketEvents.FOLLOW_INCOMING, { requestId, actorUserId: followerUid, actorName: followerName });
  });

  // Target's reply to a pending Follow request. Accept creates the actual
  // FollowRecord (same as the old immediate-follow behavior); decline just
  // drops the pending request. Either way the follower gets FOLLOW_RESULT
  // so their UI knows what happened instead of waiting silently forever.
  socket.on(SocketEvents.FOLLOW_RESPOND, (data: FollowRespondPayload) => {
    const room = socketToRoom.get(socket.id); if (!room) return;
    const respondingUid = socketToUid.get(socket.id); if (!respondingUid) return;
    const pending = pendingFollows.get(data?.requestId);
    if (!pending || pending.targetUid !== respondingUid) return;
    clearTimeout(pending.timeout);
    pendingFollows.delete(pending.requestId);

    const followerSocketId = uidToSocket.get(pending.followerUid);
    const targetName = getPlayerName(socket.id);

    if (!data.accept) {
      if (followerSocketId) io.to(followerSocketId).emit(SocketEvents.FOLLOW_RESULT, { targetName, accepted: false, reason: 'declined' });
      return;
    }

    const follows = getRoomFollows(room);
    const rec: FollowRecord = { followerId: pending.followerUid, targetId: pending.targetUid, status: 'active' };
    follows.set(pending.followerUid, rec);
    sendFollowInfo(io, pending.followerUid, rec);
    broadcastFollowerChange(io, room, pending.targetUid);
    if (followerSocketId) io.to(followerSocketId).emit(SocketEvents.FOLLOW_RESULT, { targetName, accepted: true });
  });

  socket.on(SocketEvents.FOLLOW_UNFOLLOW, () => {
    const room = socketToRoom.get(socket.id); if (!room) return;
    const followerUid = socketToUid.get(socket.id); if (!followerUid) return;
    const follows = getRoomFollows(room);
    const rec = follows.get(followerUid);
    if (!rec) return;
    follows.delete(followerUid);
    sendFollowInfo(io, followerUid, null);
    broadcastFollowerChange(io, room, rec.targetId);
  });

  socket.on(SocketEvents.DISCONNECT, () => {
    const room = socketToRoom.get(socket.id);
    const uid = socketToUid.get(socket.id);
    if (room && uid) {
      const follows = getRoomFollows(room);
      // If I was following someone, that relationship doesn't need to
      // survive my own disconnect — I'll have to re-follow after
      // reconnecting (spec's standby/reactivate rule is specifically about
      // the *target* going offline, not the follower).
      follows.delete(uid);
      // If I was being followed, park my followers in standby rather than
      // dropping them — reactivated automatically in JOIN_ROOM above the
      // moment I reconnect.
      let anyParked = false;
      for (const [followerUid, rec] of follows) {
        if (rec.targetId === uid && rec.status === 'active') {
          rec.status = 'standby';
          anyParked = true;
          sendFollowInfo(io, followerUid, rec);
        }
      }
      if (anyParked) broadcastFollowerChange(io, room, uid);
    }

    // Any pending (unanswered) Follow request involving this uid — either
    // side — can't be fulfilled correctly anymore.
    if (uid) {
      for (const [id, rec] of pendingFollows) {
        if (rec.followerUid === uid) {
          clearTimeout(rec.timeout);
          pendingFollows.delete(id);
        } else if (rec.targetUid === uid) {
          clearTimeout(rec.timeout);
          pendingFollows.delete(id);
          const followerSocketId = uidToSocket.get(rec.followerUid);
          if (followerSocketId) io.to(followerSocketId).emit(SocketEvents.FOLLOW_RESULT, { targetName: getPlayerName(socket.id), accepted: false, reason: 'offline' });
        }
      }
    }

    if (uid) uidToSocket.delete(uid);
    socketToUid.delete(socket.id);
    socketToRoom.delete(socket.id);
  });
}
