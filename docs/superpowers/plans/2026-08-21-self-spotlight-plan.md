# Self-Spotlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin toggle Spotlight on themselves from the Participant Panel — today the local row only shows a passive megaphone badge when Spotlight happens to already be active; there's no way to turn it on from your own row.

**Architecture:** Purely client-side, one file (`client/src/components/ui/ParticipantPanel.tsx`). `ParticipantRow` gains a new optional prop, `onToggleSpotlight?: () => void`, passed ONLY from the local row's call site (and only when the local user is an admin). When present, the row's existing megaphone badge position becomes an always-visible, clickable toggle (amber when active, grey when inactive) instead of the passive "shown only while active" badge every other row keeps. No server change — `SPOTLIGHT_TOGGLE` already accepts self-targeting.

**Tech Stack:** React/TypeScript. No new dependency.

## Global Constraints

- Only Spotlight gets a self-target exception — no other currently-local-row-excluded action (Kick, ForceMute, ForcePull) becomes self-targetable.
- No three-dot menu on the local row — the existing badge position itself becomes the clickable control.
- Only visible/clickable for an admin's own row (same `canSpotlight` check already gating the remote-row action) — a non-admin's own row keeps today's exact behavior unchanged.
- Every remote row's badge behavior is completely unaffected — `onToggleSpotlight` is never passed to a remote row.
- No server-side change — `server/src/socket/roomHandler.ts`'s `SPOTLIGHT_TOGGLE` handler already accepts self-targeting; do not touch it.

---

### Task 1: Add the self-toggle to the local row's Spotlight badge

**Files:**
- Modify: `client/src/components/ui/ParticipantPanel.tsx`

**Interfaces:**
- Consumes (unchanged, already exist): `emitSpotlight?: (targetUserId: string, active: boolean) => void` (component prop), `localUserId`, `localSpotlightActive`, `canSpotlight` (all already computed/available in `ParticipantPanel`'s own scope).
- Produces: `ParticipantRow`'s new `onToggleSpotlight?: () => void` prop — used only within this same file, at the local row's own call site.

- [ ] **Step 1: Add `onToggleSpotlight` to `ParticipantRow`'s prop type and destructuring**

Open `client/src/components/ui/ParticipantPanel.tsx`. Find `ParticipantRow`'s destructured parameters (currently starting at line 415) — locate `onSpotlight,` in that list (currently line 440) and add `onToggleSpotlight,` right after it:

```ts
  onSpotlight,
  onToggleSpotlight,
  onLocate,
```

Then find the matching type declaration for `onSpotlight` (currently lines 513-516):

```ts
  // Toggles Spotlight on/off for this row's player — undefined (not just a
  // no-op) below admin, same convention as onKick. Never present on the
  // local row (isLocal never gets action props, only the badge above).
  onSpotlight?: () => void;
```

Replace it with (the old comment's "Never present on the local row" claim is no longer true — corrected below — and a new type line is added for the new prop):

```ts
  // Toggles Spotlight on/off for this row's player — undefined (not just a
  // no-op) below admin, same convention as onKick. Only ever passed for
  // REMOTE rows; the local row gets the separate onToggleSpotlight below
  // instead, since Spotlight is the one action that's meaningful to target
  // at yourself (see specs/2026-08-21-self-spotlight-design.md) — Kick/
  // ForceMute/ForcePull stay excluded from the local row entirely.
  onSpotlight?: () => void;
  // specs/2026-08-21-self-spotlight-design.md — the local row's OWN way to
  // toggle Spotlight on itself. Distinct from onSpotlight above (which is
  // for acting on a REMOTE row): when this is present, the badge below
  // renders as an always-visible, clickable toggle instead of the passive
  // "shown only while active" badge every other row keeps. undefined (not
  // just a no-op) when the local viewer isn't an admin — same "hide, don't
  // disable" convention as every other admin-only action in this file.
  onToggleSpotlight?: () => void;
```

- [ ] **Step 2: Make the badge conditionally interactive**

In the same file, find the badge rendering line (currently line 627):

```tsx
        {spotlightActive && <MegaphoneFill title="Spotlight aktif — terdengar/terlihat seluruh room" size={11} className="text-amber-500 shrink-0" />}
```

Replace it with:

```tsx
        {onToggleSpotlight ? (
          <button
            type="button"
            onClick={onToggleSpotlight}
            title={spotlightActive ? 'Matikan Spotlight' : 'Nyalakan Spotlight'}
            className={`shrink-0 cursor-pointer transition-colors ${spotlightActive ? 'text-amber-500' : 'text-gray-300 dark:text-gray-600 hover:text-amber-400'}`}
          >
            <MegaphoneFill size={11} />
          </button>
        ) : (
          spotlightActive && <MegaphoneFill title="Spotlight aktif — terdengar/terlihat seluruh room" size={11} className="text-amber-500 shrink-0" />
        )}
```

(This is the ONLY change to this line — every other badge/element in this same row, e.g. the raised-hand indicator right after it, is untouched.)

- [ ] **Step 3: Pass `onToggleSpotlight` from the local row's call site**

Find the local `<ParticipantRow .../>` call site (currently lines 320-338, inside the `Online` section, the block starting `const localPending = localUserId ? pendingByUserId.get(localUserId) : undefined;`). Find its `spotlightActive={localSpotlightActive}` line (currently line 326) and add a new prop right after it:

```tsx
                    spotlightActive={localSpotlightActive}
                    onToggleSpotlight={canSpotlight && localUserId && emitSpotlight ? () => emitSpotlight(localUserId, !localSpotlightActive) : undefined}
```

(This mirrors the exact conditional-prop pattern already used for the remote row's `onSpotlight={canSpotlight && p.userId && emitSpotlight ? () => emitSpotlight(p.userId!, !p.spotlightActive) : undefined}`, currently at line 374 — do not modify that remote-row line at all.)

- [ ] **Step 4: Typecheck the client workspace**

Run: `npm run typecheck --workspace=client`

Expected: no errors. Slow on this machine (3-5+ minutes) — wait for it, don't cut it short.

- [ ] **Step 5: Typecheck the server workspace (confirms nothing else broke — this task touches no server files)**

Run: `npm run typecheck --workspace=server`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/ui/ParticipantPanel.tsx
git commit -m "feat: let an admin toggle Spotlight on their own row"
```

---

## Final Verification

- [ ] `npm run typecheck --workspace=client` passes.
- [ ] `npm run typecheck --workspace=server` passes.
- [ ] `git log --oneline -1` shows the one commit from this plan.
- [ ] Confirm the remote row's `onSpotlight` call site (line ~374) is byte-for-byte unchanged.

## Manual Testing After Deploy

1. **Admin can self-spotlight:** as an admin, open the Participant Panel, find your own row (Online section, at top) — the megaphone badge is now visible even when Spotlight is off (grey), and clicking it toggles Spotlight on (turns amber) for yourself, exactly like clicking "Nyalakan Spotlight" on someone else's row would for them.
2. **Toggle off works:** click the now-amber badge again — Spotlight turns off, badge returns to grey.
3. **Everyone sees it:** with a second account/browser in the same room, confirm that self-spotlighting the admin's own row makes them appear as the spotlighted player for that OTHER viewer too (Meeting View "main display" behavior), matching what happens when spotlighting someone else.
4. **Non-admin sees no change:** log in as a non-admin member — your own row's badge area still shows nothing when Spotlight is off, exactly as before this change (no clickable affordance appears).
5. **Remote rows unaffected:** admin toggling Spotlight on ANOTHER participant's row still works exactly as before — three-dot menu, "Nyalakan/Matikan Spotlight" menu item, no visible change to that flow.
6. **No other self-actions appear:** confirm Kick/Force Mute/Force Pull are still completely absent from your own row (no three-dot menu, no new options) — this change is scoped to Spotlight only.
