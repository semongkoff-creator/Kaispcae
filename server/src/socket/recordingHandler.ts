import { Server, Socket } from 'socket.io';
import { getPrisma } from '../lib/prisma';
import { SocketEvents, hasFeatureAccess, RECORDING_DOWNLOAD_TTL_MS, RECORDING_MAX_DOWNLOADS } from '@virtualmeet/shared';
import { getPlayerName } from './roomHandler';
import { resolveRoomRole as resolveRole } from '../lib/roles';

// §7 — Screen Recording, client-side-capture adaptation (see the Recording
// Prisma model's doc comment for the full architectural reasoning). This
// handler only owns the metadata lifecycle (lock, per-role visibility,
// finalize, disconnect cleanup) — the actual capture/upload happens
// entirely in the starting admin's own browser.
//
// Self-contained module tracking its own uid/room mappings rather than
// reaching into roomHandler.ts's private state — same "small deliberate
// duplication for decoupling" precedent as followHandler.ts/mediaHandler.ts.


const socketToUid = new Map<string, string>();
const socketToRoom = new Map<string, string>();

// The two shapes POST /uploads/recording can produce: a legacy disk .webm
// (/api/uploads/<uuid>.webm) or an A8 Lark Drive locator (drive:<file_token>).
// Both are server-generated; a client can't forge an arbitrary path/URL here.
function isValidRecordingUrl(url: unknown): url is string {
  return typeof url === 'string' && (/^\/api\/uploads\/[a-zA-Z0-9-]+\.webm$/.test(url) || /^drive:[a-zA-Z0-9_-]+$/.test(url));
}

// Finds the live socket (if any) for a given account userId within a room —
// used both to resolve the target's current display name and to confirm
// they're actually present before starting a recording of them.
function findSocketByUserId(io: Server, room: string, userId: string): string | undefined {
  const roomSockets = io.sockets.adapter.rooms.get(room);
  if (!roomSockets) return undefined;
  for (const sid of roomSockets) {
    const s = io.sockets.sockets.get(sid);
    if ((s?.data as { userId?: string })?.userId === userId) return sid;
  }
  return undefined;
}

export function registerRecordingHandlers(io: Server, socket: Socket): void {
  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string, _playerName?: string, _avatarConfig?: unknown, userId?: string) => {
    const room = roomId || 'main-office';
    const uid = (socket.data as { userId?: string }).userId || userId || socket.id;

    // QA (Data A/V checklist item 7) — a late joiner must see the banner
    // immediately too, not just learn about it on the NEXT start/stop —
    // RECORDING_ACTIVE_CHANGED above is a live delta, this is the
    // equivalent one-time snapshot (same "ROOM_STATE for the thing this
    // module doesn't otherwise expose there" shape as MEDIA_LIST arriving
    // right after ROOM_STATE elsewhere in this app).
    try {
      const dbRoom = await getPrisma().room.findUnique({ where: { slug: room }, select: { id: true, organizationId: true } });
      // Multi-tenant Fase 3 — this module registers its own independent
      // JOIN_ROOM listener (see mediaHandler.ts's comment on why
      // roomHandler.ts rejecting a cross-org join doesn't stop this one
      // from also running). socketToUid/socketToRoom deliberately only
      // populate AFTER this passes — RECORDING_START/etc. below trust them.
      if (!dbRoom || dbRoom.organizationId !== (socket.data as { organizationId?: string }).organizationId) return;
      socketToUid.set(socket.id, uid);
      socketToRoom.set(socket.id, room);
      const active = await getPrisma().recording.findFirst({ where: { roomId: dbRoom.id, status: { in: ['recording', 'processing'] } } });
      socket.emit(SocketEvents.RECORDING_ACTIVE_CHANGED, { active: !!active });
    } catch (e) {
      console.error('[recording] active-status check on join failed:', e);
    }
  });

  socket.on(SocketEvents.RECORDING_START, async (data: { targetUserId: string; title: string }) => {
    const room = socketToRoom.get(socket.id); if (!room) return;
    const uid = socketToUid.get(socket.id); if (!uid) return;
    const title = data?.title?.trim().slice(0, 100);
    if (!data?.targetUserId || !title) return;

    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
      if (!dbRoom) return;

      const role = await resolveRole(prisma, uid, dbRoom.id, dbRoom.ownerId, dbRoom.organizationId);
      if (!hasFeatureAccess(role, 'recording:start')) {
        socket.emit('admin:error', { message: 'Admin role required to start a recording' });
        return;
      }

      // Self-only, enforced server-side — the shipped UI only ever offers
      // "Myself" as a target (see App.tsx's recordingTargets; a picker for
      // recording someone ELSE was deliberately removed), but that alone
      // was never backed by a matching check here: nothing stopped a
      // hand-crafted RECORDING_START from naming any other userId, which
      // would capture that person's camera/mic/screen over the existing
      // WebRTC connection with no consent prompt of any kind on their end.
      // Recording someone without their knowledge isn't a gap to fill in —
      // it's a line this app doesn't cross.
      if (data.targetUserId !== uid) {
        socket.emit('admin:error', { message: 'You can only record yourself' });
        return;
      }

      const targetSocketId = findSocketByUserId(io, room, data.targetUserId);
      if (!targetSocketId) {
        socket.emit('admin:error', { message: 'Recording target is not currently in this room' });
        return;
      }

      // Lock — spec's own explicit rule: only one active recording per
      // room. Plain findFirst-then-create would let two RECORDING_START
      // calls that arrive within the same tick both see "no existing
      // recording" and both create a row; wrapping the check+create in a
      // Serializable transaction makes Postgres abort one of them with a
      // serialization conflict (caught below) instead.
      let row;
      try {
        row = await prisma.$transaction(async (tx) => {
          const existing = await tx.recording.findFirst({ where: { roomId: dbRoom.id, status: { in: ['recording', 'processing'] } } });
          if (existing) throw new Error('RECORDING_LOCK_HELD');
          return tx.recording.create({
            data: {
              roomId: dbRoom.id,
              startedBy: uid,
              startedByName: getPlayerName(socket.id),
              targetUserId: data.targetUserId,
              targetName: getPlayerName(targetSocketId),
              title,
            },
          });
        }, { isolationLevel: 'Serializable' });
      } catch (e) {
        const isLockConflict = e instanceof Error && e.message === 'RECORDING_LOCK_HELD';
        const isSerializationFailure = !!e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2034';
        if (isLockConflict || isSerializationFailure) {
          socket.emit('admin:error', { message: 'A recording is already in progress in this room' });
          return;
        }
        throw e;
      }

      // Per-socket visibility (spec §7's explicit rule): only the target
      // (sees it on their own tile) and admin+ (see it on any relevant
      // target) ever receive this — a plain member's client never gets the
      // field at all, not even a hidden one, so there's nothing to find in
      // their network tab either.
      const roomSockets = io.sockets.adapter.rooms.get(room);
      if (roomSockets) {
        for (const sid of roomSockets) {
          const s = io.sockets.sockets.get(sid);
          const suid = (s?.data as { userId?: string })?.userId;
          if (!suid) continue;
          const isTarget = suid === data.targetUserId;
          const viewerRole = isTarget ? null : await resolveRole(prisma, suid, dbRoom.id, dbRoom.ownerId, dbRoom.organizationId);
          if (isTarget || (viewerRole && hasFeatureAccess(viewerRole, 'recording:start'))) {
            io.to(sid).emit(SocketEvents.RECORDING_STARTED, {
              recordingId: row.id,
              targetUserId: row.targetUserId,
              targetName: row.targetName,
              startedByName: row.startedByName,
              title: row.title,
            });
          }
        }
      }
      // QA (Data A/V checklist item 7) — genuinely room-wide, unlike the
      // per-socket loop above; see RECORDING_ACTIVE_CHANGED's own comment.
      io.to(room).emit(SocketEvents.RECORDING_ACTIVE_CHANGED, { active: true });
    } catch (e) {
      console.error('[recording] start error:', e);
    }
  });

  // Purely advisory — the actual MediaRecorder only exists in the starting
  // admin's own browser, so this just flags the row as wrapping up and
  // confirms only they (not some other admin) may do so.
  socket.on(SocketEvents.RECORDING_STOP, async (data: { recordingId: string }) => {
    const uid = socketToUid.get(socket.id); if (!uid || !data?.recordingId) return;
    try {
      const prisma = getPrisma();
      const row = await prisma.recording.findUnique({ where: { id: data.recordingId } });
      if (!row || row.startedBy !== uid) {
        socket.emit('admin:error', { message: 'Only the person who started this recording can stop it' });
        return;
      }
      await prisma.recording.update({ where: { id: row.id }, data: { status: 'processing' } });
    } catch (e) {
      console.error('[recording] stop error:', e);
    }
  });

  // A falsy/empty fileUrl means the client never actually captured
  // anything (e.g. it couldn't resolve a stream for the target — see
  // useScreenRecording.ts) rather than a completed upload; that still has
  // to release the one-recording-per-room lock, just as a "failed" instead
  // of "done", or the room would stay stuck until the starter disconnects.
  socket.on(SocketEvents.RECORDING_FINALIZE, async (data: { recordingId: string; fileUrl: string | null }) => {
    const room = socketToRoom.get(socket.id);
    const uid = socketToUid.get(socket.id);
    if (!room || !uid || !data?.recordingId) return;

    try {
      const prisma = getPrisma();
      const row = await prisma.recording.findUnique({ where: { id: data.recordingId } });
      if (!row || row.startedBy !== uid) return;

      if (!data.fileUrl) {
        await prisma.recording.update({ where: { id: row.id }, data: { status: 'failed', endedAt: new Date() } });
        io.to(room).emit(SocketEvents.RECORDING_FAILED, { recordingId: row.id, targetUserId: row.targetUserId });
        io.to(room).emit(SocketEvents.RECORDING_ACTIVE_CHANGED, { active: false });
        return;
      }

      // The upload itself already happened over POST /uploads/recording,
      // which only ever hands back a same-origin /api/uploads/<uuid>.webm
      // path — so anything else here is a client inventing a URL rather than
      // reporting one. Same guard, same reason, as channelChatHandler.ts's
      // isValidAttachmentUrl: an arbitrary URL stored on a Recording row is a
      // planted external URL wearing a recording's name.
      if (!isValidRecordingUrl(data.fileUrl)) {
        console.warn(`[recording] rejected finalize with non-upload fileUrl from user ${uid}`);
        return;
      }

      await prisma.recording.update({
        where: { id: row.id },
        data: {
          status: 'done',
          endedAt: new Date(),
          fileUrl: data.fileUrl,
          downloadExpiresAt: new Date(Date.now() + RECORDING_DOWNLOAD_TTL_MS),
          maxDownloads: RECORDING_MAX_DOWNLOADS,
        },
      });
      io.to(room).emit(SocketEvents.RECORDING_ENDED, { recordingId: row.id, targetUserId: row.targetUserId });
      io.to(room).emit(SocketEvents.RECORDING_ACTIVE_CHANGED, { active: false });
    } catch (e) {
      console.error('[recording] finalize error:', e);
    }
  });

  socket.on(SocketEvents.DISCONNECT, async () => {
    const room = socketToRoom.get(socket.id);
    const uid = socketToUid.get(socket.id);
    socketToUid.delete(socket.id);
    socketToRoom.delete(socket.id);
    if (!room || !uid) return;

    // The capture pipeline lives entirely in this browser tab — if it's
    // the one that started an in-progress recording, the recording is
    // genuinely gone, not just paused. Mark it failed rather than leaving
    // it stuck in "recording" forever (which would also keep tripping the
    // one-active-recording-per-room lock).
    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
      if (!dbRoom) return;
      const active = await prisma.recording.findFirst({ where: { roomId: dbRoom.id, startedBy: uid, status: { in: ['recording', 'processing'] } } });
      if (!active) return;
      await prisma.recording.update({ where: { id: active.id }, data: { status: 'failed', endedAt: new Date() } });
      io.to(room).emit(SocketEvents.RECORDING_FAILED, { recordingId: active.id, targetUserId: active.targetUserId });
      io.to(room).emit(SocketEvents.RECORDING_ACTIVE_CHANGED, { active: false });
    } catch (e) {
      console.error('[recording] disconnect cleanup error:', e);
    }
  });
}
