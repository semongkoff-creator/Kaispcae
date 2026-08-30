# Topbar Invite/Label Cleanup — Design

## Goal

Remove the hardcoded "MAIN OFFICE" label and the "Invite" (copy join-link) button from the room's top-HUD overlay. The room-code copy button stays.

## Context

`client/src/App.tsx:2630-2663` renders a single plain overlay `<div>`, horizontally centered near the top of the viewport, containing three elements in this order:
1. `<p>MAIN OFFICE</p>` — a hardcoded literal string, not derived from the actual room's name (it reads "MAIN OFFICE" even in the "dcm" room today).
2. A room-code copy button (tooltip "Salin Kode Room") — copies the bare `roomSlug` to the clipboard.
3. An "Invite" button (tooltip "Salin Link Undangan") — copies a full join URL (`?join=<roomSlug>`) to the clipboard and shows an "Invite link copied!" toast.

Confirmed with the user: remove elements #1 and #3. Element #2 (room-code copy) is untouched.

## Design

Delete the `<p>MAIN OFFICE</p>` element and the entire "Invite" button block (including its click handler and the "Invite link copied!" toast call) from `App.tsx`. The room-code copy button's markup and behavior are unchanged. No other file is touched — this is a single-file JSX removal with no server-side or shared-code impact.

## Error handling

None needed — this is a pure removal of dead/unwanted UI, no new failure modes introduced.

## Out of scope

- No replacement content for the removed "MAIN OFFICE" label — the space is simply left empty (confirmed with the user).
- The room-code copy button is not modified in any way.
- No change to any other overlay in this region (`screenShareError`, `forceMutedNotice`, etc.).
