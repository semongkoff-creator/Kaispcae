import { Server, Socket } from 'socket.io';
import { SocketEvents, CsReplyPayload } from '@virtualmeet/shared';

// Customer Service chat, Tahap 4 — tracks which live socket(s) belong to
// which real user, purely so an admin reply arriving via POST /api/cs/reply
// has somewhere to be pushed. Deliberately NOT reusing roomHandler.ts's own
// userSocketMap: that one only ever holds a socket AFTER JOIN_ROOM admits it
// (see roomHandler.ts), so a user sitting in the Lobby with CsChatWidget's
// own dedicated connection open — never having joined a room at all — would
// be invisible to it. This map is keyed off socket.data.userId alone, set
// by index.ts's io.use() auth middleware on EVERY authenticated connection
// regardless of room. A Set per user, not a single value, since the widget
// can be open in more than one tab at once — a reply should reach all of
// them, not just whichever connected most recently.
const csUserSocketMap = new Map<string, Set<string>>();

export function registerCsHandlers(io: Server, socket: Socket): void {
  const userId = (socket.data as { userId?: string }).userId;
  if (!userId) return; // guest or unauthenticated — CS chat is real-accounts-only, see CsChatWidget.tsx

  if (!csUserSocketMap.has(userId)) csUserSocketMap.set(userId, new Set());
  csUserSocketMap.get(userId)!.add(socket.id);

  socket.on(SocketEvents.DISCONNECT, () => {
    const sockets = csUserSocketMap.get(userId);
    if (!sockets) return;
    sockets.delete(socket.id);
    if (sockets.size === 0) csUserSocketMap.delete(userId);
  });
}

// Called from routes/cs.ts once a POST /api/cs/reply's token is verified
// and the session's owning userId resolved. A no-op if that user has no
// live socket right now — the reply is already safely stored (see
// routes/cs.ts), so their next GET/open just picks it up instead of it
// being lost outright.
export function pushCsReply(io: Server, userId: string, payload: CsReplyPayload): void {
  const socketIds = csUserSocketMap.get(userId);
  if (!socketIds) return;
  for (const socketId of socketIds) {
    io.to(socketId).emit(SocketEvents.CS_REPLY, payload);
  }
}
