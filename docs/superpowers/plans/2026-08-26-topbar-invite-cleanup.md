# Topbar Invite/Label Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the hardcoded "MAIN OFFICE" label and the "Invite" (copy join-link) button from the room's top-HUD overlay, leaving the room-code copy button untouched.

**Architecture:** A single-file JSX/state removal in `client/src/App.tsx` — no new logic, no new files, no server or shared changes.

**Tech Stack:** React/TypeScript (client only).

## Global Constraints

- The room-code copy button (tooltip "Salin Kode Room", copies the bare `roomSlug`) is untouched — same markup, same behavior, same position.
- No replacement content for the removed "MAIN OFFICE" label — the space is simply left empty.
- No other overlay in this region of `App.tsx` (`sitNotice`, `roomCodeCopied` toast, etc.) is touched.

---

### Task 1: Remove the "MAIN OFFICE" label and "Invite" button

**Files:**
- Modify: `client/src/App.tsx:2` (icon import), `client/src/App.tsx:1029` (state declaration), `client/src/App.tsx:2630-2663` (the HUD block), `client/src/App.tsx:2665-2674` (the copy-toast pair)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed elsewhere — this is the only task in this plan.

- [ ] **Step 1: Remove the unused `Link45deg` icon import**

`client/src/App.tsx:2` currently reads:

```tsx
import { Clipboard, Link45deg, PersonWalking, X, MagnetFill, PersonPlusFill, DoorOpenFill, VolumeUpFill, BriefcaseFill, Display, StarFill } from 'react-bootstrap-icons';
```

`Link45deg` is used in exactly one place in this file (the Invite button being removed in Step 3) — remove it from this import list:

```tsx
import { Clipboard, PersonWalking, X, MagnetFill, PersonPlusFill, DoorOpenFill, VolumeUpFill, BriefcaseFill, Display, StarFill } from 'react-bootstrap-icons';
```

- [ ] **Step 2: Remove the now-unused `inviteLinkCopied` state**

`client/src/App.tsx:1029` currently reads:

```tsx
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
```

Delete this line entirely (its only other uses — the Invite button's `onClick` and its toast — are removed in Steps 3 and 4).

- [ ] **Step 3: Remove the "MAIN OFFICE" label and the "Invite" button**

`client/src/App.tsx:2630-2663` currently reads:

```tsx
      {/* Room name HUD + code */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-auto">
        <p className="text-gray-500 dark:text-gray-400 text-xs font-medium tracking-wider uppercase">MAIN OFFICE</p>
        <Tooltip label="Salin Kode Room" detail="Salin kode room ini untuk dibagikan.">
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(roomSlug);
              setRoomCodeCopied(true);
              setTimeout(() => setRoomCodeCopied(false), 2000);
            }}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-xs cursor-pointer transition-colors inline-flex items-center gap-1"
          >
            <Clipboard size={11} /> {roomSlug.slice(0, 12)}
          </button>
        </Tooltip>
        <Tooltip label="Salin Link Undangan" detail="Salin link undangan ke room ini.">
          <button
            onClick={async () => {
              // ?join=<slug> — read back on load by App()'s own pending-invite
              // effect below, which auto-joins this exact room once the
              // clicker is authenticated (logging in first if they weren't).
              const url = new URL(window.location.href);
              url.search = '';
              url.searchParams.set('join', roomSlug);
              await navigator.clipboard.writeText(url.toString());
              setInviteLinkCopied(true);
              setTimeout(() => setInviteLinkCopied(false), 2000);
            }}
            className="text-gray-400 hover:text-gray-700 text-xs cursor-pointer transition-colors inline-flex items-center gap-1"
          >
            <Link45deg size={12} /> Invite
          </button>
        </Tooltip>
      </div>
```

Replace with (the `<p>MAIN OFFICE</p>` line and the entire second `<Tooltip>...</Tooltip>` block removed; the room-code `<Tooltip>` block is byte-for-byte unchanged):

```tsx
      {/* Room code */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-auto">
        <Tooltip label="Salin Kode Room" detail="Salin kode room ini untuk dibagikan.">
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(roomSlug);
              setRoomCodeCopied(true);
              setTimeout(() => setRoomCodeCopied(false), 2000);
            }}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-xs cursor-pointer transition-colors inline-flex items-center gap-1"
          >
            <Clipboard size={11} /> {roomSlug.slice(0, 12)}
          </button>
        </Tooltip>
      </div>
```

(The comment above the `<div>` changes from `{/* Room name HUD + code */}` to `{/* Room code */}` since there's no longer a room-name HUD element here.)

- [ ] **Step 4: Remove the "Invite link copied!" toast**

`client/src/App.tsx:2665-2674` currently reads:

```tsx
      {roomCodeCopied && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 bg-purple-100 text-purple-700 text-[10px] px-2 py-0.5 rounded-full pointer-events-none">
          Code copied!
        </div>
      )}
      {inviteLinkCopied && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 bg-purple-100 text-purple-700 text-[10px] px-2 py-0.5 rounded-full pointer-events-none">
          Invite link copied!
        </div>
      )}
```

Replace with (only the `inviteLinkCopied` block removed; the `roomCodeCopied` block is byte-for-byte unchanged):

```tsx
      {roomCodeCopied && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 bg-purple-100 text-purple-700 text-[10px] px-2 py-0.5 rounded-full pointer-events-none">
          Code copied!
        </div>
      )}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace=client`

This is slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/App.tsx
git commit -m "fix: remove hardcoded MAIN OFFICE label and Invite button from room HUD"
```

---

## Manual Testing After Deploy

Open any room and confirm the top-HUD area no longer shows "MAIN OFFICE" text or an "Invite" button, and confirm the room-code copy button (showing e.g. "dcm" or "kaitech") still copies the room slug and shows "Code copied!" exactly as before.
