// Shared guard for the app's single-letter room hotkeys (E, B, M, V, H, …).
//
// Why this exists: those hotkeys listen on `window`, so they fire while the
// user is TYPING. Each handler had its own ad-hoc check for
// input/textarea — and every one of them missed `contenteditable`, which is
// what the Docs editor is. The result was real and user-visible: typing "B" in
// a document opened the emote wheel and preventDefault() ate the character,
// and pressing "E" opened the Room Editor mid-sentence.
//
// One helper, used by every hotkey, so the next one added can't forget a case.

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  // The Docs editor (ProseMirror) and any other rich-text surface.
  if (el.isContentEditable) return true;
  // A focused element inside a contenteditable subtree (e.g. a node view).
  return !!el.closest?.('[contenteditable="true"], input, textarea, select');
}

// True when a full-screen suite module (Base / Docs / Calendar / Attendance /
// Admin) is covering the room. Room hotkeys must be inert there: the user is
// in a spreadsheet or a document, not walking around the office.
export function shouldIgnoreRoomHotkey(target: EventTarget | null, moduleOpen: boolean): boolean {
  return moduleOpen || isTypingTarget(target);
}
