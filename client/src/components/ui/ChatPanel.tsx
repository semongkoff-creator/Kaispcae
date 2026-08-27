import { useState, useRef, useEffect, useCallback, type ReactNode, type MouseEvent, type ClipboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { LockFill, PlusLg, ChatLeftText, FileEarmarkFill, Download, TrashFill, PencilFill, PlayCircleFill, ExclamationTriangleFill, ArrowClockwise, PinAngleFill, PinAngle, MegaphoneFill, ChevronLeft, ChevronRight, XLg, Headset, Clipboard } from 'react-bootstrap-icons';
import { ChatMessage, ChannelMessage, Channel, DirectConversationSummary, EmoteType } from '@kaispace/shared';
import { api } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';
import { ChatAvatar, avatarColor } from './ChatAvatar';
import { AttachmentLightbox, type LightboxTarget } from './AttachmentLightbox';
import { AttachmentMenuButton } from './AttachmentMenuButton';
import { AttachmentTray } from './AttachmentTray';
import { usePendingAttachments, type PendingAttachment } from '@/hooks/usePendingAttachments';
import { Tooltip } from './Tooltip';
import { CsChatConversation } from './CsChatConversation';
import { useProfiles } from '@/hooks/useProfiles';
import { textMentionsUser, renderWithMentions, stripMentionsToPlainText } from '@/utils/mentions';
import { showConfirm } from '@/stores/modalStore';

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // matches server/src/routes/uploads.ts's multer limit
const MAX_COMPOSE_HEIGHT_PX = 96; // ~6 lines before the compose box scrolls internally instead of growing further
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
  // Pin/unpin within the thread (see MESSAGE_PIN) — open to anyone in the
  // channel/DM, not just admins. Right-click a message to reach it (see the
  // context menu built below), distinct from onPinNotice above (admin-only,
  // posts to the room's Notice board instead).
  onPinMessage?: (messageId: string, pinned: boolean) => void;
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
  onPinMessage,
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
  const readStateByTarget = useGameStore((s) => s.readStateByTarget);
  const mutedUserIds = useGameStore((s) => s.mutedUserIds);
  // Personal mute (services/mutedUsers.ts) — `id` is a stable userId for
  // persisted channel messages, but a SOCKET id for ephemeral zone chat
  // (ChatMessage.senderId — see chatHandler.ts); resolving through
  // playerRecords handles both without the caller needing to know which.
  const isMutedSender = (id: string) => mutedUserIds.has(playerRecords[id]?.userId ?? id);

  // Right-click on a persisted channel/DM message opens this menu (pin +
  // read receipts) — see the render at the bottom of this component. Only
  // one open at a time; a click anywhere else (or opening another) closes it.
  const [msgMenu, setMsgMenu] = useState<{ x: number; y: number; message: ChannelMessage } | null>(null);

  // 1s tick while open so typing entries lapse on their own (there's no
  // explicit "stopped typing" event — they just pass their expiry).
  const [, setTypingTick] = useState(0);
  // Ticks ONLY while there is an unexpired typing entry to expire. It used
  // to run unconditionally for as long as the surface was up, re-rendering
  // this whole component once a second forever — and a chat surface is
  // typically left open, so that was a permanent 1Hz render of one of the
  // largest components in the app to do nothing at all. Someone starting to
  // type changes typingByTarget, which restarts this effect; the tick that
  // notices the last entry lapse stops it again.
  const anyoneTyping = () =>
    Object.values(useGameStore.getState().typingByTarget).some((byUser) =>
      Object.values(byUser).some((expiresAt) => expiresAt > Date.now()),
    );
  useEffect(() => {
    if (!open || !anyoneTyping()) return;
    const iv = setInterval(() => {
      // Re-render first so the lapsed entry actually leaves the screen, then
      // decide whether there is any reason to tick again.
      setTypingTick((t) => t + 1);
      if (!anyoneTyping()) clearInterval(iv);
    }, 1000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, typingByTarget]);

  const [text, setText] = useState('');
  // A <textarea> now (was <input>) — a single-line input can never wrap, it
  // only scrolls sideways forever, which is what was actually happening in
  // the compose box for a long word with no spaces (separate from — and
  // upstream of — the sent-bubble wrap fix, which only affects already-sent
  // messages). See the auto-grow onChange below.
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
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
  const [showEmoji, setShowEmoji] = useState(false);
  const [viewingZone, setViewingZone] = useState(false);
  // Customer Service chat — a tab alongside channels/DMs/zone, same
  // mutually-exclusive local-boolean shape as viewingZone above rather than
  // a new activeChatTarget type: CS has its own session/message model
  // entirely (see CsChatConversation.tsx), nothing here needs to touch
  // useChannelChat.ts's channel/DM join-leave/fetch logic to add it.
  const [csTabActive, setCsTabActive] = useState(false);
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
  // pending state on (see sendPendingZoneAttachments), so this is the ONLY
  // signal the user gets that something's happening.
  const [zoneFileUploading, setZoneFileUploading] = useState(false);
  // Paste/attach stage files here first — nothing uploads or sends until
  // Kirim (handleSend) drains this. See usePendingAttachments.ts.
  const pendingAttachments = usePendingAttachments();
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

  // Pinned-message bar — zone chat has no pin concept (ephemeral, no
  // isPinned field), so this only ever shows for the channel/DM tabs.
  // Telegram-style: one at a time, with a counter to step through the rest
  // if there's more than one pinned in this thread.
  const pinnedMessages = viewingZone ? [] : messages.filter((m) => m.isPinned);
  const [pinCursor, setPinCursor] = useState(0);
  useEffect(() => {
    setPinCursor(0);
  }, [activeChatTarget?.type, activeChatTarget?.id]);
  // JS's % keeps the sign of the dividend, so a plain `pinCursor % length`
  // stays negative after stepping "previous" past index 0 — this wraps it
  // back into [0, length) both directions.
  const pinIndex = pinnedMessages.length > 0 ? ((pinCursor % pinnedMessages.length) + pinnedMessages.length) % pinnedMessages.length : 0;
  const currentPin = pinnedMessages[pinIndex];

  // Jump-to-message — scrolls the already-loaded message into view and
  // flashes it briefly, so clicking a pinned message actually lands you on
  // it in the real conversation instead of just naming it. Only reaches
  // messages already in `messages` (the loaded window); an older pinned
  // message outside that window won't be found — Load Older first.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const scrollToMessage = useCallback((messageId: string) => {
    const el = scrollRef.current?.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(messageId);
    setTimeout(() => setHighlightedId((cur) => (cur === messageId ? null : cur)), 1500);
  }, []);

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

  // Full "who has read THIS message" — everyone whose thread-wide lastReadAt
  // is at or past this message's own createdAt (see ChatRead's doc comment,
  // server/prisma/schema.prisma). Unlike MessengerApp's passive under-bubble
  // hint (which only ever labels each reader's newest reached message), this
  // is computed on demand for whichever message was right-clicked, so it
  // also answers "did they see this OLDER one" correctly.
  const readersOf = useCallback((message: ChannelMessage): string[] => {
    if (!activeChatTarget) return [];
    const key = `${activeChatTarget.type}:${activeChatTarget.id}`;
    const state = readStateByTarget[key] ?? {};
    return Object.entries(state)
      .filter(([uid, lastReadAt]) => uid !== localUserId && lastReadAt >= message.createdAt)
      .map(([uid]) => Object.values(playerRecords).find((p) => p.userId === uid)?.name ?? profileByUser.get(uid)?.name ?? 'Seseorang');
  }, [activeChatTarget, readStateByTarget, playerRecords, profileByUser, localUserId]);

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

  // Zone (Private) chat has no persisted message / pending-bubble concept to
  // hang an optimistic upload off of (see handleAttachFile's old doc
  // comment — chatHandler.ts is a pure live relay, never saved), so each
  // staged attachment uploads here, sequentially, only once Kirim is
  // pressed — same upload call and "Mengunggah…" signal the old
  // upload-on-attach path used, just moved to send time.
  const sendPendingZoneAttachments = useCallback(
    async (attachments: PendingAttachment[], zoneId: string) => {
      setZoneFileUploading(true);
      for (const { file } of attachments) {
        try {
          const { url, fileName } = await api.uploadMedia(file, roomSlug);
          onSendZone?.('', zoneId, url, fileName);
        } catch (e) {
          console.error('[chat] zone file upload failed:', e);
          setAttachError('Upload gagal — coba lagi.');
        }
      }
      setZoneFileUploading(false);
    },
    [onSendZone, roomSlug]
  );

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    const attachments = pendingAttachments.items;
    if (!trimmed && attachments.length === 0) return;
    // Every zone/channel send also shows as a floating speech bubble over
    // the avatar — no separate "Bubble" mode to remember to turn on first.
    // DMs are excluded: their content is private, and a bubble is public to
    // anyone standing nearby. The bubble is plain canvas-drawn text (see
    // GameCanvas's speech-bubble draw loop) with no mention-markup parsing
    // of its own — sending it the raw "@[Name](userId)" token straight from
    // the input (correct for onSend/onSendZone, which DO parse it via
    // renderWithMentions) rendered the userId itself as garbled-looking text
    // over the avatar. stripMentionsToPlainText reduces it to "@Name" first.
    const bubbleText = stripMentionsToPlainText(trimmed);
    if (viewingZone && currentZone && onSendZone) {
      if (trimmed) {
        onSendZone(trimmed, currentZone.id);
        onBubble(bubbleText);
      }
      if (attachments.length > 0) sendPendingZoneAttachments(attachments, currentZone.id);
    } else {
      if (trimmed) {
        onSend(trimmed);
        if (activeChatTarget?.type !== 'dm') onBubble(bubbleText);
      }
      // Channel/DM attachments each go through onSendFile exactly like a
      // single manual attach did before — instant optimistic bubble +
      // background upload per file (see useChannelChat.ts's
      // sendFileMessage). Several staged files just means several bubbles.
      attachments.forEach((a) => onSendFile?.(a.file));
    }
    pendingAttachments.clear();
    setText('');
    setShowEmoji(false);
    setMention(null);
    // Collapse the compose box back to one line — it only grows via a
    // direct DOM style write (see the textarea's onChange below), so
    // clearing the `text` state alone wouldn't shrink it back.
    if (messageInputRef.current) messageInputRef.current.style.height = 'auto';
  }, [text, onSend, onBubble, viewingZone, currentZone, onSendZone, activeChatTarget, onSendFile, pendingAttachments, sendPendingZoneAttachments]);

  const insertEmoji = (emoji: string) => {
    setText((prev) => prev + emoji);
  };

  // Paste/attach no longer uploads or sends anything by itself — it only
  // stages the file into pendingAttachments (rendered as AttachmentTray
  // below the input) so the user can review, add more, and remove before
  // committing. The actual upload/send happens in handleSend once Kirim is
  // pressed, branching the same way it always did (zone upload-then-emit vs.
  // onSendFile's instant-bubble-then-upload) — see sendPendingZoneAttachments
  // and handleSend above.
  const handleAttachFile = useCallback(
    (file: File) => {
      setAttachError('');
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachError(`File is too large — max ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB.`);
        return;
      }
      pendingAttachments.add(file);
    },
    [pendingAttachments]
  );

  // Ctrl+V a screenshot straight into the input, Lark/WhatsApp-style —
  // reuses handleAttachFile verbatim (same size check, same staging), so
  // this is zero new upload logic, just a new entry point into the existing
  // one. Only intercepts when the clipboard actually carries image data;
  // anything else (plain text, a copied file that isn't an image) falls
  // through to the browser's normal paste behavior untouched. Multiple
  // images pasted at once all get staged together, same as attaching
  // several files manually one after another.
  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const imageFiles = Array.from(e.clipboardData?.items ?? [])
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((f): f is File => !!f);
      if (imageFiles.length === 0) return;
      e.preventDefault();
      imageFiles.forEach((file) => handleAttachFile(file));
    },
    [handleAttachFile]
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
      {/* Restored to its own standalone bottom-right trigger (was briefly
          folded into the meeting toolbar — reverted per request). Still
          uses the "Ethereal Collaboration" glass upgrade (backdrop-blur-xl,
          translucent border/glow) from the separately-approved restyle pass
          — only the toolbar placement was undone, not that styling. */}
      <div className="absolute bottom-4 right-4 z-50 pointer-events-auto">
        <Tooltip
          label="Chat"
          detail="Buka panel chat untuk kirim pesan ke channel, zone, atau langsung (DM) ke satu orang."
          align="end"
        >
          <button
            onClick={() => onToggleOpen(!open)}
            className="font-login-body bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl px-3 py-2 rounded-lg text-sm text-login-accent dark:text-purple-300 hover:brightness-110 border border-login-border-soft dark:border-white/10 shadow-lg shadow-purple-500/10 cursor-pointer inline-flex items-center gap-1.5"
          >
            <img src="/assets/img/icons/message.svg" width={14} height={14} alt="" /> {open ? 'Hide' : 'Message'}
            {!open && totalUnread > 0 && (
              <span className="ml-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold inline-flex items-center justify-center">
                {totalUnread > 99 ? '99+' : totalUnread}
              </span>
            )}
          </button>
        </Tooltip>
      </div>

      {open && (
        <div
          className="absolute bottom-16 right-4 z-50 w-80 h-[28rem] bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl rounded-xl border border-login-border-soft dark:border-white/10 shadow-2xl shadow-purple-500/10 flex flex-col pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="p-3 border-b border-login-border-soft dark:border-gray-700 flex items-center justify-between">
            <span className="font-login-body text-gray-900 dark:text-gray-100 text-sm font-medium">Global Chat</span>
          </div>

          <div className="flex flex-wrap gap-1 px-3 pt-2 pb-1">
            {channels.map((c) => (
              <Tooltip key={c.id} label={`#${c.name}`} detail="Pindah ke channel ini." wrapperClassName="shrink-0">
                <button
                  onClick={() => { setViewingZone(false); setCsTabActive(false); onSelectTarget({ type: 'channel', id: c.id }); }}
                  className={`shrink-0 px-2 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                    !viewingZone && activeChatTarget?.type === 'channel' && activeChatTarget.id === c.id
                      ? 'bg-login-accent text-white'
                      : 'bg-login-surface dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-login-border-soft dark:hover:bg-gray-600'
                  }`}
                >
                  #{c.name}
                  {(unreadByTarget[`channel:${c.id}`] ?? 0) > 0 && (
                    <span className="ml-1 min-w-[14px] h-3.5 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold inline-flex items-center justify-center align-middle">
                      {unreadByTarget[`channel:${c.id}`]}
                    </span>
                  )}
                </button>
              </Tooltip>
            ))}
            {dmConversations.map((d) => (
              <Tooltip key={d.id} label={`Chat dengan ${d.otherUser.displayName}`} detail="Percakapan 1-on-1 dengan orang ini." wrapperClassName="shrink-0">
                <button
                  onClick={() => { setViewingZone(false); setCsTabActive(false); onSelectTarget({ type: 'dm', id: d.id }); }}
                  className={`shrink-0 px-2 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                    !viewingZone && activeChatTarget?.type === 'dm' && activeChatTarget.id === d.id
                      ? 'bg-login-accent text-white'
                      : 'bg-login-surface dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-login-border-soft dark:hover:bg-gray-600'
                  }`}
                >
                  @{d.otherUser.displayName}
                  {(unreadByTarget[`dm:${d.id}`] ?? 0) > 0 && (
                    <span className="ml-1 min-w-[14px] h-3.5 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold inline-flex items-center justify-center align-middle">
                      {unreadByTarget[`dm:${d.id}`]}
                    </span>
                  )}
                </button>
              </Tooltip>
            ))}
            {currentZone && (
              <Tooltip label={`Private to ${currentZone.name}`} detail="Chat yang cuma sampai ke orang di zone ini." wrapperClassName="shrink-0">
                <button
                  onClick={() => { setViewingZone(true); setCsTabActive(false); }}
                  className={`shrink-0 px-2 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                    viewingZone ? 'bg-login-accent text-white' : 'bg-login-surface dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-login-border-soft dark:hover:bg-gray-600'
                  }`}
                >
                  <LockFill size={10} className="inline -mt-0.5 mr-1" /> {currentZone.name}
                </button>
              </Tooltip>
            )}
            {/* Customer Service chat — always available, not gated on
                anything (no isGuest/isAdmin check: guests can't open a
                session server-side anyway, see routes/cs.ts's
                authenticateToken, but hiding the tab for them isn't the
                enforcement, just tidiness — matches the CsChatWidget-era
                scoping). */}
            <Tooltip label="Customer Service" detail="Tanya seputar cara pakai KaiSpace, atau hubungi admin." wrapperClassName="shrink-0">
              <button
                onClick={() => { setViewingZone(false); setCsTabActive(true); }}
                className={`shrink-0 px-2 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                  csTabActive ? 'bg-login-accent text-white' : 'bg-login-surface dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-login-border-soft dark:hover:bg-gray-600'
                }`}
              >
                <Headset size={10} className="inline -mt-0.5 mr-1" /> CS
              </button>
            </Tooltip>
            {isAdmin && (
              <Tooltip label="Channel Baru" detail="Buat channel baru. (Khusus admin.)" wrapperClassName="shrink-0">
                <button
                  onClick={() => setShowNewChannel((v) => !v)}
                  className="shrink-0 px-2 py-1 rounded-md text-[11px] font-medium bg-login-surface dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-login-border-soft dark:hover:bg-gray-600 cursor-pointer"
                >
                  <PlusLg size={10} />
                </button>
              </Tooltip>
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
              <Tooltip label="Buat" detail="Buat channel dengan nama ini.">
                <button onClick={handleCreateChannel} className="bg-purple-600 hover:bg-purple-700 text-white text-[11px] px-2 py-1 rounded cursor-pointer">
                  Create
                </button>
              </Tooltip>
            </div>
          )}

          {csTabActive ? (
            <CsChatConversation active={csTabActive} />
          ) : (
          <>
          {/* Telegram-style pinned bar — one message at a time, chevrons to
              step through the rest if more than one is pinned. Clicking the
              text jumps straight to that message in the conversation below
              (see scrollToMessage) instead of just naming it. */}
          {currentPin && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-purple-100 dark:border-gray-700 bg-purple-50/50 dark:bg-gray-800/50">
              <PinAngleFill size={11} className="text-purple-500 shrink-0" />
              <Tooltip label="Lompat ke Pesan" detail="Lompat ke pesan yang disematkan ini." wrapperClassName="flex-1 min-w-0">
                <button
                  onClick={() => scrollToMessage(currentPin.id)}
                  className="flex-1 min-w-0 text-left text-[11px] text-gray-600 dark:text-gray-300 truncate cursor-pointer hover:text-purple-700 dark:hover:text-purple-300"
                >
                  {currentPin.text ? renderWithMentions(currentPin.text, localUserId) : currentPin.attachmentName ? `📎 ${currentPin.attachmentName}` : 'Pesan disematkan'}
                </button>
              </Tooltip>
              {pinnedMessages.length > 1 && (
                <div className="flex items-center gap-0.5 shrink-0 text-gray-400">
                  <Tooltip label="Sebelumnya" detail="Lihat pesan sematan sebelumnya.">
                    <button onClick={() => setPinCursor((c) => c - 1)} className="w-4 h-4 inline-flex items-center justify-center hover:text-purple-600 cursor-pointer">
                      <ChevronLeft size={9} />
                    </button>
                  </Tooltip>
                  <span className="text-[9px]">{pinIndex + 1}/{pinnedMessages.length}</span>
                  <Tooltip label="Berikutnya" detail="Lihat pesan sematan berikutnya.">
                    <button onClick={() => setPinCursor((c) => c + 1)} className="w-4 h-4 inline-flex items-center justify-center hover:text-purple-600 cursor-pointer">
                      <ChevronRight size={9} />
                    </button>
                  </Tooltip>
                </div>
              )}
              {isAdmin && (
                <Tooltip label="Lepas Sematan" detail="Batalkan status sematan pesan ini. (Khusus admin.)">
                  <button
                    onClick={() => onPinMessage?.(currentPin.id, false)}
                    className="w-4 h-4 shrink-0 inline-flex items-center justify-center text-gray-400 hover:text-red-500 cursor-pointer"
                  >
                    <XLg size={9} />
                  </button>
                </Tooltip>
              )}
            </div>
          )}

          <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto p-3 space-y-2 text-xs"
          >
            {!viewingZone && hasMoreOlder && messages.length > 0 && (
              <Tooltip label="Muat Pesan Lama" detail="Tampilkan pesan-pesan sebelumnya di channel ini." wrapperClassName="w-full">
                <button
                  onClick={handleLoadOlder}
                  disabled={loadingOlder}
                  className="w-full text-center text-[10px] text-purple-500 hover:text-purple-700 disabled:opacity-50 cursor-pointer py-1"
                >
                  {loadingOlder ? 'Loading...' : 'Load older messages'}
                </button>
              </Tooltip>
            )}

            {viewingZone
              ? zoneMessages.filter((m) => m.isBot || !isMutedSender(m.senderId)).map((m) => {
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
                      {m.text && <span className={`break-words select-text ${m.isBot ? 'whitespace-pre-line' : ''}`}>{renderWithMentions(m.text, localUserId)}</span>}
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
              : messages.filter((m) => !isMutedSender(m.senderId)).map((m) => {
                  const isOwn = m.senderId === localUserId;
                  const isMentioned = textMentionsUser(m.text, localUserId);
                  return (
                    <div
                      key={m.id}
                      data-message-id={m.id}
                      className={`rounded-lg transition-colors duration-500 ${highlightedId === m.id ? 'bg-amber-200/60 dark:bg-amber-500/20' : ''}`}
                    >
                      <MessageBubble
                        isOwn={isOwn}
                        name={profileByUser.get(m.senderId)?.name || m.senderName}
                        color={avatarColor(m.senderId || m.senderName)}
                        photoUrl={profileByUser.get(m.senderId)?.photo ?? undefined}
                        time={m.createdAt}
                        mentioned={isMentioned}
                        pinned={m.isPinned}
                        onContextMenu={(e) => { e.preventDefault(); setMsgMenu({ x: e.clientX, y: e.clientY, message: m }); }}
                        actions={
                          <>
                            <Tooltip label="Balas" detail="Lihat atau tambahkan balasan pada pesan ini.">
                              <button
                                onClick={() => toggleThread(m.id)}
                                className="text-[10px] text-purple-500 hover:text-purple-700 cursor-pointer inline-flex items-center gap-1"
                              >
                                <ChatLeftText size={9} />
                                {m.replyCount ? `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}` : 'Reply'}
                              </button>
                            </Tooltip>
                            {isOwn && onEditMessage && m.text && editingId !== m.id && (
                              <Tooltip label="Edit" detail="Ubah isi pesanmu.">
                                <button
                                  onClick={() => beginEdit(m.id, m.text)}
                                  className="text-[10px] text-gray-400 hover:text-purple-600 cursor-pointer inline-flex items-center gap-1"
                                >
                                  <PencilFill size={9} /> Edit
                                </button>
                              </Tooltip>
                            )}
                            {isOwn && onDeleteMessage && (
                              <Tooltip label="Hapus" detail="Hapus pesan ini.">
                                <button
                                  onClick={async () => { if (await showConfirm('Hapus pesan ini?', { danger: true })) onDeleteMessage(m.id); }}
                                  className="text-[10px] text-gray-400 hover:text-red-500 cursor-pointer inline-flex items-center gap-1"
                                >
                                  <TrashFill size={9} /> Delete
                                </button>
                              </Tooltip>
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
                            <span className="break-words select-text">
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
                          <Tooltip label="Coba Lagi" detail="Pesan gagal terkirim — klik untuk kirim ulang.">
                            <button
                              type="button"
                              onClick={() => onRetry?.(m)}
                              className="mt-0.5 flex items-center gap-1 text-[9px] text-red-300 hover:text-red-100 cursor-pointer"
                            >
                              <ExclamationTriangleFill size={9} /> Gagal terkirim — coba lagi <ArrowClockwise size={9} />
                            </button>
                          </Tooltip>
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
                                    <Tooltip label="Edit" detail="Ubah isi balasanmu.">
                                      <button onClick={() => beginEdit(r.id, r.text)} className="text-gray-400 hover:text-purple-600 cursor-pointer">
                                        <PencilFill size={9} />
                                      </button>
                                    </Tooltip>
                                  )}
                                  {onDeleteMessage && (
                                    <Tooltip label="Hapus" detail="Hapus balasan ini.">
                                      <button onClick={async () => { if (await showConfirm('Hapus balasan ini?', { danger: true })) onDeleteMessage(r.id); }} className="text-gray-400 hover:text-red-500 cursor-pointer">
                                        <TrashFill size={9} />
                                      </button>
                                    </Tooltip>
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
                            <Tooltip label="Kirim Balasan" detail="Kirim balasanmu di thread ini.">
                              <button
                                onClick={() => handleSendReply(m.id)}
                                disabled={!replyText.trim()}
                                className="bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white text-[11px] px-2 py-1 rounded cursor-pointer"
                              >
                                Send
                              </button>
                            </Tooltip>
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
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10">
              <Tooltip label="Pesan Baru" detail="Ada pesan baru — klik untuk scroll ke bawah.">
                <button
                  onClick={() => scrollToBottom(true)}
                  className="bg-purple-600 hover:bg-purple-700 text-white text-[10px] font-medium px-2.5 py-1 rounded-full shadow-lg cursor-pointer flex items-center gap-1"
                >
                  Pesan baru ↓
                </button>
              </Tooltip>
            </div>
          )}
          </div>

          {showEmoji && (
            <div className="px-3 pb-2 flex flex-wrap gap-1">
              {COMMON_EMOJIS.map((e) => (
                <button key={e} onClick={() => insertEmoji(e)} className="hover:bg-purple-50 dark:hover:bg-gray-700 rounded p-0.5 text-sm cursor-pointer">{e}</button>
              ))}
            </div>
          )}

          <AttachmentTray items={pendingAttachments.items} onRemove={pendingAttachments.remove} />
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
            <Tooltip label="Emoji" detail="Tambahkan emoji ke pesanmu.">
              <button onClick={() => setShowEmoji(!showEmoji)} className="cursor-pointer"><img src="/assets/img/icons/emoticon.svg" width={16} height={16} alt="" /></button>
            </Tooltip>
            {/* Potongan C3 — file attachments work for zone (Private) chat
                too, not just persisted Channel/DM. */}
            <AttachmentMenuButton
              onFile={handleAttachFile}
              title="Lampirkan File"
              detail="Kirim gambar, video, atau dokumen."
              disabled={zoneFileUploading}
              buttonClassName="text-purple-600 dark:text-purple-400 disabled:opacity-40 cursor-pointer"
            />
            <div className="relative flex-1">
              {/* Potongan C2 — @mention candidates, #general (persisted
                  channel/DM) only: zone chat has no real userId-backed
                  participant list to mention from. */}
              {mention && !viewingZone && (
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
              <textarea
                ref={messageInputRef}
                rows={1}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  updateMentionState(e.target.value, e.target.selectionStart ?? e.target.value.length);
                  // Only the persisted channel/DM path has a typing indicator —
                  // zone chat is a different, ephemeral concept.
                  if (e.target.value && !viewingZone) onTyping?.();
                  // Auto-grow with content, capped at MAX_COMPOSE_HEIGHT_PX —
                  // reset to 'auto' first so it can shrink back down too
                  // (deleting text), not just grow.
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, MAX_COMPOSE_HEIGHT_PX)}px`;
                }}
                onKeyDown={(e) => {
                  if (mention && mentionCandidates.length > 0) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionActiveIndex((i) => (i + 1) % mentionCandidates.length); return; }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setMentionActiveIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length); return; }
                    if (e.key === 'Enter') { e.preventDefault(); insertMention(mentionCandidates[mentionActiveIndex]); return; }
                    if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
                  }
                  // Unchanged from the old <input>: Enter always sends (no
                  // Shift+Enter newline support — out of scope here, this is
                  // only fixing the overflow, not adding multi-line compose).
                  if (e.key === 'Enter') { e.preventDefault(); handleSend(); }
                }}
                onBlur={() => setMention(null)}
                onPaste={handlePaste}
                placeholder={viewingZone ? `Message ${currentZone?.name}...` : 'enter your chat here'}
                maxLength={200}
                className="font-login-body w-full resize-none break-words bg-login-surface dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-xs rounded px-2 py-1.5 outline-none border border-login-border-soft dark:border-gray-700 focus:border-login-accent disabled:opacity-60"
              />
            </div>
            <Tooltip label="Kirim" detail="Kirim pesanmu.">
              <button
                onClick={handleSend}
                disabled={!text.trim() && pendingAttachments.items.length === 0}
                className="bg-login-accent hover:brightness-110 disabled:opacity-40 text-white text-xs w-7 h-7 shrink-0 rounded flex items-center justify-center cursor-pointer"
              >
                <img src="/assets/img/icons/send.svg" width={14} height={14} alt="" />
              </button>
            </Tooltip>
          </div>
          </>
          )}
        </div>
      )}
      {lightbox && <AttachmentLightbox target={lightbox} onClose={() => setLightbox(null)} />}
      {/* Right-click menu for a persisted channel/DM message — pin/unpin the
          thread bookmark, optionally promote to the room's Notice board
          (admin only, same action as the old bare right-click), and see
          exactly who has read this message. A full-screen backdrop closes it
          on any outside click/right-click. */}
      {/* Portaled straight to document.body — ChatPanel's own root has
          backdrop-blur-md (line ~430), and CSS filter/backdrop-filter
          establishes a new containing block for `position: fixed`
          descendants. Left un-portaled, this menu's "fixed" coordinates
          would be measured from the panel's own corner instead of the
          actual viewport, landing it off-screen or visually stuck behind
          the panel instead of on top of everything. */}
      {msgMenu && createPortal(
        <div
          className="fixed inset-0 z-[1000]"
          onClick={() => setMsgMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setMsgMenu(null); }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'fixed', left: Math.min(msgMenu.x, window.innerWidth - 220), top: Math.min(msgMenu.y, window.innerHeight - 260) }}
            className="z-[1001] w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl py-1 text-xs"
          >
            {/* Right-click → Copy, same as any desktop chat app — text is
                already Ctrl+C-selectable (select-text above), but this menu
                itself preventDefault()s the browser's own native "Copy" item,
                so without this there was no right-click way to copy at all. */}
            {msgMenu.message.text && (
              <Tooltip label="Salin Teks" detail="Salin isi pesan ini ke clipboard." wrapperClassName="w-full">
                <button
                  onClick={async () => {
                    try { await navigator.clipboard.writeText(msgMenu.message.text); } catch { /* clipboard permission denied — text stays selectable via Ctrl+C as a fallback */ }
                    setMsgMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 cursor-pointer text-gray-700 dark:text-gray-200"
                >
                  <Clipboard size={11} /> Salin teks
                </button>
              </Tooltip>
            )}
            {isAdmin && onPinMessage && (
              <Tooltip label={msgMenu.message.isPinned ? 'Lepas Sematan' : 'Sematkan'} detail="Sematkan pesan ini di channel. (Khusus admin.)" wrapperClassName="w-full">
                <button
                  onClick={() => { onPinMessage(msgMenu.message.id, !msgMenu.message.isPinned); setMsgMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 cursor-pointer text-gray-700 dark:text-gray-200"
                >
                  {msgMenu.message.isPinned ? <PinAngleFill size={11} className="text-indigo-500" /> : <PinAngle size={11} />}
                  {msgMenu.message.isPinned ? 'Lepas sematan' : 'Sematkan pesan'}
                </button>
              </Tooltip>
            )}
            {isAdmin && onPinNotice && (
              <Tooltip label="Jadikan Pengumuman" detail="Tampilkan pesan ini sebagai banner untuk semua orang. (Khusus admin.)" wrapperClassName="w-full">
                <button
                  onClick={() => { onPinNotice(msgMenu.message); setMsgMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 cursor-pointer text-gray-700 dark:text-gray-200"
                >
                  <MegaphoneFill size={11} /> Jadikan pengumuman
                </button>
              </Tooltip>
            )}
            {/* Full "who's read this" list — admin sees it on ANY message;
                a regular member only on their OWN ("cuma bisa inspek diri
                kita sendiri" — inspecting yourself means seeing who's read
                what YOU sent, not just a count). Nothing shown at all for
                someone else's message if you're not admin. */}
            {(isAdmin || msgMenu.message.senderId === localUserId) && (
              <>
                <div className="px-3 pt-1.5 pb-1 text-[10px] font-medium text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-700 mt-1">
                  Dibaca oleh
                </div>
                <div className="max-h-32 overflow-y-auto">
                  {(() => {
                    const readers = readersOf(msgMenu.message);
                    if (readers.length === 0) {
                      return <div className="px-3 py-1 text-gray-400 dark:text-gray-500">Belum ada yang membaca</div>;
                    }
                    return readers.map((n, i) => (
                      <div key={i} className="px-3 py-1 text-gray-600 dark:text-gray-300">{n}</div>
                    ));
                  })()}
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
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
  pinned,
  onContextMenu,
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
  // Zone chat's own right-click shortcut: straight to "pin as Notice", no
  // menu. Ignored when onContextMenu is passed (persisted channel/DM
  // messages below use the fuller menu instead — see ChatMessageMenu).
  pinnable?: boolean;
  onPin?: () => void;
  // Thread-pin indicator (ChatMessage.isPinned, see MESSAGE_PIN) — distinct
  // from pinnable/onPin above, which is the room Notice board.
  pinned?: boolean;
  onContextMenu?: (e: MouseEvent) => void;
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
          onContextMenu={onContextMenu ?? (pinnable ? (e) => { e.preventDefault(); onPin?.(); } : undefined)}
          title={onContextMenu ? 'Klik kanan untuk opsi (sematkan, lihat yang sudah baca)' : pinnable ? 'Right-click to pin as notice' : undefined}
          className={`min-w-0 rounded-2xl px-2.5 py-1.5 ${isOwn ? 'rounded-br-sm' : 'rounded-bl-sm'} ${onContextMenu || pinnable ? 'cursor-context-menu' : ''} ${bodyText} ${
            isBot
              ? 'bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800'
              : mentioned ? 'bg-amber-100 dark:bg-amber-900/40' : isOwn ? 'bg-purple-600' : 'bg-gray-100 dark:bg-gray-700'
          }`}
        >
          {!isOwn && <div className="font-semibold text-[11px] mb-0.5 leading-tight" style={{ color }}>{name}</div>}
          {children}
          <div className={`text-[9px] mt-0.5 flex items-center gap-1 ${isOwn ? 'text-purple-200 justify-end' : 'text-gray-400 dark:text-gray-500'}`}>
            {pinned && <PinAngleFill size={8} className={isOwn ? 'text-purple-100' : 'text-indigo-500'} title="Disematkan" />}
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
        <Tooltip label={fileName || 'Attachment'} detail="Buka gambar ukuran penuh." wrapperClassName="w-full h-full">
          <button type="button" onClick={onOpen} className="block w-full h-full cursor-pointer">
            <img
              src={url}
              alt={fileName || 'Attachment'}
              onLoad={() => setState('loaded')}
              onError={() => setState('failed')}
              className={`w-full h-full object-cover transition-opacity ${state === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
            />
          </button>
        </Tooltip>
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
        <div className="absolute bottom-1 right-1 w-5 h-5">
          <Tooltip label="Unduh" detail="Simpan gambar ini." wrapperClassName="w-5 h-5">
            <a
              href={url}
              download={fileName}
              onClick={(e) => e.stopPropagation()}
              className="w-5 h-5 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center cursor-pointer"
            >
              <Download size={10} />
            </a>
          </Tooltip>
        </div>
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
      <Tooltip label="Putar Video" detail="Putar video ini.">
        <button type="button" onClick={open} className="relative block mt-1 cursor-pointer w-48">
          <video src={url} muted preload="metadata" className="w-48 rounded bg-black pointer-events-none" />
          <span className="absolute inset-0 flex items-center justify-center">
            <PlayCircleFill size={34} className="text-white/90 drop-shadow" />
          </span>
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label="Buka File" detail="Buka atau unduh file ini." wrapperClassName="w-full">
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
    </Tooltip>
  );
}
