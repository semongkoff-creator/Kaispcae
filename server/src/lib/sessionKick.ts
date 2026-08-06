import { Server } from 'socket.io';
import { SESSION_SUPERSEDED, SESSION_SUPERSEDED_MESSAGE } from '../middleware/auth';

// Bug 1 — server-initiated disconnect of a user's OTHER live sockets the moment
// a new login supersedes them, so the old device is kicked immediately instead
// of only failing on its next request. The new device connects its own socket
// afterward (with the fresh sessionId), so it's never caught here.
let ioRef: Server | null = null;

export function setSessionKickIo(io: Server): void {
  ioRef = io;
}

export function disconnectUserSockets(userId: string, keepSessionId?: string): void {
  if (!ioRef) return;
  for (const [, socket] of ioRef.sockets.sockets) {
    if (socket.data?.userId === userId && socket.data?.sessionId !== keepSessionId) {
      // Emit first so the client can show a clear message, then disconnect.
      socket.emit(SESSION_SUPERSEDED, { message: SESSION_SUPERSEDED_MESSAGE });
      socket.disconnect(true);
    }
  }
}

// A voluntary logout (auth.ts's /auth/logout) also needs to kick this
// user's live sockets — the token it just invalidated may still be sitting
// in an open tab's memory — but WITHOUT the SESSION_SUPERSEDED message
// above: that copy is specifically "you got logged in elsewhere", which
// would read as a confusing non-sequitur on a logout the user asked for
// themselves. Silent disconnect only.
export function disconnectUserSocketsSilently(userId: string): void {
  if (!ioRef) return;
  for (const [, socket] of ioRef.sockets.sockets) {
    if (socket.data?.userId === userId) socket.disconnect(true);
  }
}
