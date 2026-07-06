import { PencilFill } from 'react-bootstrap-icons';

interface AvatarEditorButtonProps {
  onClick: () => void;
}

export function AvatarEditorButton({ onClick }: AvatarEditorButtonProps) {
  return (
    <button
      onClick={onClick}
      className="absolute bottom-4 left-4 z-30 bg-white/90 backdrop-blur-sm hover:bg-white text-purple-700 hover:text-purple-800 text-xs font-medium px-3 py-2 rounded-lg border border-purple-200 shadow-sm transition-all cursor-pointer inline-flex items-center gap-1.5"
    >
      <PencilFill size={12} /> Edit Avatar
    </button>
  );
}
