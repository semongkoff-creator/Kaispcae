import { create } from 'zustand';

// Promise-based replacement for window.alert/confirm/prompt — the browser's
// native dialogs blocked the whole page with a "site says" chrome that
// doesn't match KaiSpace's look, and couldn't be styled at all. A single
// GlobalModal component (mounted once, near the app root) renders whichever
// of these is current; callers just `await` the same shape of result the
// native functions returned (void / boolean / string|null), so a call site
// like `if (window.confirm(msg))` only needs to become `if (await
// showConfirm(msg))` (and its enclosing handler marked `async`) — no
// broader control-flow rewrite.
//
// Only one modal can be open at a time (`request` is a single slot, not a
// queue) — every existing call site only ever opened one at once anyway
// (native dialogs are the same way: the page is fully blocked, so there was
// never a "second" alert queued behind a visible one).

interface AlertRequest {
  kind: 'alert';
  message: string;
  title?: string;
  resolve: () => void;
}

interface ConfirmRequest {
  kind: 'confirm';
  message: string;
  title?: string;
  // Red confirm button instead of purple — for genuinely destructive actions
  // (kick, delete). Matches ReportUserModal/native call-site conventions
  // elsewhere in the app for "this can't be undone" actions.
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  resolve: (ok: boolean) => void;
}

interface PromptRequest {
  kind: 'prompt';
  message: string;
  title?: string;
  defaultValue?: string;
  placeholder?: string;
  // 'number' just switches the <input> type (browser numeric keypad on
  // mobile, spinner arrows) — the returned value is still a string, same as
  // window.prompt always returned regardless of what you typed. Callers that
  // parsed the native prompt's result with Number(...)/parseInt(...) keep
  // doing exactly that on this string, unchanged.
  inputType?: 'text' | 'number';
  resolve: (value: string | null) => void;
}

type ModalRequest = AlertRequest | ConfirmRequest | PromptRequest;

interface ModalStoreState {
  request: ModalRequest | null;
}

export const useModalStore = create<ModalStoreState>(() => ({
  request: null,
}));

function show(request: ModalRequest) {
  useModalStore.setState({ request });
}

// Called by GlobalModal once the user has acted (or the request is being
// torn down some other way) — always clears the slot before resolving, so a
// caller's `.then()`/code-after-`await` never sees `request` still set to
// the modal it just closed.
export function dismissModal<T>(resolve: (value: T) => void, value: T) {
  useModalStore.setState({ request: null });
  resolve(value);
}

export function showAlert(message: string, opts?: { title?: string }): Promise<void> {
  return new Promise((resolve) => {
    show({ kind: 'alert', message, title: opts?.title, resolve: () => dismissModal(resolve, undefined) });
  });
}

export function showConfirm(
  message: string,
  opts?: { title?: string; danger?: boolean; confirmLabel?: string; cancelLabel?: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    show({
      kind: 'confirm',
      message,
      title: opts?.title,
      danger: opts?.danger,
      confirmLabel: opts?.confirmLabel,
      cancelLabel: opts?.cancelLabel,
      resolve: (ok) => dismissModal(resolve, ok),
    });
  });
}

export function showPrompt(
  message: string,
  defaultValue?: string,
  opts?: { title?: string; placeholder?: string; inputType?: 'text' | 'number' },
): Promise<string | null> {
  return new Promise((resolve) => {
    show({
      kind: 'prompt',
      message,
      defaultValue,
      title: opts?.title,
      placeholder: opts?.placeholder,
      inputType: opts?.inputType,
      resolve: (value) => dismissModal(resolve, value),
    });
  });
}
