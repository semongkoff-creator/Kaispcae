import { useState, useRef, useEffect, useCallback } from 'react';
import { SendFill, Whatsapp } from 'react-bootstrap-icons';
import { api, CsMessage } from '@/services/api';
import { useCsSocket, CsReplyPayload } from '@/hooks/useCsSocket';

// Customer Service chat — Tahap 2 (bot FAQ), Tahap 3 (handoff to n8n),
// Tahap 4 (admin replies pushed live via useCsSocket's own dedicated
// connection — see that hook's comment for why it can't reuse
// useSocket.ts's room-scoped one). Originally its own floating button+panel
// (CsChatWidget.tsx); now embedded as a tab inside the existing ChatPanel
// instead of a second chat surface — same conversation logic, just a
// different container. Because ChatPanel only ever mounts inside a room
// (App.tsx's Game, never Lobby.tsx), Chat CS is no longer reachable from
// the Lobby — a deliberate tradeoff the product owner chose over keeping
// two separate chat entry points.
interface CsChatConversationProps {
  // Whether this tab is the one currently showing — gates the initial
  // session fetch (no point opening a session for a tab nobody's looking
  // at yet) and whether an incoming reply counts as "unread" for the
  // parent's tab badge instead of just appending silently.
  active: boolean;
  onUnread?: () => void;
}

export function CsChatConversation({ active, onUnread }: CsChatConversationProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<'bot' | 'human'>('bot');
  const [messages, setMessages] = useState<CsMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [offerAdmin, setOfferAdmin] = useState(false);
  // wa.me deep link — set whenever a message/handoff response includes one
  // (see routes/cs.ts's buildWhatsAppLink), cleared on the next send/handoff
  // so it only shows right after the trigger that produced it, same
  // lifecycle as offerAdmin above.
  const [waLink, setWaLink] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Refs so the socket's reply handler (registered once on mount, see
  // useCsSocket) always reads the LATEST sessionId/active state rather than
  // whatever they were at the moment the socket connected.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const activeRef = useRef(active);
  activeRef.current = active;

  const handleReply = useCallback((payload: CsReplyPayload) => {
    if (payload.sessionId !== sessionIdRef.current) return; // a reply for a different/older session — ignore
    setMessages((prev) => [...prev, { id: `admin-${payload.createdAt}`, from: payload.from, text: payload.text, createdAt: payload.createdAt }]);
    if (!activeRef.current) onUnread?.();
  }, [onUnread]);
  useCsSocket(handleReply);

  useEffect(() => {
    if (!active || sessionId) return;
    setLoading(true);
    setError(null);
    api.csOpenSession()
      .then((res) => {
        setSessionId(res.sessionId);
        setMode(res.mode);
        setMessages(res.messages);
      })
      .catch(() => setError('Gagal membuka Chat CS. Coba lagi.'))
      .finally(() => setLoading(false));
  }, [active, sessionId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, loading]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !sessionId || loading) return;
    setInput('');
    setLoading(true);
    setError(null);
    setOfferAdmin(false);
    setWaLink(null);
    const optimisticId = `local-${Date.now()}`;
    setMessages((prev) => [...prev, { id: optimisticId, from: 'user', text, createdAt: new Date().toISOString() }]);
    try {
      const res = await api.csSendMessage(sessionId, text);
      setMessages((prev) => {
        const withoutOptimistic = prev.filter((m) => m.id !== optimisticId);
        return [...withoutOptimistic, res.userMessage, ...(res.botMessage ? [res.botMessage] : [])];
      });
      setOfferAdmin(res.offerAdmin);
      setMode(res.mode);
      setWaLink(res.waLink);
    } catch {
      setError('Pesan gagal terkirim. Coba lagi.');
    } finally {
      setLoading(false);
    }
  }, [input, sessionId, loading]);

  const requestAdmin = useCallback(async () => {
    if (!sessionId || loading) return;
    setOfferAdmin(false);
    setWaLink(null);
    setLoading(true);
    setError(null);
    try {
      const res = await api.csHandoff(sessionId);
      setMode(res.mode);
      if (res.botMessage) setMessages((prev) => [...prev, res.botMessage!]);
      setWaLink(res.waLink);
    } catch {
      setError('Gagal menghubungkan ke admin. Coba lagi.');
    } finally {
      setLoading(false);
    }
  }, [sessionId, loading]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {mode === 'human' && (
        <div className="px-3 py-1.5 border-b border-purple-100 dark:border-gray-700 bg-green-50/60 dark:bg-green-900/20">
          <p className="text-[10px] text-green-600 dark:text-green-400 inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Terhubung dengan admin
          </p>
        </div>
      )}
      <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.from === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-xs leading-relaxed ${
                m.from === 'user'
                  ? 'bg-purple-600 text-white rounded-br-sm'
                  : m.from === 'admin'
                    ? 'bg-green-100 dark:bg-green-900/40 text-gray-800 dark:text-gray-100 rounded-bl-sm'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-100 rounded-bl-sm'
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 dark:bg-gray-700 rounded-2xl rounded-bl-sm px-3 py-1.5 text-xs text-gray-400">…</div>
          </div>
        )}
        {offerAdmin && (
          <div className="flex justify-start">
            <button
              onClick={requestAdmin}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded-full border border-purple-300 text-purple-600 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer disabled:opacity-50"
            >
              Hubungi admin
            </button>
          </div>
        )}
        {waLink && (
          <div className="flex justify-start">
            <a
              href={waLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-[#25D366] hover:bg-[#20bd5a] text-white font-medium cursor-pointer"
            >
              <Whatsapp size={13} /> Chat di WhatsApp
            </a>
          </div>
        )}
        {error && <p className="text-[11px] text-red-500 text-center">{error}</p>}
      </div>

      <div className="p-3 border-t border-purple-100 dark:border-gray-700 flex items-center gap-1.5 shrink-0">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder={mode === 'human' ? 'Tulis pesan untuk admin…' : 'Tulis pertanyaan…'}
          disabled={!sessionId || loading}
          maxLength={2000}
          className="flex-1 bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-xs rounded px-2 py-1.5 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500 disabled:opacity-60"
        />
        <button
          onClick={send}
          disabled={!input.trim() || !sessionId || loading}
          className="bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded cursor-pointer inline-flex items-center gap-1 shrink-0"
        >
          <SendFill size={11} />
        </button>
      </div>
    </div>
  );
}
