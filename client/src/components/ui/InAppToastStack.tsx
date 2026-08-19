import { useEffect } from 'react';
import { XLg } from 'react-bootstrap-icons';
import { useGameStore } from '@/stores/gameStore';

const AUTO_DISMISS_MS = 5000;

// The "nicer" in-app replacement for a native OS Notification() popup while
// the tab is actually visible/focused — see browserNotifications.ts's
// notifyNewMessage/notifyNudge, which push here instead of showing nothing
// at all in that case (a native popup's own chrome is 100% OS-controlled
// and can't be restyled, so there was never a way to make THAT nicer).
// Native notifications are unchanged for a backgrounded tab.
export function InAppToastStack() {
  const toasts = useGameStore((s) => s.inAppToasts);
  const dismiss = useGameStore((s) => s.dismissInAppToast);

  const nudges = toasts.filter((t) => t.variant === 'nudge');
  const defaults = toasts.filter((t) => t.variant !== 'nudge');

  return (
    <>
      <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none w-72">
        {defaults.map((t) => (
          <Toast key={t.id} icon={t.icon} title={t.title} text={t.text} variant={t.variant} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
      {/* Nudges land in top-center — a poke is meant to grab attention, so it
          gets a spot the eye naturally goes to instead of blending into the
          same corner as routine chat toasts. */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] flex flex-col items-center gap-2 pointer-events-none w-72">
        {nudges.map((t) => (
          <Toast key={t.id} icon={t.icon} title={t.title} text={t.text} variant={t.variant} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </>
  );
}

function Toast({ icon, title, text, variant, onDismiss }: { icon: string; title: string; text: string; variant: 'default' | 'nudge'; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isNudge = variant === 'nudge';

  return (
    <div
      className={`pointer-events-auto rounded-xl shadow-xl px-3.5 py-3 flex items-start gap-2.5 animate-[toast-in_0.2s_ease-out] w-full ${
        isNudge
          ? 'bg-purple-600 dark:bg-purple-700 border border-purple-400 text-white'
          : 'bg-white dark:bg-gray-900 border border-purple-100 dark:border-gray-700'
      }`}
      style={{ animationFillMode: 'backwards' }}
    >
      <span className="text-lg leading-none shrink-0 mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-semibold truncate ${isNudge ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>{title}</p>
        <p className={`text-xs mt-0.5 break-words ${isNudge ? 'text-purple-50' : 'text-gray-600 dark:text-gray-300'}`}>{text}</p>
      </div>
      <button
        onClick={onDismiss}
        title="Tutup"
        className={`shrink-0 cursor-pointer ${isNudge ? 'text-purple-200 hover:text-white' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'}`}
      >
        <XLg size={11} />
      </button>
    </div>
  );
}
