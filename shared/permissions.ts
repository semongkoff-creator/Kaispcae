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
  'teleport:admin': 'staff',
  // §5 — matches the spec's own literal example ("summon: minRole staff").
  // Both the single-user and whole-room forms share this one gate — the
  // spec checks role identically for both (§5.1 and §5.2/5.3's pseudocode).
  'summon': 'staff',
  // §6 (spec's §8/RTC upgrade) — spotlighting bypasses everyone's distance
  // visibility limit for that one target, effectively a broadcast-to-room
  // action, so it's gated the same as the other staff+ room-wide controls.
  'rtc:spotlight': 'staff',
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
  // Gated at admin+ specifically, one tier above the staff+ Summon/Spotlight
  // controls, since forcibly ending someone's session is more disruptive
  // than moving or spotlighting them.
  'room:kick': 'admin',
} as const satisfies Record<string, Role>;

export type FeatureKey = keyof typeof FEATURE_MIN_ROLE;

export function hasFeatureAccess(role: Role, feature: FeatureKey): boolean {
  return roleAtLeast(role, FEATURE_MIN_ROLE[feature]);
}
