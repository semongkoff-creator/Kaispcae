import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { XLg, PlusLg, EmojiSmile, Search, SendFill, FileEarmarkFill, Download, TrashFill, PencilFill, PeopleFill, PlayCircleFill, ExclamationTriangleFill } from 'react-bootstrap-icons';
import { ChannelMessage, Channel, DirectConversationSummary } from '@virtualmeet/shared';
import { api } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';
import { GroupMembers } from './GroupMembers';
import { useProfiles } from '@/hooks/useProfiles';
import { AttachmentLightbox, type LightboxTarget } from '@/components/ui/AttachmentLightbox';
import { AttachmentMenuButton } from '@/components/ui/AttachmentMenuButton';

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

function Avatar({ name, seed, size = 40, square = false, photoUrl }: { name: string; seed: string; size?: number; square?: boolean; photoUrl?: string }) {
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name}
        className={`${square ? 'rounded-lg' : 'rounded-full'} object-cover shrink-0`}
        style={{ width: size, height: size }}
      />
    );
  }
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

  // Bug 8 — resolve each sender's CURRENT name/photo by senderId (one batched,
  // per-session-cached lookup) so old messages show the sender's latest
  // identity, not the senderName snapshot stored on the message.
  const profileByUser = useProfiles(
    Array.from(new Set(messages.map((m) => m.senderId).filter(Boolean))),
  );

  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // Bug 10 — attachment preview opens in this in-app lightbox, not a new tab.
  const [lightbox, setLightbox] = useState<LightboxTarget | null>(null);
  const [uploading, setUploading] = useState(false);
  const [attachError, setAttachError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const [showMembers, setShowMembers] = useState(false);
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
                // Bug 8 — current name/photo by id, snapshot senderName only as fallback.
                const senderProfile = profileByUser.get(m.senderId);
                const senderName = senderProfile?.name || m.senderName;
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
                        {!grouped && <Avatar name={senderName} seed={m.senderId} size={32} photoUrl={senderProfile?.photo ?? undefined} />}
                      </div>
                      <div className={`max-w-[min(560px,70%)] min-w-0 ${own ? 'items-end' : 'items-start'} flex flex-col`}>
                        {!grouped && (
                          <span className={`text-[11px] text-gray-400 mb-1 px-1 ${own ? 'text-right' : ''}`}>
                            {own ? 'Kamu' : senderName} · {new Date(m.createdAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
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
                              {m.attachmentUrl && <MessageAttachment url={m.attachmentUrl} name={m.attachmentName} own={own} onOpen={setLightbox} />}
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
                <AttachmentMenuButton
                  onFile={(f) => void handleFile(f)}
                  disabled={uploading}
                  title="Lampirkan file"
                  iconSize={15}
                  buttonClassName="w-7 h-7 rounded hover:bg-gray-100 dark:hover:bg-gray-700 inline-flex items-center justify-center text-gray-400 shrink-0 disabled:opacity-50"
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
      {lightbox && <AttachmentLightbox target={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

// Bug 10 — clicking an attachment opens the shared in-app lightbox (onOpen)
// instead of a new tab. Mirrors ChatPanel's ChatAttachment — same allowlist,
// same reasoning about what a browser can display inline (see uploads.ts).

// Bug 3 — mirrors ChatPanel.tsx's ImageThumb: a bare <img> showed nothing
// while loading and fell through to the browser's own broken-image icon on
// failure, reading as "you have to open/download this to see what it is".
// Sized a bit larger than ChatPanel's version (this surface has more room)
// but otherwise identical — fixed box + object-cover so the loading/failed
// states have somewhere stable to center in, same tradeoff ChatPanel's
// version documents. Corner download button is a sibling of the
// open-lightbox button, never nested — nesting <a>/<button> inside a
// <button> is invalid HTML with inconsistent cross-browser behavior.
function ImageThumb({ url, name, onOpen }: { url: string; name?: string; onOpen: () => void }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  return (
    <div className="relative mb-1.5 w-48 h-36 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-700">
      {state !== 'failed' && (
        <button type="button" onClick={onOpen} title={name} className="block w-full h-full cursor-pointer">
          <img
            src={url}
            alt={name ?? 'lampiran'}
            onLoad={() => setState('loaded')}
            onError={() => setState('failed')}
            className={`w-full h-full object-cover transition-opacity ${state === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
          />
        </button>
      )}
      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="w-6 h-6 rounded-full border-2 border-gray-300 dark:border-gray-500 border-t-transparent animate-spin" />
        </div>
      )}
      {state === 'failed' && (
        <button
          type="button"
          onClick={onOpen}
          title="Gagal dimuat — klik untuk detail/unduh"
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-2 text-center cursor-pointer"
        >
          <ExclamationTriangleFill size={20} className="text-amber-500" />
          <span className="text-[10px] text-gray-500 dark:text-gray-400 leading-tight">Gagal dimuat</span>
        </button>
      )}
      {state === 'loaded' && (
        <a
          href={url}
          download={name}
          onClick={(e) => e.stopPropagation()}
          title="Unduh"
          className="absolute bottom-1.5 right-1.5 w-6 h-6 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center cursor-pointer"
        >
          <Download size={12} />
        </a>
      )}
    </div>
  );
}

function MessageAttachment({ url, name, own, onOpen }: { url: string; name?: string; own: boolean; onOpen: (t: LightboxTarget) => void }) {
  const open = () => onOpen({ url, fileName: name });
  // Bug 17 — detect by the original FILENAME first; Drive attachments have an
  // extension-less proxy URL (/api/files/<token>).
  const probe = name || url;
  if (IMAGE_EXT_RE.test(probe)) {
    return <ImageThumb url={url} name={name} onOpen={open} />;
  }
  if (VIDEO_EXT_RE.test(probe)) {
    return (
      <button type="button" onClick={open} className="relative block mb-1.5 cursor-pointer">
        <video src={url} muted preload="metadata" className="max-w-full max-h-72 rounded-lg bg-black pointer-events-none" />
        <span className="absolute inset-0 flex items-center justify-center">
          <PlayCircleFill size={40} className="text-white/90 drop-shadow" />
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={open}
      className={`flex items-center gap-2 mb-1.5 px-2.5 py-2 rounded-lg w-full text-left cursor-pointer ${
        own ? 'bg-indigo-400/40' : 'bg-gray-100 dark:bg-gray-700'
      }`}
    >
      <FileEarmarkFill size={18} className="shrink-0" />
      <span className="text-xs truncate flex-1">{name ?? 'Lampiran'}</span>
      <Download size={13} className="shrink-0" />
    </button>
  );
}
