import { useState, useRef, useEffect, useCallback } from 'react';
import { ChatMessage, EMOTE_EMOJI, EMOTE_LIST, EmoteType } from '@virtualmeet/shared';

const COMMON_EMOJIS = ['😀','😂','❤️','👍','🔥','🎉','😢','😡','🤔','👋','💯','✨'];

interface ChatPanelProps {
  messages: ChatMessage[];
  localPlayerName: string;
  onSend: (text: string, isProximity?: boolean) => void;
  onBubble: (text: string) => void;
  onEmote: (emote: EmoteType) => void;
}

export function ChatPanel({ messages, localPlayerName, onSend, onBubble, onEmote }: ChatPanelProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [proximityMode, setProximityMode] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (proximityMode) {
      onBubble(trimmed);
    } else {
      onSend(trimmed);
    }
    setText('');
    setShowEmoji(false);
  }, [text, proximityMode, onSend, onBubble]);

  const insertEmoji = (emoji: string) => {
    setText((prev) => prev + emoji);
  };

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className="absolute bottom-4 right-4 z-50 bg-gray-800/90 backdrop-blur-sm px-3 py-2 rounded-lg text-sm text-white/80 hover:text-white border border-white/10 cursor-pointer pointer-events-auto"
      >
        💬 {open ? 'Hide' : 'Chat'}
      </button>

      {open && (
        <div
          className="absolute bottom-16 right-4 z-50 w-72 h-96 bg-gray-800/95 backdrop-blur-md rounded-xl border border-white/10 shadow-2xl flex flex-col pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="p-3 border-b border-white/10 flex items-center justify-between">
            <span className="text-white text-sm font-medium">Chat</span>
            <label className="flex items-center gap-1 text-xs text-white/50 cursor-pointer">
              <input type="checkbox" checked={proximityMode} onChange={(e) => setProximityMode(e.target.checked)} className="w-3 h-3" />
              Bubble
            </label>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
            {messages.slice(-50).map((m) => {
              const isMentioned = m.text.includes(`@${localPlayerName}`);
              return (
                <div key={m.id} className={`${isMentioned ? 'bg-yellow-500/10 rounded px-2 py-1 -mx-2' : ''}`}>
                  <span className="text-white/40 font-mono text-[10px] mr-1">
                    {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: m.senderColor }} />
                  <span className="text-white/70 font-medium">{m.senderName}</span>
                  {m.isProximity && <span className="text-white/30 ml-1 text-[10px]">(nearby)</span>}
                  <span className="text-white/90 ml-1 break-words">{m.text}</span>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {showEmoji && (
            <div className="px-3 pb-2 flex flex-wrap gap-1">
              {COMMON_EMOJIS.map((e) => (
                <button key={e} onClick={() => insertEmoji(e)} className="hover:bg-white/10 rounded p-0.5 text-sm cursor-pointer">{e}</button>
              ))}
            </div>
          )}

          <div className="p-3 border-t border-white/10 flex gap-2 items-center">
            <button onClick={() => setShowEmoji(!showEmoji)} className="text-sm cursor-pointer">😊</button>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder={proximityMode ? 'Say nearby...' : 'Type a message...'}
              maxLength={200}
              className="flex-1 bg-gray-700 text-white text-xs rounded px-2 py-1.5 outline-none border border-white/10 focus:border-blue-400"
            />
            <button
              onClick={handleSend}
              disabled={!text.trim()}
              className="bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded cursor-pointer"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
