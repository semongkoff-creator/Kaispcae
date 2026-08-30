import { Server, Socket } from 'socket.io';
import { SocketEvents, DeskNoteData } from '@kaispace/shared';
import { getPrisma } from '../lib/prisma';
import { socketRateLimit } from '../middleware/rateLimit';
import { getPlayerName } from './roomHandler';
import { sanitizeChat } from '../middleware/validate';

const canWriteNote = socketRateLimit(2); // max 2 add/edit/delete calls/sec per socket
const NOTE_MAX_LENGTH = 300;

function toDeskNoteData(n: { id: string; x: number; y: number; authorUserId: string; authorName: string; text: string; updatedAt: Date }): DeskNoteData {
  return { id: n.id, x: n.x, y: n.y, authorUserId: n.authorUserId, authorName: n.authorName, text: n.text, updatedAt: n.updatedAt.getTime() };
}

// QA #7/#8/#9 — a sticky note placed on the map, same "Add Media" flow as
// image/whiteboard/file (lands at the player's current tile — see
// AddMediaPanel.tsx). Not registered for guest sockets (see index.ts's
// registration list) — an unauthenticated visitor can read every note
// (delivered via ROOM_STATE.notes, no socket round trip needed) but can't
// place or edit one, same posture as furniture assignment/media add.
export function registerNoteHandlers(io: Server, socket: Socket) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string) => {
    const slug = roomId || null;
    if (!slug) { currentRoom = null; return; }
    // Multi-tenant Fase 3 — this module registers its own independent
    // JOIN_ROOM listener (see mediaHandler.ts's comment on why roomHandler.ts
    // rejecting a cross-org join doesn't stop this one from also running).
    try {
      const room = await getPrisma().room.findUnique({ where: { slug }, select: { organizationId: true } });
      if (!room || room.organizationId !== (socket.data as { organizationId?: string }).organizationId) { currentRoom = null; return; }
    } catch (e) {
      console.error('[note] org check failed:', e);
      currentRoom = null;
      return;
    }
    currentRoom = slug;
  });

  socket.on(SocketEvents.NOTE_ADD, async (data: { x: number; y: number; text: string }) => {
    if (!canWriteNote(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const uid = (socket.data as { userId?: string }).userId;
    if (!uid) return;
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number' || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
    const text = sanitizeChat(data?.text || '').slice(0, NOTE_MAX_LENGTH);
    if (!text) return;

    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room }, select: { id: true } });
      if (!dbRoom) return;

      // specs/2026-08-21-room-entry-name-prompt-design.md — final-review
      // fix (round 2): authorName is a persisted, DB-visible attribution
      // read by everyone who ever sees this note, forever — it must be the
      // real account name, not whatever room-entry nametag the author
      // happened to be using at that moment (getPlayerName(socket.id) now
      // returns that room-entry name, since JOIN_ROOM's displayName carries
      // it — see App.tsx's authDisplayName). Falls back to getPlayerName
      // only if the DB lookup somehow fails (e.g. the user row vanished
      // mid-request) — same graceful-degradation posture as other
      // best-effort name resolutions in this codebase.
      const authorUser = await prisma.user.findUnique({ where: { id: uid }, select: { displayName: true } });
      const authorName = authorUser?.displayName || getPlayerName(socket.id);
      const note = await prisma.deskNote.create({
        data: { roomId: dbRoom.id, x: Math.round(data.x), y: Math.round(data.y), authorUserId: uid, authorName, text },
      });
      io.to(room).emit(SocketEvents.NOTE_ADDED, toDeskNoteData(note));
    } catch (e) {
      console.error('[note] add error:', e);
    }
  });

  // Author-only — "Pembuat edit/hapus; lain baca saja."
  socket.on(SocketEvents.NOTE_EDIT, async (data: { id: string; text: string }) => {
    if (!canWriteNote(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const uid = (socket.data as { userId?: string }).userId;
    if (!uid || typeof data?.id !== 'string') return;
    const text = sanitizeChat(data?.text || '').slice(0, NOTE_MAX_LENGTH);
    if (!text) return;

    try {
      const prisma = getPrisma();
      const existing = await prisma.deskNote.findUnique({ where: { id: data.id } });
      if (!existing || existing.authorUserId !== uid) {
        socket.emit('admin:error', { message: 'Catatan ini cuma bisa diedit oleh yang menulisnya' });
        return;
      }
      const note = await prisma.deskNote.update({ where: { id: data.id }, data: { text } });
      io.to(room).emit(SocketEvents.NOTE_UPDATED, toDeskNoteData(note));
    } catch (e) {
      console.error('[note] edit error:', e);
    }
  });

  socket.on(SocketEvents.NOTE_DELETE, async (data: { id: string }) => {
    if (!canWriteNote(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const uid = (socket.data as { userId?: string }).userId;
    if (!uid || typeof data?.id !== 'string') return;

    try {
      const prisma = getPrisma();
      const existing = await prisma.deskNote.findUnique({ where: { id: data.id } });
      // Author-only, no admin override — same posture as furniture
      // unassignment ("first-person only, no moderation here").
      if (!existing || existing.authorUserId !== uid) return;

      await prisma.deskNote.delete({ where: { id: data.id } });
      io.to(room).emit(SocketEvents.NOTE_DELETED, { id: data.id });
    } catch (e) {
      console.error('[note] delete error:', e);
    }
  });
}
