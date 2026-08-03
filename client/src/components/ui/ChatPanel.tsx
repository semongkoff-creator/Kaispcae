import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { ChatDotsFill, LockFill, EmojiSmile, PlusLg, ChatLeftText, FileEarmarkFill, Download, TrashFill, PencilFill, PlayCircleFill, ExclamationTriangleFill, ArrowClockwise } from 'react-bootstrap-icons';
import { ChatMessage, ChannelMessage, Channel, DirectConversationSummary, EmoteType } from '@virtualmeet/shared';
import { api } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';
import { ChatAvatar, avatarColor } from './ChatAvatar';
import { AttachmentLightbox, type LightboxTarget } from './AttachmentLightbox';
import { AttachmentMenuButton } from './AttachmentMenuButton';
import { useProfiles } from '@/hooks/useProfiles';
import { textMentionsUser, renderWithMentions } from '@/utils/mentions';

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // matches server/src/routes/uploads.ts's multer limit
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|avi)$/i;

function isImageAttachment(url: string): boolean {
  return IMAGE_EXT_RE.test(url);
}

function isVideoAttachment(url: string): boolean {
  return VIDEO_EXT_RE.test(url);
}

const COMMON_EMOJIS = ['😀','😂','❤️','👍','🔥','🎉','😢','😡','🤔','👋','💯','✨'];

interface ChatPanelProps {
  localPlayerName: string;
  localUserId: string;
  onBubble: (text: string) => void;
  onEmote: (emote: EmoteType) => void;
  // When set, the local player is standing inside a zone that has its own
  // private chat — a "Private" pill appears automatically while true and
  // disappears once they leave (falling back to the last channel/DM).
  currentZone?: { id: string; name: string } | null;
  zoneMessages?: ChatMessage[];
  // Potongan C3 — attachmentUrl/attachmentName are set for a file share
  // (text is '' in that case, same convention as the persisted onSend below).
  onSendZone?: (text: string, zoneId: string, attachmentUrl?: string, attachmentName?: string) => void;
  // Needed here (not just in useChannelChat) because zone-chat file uploads
  // are done directly in this component — see handleAttachFile — rather
  // than through a hook, matching how zone chat's send path already lives
  // in App.tsx rather than useChannelChat.ts.
  roomSlug: string;
  // Only admins can pin a message as the room's Notice banner — the
  // server re-checks this independently (see roomHandler.ts's NOTICE_PIN
  // handler), this just decides whether the option is offered at all.
  isAdmin?: boolean;
  onPinNotice?: (message: { id: string; text: string; senderName: string }) => void;

  // Persisted Channel/DM/Thread chat (see useChannelChat.ts) — ChatPanel
  // stays presentational, all persistence/socket plumbing lives there.
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  channels: Channel[];
  dmConversations: DirectConversationSummary[];
  activeChatTarget: { type: 'channel' | 'dm'; id: string } | null;
  onSelectTarget: (target: { type: 'channel' | 'dm'; id: string }) => void;
  messages: ChannelMessage[];
  onSend: (text: string, parentId?: string, attachment?: { url: string; fileName: string }) => void;
  // Bug 6 — attaching a file now shows the bubble immediately (local blob:
  // preview) and uploads in the background, rather than blocking on the
  // whole upload before onSend is even called. See useChannelChat.ts's
  // sendFileMessage. onRetry re-attempts a message stuck in status:'failed'.
  onSendFile?: (file: File) => void;
  onRetry?: (message: ChannelMessage) => void;
  // Throttled ping while composing, for the "X is typing…" indicator.
  onTyping?: () => void;
  // Delete one of your own persisted channel/DM messages (see MESSAGE_DELETE).
  onDeleteMessage?: (messageId: string) => void;
  // Edit the text of one of your own messages (see MESSAGE_EDIT).
  onEditMessage?: (messageId: string, text: string) => void;
  onLoadOlder: () => Promise<number>;
  onCreateChannel: (name: string) => Promise<Channel>;
}

export function ChatPanel({
  localPlayerName,
  localUserId,
  onBubble,
  onEmote,
  currentZone,
  zoneMessages = [],
  onSendZone,
  roomSlug,
  isAdmin,
  onPinNotice,
  open,
  onToggleOpen,
  channels,
  dmConversations,
  activeChatTarget,
  onSelectTarget,
  messages,
  onSend,
  onSendFile,
  onRetry,
  onTyping,
  onDeleteMessage,
  onEditMessage,
  onLoadOlder,
  onCreateChannel,
}: ChatPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // Bug 10 — attachment preview opens in this in-app lightbox, not a new tab.
  const [lightbox, setLightbox] = useState<LightboxTarget | null>(null);
  const beginEdit = (id: string, current: string) => { setEditingId(id); setEditText(current); };
  const commitEdit = () => {
    const t = editText.trim();
    if (editingId && t) onEditMessage?.(editingId, t);
    setEditingId(null);
    setEditText('');
  };
  const unreadByTarget = useGameStore((s) => s.unreadByTarget);
  // Total unread across every target (for the collapsed Chat button badge).
  const totalUnread = Object.values(unreadByTarget).reduce((a, b) => a + b, 0);

  const typingByTarget = useGameStore((s) => s.typingByTarget);
  const playerRecords = useGameStore((s) => s.playerRecords);
  // 1s tick while open so typing entries lapse on their own (there's no
  // explicit "stopped typing" event — they just pass their expiry).
  const [, setTypingTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const iv = setInterval(() => setTypingTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, [open]);

  const [text, setText] = useState('');
  const messageInputRef = useRef<HTMLInputElement>(null);
  // Potongan C2 — @mention autocomplete (Bagian 1). null = closed. When open,
  // `query` is whatever's typed after the triggering "@" (before the cursor,
  // no whitespace yet), `start` is that "@"'s index in `text` so a selection
  // knows exactly what span to replace. #general only for now, per spec.
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const mentionCandidates = (() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const seen = new Set<string>();
    const others = Object.values(playerRecords)
      .filter((p): p is typeof p & { userId: string } => !!p.userId)
      .map((p) => ({ userId: p.userId, name: p.name }));
    const all = [{ userId: localUserId, name: localPlayerName }, ...others];
    const out: { userId: string; name: string }[] = [];
    for (const c of all) {
      if (seen.has(c.userId)) continue;
      if (q && !c.name.toLowerCase().includes(q)) continue;
      seen.add(c.userId);
      out.push(c);
      if (out.length >= 8) break;
    }
    return out;
  })();
  // Re-derive the active "@query" from the input's actual caret position
  // (not just the trailing end of the string) so editing mid-message works
  // too, not only typing at the end. Runs on every keystroke.
  const updateMentionState = useCallback((value: string, caret: number) => {
    const uptoCaret = value.slice(0, caret);
    const m = uptoCaret.match(/(?:^|\s)@([^\s@]*)$/);
    if (m) {
      setMention({ query: m[1], start: uptoCaret.length - m[1].length - 1 });
      setMentionActiveIndex(0);
    } else {
      setMention(null);
    }
  }, []);
  const insertMention = useCallback((candidate: { userId: string; name: string }) => {
    if (!mention) return;
    const input = messageInputRef.current;
    const caret = input?.selectionStart ?? text.length;
    const token = `@[${candidate.name}](${candidate.userId}) `;
    const next = text.slice(0, mention.start) + token + text.slice(caret);
    setText(next);
    setMention(null);
    // Put the caret right after the inserted token, next tick (after the
    // controlled value has actually updated the DOM).
    const pos = mention.start + token.length;
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(pos, pos); });
  }, [mention, text]);
  const [proximityMode, setProximityMode] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [viewingZone, setViewingZone] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  // Kept in the global store (not local state) — see gameStore.ts's
  // repliesByParent doc comment — so a reply landing over the socket while
  // this thread is expanded shows up immediately for everyone viewing it,
  // not just after a manual refetch.
  const repliesByParent = useGameStore((s) => s.repliesByParent);
  const setParentReplies = useGameStore((s) => s.setParentReplies);
  const threadReplies = expandedThreadId ? repliesByParent[expandedThreadId] ?? [] : [];
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const [attachError, setAttachError] = useState('');
  // Potongan C3 — zone-chat file upload has no message bubble to show a
  // pending state on (see handleAttachFile), so this is the ONLY signal the
  // user gets that something's happening.
  const [zoneFileUploading, setZoneFileUploading] = useState(false);
  // Scroll container (not an anchor element): we drive scrollTop directly,
  // which is steadier under React re-renders than scrollIntoView (that can
  // yank the whole page and fights the smooth-scroll mid-render).
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the user is parked at (or near) the bottom. A ref, not state, so
  // reading it inside the new-message effect never runs a render behind.
  const isNearBottomRef = useRef(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    isNearBottomRef.current = true;
    setHasNewMessages(false);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // ~100px slack so "basically at the bottom" still counts as at-bottom.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    isNearBottomRef.current = nearBottom;
    if (nearBottom) setHasNewMessages(false);
  }, []);

  // Fall back to the channel/DM view the moment there's no zone chat left.
  useEffect(() => {
    if (!currentZone && viewingZone) setViewingZone(false);
  }, [currentZone, viewingZone]);

  const visibleMessages = viewingZone ? zoneMessages : messages;

  // Current identity (name + photo) for the channel/DM senders in view —
  // including any expanded thread replies — resolved by senderId in one batched
  // lookup, cached per user (see useProfiles). This is what makes old messages
  // show the sender's LATEST name/photo rather than the snapshot stored on the
  // message (Bug 8). Zone chat (ChatMessage) carries no senderId, so it keeps
  // the snapshot name + initials avatar.
  const profileByUser = useProfiles(
    Array.from(new Set([
      ...messages.map((m) => m.senderId),
      ...threadReplies.map((r) => r.senderId),
    ].filter(Boolean))),
  );

  // A new message arrived (or was sent). If the user is at the bottom, follow
  // it; if they've scrolled up to read history, DON'T yank them — flag it so
  // the "new messages" pill appears instead.
  useEffect(() => {
    if (isNearBottomRef.current) scrollToBottom(true);
    else setHasNewMessages(true);
  }, [visibleMessages.length, scrollToBottom]);

  // Opening the panel, or switching tab/zone, is a fresh scrollback — jump
  // straight to the newest message (no smooth animation on first paint).
  useEffect(() => {
    if (!open) return;
    // Next frame, once the new list has rendered at its real height.
    const id = requestAnimationFrame(() => scrollToBottom(false));
    return () => cancelAnimationFrame(id);
  }, [open, viewingZone, activeChatTarget?.type, activeChatTarget?.id, scrollToBottom]);

  // Switching targets means a fresh scrollback — reset thread/pagination UI.
  useEffect(() => {
    setExpandedThreadId(null);
    setHasMoreOlder(true);
    setMention(null);
  }, [activeChatTarget?.type, activeChatTarget?.id]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (viewingZone && currentZone && onSendZone) {
      onSendZone(trimmed, currentZone.id);
    } else if (proximityMode) {
      onBubble(trimmed);
    } else {
      onSend(trimmed);
    }
    setText('');
    setShowEmoji(false);
    setMention(null);
  }, [text, proximityMode, onSend, onBubble, viewingZone, currentZone, onSendZone]);

  const insertEmoji = (emoji: string) => {
    setText((prev) => prev + emoji);
  };

  // Bug 6 — this used to await the ENTIRE upload here before calling onSend
  // at all, so the bubble (and every send-round-trip-wait on top of it)
  // never appeared until the file had already finished uploading. onSendFile
  // (useChannelChat.ts's sendFileMessage) now shows the bubble immediately
  // (local blob: preview) and runs the upload in the background — this
  // function only does the synchronous size pre-check, which still belongs
  // here since it should reject before any bubble is even created. A failed
  // upload/send shows up as that bubble's own status:'failed' with a retry
  // button (see the message-list rendering below), not a generic banner.
  const handleAttachFile = useCallback(
    (file: File) => {
      setAttachError('');
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachError(`File is too large — max ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB.`);
        return;
      }
      // Potongan C3 — zone (Private) chat has no persisted message / pending-
      // bubble concept to hang an optimistic upload off of (see chatHandler.ts
      // — it's a pure live relay, never saved), so unlike onSendFile's
      // instant-bubble-then-upload-in-background pattern, this uploads FIRST
      // and only calls onSendZone once there's a real URL to send. The
      // "Mengunggah…" state below covers the gap so it never looks stuck.
      if (viewingZone && currentZone && onSendZone) {
        setZoneFileUploading(true);
        api.uploadMedia(file, roomSlug)
          .then(({ url, fileName }) => {
            onSendZone('', currentZone.id, url, fileName);
          })
          .catch((e) => {
            console.error('[chat] zone file upload failed:', e);
            setAttachError('Upload gagal — coba lagi.');
          })
          .finally(() => setZoneFileUploading(false));
        return;
      }
      onSendFile?.(file);
    },
    [onSendFile, viewingZone, currentZone, onSendZone, roomSlug]
  );

  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder || !hasMoreOlder) return;
    setLoadingOlder(true);
    try {
      const count = await onLoadOlder();
      if (!count) setHasMoreOlder(false);
    } finally {
      setLoadingOlder(false);
    }
  }, [onLoadOlder, loadingOlder, hasMoreOlder]);

  const toggleThread = useCallback(
    (messageId: string) => {
      if (expandedThreadId === messageId) {
        setExpandedThreadId(null);
        return;
      }
      setExpandedThreadId(messageId);
      api.getReplies(messageId).then((res) => setParentReplies(messageId, res.replies));
    },
    [expandedThreadId, setParentReplies]
  );

  const handleSendReply = useCallback(
    (parentId: string) => {
      const trimmed = replyText.trim();
      if (!trimmed) return;
      onSend(trimmed, parentId);
      setReplyText('');
      // No refetch needed — the CHANNEL_MESSAGE_NEW/DM_MESSAGE_NEW socket
      // handler appends this reply to repliesByParent[parentId] as soon as
      // the server persists+broadcasts it (see useSocket.ts), and this
      // component reads that same store slice reactively.
    },
    [replyText, onSend]
  );

  const handleCreateChannel = useCallback(async () => {
    const name = newChannelName.trim();
    if (!name) return;
    try {
      await onCreateChannel(name);
      setNewChannelName('');
      setShowNewChannel(false);
    } catch (e) {
      console.error('[chat] failed to create channel:', e);
    }
  }, [newChannelName, onCreateChannel]);

  return (
    <>
      <button
        onClick={() => onToggleOpen(!open)}
        className="absolute bottom-4 right-4 z-50 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm px-3 py-2 rounded-lg text-sm text-purple-700 dark:text-purple-300 hover:text-purple-800 border border-purple-200 dark:border-gray-600 shadow-sm cursor-pointer pointer-events-auto inline-flex items-center gap-1.5"
      >
        <ChatDotsFill size={14} /> {open ? 'Hide' : 'Chat'}
        {!open && totalUnread > 0 && (
          <span className="ml-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold inline-flex items-center justify-center">
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute bottom-16 right-4 z-50 w-80 h-[28rem] bg-white/95 dark:bg-gray-900/95 backdrop-blur-md rounded-xl border border-purple-100 dark:border-gray-700 shadow-2xl flex flex-col pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="p-3 border-b border-purple-100 dark:border-gray-700 flex items-center justify-between">
            <span className="text-gray-900 dark:text-gray-100 text-sm font-medium">Chat</span>
            <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
              <input type="checkbox" checked={proximityMode} onChange={(e) => setProximityMode(e.target.checked)} className="w-3 h-3 accent-purple-600" />
              Bubble
            </label>
          </div>

          <div className="flex gap-1 px-3 pt-2 pb-1 overflow-x-auto">
            {channels.map((c) => (
              <button
                key={c.id}
                onClick={() => { setViewingZone(false); onSelectTarget({ type: 'channel', id: c.id }); }}
                className={`shrink-0 px-2 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                  !viewingZone && activeChatTarget?.type === 'channel' && activeChatTarget.id === c.id
                    ? 'bg-purple-600 text-white'
                    : 'bg-purple-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-purple-100 dark:hover:bg-gray-600'
                }`}
              >
                #{c.name}
                {(unreadByTarget[`channel:${c.id}`] ?? 0) > 0 && (
                  <span className="ml-1 min-w-[14px] h-3.5 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold inline-flex items-center justify-center align-middle">
                    {unreadByTarget[`channel:${c.id}`]}
                  </span>
                )}
              </button>
            ))}
            {dmConversations.map((d) => (
              <button
                key={d.id}
                onClick={() => { setViewingZone(false); onSelectTarget({ type: 'dm', id: d.id }); }}
                className={`shrink-0 px-2 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                  !viewingZone && activeChatTarget?.type === 'dm' && activeChatTarget.id === d.id
                    ? 'bg-purple-600 text-white'
                    : 'bg-purple-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-purple-100 dark:hover:bg-gray-600'
                }`}
                title={`DM with ${d.otherUser.displayName}`}
              >
                @{d.otherUser.displayName}
                {(unreadByTarget[`dm:${d.id}`] ?? 0) > 0 && (
                  <span className="ml-1 min-w-[14px] h-3.5 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold inline-flex items-center justify-center align-middle">
                    {unreadByTarget[`dm:${d.id}`]}
                  </span>
                )}
              </button>
            ))}
            {currentZone && (
              <button
                onClick={() => setViewingZone(true)}
                className={`shrink-0 px-2 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                  viewingZone ? 'bg-purple-600 text-white' : 'bg-purple-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-purple-100 dark:hover:bg-gray-600'
                }`}
                title={`Private to ${currentZone.name}`}
              >
                <LockFill size={10} className="inline -mt-0.5 mr-1" /> {currentZone.name}
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => setShowNewChannel((v) => !v)}
                className="shrink-0 px-2 py-1 rounded-md text-[11px] font-medium bg-purple-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-purple-100 dark:hover:bg-gray-600 cursor-pointer"
                title="New channel"
              >
                <PlusLg size={10} />
              </button>
            )}
          </div>

          {showNewChannel && (
            <div className="flex gap-1 px-3 pb-2">
              <input
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateChannel()}
                placeholder="channel-name"
                maxLength={30}
                className="flex-1 bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-xs rounded px-2 py-1 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500"
              />
              <button onClick={handleCreateChannel} className="bg-purple-600 hover:bg-purple-700 text-white text-[11px] px-2 py-1 rounded cursor-pointer">
                Create
              </button>
            </div>
          )}

          <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto p-3 space-y-2 text-xs"
          >
            {!viewingZone && hasMoreOlder && messages.length > 0 && (
              <button
                onClick={handleLoadOlder}
                disabled={loadingOlder}
                className="w-full text-center text-[10px] text-purple-500 hover:text-purple-700 disabled:opacity-50 cursor-pointer py-1"
              >
                {loadingOlder ? 'Loading...' : 'Load older messages'}
              </button>
            )}

            {viewingZone
              ? zoneMessages.map((m) => {
                  const isOwn = !m.isBot && m.senderName === localPlayerName;
                  const isMentioned = !m.isBot && m.text.includes(`@${localPlayerName}`);
                  return (
                    <MessageBubble
                      key={m.id}
                      isOwn={isOwn}
                      name={m.senderName}
                      color={m.senderColor || avatarColor(m.senderName)}
                      time={m.timestamp}
                      mentioned={isMentioned}
                      isBot={m.isBot}
                      pinnable={!m.isBot && !!(isAdmin && onPinNotice)}
                      onPin={() => onPinNotice?.(m)}
                    >
                      {m.isProximity && <span className="opacity-60 mr-1">(nearby)</span>}
                      {m.text && <span className={`break-words ${m.isBot ? 'whitespace-pre-line' : ''}`}>{m.text}</span>}
                      {/* Potongan C3 — same attachment UI (icon by type, name,
                          click to open/download) as persisted chat, reused
                          as-is rather than a second render path. */}
                      {m.attachmentUrl && (
                        <ChatAttachment url={m.attachmentUrl} fileName={m.attachmentName} isOwn={isOwn} onOpen={setLightbox} />
                      )}
                      {m.isBot && m.botThumbnailUrl && (
                        <img
                          src={m.botThumbnailUrl}
                          alt=""
                          onError={(e) => { e.currentTarget.style.display = 'none'; }}
                          className="mt-1.5 w-full max-w-[160px] rounded-lg border border-purple-200 dark:border-purple-800"
                        />
                      )}
                    </MessageBubble>
                  );
                })
              : messages.map((m) => {
                  const isOwn = m.senderId === localUserId;
                  const isMentioned = textMentionsUser(m.text, localUserId);
                  return (
                    <div key={m.id}>
                      <MessageBubble
                        isOwn={isOwn}
                        name={profileByUser.get(m.senderId)?.name || m.senderName}
                        color={avatarColor(m.senderId || m.senderName)}
                        photoUrl={profileByUser.get(m.senderId)?.photo ?? undefined}
                        time={m.createdAt}
                        mentioned={isMentioned}
                        pinnable={!!(isAdmin && onPinNotice)}
                        onPin={() => onPinNotice?.(m)}
                        actions={
                          <>
                            <button
                              onClick={() => toggleThread(m.id)}
                              className="text-[10px] text-purple-500 hover:text-purple-700 cursor-pointer inline-flex items-center gap-1"
                            >
                              <ChatLeftText size={9} />
                              {m.replyCount ? `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}` : 'Reply'}
                            </button>
                            {isOwn && onEditMessage && m.text && editingId !== m.id && (
                              <button
                                onClick={() => beginEdit(m.id, m.text)}
                                title="Edit message"
                                className="text-[10px] text-gray-400 hover:text-purple-600 cursor-pointer inline-flex items-center gap-1"
                              >
                                <PencilFill size={9} /> Edit
                              </button>
                            )}
                            {isOwn && onDeleteMessage && (
                              <button
                                onClick={() => { if (window.confirm('Delete this message?')) onDeleteMessage(m.id); }}
                                title="Delete message"
                                className="text-[10px] text-gray-400 hover:text-red-500 cursor-pointer inline-flex items-center gap-1"
                              >
                                <TrashFill size={9} /> Delete
                              </button>
                            )}
                          </>
                        }
                      >
                        {editingId === m.id ? (
                          <input
                            autoFocus
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); else if (e.key === 'Escape') { setEditingId(null); setEditText(''); } }}
                            onBlur={commitEdit}
                            maxLength={200}
                            className="bg-white/90 text-gray-900 text-xs rounded px-1 py-0.5 outline-none border border-purple-300 w-40"
                          />
                        ) : (
                          m.text && (
                            <span className="break-words">
                              {renderWithMentions(m.text, localUserId)}
                              {m.edited && <span className="ml-1 text-[9px] opacity-60">(diedit)</span>}
                            </span>
                          )
                        )}
                        {m.attachmentUrl && (
                          <ChatAttachment url={m.attachmentUrl} fileName={m.attachmentName} isOwn={isOwn} onOpen={setLightbox} />
                        )}
                        {/* Bug 6 — this bubble is the sender's own optimistic
                            echo, shown before the server has confirmed
                            anything. 'pending' auto-clears the moment the
                            real broadcast reconciles it (see
                            appendTargetMessage); 'failed' stays until Retry
                            or the page reloads, same pattern chat apps use
                            for "message not delivered". */}
                        {m.status === 'pending' && (
                          <span className="mt-0.5 flex items-center gap-1 text-[9px] opacity-70">
                            <span className="w-2 h-2 rounded-full border border-current border-t-transparent animate-spin" />
                            Mengirim…
                          </span>
                        )}
                        {m.status === 'failed' && (
                          <button
                            type="button"
                            onClick={() => onRetry?.(m)}
                            title="Coba kirim lagi"
                            className="mt-0.5 flex items-center gap-1 text-[9px] text-red-300 hover:text-red-100 cursor-pointer"
                          >
                            <ExclamationTriangleFill size={9} /> Gagal terkirim — coba lagi <ArrowClockwise size={9} />
                          </button>
                        )}
                      </MessageBubble>

                      {expandedThreadId === m.id && (
                        <div className="ml-3 mt-1 pl-2 border-l-2 border-purple-100 dark:border-gray-700 space-y-1">
                          {threadReplies.map((r) => (
                            <div key={r.id} className="rounded bg-purple-50/50 dark:bg-gray-700/50 px-2 py-1 group/reply flex items-start justify-between gap-1">
                              <span className="min-w-0">
                                <span className="font-medium text-gray-500 dark:text-gray-400 mr-1">{profileByUser.get(r.senderId)?.name || r.senderName}</span>
                                {editingId === r.id ? (
                                  <input
                                    autoFocus
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); else if (e.key === 'Escape') { setEditingId(null); setEditText(''); } }}
                                    onBlur={commitEdit}
                                    maxLength={200}
                                    className="bg-white text-gray-900 text-[11px] rounded px-1 py-0.5 outline-none border border-purple-300 w-32"
                                  />
                                ) : (
                                  <span className="text-gray-800 dark:text-gray-200 break-words">
                                    {renderWithMentions(r.text, localUserId)}
                                    {r.edited && <span className="ml-1 text-[9px] text-gray-400 dark:text-gray-500">(diedit)</span>}
                                  </span>
                                )}
                              </span>
                              {r.senderId === localUserId && editingId !== r.id && (
                                <span className="shrink-0 flex items-center gap-1 opacity-0 group-hover/reply:opacity-100 transition-opacity">
                                  {onEditMessage && (
                                    <button onClick={() => beginEdit(r.id, r.text)} title="Edit reply" className="text-gray-400 hover:text-purple-600 cursor-pointer">
                                      <PencilFill size={9} />
                                    </button>
                                  )}
                                  {onDeleteMessage && (
                                    <button onClick={() => { if (window.confirm('Delete this reply?')) onDeleteMessage(r.id); }} title="Delete reply" className="text-gray-400 hover:text-red-500 cursor-pointer">
                                      <TrashFill size={9} />
                                    </button>
                                  )}
                                </span>
                              )}
                            </div>
                          ))}
                          <div className="flex gap-1 pt-1">
                            <input
                              value={replyText}
                              onChange={(e) => setReplyText(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && handleSendReply(m.id)}
                              placeholder="Reply in thread..."
                              maxLength={200}
                              className="flex-1 bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-[11px] rounded px-2 py-1 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500"
                            />
                            <button
                              onClick={() => handleSendReply(m.id)}
                              disabled={!replyText.trim()}
                              className="bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white text-[11px] px-2 py-1 rounded cursor-pointer"
                            >
                              Send
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
            {visibleMessages.length === 0 && (
              <p className="text-gray-400 dark:text-gray-500 text-center mt-4">
                {viewingZone ? `No messages in ${currentZone?.name} yet.` : 'No messages yet.'}
              </p>
            )}
          </div>
          {hasNewMessages && (
            <button
              onClick={() => scrollToBottom(true)}
              className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 bg-purple-600 hover:bg-purple-700 text-white text-[10px] font-medium px-2.5 py-1 rounded-full shadow-lg cursor-pointer flex items-center gap-1"
            >
              Pesan baru ↓
            </button>
          )}
          </div>

          {showEmoji && (
            <div className="px-3 pb-2 flex flex-wrap gap-1">
              {COMMON_EMOJIS.map((e) => (
                <button key={e} onClick={() => insertEmoji(e)} className="hover:bg-purple-50 dark:hover:bg-gray-700 rounded p-0.5 text-sm cursor-pointer">{e}</button>
              ))}
            </div>
          )}

          {attachError && (
            <p className="px-3 pb-1 text-[10px] text-red-500">{attachError}</p>
          )}
          {zoneFileUploading && (
            <p className="px-3 pb-1 text-[10px] text-gray-400 dark:text-gray-500 italic">Mengunggah…</p>
          )}
          {(() => {
            if (viewingZone || !activeChatTarget) return null;
            const key = `${activeChatTarget.type}:${activeChatTarget.id}`;
            const now = Date.now();
            const names = Object.entries(typingByTarget[key] ?? {})
              .filter(([uid, exp]) => exp > now && uid !== localUserId)
              .map(([uid]) => Object.values(playerRecords).find((p) => p.userId === uid)?.name ?? 'Seseorang');
            if (names.length === 0) return null;
            const label =
              names.length === 1 ? `${names[0]} sedang mengetik…`
              : names.length === 2 ? `${names[0]} dan ${names[1]} sedang mengetik…`
              : `${names[0]} dan ${names.length - 1} lainnya sedang mengetik…`;
            return (
              <p className="px-3 pb-1 text-[10px] text-gray-400 dark:text-gray-500 italic flex items-center gap-1">
                <span className="inline-flex gap-0.5">
                  <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </span>
                {label}
              </p>
            );
          })()}
          <div className="p-3 border-t border-purple-100 dark:border-gray-700 flex gap-2 items-center">
            <button onClick={() => setShowEmoji(!showEmoji)} className="text-purple-600 dark:text-purple-400 cursor-pointer"><EmojiSmile size={16} /></button>
            {/* Potongan C3 — file attachments now work for zone (Private)
                chat too, not just persisted Channel/DM. Still hidden for
                proximityMode ("Say nearby") — that's a floating speech
                bubble over the avatar, not a real chat log to attach
                anything to. */}
            {!proximityMode && (
              <AttachmentMenuButton
                onFile={handleAttachFile}
                title="Lampirkan"
                disabled={zoneFileUploading}
                buttonClassName="text-purple-600 dark:text-purple-400 disabled:opacity-40 cursor-pointer"
              />
            )}
            <div className="relative flex-1">
              {/* Potongan C2 — @mention candidates, #general (persisted
                  channel/DM) only: zone/bubble chat has no real userId-backed
                  participant list to mention from. */}
              {mention && !viewingZone && !proximityMode && (
                <div className="absolute bottom-full left-0 mb-1 w-56 max-h-48 overflow-y-auto bg-white dark:bg-gray-800 border border-purple-200 dark:border-gray-600 rounded-lg shadow-lg z-10">
                  {mentionCandidates.length === 0 ? (
                    <p className="px-2.5 py-1.5 text-[11px] text-gray-400">Tidak ada yang cocok</p>
                  ) : mentionCandidates.map((c, i) => (
                    <button
                      key={c.userId}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()} // keep the input focused — a blur here would close this before the click registers
                      onClick={() => insertMention(c)}
                      className={`w-full text-left px-2.5 py-1.5 text-xs cursor-pointer ${i === mentionActiveIndex ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-900 dark:text-purple-200' : 'text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700'}`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
              <input
                ref={messageInputRef}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  updateMentionState(e.target.value, e.target.selectionStart ?? e.target.value.length);
                  // Only the persisted channel/DM path has a typing indicator —
                  // zone/bubble chat is a different, ephemeral concept.
                  if (e.target.value && !viewingZone && !proximityMode) onTyping?.();
                }}
                onKeyDown={(e) => {
                  if (mention && mentionCandidates.length > 0) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionActiveIndex((i) => (i + 1) % mentionCandidates.length); return; }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setMentionActiveIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length); return; }
                    if (e.key === 'Enter') { e.preventDefault(); insertMention(mentionCandidates[mentionActiveIndex]); return; }
                    if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
                  }
                  if (e.key === 'Enter') handleSend();
                }}
                onBlur={() => setMention(null)}
                placeholder={viewingZone ? `Message ${currentZone?.name}...` : proximityMode ? 'Say nearby...' : 'Type a message...'}
                maxLength={200}
                className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-xs rounded px-2 py-1.5 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500 disabled:opacity-60"
              />
            </div>
            <button
              onClick={handleSend}
              disabled={!text.trim()}
              className="bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded cursor-pointer"
            >
              Send
            </button>
          </div>
        </div>
      )}
      {lightbox && <AttachmentLightbox target={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

// One chat bubble, WhatsApp-group style: own messages hug the right with no
// avatar (purple, unchanged); everyone else hugs the left with a round avatar
// and their name coloured to match it. The sender-specific body (text, edit
// input, attachment) is passed as children so this wrapper stays identical for
// zone chat and channel/DM chat; per-message actions (reply/edit/delete) go in
// `actions`, rendered under the bubble on the same side.
function MessageBubble({
  isOwn,
  name,
  color,
  photoUrl,
  time,
  mentioned,
  isBot,
  pinnable,
  onPin,
  children,
  actions,
}: {
  isOwn: boolean;
  name: string;
  color: string;
  photoUrl?: string;
  time: number | string;
  mentioned?: boolean;
  // Music Bot's own replies (see musicHandler.ts) — a distinct tint so a bot
  // reply reads as "system", not as if some player is talking about song
  // titles. Never combined with isOwn/mentioned in practice (the bot is
  // never the local player, and its own name never matches @mentions).
  isBot?: boolean;
  pinnable?: boolean;
  onPin?: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  // A mentioned message keeps its amber highlight and needs dark text on it,
  // overriding the white-on-purple own-message default.
  const bodyText = mentioned || !isOwn ? 'text-gray-900 dark:text-gray-100' : 'text-white';
  return (
    <div className={`flex gap-1.5 ${isOwn ? 'justify-end' : 'justify-start'}`}>
      {!isOwn && <ChatAvatar name={name} color={color} photoUrl={photoUrl} />}
      <div className={`flex flex-col min-w-0 max-w-[80%] ${isOwn ? 'items-end' : 'items-start'}`}>
        <div
          onContextMenu={pinnable ? (e) => { e.preventDefault(); onPin?.(); } : undefined}
          title={pinnable ? 'Right-click to pin as notice' : undefined}
          className={`rounded-2xl px-2.5 py-1.5 ${isOwn ? 'rounded-br-sm' : 'rounded-bl-sm'} ${pinnable ? 'cursor-context-menu' : ''} ${bodyText} ${
            isBot
              ? 'bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800'
              : mentioned ? 'bg-amber-100 dark:bg-amber-900/40' : isOwn ? 'bg-purple-600' : 'bg-gray-100 dark:bg-gray-700'
          }`}
        >
          {!isOwn && <div className="font-semibold text-[11px] mb-0.5 leading-tight" style={{ color }}>{name}</div>}
          {children}
          <div className={`text-[9px] mt-0.5 ${isOwn ? 'text-purple-200 text-right' : 'text-gray-400 dark:text-gray-500'}`}>
            {new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
        {actions && <div className="flex gap-2 mt-0.5 px-1">{actions}</div>}
      </div>
      {/* Bug 9 — own messages now also carry their avatar, mirrored to the RIGHT
          of the (right-aligned) bubble. Same ChatAvatar as everyone else, so it
          shows the current profile photo (or initials). No name label inside an
          own bubble, and its purple/right layout is unchanged. */}
      {isOwn && <ChatAvatar name={name} color={color} photoUrl={photoUrl} />}
    </div>
  );
}

// Bug 3 — the thumbnail used to be a bare <img>: nothing shown while it
// loaded (just the bg-purple-100 box) and a failed load fell through to the
// browser's own broken-image icon — reading as "you have to open/download
// this to find out what it is" even though the whole point of an inline
// thumbnail is not needing to. Tracks its own load state so a spinner shows
// while pending and a clear "gagal dimuat" replaces a silently-broken image.
// The corner download button is a SIBLING of the open-lightbox button, not a
// nested one — a <button>/<a> inside a <button> is invalid HTML and behaves
// inconsistently across browsers.
function ImageThumb({ url, fileName, onOpen }: { url: string; fileName?: string; onOpen: () => void }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  return (
    <div className="relative mt-1 w-32 h-24 rounded overflow-hidden bg-purple-100 dark:bg-gray-700">
      {state !== 'failed' && (
        <button type="button" onClick={onOpen} title={fileName} className="block w-full h-full cursor-pointer">
          <img
            src={url}
            alt={fileName || 'Attachment'}
            onLoad={() => setState('loaded')}
            onError={() => setState('failed')}
            className={`w-full h-full object-cover transition-opacity ${state === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
          />
        </button>
      )}
      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="w-5 h-5 rounded-full border-2 border-purple-300 border-t-transparent animate-spin" />
        </div>
      )}
      {state === 'failed' && (
        <button
          type="button"
          onClick={onOpen}
          title="Gagal dimuat — klik untuk detail/unduh"
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-1 text-center cursor-pointer"
        >
          <ExclamationTriangleFill size={16} className="text-amber-500" />
          <span className="text-[9px] text-gray-500 dark:text-gray-400 leading-tight">Gagal dimuat</span>
        </button>
      )}
      {state === 'loaded' && (
        <a
          href={url}
          download={fileName}
          onClick={(e) => e.stopPropagation()}
          title="Unduh"
          className="absolute bottom-1 right-1 w-5 h-5 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center cursor-pointer"
        >
          <Download size={10} />
        </a>
      )}
    </div>
  );
}

// Image attachments render as a clickable inline preview (opens the
// full-size image in a new tab — no in-app viewer for chat attachments,
// unlike Add Media's MediaViewerModal, since this is a much smaller/simpler
// surface); anything else renders as a compact download row instead of
// trying to guess how to preview an arbitrary file type.
// Bug 10 — clicking an attachment opens the in-app lightbox (onOpen) rather
// than navigating to a new tab. The in-bubble element is a preview/affordance
// only; playback/preview happens in the lightbox.
function ChatAttachment({ url, fileName, isOwn, onOpen }: { url: string; fileName?: string; isOwn: boolean; onOpen: (t: LightboxTarget) => void }) {
  const open = () => onOpen({ url, fileName });
  // Bug 17 — detect by the original FILENAME first. Drive-backed attachments are
  // served from an extension-less proxy URL (/api/files/<token>), so testing the
  // URL alone mis-detected every Drive image/video as a plain file.
  const probe = fileName || url;
  if (isImageAttachment(probe)) {
    return <ImageThumb url={url} fileName={fileName} onOpen={open} />;
  }
  if (isVideoAttachment(probe)) {
    // Muted, controls-less first frame as a thumbnail with a play badge; the
    // actual player (with controls + autoplay) lives in the lightbox.
    return (
      <button type="button" onClick={open} className="relative block mt-1 cursor-pointer w-48">
        <video src={url} muted preload="metadata" className="w-48 rounded bg-black pointer-events-none" />
        <span className="absolute inset-0 flex items-center justify-center">
          <PlayCircleFill size={34} className="text-white/90 drop-shadow" />
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={open}
      className={`mt-1 flex items-center gap-1.5 rounded px-2 py-1 text-[11px] w-full text-left cursor-pointer ${
        isOwn ? 'bg-purple-700/60 text-white hover:bg-purple-700' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700'
      }`}
    >
      <FileEarmarkFill size={12} className="shrink-0" />
      <span className="truncate flex-1">{fileName || 'Open file'}</span>
      <Download size={11} className="shrink-0" />
    </button>
  );
}
