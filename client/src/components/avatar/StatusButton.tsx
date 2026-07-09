import { useState, useRef, useEffect } from 'react';
import { ChatDotsFill } from 'react-bootstrap-icons';

interface StatusButtonProps {
  status: string;
  onSave: (status: string) => void;
  // 'sidebar': icon-only trigger, popover opens to the right (see Sidebar.tsx).
  // Omit (or 'standalone') for the original labeled floating button.
  variant?: 'standalone' | 'sidebar';
}

const QUICK_STATUSES = ['WFH', '🎧 Focus', 'In a meeting', '☕ Break', 'Available'];

export function StatusButton({ status, onSave, variant = 'standalone' }: StatusButtonProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(status);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(status);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, status]);

  const handleSave = () => {
    onSave(value.trim().slice(0, 24));
    setOpen(false);
  };

  const handleQuickPick = (s: string) => {
    onSave(s);
    setOpen(false);
  };

  const isSidebar = variant === 'sidebar';

  return (
    <div className={isSidebar ? 'relative' : 'absolute bottom-16 left-4 z-30 pointer-events-auto'}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={isSidebar ? (status || 'Set Status') : undefined}
        className={
          isSidebar
            ? `w-10 h-10 rounded-lg flex items-center justify-center transition-all cursor-pointer ${status ? 'text-purple-700 bg-purple-50' : 'text-purple-700 hover:bg-purple-50'}`
            : 'bg-white/90 backdrop-blur-sm hover:bg-white text-purple-700 hover:text-purple-800 text-xs font-medium px-3 py-2 rounded-lg border border-purple-200 shadow-sm transition-all cursor-pointer inline-flex items-center gap-1.5'
        }
      >
        <ChatDotsFill size={isSidebar ? 16 : 12} /> {!isSidebar && (status || 'Set Status')}
      </button>

      {open && (
        <div
          className={isSidebar ? 'absolute top-0 left-full ml-2 w-56 bg-white rounded-xl border border-purple-100 shadow-xl p-3 z-40' : 'absolute bottom-11 left-0 w-56 bg-white rounded-xl border border-purple-100 shadow-xl p-3'}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-2">Custom Status</p>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value.slice(0, 24))}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            placeholder="e.g. WFH, In a meeting"
            maxLength={24}
            className="w-full bg-purple-50/50 text-gray-900 placeholder-gray-400 text-xs rounded-lg px-3 py-2 mb-2 outline-none border border-purple-100 focus:border-purple-500"
          />
          <div className="flex flex-wrap gap-1 mb-3">
            {QUICK_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => handleQuickPick(s)}
                className="px-2 py-1 rounded-full bg-purple-50 text-purple-700 text-[10px] hover:bg-purple-100 cursor-pointer"
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { onSave(''); setOpen(false); }}
              className="flex-1 py-1.5 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 text-xs cursor-pointer"
            >
              Clear
            </button>
            <button
              onClick={handleSave}
              className="flex-1 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium cursor-pointer"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
