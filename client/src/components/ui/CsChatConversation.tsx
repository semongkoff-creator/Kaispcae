import { useState, useRef, useEffect, useCallback } from 'react';
import { SendFill, Whatsapp } from 'react-bootstrap-icons';
import { api, CsMessage } from '@/services/api';
import { Tooltip } from '@/components/ui/Tooltip';

// Customer Service chat — bot FAQ (server/src/data/csFaq.ts, sourced from
// docs/KB-FAQ-KaiSpace.docx) plus a "Hubungi admin" handoff that opens a
// wa.me deep link. Originally its own floating button+panel
// (CsChatWidget.tsx); now embedded as a tab inside the existing ChatPanel
// instead of a second chat surface — same conversation logic, just a
// different container. Because ChatPanel only ever mounts inside a room
// (App.tsx's Game, never Lobby.tsx), Chat CS is no longer reachable from
// the Lobby — a deliberate tradeoff the product owner chose over keeping
// two separate chat entry points.
interface CsChatConversationProps {
  // Whether this tab is the one currently showing — gates the initial
  // session fetch (no point opening a session for a tab nobody's looking
  // at yet).
  active: boolean;
}

export function CsChatConversation({ active }: CsChatConversationProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
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

  useEffect(() => {
    if (!active || sessionId) return;
    setLoading(true);
    setError(null);
    api.csOpenSession()
      .then((res) => {
        setSessionId(res.sessionId);
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
      <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.from === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] min-w-0 rounded-2xl px-3 py-1.5 text-xs leading-relaxed whitespace-pre-line break-words select-text ${
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
            <Tooltip label="Hubungi Admin" detail="Dapatkan link WhatsApp untuk chat langsung dengan tim kami.">
              <button
                onClick={requestAdmin}
                disabled={loading}
                className="text-xs px-3 py-1.5 rounded-full border border-purple-300 text-purple-600 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer disabled:opacity-50"
              >
                Hubungi admin
              </button>
            </Tooltip>
          </div>
        )}
        {waLink && (
          <div className="flex justify-start">
            <Tooltip label="Chat di WhatsApp" detail="Buka WhatsApp untuk lanjut ngobrol dengan admin.">
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-[#25D366] hover:bg-[#20bd5a] text-white font-medium cursor-pointer"
              >
                <Whatsapp size={13} /> Chat di WhatsApp
              </a>
            </Tooltip>
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
          placeholder="Tulis pertanyaan…"
          disabled={!sessionId || loading}
          maxLength={2000}
          className="flex-1 bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-xs rounded px-2 py-1.5 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500 disabled:opacity-60"
        />
        <Tooltip label="Kirim" detail="Kirim pertanyaanmu." wrapperClassName="shrink-0">
          <button
            onClick={send}
            disabled={!input.trim() || !sessionId || loading}
            className="bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded cursor-pointer inline-flex items-center gap-1 shrink-0"
          >
            <SendFill size={11} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
