import { PinAngleFill, X } from 'react-bootstrap-icons';
import { Notice } from '@kaispace/shared';

interface NoticeBannerProps {
  notice: Notice;
  isAdmin: boolean;
  onUnpin: () => void;
}

// Persistent pinned-message banner (§1.3's "pin as notice") — distinct
// from a speech bubble (per-sender, auto-expires) and from Furniture
// banners (static signage placed via the Room Editor). Only one notice is
// pinned per room; unpinning is admin-only, same as pinning (see
// ChatPanel.tsx's right-click handler and roomHandler.ts's server-side check).
export function NoticeBanner({ notice, isAdmin, onUnpin }: NoticeBannerProps) {
  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 max-w-md pointer-events-auto">
      <div className="bg-amber-50 border border-amber-200 shadow-md rounded-full pl-3 pr-2 py-1.5 flex items-center gap-2">
        <PinAngleFill size={12} className="text-amber-600 shrink-0" />
        <span className="text-amber-900 text-xs truncate">
          <span className="font-semibold">{notice.senderName}:</span> {notice.text}
        </span>
        {isAdmin && (
          <button
            onClick={onUnpin}
            title="Unpin notice"
            className="text-amber-500 hover:text-amber-700 cursor-pointer shrink-0"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
