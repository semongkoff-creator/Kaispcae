import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { XLg, PlusLg, Paperclip, EmojiSmile, Search, SendFill, FileEarmarkFill, Download, TrashFill, PencilFill, PeopleFill } from 'react-bootstrap-icons';
import { ChannelMessage, Channel, DirectConversationSummary } from '@virtualmeet/shared';
import { api } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';
import { GroupMembers } from './GroupMembers';

// §Messenger — the full-screen chat surface, in the same "module panel over
// the room" shape Docs/Base/Calendar/Attendance already use (see App.tsx).
//
// This does NOT replace ChatPanel: that stays as the small in-game overlay for
// talking while you walk around, which is the thing a floating panel is
// actually good at. The two render the same store slices and go through the
// same useChannelChat hook, so a message sent in one appears in the other with
// no extra plumbing.

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // matches server/src/routes/uploads.ts
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|avi)$/i;
const COMMON_EMOJIS = ['😀', '😂', '❤️', '👍', '🔥', '🎉', '😢', '😡', '🤔', '👋', '💯', '✨'];

// Deterministic per-person avatar tint. Hashing the id (not the name) keeps a
// person's colour stable even if they rename themselves.
const AVATAR_TINTS = [
  'bg-rose-500', 'bg-orange-500', 'bg-amber-500', 'bg-lime-600',
  'bg-emerald-500', 'bg-teal-500', 'bg-sky-500', 'bg-indigo-500',
  'bg-violet-500', 'bg-fuchsia-500',
];

function tintFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Chat-list time formatting: today → clock, yesterday → "Kemarin", older →
// short date. Matches how a messenger's list column reads at a glance.
function listTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Kemarin';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Hari ini';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Kemarin';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

function Avatar({ name, seed, size = 40, square = false }: { name: string; seed: string; size?: number; square?: boolean }) {
  return (
    <div
      className={`${tintFor(seed)} ${square ? 'rounded-lg' : 'rounded-full'} flex items-center justify-center text-white font-semibold shrink-0 select-none`}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initialsOf(name)}
    </div>
  );
}

type Target = { type: 'channel' | 'dm'; id: string };

// One normalized shape for both channels and DMs so the list column renders
// from a single array instead of two near-identical branches.
interface Row {
  key: string;
  target: Target;
  title: string;
  seed: string;
  isChannel: boolean;
  preview: string;
  ts: number;
  unread: number;
}

interface MessengerAppProps {
  localUserId: string;
  // Creating a channel is an admin-only room-management action
  // ('channel:create', see shared/permissions.ts). The server enforces it
  // independently — this only decides whether the button is offered, the
  // same way ChatPanel's own "+" is gated.
  isAdmin?: boolean;
  // Needed to list the room's approved members in the group-members panel.
  roomSlug: string;
  onClose: () => void;
  channels: Channel[];
  dmConversations: DirectConversationSummary[];
  activeChatTarget: Target | null;
  onSelectTarget: (t: Target) => void;
  messages: ChannelMessage[];
  onSend: (text: string, parentId?: string, attachment?: { url: string; fileName: string }) => void;
  onTyping?: () => void;
  onDeleteMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string, text: string) => void;
  onLoadOlder: () => Promise<number>;
  onCreateChannel: (name: string) => Promise<Channel>;
}

export function MessengerApp({
  localUserId,
  isAdmin,
  roomSlug,
  onClose,
  channels,
  dmConversations,
  activeChatTarget,
  onSelectTarget,
  messages,
  onSend,
  onTyping,
  onDeleteMessage,
  onEditMessage,
  onLoadOlder,
  onCreateChannel,
}: MessengerAppProps) {
  const unreadByTarget = useGameStore((s) => s.unreadByTarget);
  const typingByTarget = useGameStore((s) => s.typingByTarget);
  const playerRecords = useGameStore((s) => s.playerRecords);

  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [attachError, setAttachError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const [showMembers, setShowMembers] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 1s tick so typing indicators lapse on their own — there's no explicit
  // "stopped typing" event, entries just pass their expiry.
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const rows = useMemo<Row[]>(() => {
    const channelRows: Row[] = channels.map((c) => ({
      key: `channel:${c.id}`,
      target: { type: 'channel' as const, id: c.id },
      title: c.name,
      seed: c.id,
      isChannel: true,
      preview: c.lastMessage ? `${c.lastMessage.senderName}: ${c.lastMessage.text}` : 'Belum ada pesan',
      ts: c.lastMessage?.createdAt ?? c.createdAt,
      unread: unreadByTarget[`channel:${c.id}`] ?? 0,
    }));
    const dmRows: Row[] = dmConversations.map((d) => ({
      key: `dm:${d.id}`,
      target: { type: 'dm' as const, id: d.id },
      title: d.otherUser.displayName,
      seed: d.otherUser.id,
      isChannel: false,
      preview: d.lastMessage ? d.lastMessage.text : 'Belum ada pesan',
      ts: d.lastMessage?.createdAt ?? d.createdAt,
      unread: unreadByTarget[`dm:${d.id}`] ?? 0,
    }));
    const all = [...channelRows, ...dmRows];
    const q = query.trim().toLowerCase();
    const filtered = q ? all.filter((r) => r.title.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q)) : all;
    // Most recent conversation first — the ordering every messenger uses, and
    // the reason lastMessage is fetched with the list rather than on open.
    return filtered.sort((a, b) => b.ts - a.ts);
  }, [channels, dmConversations, unreadByTarget, query]);

  const activeRow = activeChatTarget
    ? rows.find((r) => r.target.type === activeChatTarget.type && r.target.id === activeChatTarget.id)
      ?? {
        key: `${activeChatTarget.type}:${activeChatTarget.id}`,
        target: activeChatTarget,
        title: activeChatTarget.type === 'channel'
          ? channels.find((c) => c.id === activeChatTarget.id)?.name ?? 'Channel'
          : dmConversations.find((d) => d.id === activeChatTarget.id)?.otherUser.displayName ?? 'Chat',
        seed: activeChatTarget.id,
        isChannel: activeChatTarget.type === 'channel',
        preview: '',
        ts: 0,
        unread: 0,
      }
    : null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, activeChatTarget?.id]);

  // A fresh target starts out assuming there IS older history — otherwise
  // switching conversations would permanently hide "load older" after the
  // first one that ran out.
  useEffect(() => {
    setHasMoreOlder(true);
  }, [activeChatTarget?.type, activeChatTarget?.id]);

  const send = useCallback(() => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
    setShowEmoji(false);
  }, [text, onSend]);

  const handleFile = useCallback(
    async (file: File) => {
      setAttachError('');
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachError('File terlalu besar (maks 50MB).');
        return;
      }
      setUploading(true);
      try {
        const { url, fileName } = await api.uploadMedia(file);
        onSend('', undefined, { url, fileName });
      } catch (e) {
        console.error('[messenger] upload gagal:', e);
        setAttachError('Upload gagal — cek tipe filenya.');
      } finally {
        setUploading(false);
      }
    },
    [onSend]
  );

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMoreOlder) return;
    setLoadingOlder(true);
    try {
      const n = await onLoadOlder();
      if (!n) setHasMoreOlder(false);
    } finally {
      setLoadingOlder(false);
    }
  }, [onLoadOlder, loadingOlder, hasMoreOlder]);

  const createChannel = useCallback(async () => {
    const name = newChannelName.trim();
    if (!name) return;
    try {
      await onCreateChannel(name);
      setNewChannelName('');
      setShowNewChannel(false);
    } catch (e) {
      console.error('[messenger] gagal membuat channel:', e);
    }
  }, [newChannelName, onCreateChannel]);

  const typingNames = activeChatTarget
    ? Object.entries(typingByTarget[`${activeChatTarget.type}:${activeChatTarget.id}`] ?? {})
        .filter(([uid, until]) => uid !== localUserId && (until as number) > Date.now())
        .map(([uid]) => playerRecords[uid]?.name ?? 'Seseorang')
    : [];

  return (
    // pl-14 clears the room's Sidebar rail (z-50) — same as DocsApp,
    // BasesLauncher and AttendanceApp. Without it the rail sits on top of this
    // panel's own header and eats the "Chats" title.
    <div className="absolute inset-0 z-40 flex bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 overflow-hidden pl-14">
      {/* ── Kolom daftar percakapan ───────────────────────────────── */}
      <aside className="w-[300px] shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col bg-gray-50 dark:bg-gray-850">
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-semibold">Chats</h1>
            {isAdmin && (
              <button
                onClick={() => setShowNewChannel((v) => !v)}
                title="Channel baru"
                className="w-7 h-7 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 inline-flex items-center justify-center text-gray-600 dark:text-gray-300"
              >
                <PlusLg size={15} />
              </button>
            )}
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari"
              className="w-full pl-8 pr-3 py-1.5 rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm outline-none focus:border-indigo-400"
            />
          </div>
          {showNewChannel && isAdmin && (
            <div className="mt-2 flex gap-1.5">
              <input
                autoFocus
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createChannel()}
                placeholder="nama-channel"
                className="flex-1 min-w-0 px-2 py-1.5 rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm outline-none focus:border-indigo-400"
              />
              <button onClick={createChannel} className="px-2.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm">
                Buat
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto pb-2">
          {rows.length === 0 && (
            <p className="px-4 py-6 text-sm text-gray-400 text-center">Tidak ada percakapan.</p>
          )}
          {rows.map((r) => {
            const active = activeChatTarget?.type === r.target.type && activeChatTarget?.id === r.target.id;
            return (
              <button
                key={r.key}
                onClick={() => onSelectTarget(r.target)}
                className={`w-full text-left px-3 py-2.5 flex gap-2.5 items-start transition-colors ${
                  active ? 'bg-indigo-50 dark:bg-indigo-950/40' : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                {r.isChannel ? (
                  <div className="w-10 h-10 rounded-lg bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-300 shrink-0 font-semibold text-sm">
                    #
                  </div>
                ) : (
                  <Avatar name={r.title} seed={r.seed} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-sm truncate flex-1">{r.title}</span>
                    <span className="text-[11px] text-gray-400 shrink-0">{listTime(r.ts)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-gray-500 dark:text-gray-400 truncate flex-1">{r.preview}</span>
                    {r.unread > 0 && (
                      <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold inline-flex items-center justify-center shrink-0">
                        {r.unread > 99 ? '99+' : r.unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* ── Panel percakapan ──────────────────────────────────────── */}
      <section className="flex-1 flex flex-col min-w-0 relative">
        <header className="h-14 shrink-0 px-4 flex items-center gap-3 border-b border-gray-200 dark:border-gray-700">
          {activeRow ? (
            <>
              {activeRow.isChannel ? (
                <div className="w-8 h-8 rounded-lg bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-300 font-semibold text-xs">
                  #
                </div>
              ) : (
                <Avatar name={activeRow.title} seed={activeRow.seed} size={32} />
              )}
              <div className="min-w-0">
                <h2 className="font-semibold text-sm truncate">{activeRow.title}</h2>
                {typingNames.length > 0 && (
                  <p className="text-[11px] text-indigo-500 truncate">
                    {typingNames.slice(0, 2).join(', ')} sedang mengetik…
                  </p>
                )}
              </div>
            </>
          ) : (
            <h2 className="font-semibold text-sm text-gray-400">Pilih percakapan</h2>
          )}
          <div className="ml-auto flex items-center gap-1">
            {activeRow?.isChannel && (
              <button
                onClick={() => setShowMembers((v) => !v)}
                title="Anggota grup"
                className={`text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md mr-1 ${
                  showMembers
                    ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-300'
                    : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
              >
                <PeopleFill size={12} /> Anggota
              </button>
            )}
            <button
              onClick={onClose}
              title="Tutup"
              className="w-8 h-8 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 inline-flex items-center justify-center text-gray-500"
            >
              <XLg size={15} />
            </button>
          </div>
        </header>

        {!activeChatTarget ? (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
            Pilih percakapan di sebelah kiri untuk mulai.
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-4 bg-gray-50/60 dark:bg-gray-900">
              {hasMoreOlder && messages.length > 0 && (
                <div className="text-center mb-4">
                  <button
                    onClick={loadOlder}
                    disabled={loadingOlder}
                    className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50"
                  >
                    {loadingOlder ? 'Memuat…' : 'Muat pesan lama'}
                  </button>
                </div>
              )}
              {messages.length === 0 && (
                <p className="text-center text-sm text-gray-400 mt-10">Belum ada pesan. Mulai percakapan.</p>
              )}
              {messages.map((m, i) => {
                const own = m.senderId === localUserId;
                const prev = messages[i - 1];
                // Group consecutive messages from one person: only the first
                // carries an avatar and name, the rest just stack. Same reason
                // a messenger does it — a wall of repeated names is noise.
                const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
                const grouped = !newDay && prev?.senderId === m.senderId && m.createdAt - prev.createdAt < 5 * 60 * 1000;
                return (
                  <div key={m.id}>
                    {newDay && (
                      <div className="flex items-center justify-center my-4">
                        <span className="text-[11px] text-gray-400 bg-gray-100 dark:bg-gray-800 px-2.5 py-1 rounded-full">
                          {dayLabel(m.createdAt)}
                        </span>
                      </div>
                    )}
                    <div className={`flex gap-2.5 ${own ? 'flex-row-reverse' : ''} ${grouped ? 'mt-0.5' : 'mt-3'}`}>
                      <div className="w-8 shrink-0">
                        {!grouped && <Avatar name={m.senderName} seed={m.senderId} size={32} />}
                      </div>
                      <div className={`max-w-[min(560px,70%)] min-w-0 ${own ? 'items-end' : 'items-start'} flex flex-col`}>
                        {!grouped && (
                          <span className={`text-[11px] text-gray-400 mb-1 px-1 ${own ? 'text-right' : ''}`}>
                            {own ? 'Kamu' : m.senderName} · {new Date(m.createdAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                        <div className="group relative">
                          {editingId === m.id ? (
                            <div className="flex gap-1.5">
                              <input
                                autoFocus
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    const t = editText.trim();
                                    if (t) onEditMessage?.(m.id, t);
                                    setEditingId(null);
                                  }
                                  if (e.key === 'Escape') setEditingId(null);
                                }}
                                className="px-3 py-2 rounded-2xl border border-indigo-300 text-sm outline-none dark:bg-gray-800"
                              />
                              <button onClick={() => setEditingId(null)} className="text-xs text-gray-400 hover:underline">
                                batal
                              </button>
                            </div>
                          ) : (
                            <div
                              className={`px-3.5 py-2 rounded-2xl text-sm break-words whitespace-pre-wrap ${
                                own
                                  ? 'bg-indigo-500 text-white rounded-br-md'
                                  : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-bl-md'
                              }`}
                            >
                              {m.attachmentUrl && <MessageAttachment url={m.attachmentUrl} name={m.attachmentName} own={own} />}
                              {m.text}
                            </div>
                          )}
                          {own && editingId !== m.id && (
                            <div className={`absolute top-1/2 -translate-y-1/2 ${own ? 'right-full mr-1.5' : 'left-full ml-1.5'} hidden group-hover:flex gap-0.5`}>
                              {m.text && (
                                <button
                                  onClick={() => { setEditingId(m.id); setEditText(m.text); }}
                                  title="Edit"
                                  className="w-6 h-6 rounded hover:bg-gray-200 dark:hover:bg-gray-700 inline-flex items-center justify-center text-gray-400"
                                >
                                  <PencilFill size={10} />
                                </button>
                              )}
                              <button
                                onClick={() => onDeleteMessage?.(m.id)}
                                title="Hapus"
                                className="w-6 h-6 rounded hover:bg-red-100 dark:hover:bg-red-900/40 inline-flex items-center justify-center text-gray-400 hover:text-red-500"
                              >
                                <TrashFill size={10} />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {/* ── Composer ───────────────────────────────────────── */}
            <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 px-4 py-3">
              {attachError && <p className="text-xs text-red-500 mb-1.5">{attachError}</p>}
              {showEmoji && (
                <div className="mb-2 flex flex-wrap gap-1 p-2 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                  {COMMON_EMOJIS.map((e) => (
                    <button
                      key={e}
                      onClick={() => setText((t) => t + e)}
                      className="w-7 h-7 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-base"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2 rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 focus-within:border-indigo-400 bg-white dark:bg-gray-800">
                <button
                  onClick={() => setShowEmoji((v) => !v)}
                  title="Emoji"
                  className="w-7 h-7 rounded hover:bg-gray-100 dark:hover:bg-gray-700 inline-flex items-center justify-center text-gray-400 shrink-0"
                >
                  <EmojiSmile size={15} />
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  title="Lampirkan file"
                  className="w-7 h-7 rounded hover:bg-gray-100 dark:hover:bg-gray-700 inline-flex items-center justify-center text-gray-400 shrink-0 disabled:opacity-50"
                >
                  <Paperclip size={15} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFile(f);
                    e.target.value = '';
                  }}
                />
                <textarea
                  rows={1}
                  value={text}
                  onChange={(e) => { setText(e.target.value); onTyping?.(); }}
                  onKeyDown={(e) => {
                    // Enter sends, Shift+Enter breaks the line — the
                    // convention every messenger uses.
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={activeRow ? `Kirim pesan ke ${activeRow.title}` : 'Pilih percakapan'}
                  className="flex-1 min-w-0 resize-none bg-transparent text-sm outline-none py-1 max-h-32"
                />
                <button
                  onClick={send}
                  disabled={!text.trim() || uploading}
                  className="w-8 h-8 rounded-lg bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 disabled:hover:bg-indigo-500 text-white inline-flex items-center justify-center shrink-0"
                >
                  <SendFill size={13} />
                </button>
              </div>
              {uploading && <p className="text-xs text-gray-400 mt-1.5">Mengunggah…</p>}
            </div>
          </>
        )}
        {showMembers && activeRow?.isChannel && activeChatTarget && (
          <GroupMembers
            channelId={activeChatTarget.id}
            roomSlug={roomSlug}
            channelName={activeRow.title}
            canManage={!!isAdmin}
            onClose={() => setShowMembers(false)}
          />
        )}
      </section>
    </div>
  );
}

// Images and videos render inline; anything else gets a download row. Mirrors
// ChatPanel's ChatAttachment — same allowlist, same reasoning about what a
// browser can safely display inline (see server/src/routes/uploads.ts).
function MessageAttachment({ url, name, own }: { url: string; name?: string; own: boolean }) {
  if (IMAGE_EXT_RE.test(url)) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block mb-1.5">
        <img src={url} alt={name ?? 'lampiran'} className="max-w-full max-h-72 rounded-lg" />
      </a>
    );
  }
  if (VIDEO_EXT_RE.test(url)) {
    return <video src={url} controls className="max-w-full max-h-72 rounded-lg mb-1.5" />;
  }
  return (
    <a
      href={url}
      download={name}
      className={`flex items-center gap-2 mb-1.5 px-2.5 py-2 rounded-lg ${
        own ? 'bg-indigo-400/40' : 'bg-gray-100 dark:bg-gray-700'
      }`}
    >
      <FileEarmarkFill size={18} className="shrink-0" />
      <span className="text-xs truncate flex-1">{name ?? 'Lampiran'}</span>
      <Download size={13} className="shrink-0" />
    </a>
  );
}
