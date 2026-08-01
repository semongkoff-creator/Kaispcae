import { Furniture } from '@virtualmeet/shared';

// Fitur 15B — two Interactive Object types carry a real "secret" a normal
// player must never see in their own client's data (both password and
// multiple_choice's isCorrect flags — knowing which pick is right defeats
// the point same as knowing the password does): a password-type piece's
// interactiveConfig.password, and a multiple_choice-type piece's
// options[].isCorrect. ANY furniture list handed to a normal player
// (ROOM_STATE on join, ROOM_UPDATED on a live edit) must go through this
// first — only the Room Editor's own admin-gated GET /editor-data
// (resolveRoomRole + room:update) ever returns the real values, so the admin
// can read/edit them. Verification never trusts a client-side compare
// either — see INTERACTIVE_PASSWORD_CHECK / INTERACTIVE_CHOICE_CHECK in
// roomHandler.ts, which re-read the room's own stored layerData fresh
// rather than anything the client sent.
export function redactInteractiveSecrets(furniture: Furniture[]): Furniture[] {
  return furniture.map((f) => {
    if (f.interactiveType === 'password' && f.interactiveConfig?.password != null) {
      const { password: _drop, ...rest } = f.interactiveConfig;
      return { ...f, interactiveConfig: rest };
    }
    if (f.interactiveType === 'multiple_choice' && f.interactiveConfig?.options) {
      return {
        ...f,
        interactiveConfig: { ...f.interactiveConfig, options: f.interactiveConfig.options.map((o) => ({ text: o.text, isCorrect: false })) },
      };
    }
    return f;
  });
}
