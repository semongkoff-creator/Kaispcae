import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { XLg, ChatDotsFill, PersonWalking, ArrowRepeat } from 'react-bootstrap-icons';
import { AvatarConfig } from '@virtualmeet/shared';
import { Avatar } from '@/components/Messenger/chatVisuals';

interface PlayerCardProps {
  name: string;
  seed: string;
  avatarConfig?: AvatarConfig;
  // Click point on screen (page coordinates) the card should appear near —
  // the clicked avatar's own on-screen position, from GameCanvas's click
  // handler. Actual placement is clamped into the viewport below.
  anchorX: number;
  anchorY: number;
  // Each action is undefined (not a no-op) when unavailable for this player
  // — same "don't render, don't disable" convention ParticipantPanel uses
  // for its own per-row menu (e.g. a guest has no userId to DM/follow).
  onSendMessage?: () => void;
  isFollowingThem?: boolean;
  onFollow?: () => void;
  onUnfollow?: () => void;
  onCopyOutfit?: () => void;
  onClose: () => void;
}

const MARGIN = 8;

// ZEP-style card that opens where you click another player's avatar on the
// map (see GameCanvas.tsx's onCanvasClick hit-test). Positioning mirrors
// Tooltip.tsx's own technique — render off-screen first, measure the card's
// real size via useLayoutEffect, then clamp into the viewport — so a click
// near any screen edge never pushes the card out of view. Close-on-outside-
// click/Escape mirrors DeviceMenu.tsx's identical convention ("like every
// other popover in the HUD").
export function PlayerCard({
  name,
  seed,
  avatarConfig,
  anchorX,
  anchorY,
  onSendMessage,
  isFollowingThem,
  onFollow,
  onUnfollow,
  onCopyOutfit,
  onClose,
}: PlayerCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchorX - rect.width / 2;
    let top = anchorY - rect.height - 16; // open above the clicked avatar, like a speech bubble
    left = Math.min(Math.max(left, MARGIN), vw - rect.width - MARGIN);
    top = Math.min(Math.max(top, MARGIN), vh - rect.height - MARGIN);
    setStyle({ top, left });
  }, [anchorX, anchorY]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={cardRef}
      style={{ position: 'fixed', top: style?.top ?? -9999, left: style?.left ?? -9999, visibility: style ? 'visible' : 'hidden' }}
      className="relative z-[95] w-56 bg-white/95 dark:bg-gray-900/95 backdrop-blur-md rounded-xl border border-purple-100 dark:border-gray-700 shadow-2xl p-3"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        onClick={onClose}
        title="Tutup"
        className="absolute top-2 right-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
      >
        <XLg size={12} />
      </button>

      <div className="flex flex-col items-center gap-1.5 pt-1 pb-2">
        <Avatar name={name} seed={seed} size={56} />
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 text-center break-words max-w-full">{name}</span>
      </div>

      <div className="flex flex-col gap-1">
        {onSendMessage && (
          <button
            onClick={onSendMessage}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-800 cursor-pointer"
          >
            <ChatDotsFill size={13} className="text-purple-600 dark:text-purple-400" /> Send Message
          </button>
        )}
        {isFollowingThem ? (
          onUnfollow && (
            <button
              onClick={onUnfollow}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-800 cursor-pointer"
            >
              <PersonWalking size={13} className="text-red-500" /> Berhenti Mengikuti
            </button>
          )
        ) : (
          onFollow && (
            <button
              onClick={onFollow}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-800 cursor-pointer"
            >
              <PersonWalking size={13} className="text-purple-600 dark:text-purple-400" /> Follow
            </button>
          )
        )}
        {onCopyOutfit && avatarConfig && (
          <button
            onClick={onCopyOutfit}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-800 cursor-pointer"
          >
            <ArrowRepeat size={13} className="text-purple-600 dark:text-purple-400" /> Copy Outfit
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}
