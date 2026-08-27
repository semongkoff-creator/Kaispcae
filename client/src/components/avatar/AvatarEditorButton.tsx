import { PencilFill } from 'react-bootstrap-icons';
import { Icon } from '@iconify/react';

interface AvatarEditorButtonProps {
  onClick: () => void;
  // 'sidebar': icon-only, sized/styled to sit inside Sidebar.tsx's rail.
  // Omit (or 'standalone') for the original labeled floating button.
  variant?: 'standalone' | 'sidebar';
}

export function AvatarEditorButton({ onClick, variant = 'standalone' }: AvatarEditorButtonProps) {
  if (variant === 'sidebar') {
    return (
      <button
        onClick={onClick}
        title="Edit Avatar"
        className="w-8 h-8 rounded-lg flex items-center justify-center text-login-accent dark:text-purple-300 hover:bg-login-surface dark:hover:bg-gray-700 transition-all cursor-pointer"
      >
        {/* Figma workspace restyle (kxCY7H7D8ZHzGkMCBDA2Y8, node 6:200) — sidebar
            variant only; the standalone floating button below keeps its
            original icon, not requested for this pass. */}
        <Icon icon="solar:user-bold" width={14} height={14} />
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className="absolute bottom-4 left-4 z-30 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm hover:bg-white text-purple-700 dark:text-purple-300 hover:text-purple-800 text-xs font-medium px-3 py-2 rounded-lg border border-purple-200 dark:border-gray-600 shadow-sm transition-all cursor-pointer inline-flex items-center gap-1.5"
    >
      <PencilFill size={12} /> Edit Avatar
    </button>
  );
}
