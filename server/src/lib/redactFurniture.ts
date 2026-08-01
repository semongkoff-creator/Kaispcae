import { Furniture } from '@virtualmeet/shared';

// Fitur 15B — a 'password'-type Interactive Object carries its real password
// in interactiveConfig.password. ANY furniture list handed to a normal
// player (ROOM_STATE on join, ROOM_UPDATED on a live edit) must have it
// stripped first — only the Room Editor's own admin-gated GET /editor-data
// (resolveRoomRole + room:update) ever returns the real value, so the admin
// can read/edit it. Verification never trusts a client-side compare either —
// see INTERACTIVE_PASSWORD_CHECK in roomHandler.ts, which re-reads the
// room's own stored layerData fresh rather than anything the client sent.
export function redactFurniturePasswords(furniture: Furniture[]): Furniture[] {
  return furniture.map((f) => {
    if (f.interactiveType !== 'password' || f.interactiveConfig?.password == null) return f;
    const { password: _drop, ...rest } = f.interactiveConfig;
    return { ...f, interactiveConfig: rest };
  });
}
