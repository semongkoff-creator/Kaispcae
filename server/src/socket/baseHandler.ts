import { Server, Socket } from 'socket.io';
import { getPrisma } from '../lib/prisma';
import { PresenceUser } from '@virtualmeet/shared';
import { resolveBaseRole } from '../lib/baseAccess';


// Presence per base: socketId → who they are + which view/cell they're on.
interface PresenceEntry extends PresenceUser { socketId: string; baseId: string }
const presence = new Map<string, Map<string, PresenceEntry>>(); // baseId → (socketId → entry)

function baseRoom(baseId: string): string { return `base:${baseId}`; }

// Dedupe presence to one entry per user (latest cursor wins), for the avatar
// bar + per-cell edit outlines.
function presenceList(baseId: string): PresenceUser[] {
  const m = presence.get(baseId);
  if (!m) return [];
  const byUser = new Map<string, PresenceUser>();
  for (const e of m.values()) byUser.set(e.userId, { userId: e.userId, name: e.name, viewId: e.viewId, cursor: e.cursor });
  return Array.from(byUser.values());
}

function broadcastPresence(io: Server, baseId: string): void {
  io.to(baseRoom(baseId)).emit('base:presence', { type: 'presence', users: presenceList(baseId) });
}

export function registerBaseHandlers(io: Server, socket: Socket): void {
  const joined = new Set<string>();

  socket.on('base:join', async (baseId: string) => {
    const uid = (socket.data as { userId?: string }).userId;
    if (!uid || typeof baseId !== 'string') return;
    try {
      const role = await resolveBaseRole(getPrisma(), baseId, uid);
      if (!role) return; // no access → don't join the room
      const user = await getPrisma().user.findUnique({ where: { id: uid }, select: { displayName: true } });
      socket.join(baseRoom(baseId));
      socket.join(`user:${uid}`); // lets the mutations REST route exclude the actor's own sockets
      joined.add(baseId);
      if (!presence.has(baseId)) presence.set(baseId, new Map());
      presence.get(baseId)!.set(socket.id, { socketId: socket.id, baseId, userId: uid, name: user?.displayName ?? 'Seseorang' });
      broadcastPresence(io, baseId);
    } catch (e) { console.error('[base] join error:', e); }
  });

  socket.on('base:leave', (baseId: string) => {
    if (typeof baseId !== 'string') return;
    socket.leave(baseRoom(baseId));
    joined.delete(baseId);
    presence.get(baseId)?.delete(socket.id);
    broadcastPresence(io, baseId);
  });

  // Cursor / editing-cell presence — relayed so peers can outline the cell
  // someone else is editing with their name.
  socket.on('base:cursor', (data: { baseId: string; viewId?: string; recordId?: string; fieldId?: string }) => {
    const m = presence.get(data?.baseId);
    const entry = m?.get(socket.id);
    if (!entry) return;
    entry.viewId = data.viewId;
    entry.cursor = data.recordId && data.fieldId ? { recordId: data.recordId, fieldId: data.fieldId } : undefined;
    broadcastPresence(io, data.baseId);
  });

  socket.on('disconnect', () => {
    for (const baseId of joined) {
      presence.get(baseId)?.delete(socket.id);
      broadcastPresence(io, baseId);
    }
  });
}
