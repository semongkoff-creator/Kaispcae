import { useState } from 'react';
import { ChatDotsFill } from 'react-bootstrap-icons';

interface ChatToggleButtonProps {
  open: boolean;
  onToggle: () => void;
  unreadCount: number;
}

// Toolbar entry point for ChatPanel — previously ChatPanel rendered its own
// bottom-right trigger button; this calls the exact same toggle
// (channelChat.setChatPanelOpen, see App.tsx) so opening/closing behaves
// identically, just from the meeting toolbar instead of a separate corner.
export function ChatToggleButton({ open, onToggle, unreadCount }: ChatToggleButtonProps) {
  const [showLabel, setShowLabel] = useState(false);

  return (
    <button
      onClick={onToggle}
      onMouseEnter={() => setShowLabel(true)}
      onMouseLeave={() => setShowLabel(false)}
      className={`relative flex items-center justify-center w-11 h-11 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer ${
        open
          ? 'bg-purple-600 border-purple-500 shadow-purple-500/30'
          : 'bg-white/90 dark:bg-gray-800/90 border-purple-200/60 dark:border-white/10 shadow-purple-500/10'
      }`}
      title="Chat"
    >
      <ChatDotsFill className={open ? 'text-white' : 'text-purple-700 dark:text-purple-300'} size={18} />
      {!open && unreadCount > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold inline-flex items-center justify-center border-2 border-white dark:border-gray-900">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
      {showLabel && (
        <span className="absolute -top-8 whitespace-nowrap text-xs bg-white dark:bg-gray-800 text-purple-700 dark:text-purple-300 border border-purple-100 dark:border-gray-700 shadow-sm px-2 py-0.5 rounded">
          Chat
        </span>
      )}
    </button>
  );
}
