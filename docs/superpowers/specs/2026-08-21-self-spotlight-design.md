# Self-Spotlight — Design

## Goal

Let an admin activate "Spotlight" on themselves from the Participant Panel, not only on other people — today the local (own) row shows a passive megaphone badge when Spotlight is active on you, but there is no way to turn it on/off from your own row.

## Context

Direct codebase investigation (not assumption):

- "Spotlight" (ZEP-style) makes a player's presence broadcast to everyone in the room regardless of distance/zone/DND — the existing UI copy for the remote-row action describes it as "Jadikan orang ini tampilan utama di Meeting View semua orang" (`client/src/components/ui/ParticipantPanel.tsx:761`). It's admin-only (`shared/permissions.ts`'s `presence:spotlight`), toggled via `emitSpotlight(targetUserId, active)`.
- **The restriction against self-targeting is purely client-side UI — nothing server-side blocks it.** `server/src/socket/roomHandler.ts`'s `SPOTLIGHT_TOGGLE` handler only checks whether the sender is an admin (`canAccess(rs, senderUid, 'presence:spotlight')`); it never compares `targetUserId` against the sender. Self-targeting already works today if a client simply emits it — nothing needs to change server-side.
- `emitSpotlight` is already fully wired end-to-end client-side (`useSocket.ts` → `App.tsx` → passed into `<ParticipantPanel emitSpotlight={emitSpotlight} .../>`) — nothing needs to change in that wiring either.
- The entire gap is in `ParticipantPanel.tsx`: the local user's own row is never given any action props at all (no `onKick`, `onForceMute`, `onForcePull`, `onSpotlight`) — only the passive `spotlightActive` badge, which renders `{spotlightActive && <MegaphoneFill .../>}` (shown only when active, never clickable) identically on every row, local or remote.
- `ParticipantRow`'s `hasActions` check (`!isLocal && (... || onSpotlight || ...)`) structurally assumes local rows never get a three-dot action menu — a deliberate, sensible "no self-actions" pattern for Kick/ForceMute/ForcePull (which make no sense targeted at yourself), but Spotlight is a legitimate exception: an admin presenting to the room may want to spotlight themselves directly.

## Scope (confirmed with user)

- Only Spotlight gets a self-target exception — Kick/ForceMute/ForcePull and every other currently-local-row-excluded action stay excluded, unchanged.
- No three-dot menu is added to the local row. Instead, the existing megaphone badge on the local row becomes a clickable toggle — always visible (on or off state), not just shown-when-active like every other row's passive badge.
- Only visible/clickable for an admin's own row (same `canSpotlight` permission check already used for the remote-row action) — a non-admin's own row keeps today's exact behavior (badge shown only while active, never clickable).
- No server-side change — the existing `SPOTLIGHT_TOGGLE` handler already accepts self-targeting.

## Design

### Component change

`client/src/components/ui/ParticipantPanel.tsx`'s `ParticipantRow`: the badge block (currently `{spotlightActive && <MegaphoneFill .../>}`, rendered identically for every row) gains a new optional prop, `onToggleSpotlight?: () => void`, passed only from the LOCAL row's call site (and only when `canSpotlight` is true there) — the remote-row call site never receives it, so remote rows are completely unaffected.

Rendering logic for that one badge position:
- If `onToggleSpotlight` is provided (i.e., this is your own row and you're an admin): always render the megaphone icon (both on and off states), as a clickable button calling `onToggleSpotlight`, with distinct styling for active (amber/filled, matching today's active color) vs. inactive (grey/outline) so the two states are visually unambiguous.
- Otherwise (every remote row, or a non-admin's own row): unchanged — `{spotlightActive && <MegaphoneFill .../>}`, passive, no click affordance.

### Call site

The local `<ParticipantRow>` (`ParticipantPanel.tsx`'s Online section, local-row block) gains `onToggleSpotlight={canSpotlight && localUserId ? () => emitSpotlight(localUserId, !localSpotlightActive) : undefined}` — mirroring the exact conditional-prop pattern already used for the remote row's `onSpotlight`.

### Data flow

1. Admin clicks the (now-always-visible) badge on their own row.
2. `emitSpotlight(localUserId, !localSpotlightActive)` fires — the same call already used for remote targets, just self-targeted.
3. Server's existing `SPOTLIGHT_TOGGLE` handler processes it identically (no server change) and broadcasts `SPOTLIGHT_CHANGED` to everyone in the room, including the admin's own client.
4. `localSpotlightActive` (already derived from that broadcast today) updates, and the badge's visual state (amber vs. grey) follows automatically — no separate optimistic update needed, matching how the existing broadcast-driven state already works for remote targets.

## Error handling

- A failed/dropped emit (network blip): the badge simply doesn't change state, since it's driven by the broadcast round-trip, not an optimistic local flip — matches today's existing behavior for toggling Spotlight on someone else. No error toast, consistent with the rest of this admin-action family.
- Non-admin viewing their own row: no badge shown at all while inactive (identical to today), never clickable — the permission check happens client-side (matching the remote-row pattern) and is still enforced server-side regardless.

## Out of scope

- Any other currently-local-row-excluded action (Kick, ForceMute, ForcePull) becoming self-targetable.
- A three-dot menu on the local row.
- Any server-side change — `SPOTLIGHT_TOGGLE` already supports this.
