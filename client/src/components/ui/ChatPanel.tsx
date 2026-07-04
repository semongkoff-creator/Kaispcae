import { useState, useRef, useEffect, useCallback } from 'react';
import { ChatMessage, EMOTE_EMOJI, EMOTE_LIST, EmoteType } from '@virtualmeet/shared';

const COMMON_EMOJIS = ['😀','😂','❤️','👍','🔥','🎉','😢','😡','🤔','👋','💯','✨'];

interface ChatPanelProps {
  messages: ChatMessage[];
  localPlayerName: string;
  onSend: (text: string, isProximity?: boolean) => void;
  onBubble: (text: string) => void;
  onEmote: (emote: EmoteType) => void;
  // When set, the local player is standing inside a zone that has its own
  // private chat — the "Private" tab appears automatically while true and
  // disappears (falling back to "All") once they leave.
  currentZone?: { id: string; name: string } | null;
  zoneMessages?: ChatMessage[];
  onSendZone?: (text: string, zoneId: string) => void;
}

export function ChatPanel({ messages, localPlayerName, onSend, onBubble, onEmote, currentZone, zoneMessages = [], onSendZone }: ChatPanelProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [proximityMode, setProximityMode] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [activeTab, setActiveTab] = useState<'all' | 'private'>('all');
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fall back to "All" the moment there's no zone chat to show anymore.
  useEffect(() => {
    if (!currentZone && activeTab === 'private') setActiveTab('all');
  }, [currentZone, activeTab]);

  const visibleMessages = activeTab === 'private' ? zoneMessages : messages;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleMessages]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (activeTab === 'private' && currentZone && onSendZone) {
      onSendZone(trimmed, currentZone.id);
    } else if (proximityMode) {
      onBubble(trimmed);
    } else {
      onSend(trimmed);
    }
    setText('');
    setShowEmoji(false);
  }, [text, proximityMode, onSend, onBubble, activeTab, currentZone, onSendZone]);

  const insertEmoji = (emoji: string) => {
    setText((prev) => prev + emoji);
  };

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className="absolute bottom-4 right-4 z-50 bg-white/90 backdrop-blur-sm px-3 py-2 rounded-lg text-sm text-purple-700 hover:text-purple-800 border border-purple-200 shadow-sm cursor-pointer pointer-events-auto"
      >
        💬 {open ? 'Hide' : 'Chat'}
      </button>

      {open && (
        <div
          className="absolute bottom-16 right-4 z-50 w-72 h-96 bg-white/95 backdrop-blur-md rounded-xl border border-purple-100 shadow-2xl flex flex-col pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="p-3 border-b border-purple-100 flex items-center justify-between">
            <span className="text-gray-900 text-sm font-medium">Chat</span>
            <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" checked={proximityMode} onChange={(e) => setProximityMode(e.target.checked)} className="w-3 h-3 accent-purple-600" />
              Bubble
            </label>
          </div>

          {currentZone && (
            <div className="flex gap-1 px-3 pt-2">
              <button
                onClick={() => setActiveTab('all')}
                className={`flex-1 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                  activeTab === 'all' ? 'bg-purple-600 text-white' : 'bg-purple-50 text-gray-500 hover:bg-purple-100'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setActiveTab('private')}
                className={`flex-1 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                  activeTab === 'private' ? 'bg-purple-600 text-white' : 'bg-purple-50 text-gray-500 hover:bg-purple-100'
                }`}
                title={`Private to ${currentZone.name}`}
              >
                🔒 {currentZone.name}
              </button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-3 space-y-1.5 text-xs">
            {visibleMessages.slice(-50).map((m) => {
              const isMentioned = m.text.includes(`@${localPlayerName}`);
              const isOwn = m.senderName === localPlayerName;
              return (
                <div
                  key={m.id}
                  className={`rounded-lg px-2 py-1 ${
                    isMentioned ? 'bg-amber-100' : isOwn ? 'bg-purple-600' : 'bg-gray-100'
                  }`}
                >
                  <span className={`font-mono text-[10px] mr-1 ${isOwn ? 'text-purple-200' : 'text-gray-400'}`}>
                    {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: m.senderColor }} />
                  <span className={`font-medium ${isOwn ? 'text-purple-100' : 'text-gray-500'}`}>{m.senderName}</span>
                  {m.isProximity && <span className={`ml-1 text-[10px] ${isOwn ? 'text-purple-200' : 'text-gray-400'}`}>(nearby)</span>}
                  <span className={`ml-1 break-words ${isOwn ? 'text-white' : 'text-gray-900'}`}>{m.text}</span>
                </div>
              );
            })}
            {visibleMessages.length === 0 && (
              <p className="text-gray-400 text-center mt-4">
                {activeTab === 'private' ? `No messages in ${currentZone?.name} yet.` : 'No messages yet.'}
              </p>
            )}
            <div ref={bottomRef} />
          </div>

          {showEmoji && (
            <div className="px-3 pb-2 flex flex-wrap gap-1">
              {COMMON_EMOJIS.map((e) => (
                <button key={e} onClick={() => insertEmoji(e)} className="hover:bg-purple-50 rounded p-0.5 text-sm cursor-pointer">{e}</button>
              ))}
            </div>
          )}

          <div className="p-3 border-t border-purple-100 flex gap-2 items-center">
            <button onClick={() => setShowEmoji(!showEmoji)} className="text-sm cursor-pointer">😊</button>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder={activeTab === 'private' ? `Message ${currentZone?.name}...` : proximityMode ? 'Say nearby...' : 'Type a message...'}
              maxLength={200}
              className="flex-1 bg-purple-50/50 text-gray-900 placeholder-gray-400 text-xs rounded px-2 py-1.5 outline-none border border-purple-100 focus:border-purple-500"
            />
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
    </>
  );
}
