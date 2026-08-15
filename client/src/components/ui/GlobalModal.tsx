import { useEffect, useState } from 'react';
import { XLg } from 'react-bootstrap-icons';
import { useModalStore } from '@/stores/modalStore';

// Renders whichever alert/confirm/prompt request is current (see
// modalStore.ts) — mounted exactly once, near the app root, so
// showAlert/showConfirm/showPrompt work from anywhere without every caller
// needing to render its own overlay. Visual pattern (overlay + centered
// white/gray-800 rounded-2xl card) matches the bespoke modals already in the
// app (ReportUserModal, AwayReasonModal, SettingsPanel, etc.) — this is the
// first version of that pattern pulled out somewhere reusable, not a second
// competing modal system.
export function GlobalModal() {
  const request = useModalStore((s) => s.request);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    if (request?.kind === 'prompt') setInputValue(request.defaultValue ?? '');
  }, [request]);

  // Esc always means "cancel" — same result shape window.prompt/confirm
  // gave when a user dismissed them without answering (null / false).
  useEffect(() => {
    if (!request) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (request.kind === 'alert') request.resolve();
      else if (request.kind === 'confirm') request.resolve(false);
      else request.resolve(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [request]);

  if (!request) return null;

  const cancel = () => {
    if (request.kind === 'alert') request.resolve();
    else if (request.kind === 'confirm') request.resolve(false);
    else request.resolve(null);
  };

  const defaultTitle = request.kind === 'alert' ? 'Info' : request.kind === 'confirm' ? 'Konfirmasi' : 'Masukkan';

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={cancel}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-purple-100 dark:border-gray-700 w-full max-w-sm p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">{request.title ?? defaultTitle}</h2>
          <button onClick={cancel} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
            <XLg size={16} />
          </button>
        </div>

        <p className="text-sm text-gray-700 dark:text-gray-200 mb-4 whitespace-pre-line break-words">{request.message}</p>

        {request.kind === 'prompt' && (
          <input
            type={request.inputType === 'number' ? 'number' : 'text'}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={request.placeholder}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') request.resolve(inputValue); }}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-purple-400 mb-4"
          />
        )}

        <div className="flex gap-2">
          {request.kind === 'alert' ? (
            <button
              onClick={() => request.resolve()}
              autoFocus
              className="w-full py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium cursor-pointer"
            >
              OK
            </button>
          ) : (
            <>
              <button
                onClick={cancel}
                className="flex-1 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm font-medium cursor-pointer"
              >
                {request.kind === 'confirm' ? (request.cancelLabel ?? 'Batal') : 'Batal'}
              </button>
              <button
                onClick={() => (request.kind === 'confirm' ? request.resolve(true) : request.resolve(inputValue))}
                autoFocus
                className={`flex-1 py-2 rounded-lg text-white text-sm font-medium cursor-pointer ${
                  request.kind === 'confirm' && request.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-purple-600 hover:bg-purple-700'
                }`}
              >
                {request.kind === 'confirm' ? (request.confirmLabel ?? 'Ya') : 'OK'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
