import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { SocketEvents, AnalyticsActivityPayload } from '@kaispace/shared';
import { EmojiSmile, ChatDotsFill, PeopleFill, HandIndexThumb } from 'react-bootstrap-icons';
import { SERVER_URL } from '@/services/serverUrl';

const FEED_MAX = 50;
const ICON: Record<AnalyticsActivityPayload['type'], React.ReactNode> = {
  status_change: <EmojiSmile size={11} />,
  connection: <PeopleFill size={11} />,
  chat: <ChatDotsFill size={11} />,
  poke: <HandIndexThumb size={11} />,
};
const STATUS_LABEL: Record<string, string> = {
  available: 'available', focus: 'focus', in_meeting: 'meeting',
  busy: 'busy', away: 'away', wfh: 'WFH', wfo: 'WFO', wfa: 'WFA', lunch: 'lunch', break: 'break', cuti: 'cuti',
};

function describe(e: AnalyticsActivityPayload): string {
  switch (e.type) {
    case 'status_change': return `${e.userName} ganti status ke ${STATUS_LABEL[e.detail ?? ''] ?? e.detail}`;
    case 'connection': return `${e.userName} ngobrol dengan ${e.otherUserName ?? 'seseorang'}`;
    case 'chat': return `${e.userName} mengirim pesan`;
    case 'poke': return `${e.userName} colek ${e.otherUserName ?? 'seseorang'}`;
    default: return e.userName;
  }
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'baru saja';
  if (seconds < 60) return `${seconds}d lalu`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m lalu`;
}

// v2 Bagian B.2 #5 — Office Activity Feed. Deliberately its OWN, dedicated
// socket connection rather than threading the app's single game socket down
// through AdminConsole -> AnalyticsTiersPanel -> here (those components take
// no socket-related props today, and this panel isn't open often enough to
// justify that prop-drilling) — subscribes on mount, disconnects on unmount.
// NOT the same thing as client/src/components/ui/ActivityFeed.tsx, which is
// a public, room-scoped, every-player-sees-it HUD log derived from already
// room-wide broadcasts — this one is a private, manager-only, cross-room
// feed carried over its own targeted `analytics-feed:<managerId>` channel
// (see server/src/socket/analyticsFeed.ts), and only ever shows metadata
// (never chat text — Bagian A.4).
export function OfficeActivityFeed() {
  const [events, setEvents] = useState<AnalyticsActivityPayload[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('vm_token');
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'], auth: { token: token || undefined } });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit(SocketEvents.ANALYTICS_FEED_SUBSCRIBE);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on(SocketEvents.ANALYTICS_ACTIVITY, (payload: AnalyticsActivityPayload) => {
      setEvents((prev) => [payload, ...prev].slice(0, FEED_MAX));
    });

    return () => {
      socket.emit(SocketEvents.ANALYTICS_FEED_UNSUBSCRIBE);
      socket.disconnect();
    };
  }, []);

  return (
    <div>
      <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-1 flex items-center gap-1.5">
        Office Activity Feed
        <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-gray-300'}`} />
      </p>
      <p className="text-[11px] text-gray-400 mb-2">
        "Denyut" kantor secara live — hanya jenis kejadian, bukan isi pesan atau apa yang dilihat siapa.
      </p>
      <div className="max-h-56 overflow-y-auto bg-gray-50 dark:bg-gray-800 rounded-xl p-2 space-y-1">
        {events.length === 0 ? (
          <p className="text-xs text-gray-400 px-2 py-3 text-center">Belum ada kejadian sejak panel ini dibuka.</p>
        ) : (
          events.map((e, i) => (
            <div key={`${e.timestamp}-${i}`} className="flex items-center gap-2 px-2 py-1 text-xs">
              <span className="text-purple-500 shrink-0">{ICON[e.type]}</span>
              <span className="text-gray-600 dark:text-gray-300 flex-1 truncate">{describe(e)}</span>
              <span className="text-gray-400 text-[10px] shrink-0">{formatRelativeTime(e.timestamp)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
