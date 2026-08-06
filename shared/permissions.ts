// Centralized role/permission layer (§2) — every permission check in this
// app (client-side UI gating AND server-side enforcement) should go
// through hasFeatureAccess() below rather than re-deriving its own ad-hoc
// role comparison. Before this file existed, each socket handler
// (roomHandler.ts, furnitureHandler.ts) independently re-checked
// `adminUserIds.has(uid)` / `uid === masterAdminUserId` inline — correct in
// each individual spot, but with no single place that says "this is what
// room:update actually requires", and (see roomHandler.ts's ROOM_UPDATE
// handler) at least one handler had NO server-side check at all, relying
// entirely on the client hiding the Room Editor button — exactly the gap
// this spec section explicitly warns about.
//
// 'guest' exists in the hierarchy for completeness (the spec's reference
// design includes anonymous participants) but is currently unreachable in
// this app — login is mandatory before joining a room (see LoginPage.tsx /
// the auth gate in App.tsx), so every real user is at least 'member'.
export type Role = 'owner' | 'admin' | 'staff' | 'member' | 'guest';

// Global, ACCOUNT-level role — orthogonal to the per-room Role hierarchy
// above. 'admin' accounts are the only ones allowed to create a room at all
// (see server/src/routes/rooms.ts's POST /rooms), and are auto-elevated to
// at least room-level 'admin' in every room they're in (see
// server/src/lib/roles.ts's resolveRoomRole) without needing a per-room
// RoomMember grant. Deliberately NOT elevated to 'owner' of rooms they
// didn't create — 'room:delete' below stays a hard ownerId match, so a
// global admin can only delete their own rooms, same as anyone else.
export type AccountRole = 'admin' | 'user';

const ROLE_ORDER: Role[] = ['guest', 'member', 'staff', 'admin', 'owner'];

export function roleAtLeast(role: Role, minRole: Role): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minRole);
}

// Every gated action in the app, and the minimum role it requires. Add a
// new key here (not a fresh inline check) whenever a new feature needs a
// role gate, reusing this exact same map instead of inventing a new
// role-check helper.
export const FEATURE_MIN_ROLE = {
  'room:update': 'admin',
  'admin:grant': 'admin',
  'admin:revoke': 'owner',
  'staff:grant': 'admin',
  'staff:revoke': 'admin',
  'room:delete': 'owner',
  'notice:pin': 'admin',
  'notice:unpin': 'admin',
  'furniture:assign': 'member',
  'furniture:unassign': 'member',
  // §4.1 — matches the spec's own literal example ("teleport_admin: minRole
  // staff"). Bookmarks (§4.2) aren't listed here since they're gated by an
  // exact ownerId match, not a role tier — 'owner' would be redundant with
  // that check rather than an independent gate.
  //
  // MANAGING team locations (create/delete/reorder) stays staff+ ('teleport:admin').
  // USING them (listing + jumping to an existing one) is split out to its own
  // gate open to every real user — Bug 4 separated "may use" from "may manage"
  // so members can teleport to saved spots without being able to edit the list.
  'teleport:admin': 'staff',
  'teleport:use': 'member',
  // §5 — matches the spec's own literal example ("summon: minRole staff").
  // Both the single-user and whole-room forms share this one gate — the
  // spec checks role identically for both (§5.1 and §5.2/5.3's pseudocode).
  'summon': 'staff',
  // §7 — the spec labels this "Enterprise-only", and recording someone's
  // video is more sensitive than the other staff+ room controls above, so
  // this is gated one tier higher at admin+ rather than reusing 'staff'.
  'recording:start': 'admin',
  // Channel/DM/Thread chat — creating/deleting extra channels is an
  // admin+ room-management action (like the other room-structure gates
  // above); sending messages in an existing channel/DM/thread needs no
  // gate at all (every real user is at least 'member').
  'channel:create': 'admin',
  'channel:delete': 'admin',
  // Temporary removal from the room (not a ban — they can rejoin any time).
  // Gated at admin+ specifically, one tier above the staff+ Summon control,
  // since forcibly ending someone's session is more disruptive than moving
  // them.
  'room:kick': 'admin',
  // Zoom-style "Lock Meeting" — an admin/owner toggles the room closed so
  // no new non-admin can enter (people already inside stay). In-memory only
  // (see roomHandler.ts's RoomAdminState.locked), resets on server restart.
  'room:lock': 'admin',
  // Soundboard — uploading a NEW custom sound is admin+ (keeps the shared
  // panel from being polluted by anyone who walks in); LISTENING and PLAYING
  // any sound already in the panel (default or custom) has no gate at all —
  // every real member can do that, same as sending a chat message.
  'soundboard:upload': 'admin',
  // ZEP-style Spotlight — an admin toggles a specific player's presence to
  // reach EVERYONE in the room regardless of distance/zone/DND (a PA
  // announcement). Same tier as Kick: a room-wide broadcast override is at
  // least as disruptive as removing someone, so it isn't left at Summon's
  // lower staff+ bar.
  'presence:spotlight': 'admin',
  // Akses & Password Pintu audit item #9 — an admin toggles EVERY
  // password-protected door in the room open at once (emergency override),
  // bypassing doorLock.ts's normal per-socket/per-door unlock entirely.
  // Deliberately its own key rather than reusing 'room:lock' — that gate is
  // specifically about ROOM ENTRY (Zoom-style "Lock Meeting"), a different
  // concept from door passwords, and every other room-wide admin action in
  // this map already gets its own dedicated key even when several share the
  // 'admin' tier (room:kick, presence:spotlight, room:lock itself, etc.).
  'door:override': 'admin',
} as const satisfies Record<string, Role>;

export type FeatureKey = keyof typeof FEATURE_MIN_ROLE;

export function hasFeatureAccess(role: Role, feature: FeatureKey): boolean {
  return roleAtLeast(role, FEATURE_MIN_ROLE[feature]);
}
