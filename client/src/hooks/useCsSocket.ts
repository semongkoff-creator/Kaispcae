import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { SocketEvents } from '@virtualmeet/shared';
import { SERVER_URL } from '@/services/serverUrl';

export interface CsReplyPayload {
  sessionId: string;
  from: 'admin';
  text: string;
  createdAt: string;
}

// Customer Service chat, Tahap 4 — a small, dedicated socket connection just
// for CS_REPLY, separate from useSocket.ts's room-scoped one (which simply
// doesn't exist outside a room — see CsChatWidget.tsx's own comment on why
// it can't reuse that connection). Opens once on mount and stays open for
// as long as the widget itself is mounted (Lobby or Game, wherever it's
// rendered from), not gated on the chat panel being visually open, so a
// reply is still noticed even while the panel is closed.
export function useCsSocket(onReply: (payload: CsReplyPayload) => void) {
  const [connected, setConnected] = useState(false);
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;

  useEffect(() => {
    const token = localStorage.getItem('vm_token');
    if (!token) return; // guest / not logged in — CS chat is real-accounts-only, see CsChatWidget.tsx

    const socket: Socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      auth: { token },
    });

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on(SocketEvents.CS_REPLY, (payload: CsReplyPayload) => onReplyRef.current(payload));

    return () => {
      socket.disconnect();
    };
  }, []);

  return { connected };
}
