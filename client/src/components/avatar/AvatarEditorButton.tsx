interface AvatarEditorButtonProps {
  onClick: () => void;
}

export function AvatarEditorButton({ onClick }: AvatarEditorButtonProps) {
  return (
    <button
      onClick={onClick}
      className="absolute bottom-4 left-4 z-30 bg-gray-800/80 backdrop-blur-sm hover:bg-gray-700 text-white/80 hover:text-white text-xs font-medium px-3 py-2 rounded-lg border border-white/10 transition-all cursor-pointer"
    >
      ✏️ Edit Avatar
    </button>
  );
}
