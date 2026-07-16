import { useState, useRef, useEffect, useCallback } from 'react';
import { ChatDotsFill, LockFill, EmojiSmile, PlusLg, ChatLeftText, Paperclip, FileEarmarkFill, Download, TrashFill } from 'react-bootstrap-icons';
import { ChatMessage, ChannelMessage, Channel, DirectConversationSummary, EmoteType } from '@virtualmeet/shared';
import { api } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';

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
  onSendZone?: (text: string, zoneId: string) => void;
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
  // Throttled ping while composing, for the "X is typing…" indicator.
  onTyping?: () => void;
  // Delete one of your own persisted channel/DM messages (see MESSAGE_DELETE).
  onDeleteMessage?: (messageId: string) => void;
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
  onTyping,
  onDeleteMessage,
  onLoadOlder,
  onCreateChannel,
}: ChatPanelProps) {
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
  const [uploadingFile, setUploadingFile] = useState(false);
  const [attachError, setAttachError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fall back to the channel/DM view the moment there's no zone chat left.
  useEffect(() => {
    if (!currentZone && viewingZone) setViewingZone(false);
  }, [currentZone, viewingZone]);

  const visibleMessages = viewingZone ? zoneMessages : messages;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleMessages.length]);

  // Switching targets means a fresh scrollback — reset thread/pagination UI.
  useEffect(() => {
    setExpandedThreadId(null);
    setHasMoreOlder(true);
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
  }, [text, proximityMode, onSend, onBubble, viewingZone, currentZone, onSendZone]);

  const insertEmoji = (emoji: string) => {
    setText((prev) => prev + emoji);
  };

  // Reuses the same POST /api/uploads endpoint Add Media uses (see
  // server/src/routes/uploads.ts) — same 10MB limit and mime allowlist,
  // just sent as its own chat message (empty text + attachment) instead of
  // a map object. Only available for persisted Channel/DM tabs: zone/bubble
  // chat (ChatMessage) has no attachment field at all.
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // let picking the same file twice in a row re-fire onChange
      if (!file) return;
      setAttachError('');
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachError('File is too large — max 10MB.');
        return;
      }
      setUploadingFile(true);
      try {
        const { url, fileName } = await api.uploadMedia(file);
        onSend('', undefined, { url, fileName });
      } catch (err) {
        console.error('[chat] file upload failed:', err);
        setAttachError('Upload failed — check the file type and try again.');
      } finally {
        setUploadingFile(false);
      }
    },
    [onSend]
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

          <div className="flex-1 overflow-y-auto p-3 space-y-1.5 text-xs">
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
                  const isMentioned = m.text.includes(`@${localPlayerName}`);
                  const isOwn = m.senderName === localPlayerName;
                  return (
                    <div
                      key={m.id}
                      onContextMenu={isAdmin && onPinNotice ? (e) => { e.preventDefault(); onPinNotice(m); } : undefined}
                      title={isAdmin && onPinNotice ? 'Right-click to pin as notice' : undefined}
                      className={`rounded-lg px-2 py-1 ${isAdmin && onPinNotice ? 'cursor-context-menu' : ''} ${
                        isMentioned ? 'bg-amber-100 dark:bg-amber-900/40' : isOwn ? 'bg-purple-600' : 'bg-gray-100 dark:bg-gray-700'
                      }`}
                    >
                      <span className={`font-mono text-[10px] mr-1 ${isOwn ? 'text-purple-200' : 'text-gray-400 dark:text-gray-500'}`}>
                        {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: m.senderColor }} />
                      <span className={`font-medium ${isOwn ? 'text-purple-100' : 'text-gray-500 dark:text-gray-400'}`}>{m.senderName}</span>
                      {m.isProximity && <span className={`ml-1 text-[10px] ${isOwn ? 'text-purple-200' : 'text-gray-400 dark:text-gray-500'}`}>(nearby)</span>}
                      <span className={`ml-1 break-words ${isOwn ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>{m.text}</span>
                    </div>
                  );
                })
              : messages.map((m) => {
                  const isOwn = m.senderId === localUserId;
                  const isMentioned = m.text.includes(`@${localPlayerName}`);
                  return (
                    <div key={m.id}>
                      <div
                        onContextMenu={isAdmin && onPinNotice ? (e) => { e.preventDefault(); onPinNotice(m); } : undefined}
                        title={isAdmin && onPinNotice ? 'Right-click to pin as notice' : undefined}
                        className={`rounded-lg px-2 py-1 ${isAdmin && onPinNotice ? 'cursor-context-menu' : ''} ${
                          isMentioned ? 'bg-amber-100 dark:bg-amber-900/40' : isOwn ? 'bg-purple-600' : 'bg-gray-100 dark:bg-gray-700'
                        }`}
                      >
                        <span className={`font-mono text-[10px] mr-1 ${isOwn ? 'text-purple-200' : 'text-gray-400 dark:text-gray-500'}`}>
                          {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className={`font-medium ${isOwn ? 'text-purple-100' : 'text-gray-500 dark:text-gray-400'}`}>{m.senderName}</span>
                        {m.text && (
                          <span className={`ml-1 break-words ${isOwn ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>{m.text}</span>
                        )}
                        {m.attachmentUrl && (
                          <ChatAttachment url={m.attachmentUrl} fileName={m.attachmentName} isOwn={isOwn} />
                        )}
                      </div>
                      <button
                        onClick={() => toggleThread(m.id)}
                        className="ml-2 mt-0.5 text-[10px] text-purple-500 hover:text-purple-700 cursor-pointer inline-flex items-center gap-1"
                      >
                        <ChatLeftText size={9} />
                        {m.replyCount ? `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}` : 'Reply'}
                      </button>
                      {isOwn && onDeleteMessage && (
                        <button
                          onClick={() => { if (window.confirm('Delete this message?')) onDeleteMessage(m.id); }}
                          title="Delete message"
                          className="ml-2 mt-0.5 text-[10px] text-gray-400 hover:text-red-500 cursor-pointer inline-flex items-center gap-1"
                        >
                          <TrashFill size={9} /> Delete
                        </button>
                      )}

                      {expandedThreadId === m.id && (
                        <div className="ml-3 mt-1 pl-2 border-l-2 border-purple-100 dark:border-gray-700 space-y-1">
                          {threadReplies.map((r) => (
                            <div key={r.id} className="rounded bg-purple-50/50 dark:bg-gray-700/50 px-2 py-1 group/reply flex items-start justify-between gap-1">
                              <span className="min-w-0">
                                <span className="font-medium text-gray-500 dark:text-gray-400 mr-1">{r.senderName}</span>
                                <span className="text-gray-800 dark:text-gray-200 break-words">{r.text}</span>
                              </span>
                              {r.senderId === localUserId && onDeleteMessage && (
                                <button
                                  onClick={() => { if (window.confirm('Delete this reply?')) onDeleteMessage(r.id); }}
                                  title="Delete reply"
                                  className="shrink-0 text-gray-400 hover:text-red-500 cursor-pointer opacity-0 group-hover/reply:opacity-100 transition-opacity"
                                >
                                  <TrashFill size={9} />
                                </button>
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
            <div ref={bottomRef} />
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
            {/* File attachments only make sense for persisted Channel/DM
                messages — zone/bubble chat (ChatMessage) has no attachment
                field, so the button is hidden rather than silently failing. */}
            {!viewingZone && !proximityMode && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingFile}
                  title="Attach a file"
                  className="text-purple-600 dark:text-purple-400 disabled:opacity-40 cursor-pointer"
                >
                  <Paperclip size={16} />
                </button>
              </>
            )}
            <input
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                // Only the persisted channel/DM path has a typing indicator —
                // zone/bubble chat is a different, ephemeral concept.
                if (e.target.value && !viewingZone && !proximityMode) onTyping?.();
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder={uploadingFile ? 'Uploading file...' : viewingZone ? `Message ${currentZone?.name}...` : proximityMode ? 'Say nearby...' : 'Type a message...'}
              maxLength={200}
              disabled={uploadingFile}
              className="flex-1 bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-xs rounded px-2 py-1.5 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500 disabled:opacity-60"
            />
            <button
              onClick={handleSend}
              disabled={!text.trim() || uploadingFile}
              className="bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded cursor-pointer"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// Image attachments render as a clickable inline preview (opens the
// full-size image in a new tab — no in-app viewer for chat attachments,
// unlike Add Media's MediaViewerModal, since this is a much smaller/simpler
// surface); anything else renders as a compact download row instead of
// trying to guess how to preview an arbitrary file type.
function ChatAttachment({ url, fileName, isOwn }: { url: string; fileName?: string; isOwn: boolean }) {
  if (isImageAttachment(url)) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block mt-1">
        {/* Fixed box + object-cover (not max-w/max-h, which only caps large
            images and leaves a naturally-small one — a tiny icon/sticker —
            rendering at its native size, easy to miss entirely) so every
            thumbnail reads as a deliberate preview regardless of the
            original image's actual resolution. */}
        <img src={url} alt={fileName || 'Attachment'} className="w-32 h-24 rounded object-cover bg-purple-100" />
      </a>
    );
  }
  if (isVideoAttachment(url)) {
    return <video src={url} controls className="mt-1 w-48 rounded bg-black" />;
  }
  return (
    <a
      href={url}
      download={fileName}
      target="_blank"
      rel="noopener noreferrer"
      className={`mt-1 flex items-center gap-1.5 rounded px-2 py-1 text-[11px] ${
        isOwn ? 'bg-purple-700/60 text-white hover:bg-purple-700' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700'
      }`}
    >
      <FileEarmarkFill size={12} className="shrink-0" />
      <span className="truncate flex-1">{fileName || 'Download file'}</span>
      <Download size={11} className="shrink-0" />
    </a>
  );
}
