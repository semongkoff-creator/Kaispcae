import { useEffect, useRef, useState } from 'react';
import { Paperclip, Image, CameraVideoFill, FileEarmarkFill } from 'react-bootstrap-icons';

// Bug 11 — WhatsApp-style attachment picker: the paperclip opens a small menu
// (Gambar / Video / Dokumen) first, and each choice opens the OS file picker
// pre-filtered via the input's `accept`. "Dokumen" clears the filter so any
// file type can still be sent — the menu only makes filtering easier, it never
// restricts what's allowed. The upload itself is unchanged: the chosen File is
// handed straight to onFile (which uploads to Lark Drive via the backend, A8).

interface AttachmentMenuButtonProps {
  onFile: (file: File) => void;
  disabled?: boolean;
  // Per-surface button styling (ChatPanel is purple, MessengerApp is gray).
  buttonClassName?: string;
  iconSize?: number;
  title?: string;
}

const OPTIONS: { label: string; accept: string; Icon: typeof Image }[] = [
  { label: 'Gambar', accept: 'image/*', Icon: Image },
  { label: 'Video', accept: 'video/*', Icon: CameraVideoFill },
  // Empty accept = no filter → every file type stays selectable.
  { label: 'Dokumen', accept: '', Icon: FileEarmarkFill },
];

export function AttachmentMenuButton({ onFile, disabled, buttonClassName, iconSize = 16, title = 'Lampirkan' }: AttachmentMenuButtonProps) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape. Capture phase so an ancestor that stops
  // mousedown propagation (ChatPanel's panel wrapper does) can't swallow it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (accept: string) => {
    const input = inputRef.current;
    if (!input) return;
    input.accept = accept;
    input.click();
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={title}
        className={buttonClassName}
      >
        <Paperclip size={iconSize} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 z-50 w-36 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl py-1">
          {OPTIONS.map(({ label, accept, Icon }) => (
            <button
              key={label}
              type="button"
              onClick={() => pick(accept)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer"
            >
              <Icon size={14} className="text-purple-500 shrink-0" /> {label}
            </button>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = ''; // let re-picking the same file re-fire onChange
        }}
      />
    </div>
  );
}
