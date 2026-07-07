import { Server, Socket } from 'socket.io';
import { SocketEvents, FollowInfo } from '@virtualmeet/shared';
import { getPlayerName } from './roomHandler';

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
  socket.on(SocketEvents.JOIN_ROOM, (roomId: string, _playerName?: string, _avatarConfig?: unknown, userId?: string) => {
    const room = roomId || 'main-office';
    const uid = (socket.data as { userId?: string }).userId || userId || socket.id;
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

  socket.on(SocketEvents.FOLLOW_REQUEST, (data: { targetUserId: string }) => {
    const room = socketToRoom.get(socket.id); if (!room) return;
    const followerUid = socketToUid.get(socket.id); if (!followerUid) return;
    const targetUid = data?.targetUserId;
    if (!targetUid || targetUid === followerUid) return;

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
    if (!uidToSocket.has(targetUid)) {
      socket.emit('admin:error', { message: 'User not found or offline' });
      return;
    }

    const rec: FollowRecord = { followerId: followerUid, targetId: targetUid, status: 'active' };
    follows.set(followerUid, rec);
    sendFollowInfo(io, followerUid, rec);
    broadcastFollowerChange(io, room, targetUid);
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
    if (uid) uidToSocket.delete(uid);
    socketToUid.delete(socket.id);
    socketToRoom.delete(socket.id);
  });
}
