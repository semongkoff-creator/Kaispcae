import { PencilFill } from 'react-bootstrap-icons';

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
        className="w-10 h-10 rounded-lg flex items-center justify-center text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-700 transition-all cursor-pointer"
      >
        <PencilFill size={16} />
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
