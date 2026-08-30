import { useEffect } from 'react';
import { XLg } from 'react-bootstrap-icons';
import { useGameStore } from '@/stores/gameStore';

const AUTO_DISMISS_MS = 5000;

// The "nicer" in-app replacement for a native OS Notification() popup while
// the tab is actually visible/focused — see browserNotifications.ts's
// notifyNewMessage, which pushes here instead of showing nothing at all in
// that case (a native popup's own chrome is 100% OS-controlled and can't be
// restyled, so there was never a way to make THAT nicer). Native
// notifications are unchanged for a backgrounded tab.
export function InAppToastStack() {
  const toasts = useGameStore((s) => s.inAppToasts);
  const dismiss = useGameStore((s) => s.dismissInAppToast);

  const nudges = toasts.filter((t) => t.variant === 'nudge');
  const defaults = toasts.filter((t) => t.variant !== 'nudge');

  return (
    <>
      <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none w-72">
        {defaults.map((t) => (
          <Toast key={t.id} icon={t.icon} title={t.title} text={t.text} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
      {/* Nudge toast — bottom-right, separate from the chat/system stack
          above. A first attempt lived top-center with a repeated 3x burst
          and purple styling and got reverted for reading as spammy; this is
          a deliberately plainer second pass — one toast per nudge, same
          quiet styling as every other toast, just placed somewhere that
          doesn't compete with the top-right stack. */}
      <div className="fixed bottom-4 right-4 z-[200] flex flex-col-reverse gap-2 pointer-events-none w-72">
        {nudges.map((t) => (
          <Toast key={t.id} icon={t.icon} title={t.title} text={t.text} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </>
  );
}

function Toast({ icon, title, text, onDismiss }: { icon: string; title: string; text: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="pointer-events-auto bg-white dark:bg-gray-900 rounded-xl shadow-xl border border-purple-100 dark:border-gray-700 px-3.5 py-3 flex items-start gap-2.5 animate-[toast-in_0.2s_ease-out]"
      style={{ animationFillMode: 'backwards' }}
    >
      <span className="text-lg leading-none shrink-0 mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate">{title}</p>
        <p className="text-xs text-gray-600 dark:text-gray-300 mt-0.5 break-words">{text}</p>
      </div>
      <button
        onClick={onDismiss}
        title="Tutup"
        className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
      >
        <XLg size={11} />
      </button>
    </div>
  );
}
