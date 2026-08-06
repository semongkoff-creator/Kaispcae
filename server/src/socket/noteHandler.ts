import { Server, Socket } from 'socket.io';
import { SocketEvents, DeskNoteData } from '@virtualmeet/shared';
import { getPrisma } from '../lib/prisma';
import { socketRateLimit } from '../middleware/rateLimit';
import { getPlayerName } from './roomHandler';
import { sanitizeChat } from '../middleware/validate';

const canSetNote = socketRateLimit(2); // max 2 write/delete calls/sec per socket
const NOTE_MAX_LENGTH = 300;

function toDeskNoteData(n: { furnitureId: string; authorUserId: string; authorName: string; text: string; updatedAt: Date }): DeskNoteData {
  return { furnitureId: n.furnitureId, authorUserId: n.authorUserId, authorName: n.authorName, text: n.text, updatedAt: n.updatedAt.getTime() };
}

// QA #7/#8/#9 — a sticky note "tempel" on a furniture piece. Not registered
// for guest sockets (see index.ts's registration list) — an unauthenticated
// visitor can read every note (delivered via ROOM_STATE.notes, no socket
// round trip needed) but can't write one, same posture as furniture
// assignment ('furniture:assign' requiring a real account).
export function registerNoteHandlers(io: Server, socket: Socket) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, (roomId: string) => {
    currentRoom = roomId || null;
  });

  // Creates OR edits — the server tells the difference by whether a row
  // already exists for this (room, furniture) pair. An existing note may
  // only be edited by its own author ("Pembuat edit/hapus; lain baca saja").
  socket.on(SocketEvents.NOTE_SET, async (data: { furnitureId: string; text: string }) => {
    if (!canSetNote(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const uid = (socket.data as { userId?: string }).userId;
    if (!uid) return;
    if (typeof data?.furnitureId !== 'string') return;
    const text = sanitizeChat(data?.text || '').slice(0, NOTE_MAX_LENGTH);
    if (!text) return;

    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room }, select: { id: true } });
      if (!dbRoom) return;

      const existing = await prisma.deskNote.findUnique({ where: { roomId_furnitureId: { roomId: dbRoom.id, furnitureId: data.furnitureId } } });
      if (existing && existing.authorUserId !== uid) {
        socket.emit('admin:error', { message: 'Catatan ini cuma bisa diedit oleh yang menulisnya' });
        return;
      }

      const authorName = getPlayerName(socket.id);
      const note = await prisma.deskNote.upsert({
        where: { roomId_furnitureId: { roomId: dbRoom.id, furnitureId: data.furnitureId } },
        create: { roomId: dbRoom.id, furnitureId: data.furnitureId, authorUserId: uid, authorName, text },
        update: { text, authorName },
      });
      io.to(room).emit(SocketEvents.NOTE_UPDATED, toDeskNoteData(note));
    } catch (e) {
      console.error('[note] set error:', e);
    }
  });

  socket.on(SocketEvents.NOTE_DELETE, async (data: { furnitureId: string }) => {
    if (!canSetNote(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const uid = (socket.data as { userId?: string }).userId;
    if (!uid || typeof data?.furnitureId !== 'string') return;

    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room }, select: { id: true } });
      if (!dbRoom) return;

      const existing = await prisma.deskNote.findUnique({ where: { roomId_furnitureId: { roomId: dbRoom.id, furnitureId: data.furnitureId } } });
      // Author-only, same "first-person only, no moderation here" posture
      // as FURNITURE_UNASSIGN.
      if (!existing || existing.authorUserId !== uid) return;

      await prisma.deskNote.delete({ where: { id: existing.id } });
      io.to(room).emit(SocketEvents.NOTE_DELETED, { furnitureId: data.furnitureId });
    } catch (e) {
      console.error('[note] delete error:', e);
    }
  });
}
