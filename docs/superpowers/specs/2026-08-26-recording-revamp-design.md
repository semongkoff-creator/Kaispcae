# Screen Recording Revamp — Design

## Goal

For the `kaitech` and `dcm` rooms specifically: let any room member (not just admins) start a screen recording; make the capture reliably cover the whole KaiSpace app (canvas + chat + video tiles) without breaking when the recorder switches browser tabs; move the record control from deep inside the Sidebar to a standalone control near the top of the screen; and add in-app video preview to the existing recordings list, without touching the existing 3-download limit.

## Context

Investigation before this design found **two entirely separate "recording" features already exist**, and this work only touches one of them:

- **Screen Recording** (`client/src/hooks/useScreenRecording.ts`, `client/src/components/ui/RecordingControl.tsx`, `server/src/socket/recordingHandler.ts`, `Recording` Prisma model, `server/src/routes/recordings.ts`, `server/src/routes/uploads.ts`'s `POST /uploads/recording`) — this is what this spec changes.
- **Lark VC Meetings** (`client/src/components/ui/MeetingControl.tsx`, `server/src/routes/meeting.ts`, `MomRecord` model) — an actual Lark-hosted video conference that Lark itself records. Untouched by this spec; only used as a visual anchor point for where the new recording control moves to (see Design §3).

Key facts confirmed before designing:

- **Capture**: `useScreenRecording.ts` calls `getDisplayMedia({ video: true })` with zero constraints, so the browser always shows its full "choose what to share" picker (Entire Screen / a Window / a Tab), and today's behavior on tab-switch depends entirely on which the user happened to click — "Entire Screen" and "a Window" both silently start recording the wrong content once the user switches away; only Chrome's specific "This Tab" choice survives a tab-switch correctly. No browser lets a page start capture with zero permission prompt at all — this is a security boundary every major browser enforces, not something client code can suppress.
- **Permission**: `recording:start` is a single global constant, `FEATURE_MIN_ROLE['recording:start'] = 'admin'` (`shared/permissions.ts`), with no per-room or per-org override anywhere. It is enforced twice — server-side in `recordingHandler.ts`'s `RECORDING_START` (via `resolveRoomRole` + `hasFeatureAccess`), and client-side via `App.tsx`'s `canRecord={isAdmin}` prop into `Sidebar`, which hides the whole Recording row otherwise.
- **List/download visibility already does the right thing for free**: `server/src/routes/recordings.ts`'s list route already does `hasFeatureAccess(role, 'recording:start') ? rows : rows.filter(r => r.targetUserId === req.userId)` — i.e. admin sees every recording in the room, anyone else only ever sees their own. The download route has the identical shape. **Relaxing who may START a recording does not, by itself, relax who may LIST/DOWNLOAD others' recordings** — that stays exactly as strict as today, with zero code change needed there, as long as the new "may start" check is introduced as a genuinely separate condition, not by loosening `FEATURE_MIN_ROLE['recording:start']` itself (which the list/download routes also read).
- **Lark Drive storage already fully wired**: `server/src/lib/larkDrive.ts` (header-commented "A8 — Lark Drive storage for chat attachments + P2P recordings, replacing local disk"). `POST /uploads/recording` already uploads finished recordings via `ensureRoomFolder`/`uploadFileFromPath`, returning a `drive:<token>` locator when the org has Lark credentials configured (falling back to local disk otherwise). Nothing new needed here.
- **Control placement**: `RecordingControl.tsx` already has a `standalone` CSS variant, fully coded but mounted nowhere — the only place `<RecordingControl>` is used today is `Sidebar.tsx:575` with `variant="sidebar"`, three UI layers deep (left-edge icon rail → "Room Features" dropdown → Recording row). `MeetingControl.tsx` (the separate Lark-meeting control) already self-positions at `top-16 left-1/2 -translate-x-1/2` and is the "Start Meeting" button visible in the user's screenshot.
- **No in-app preview exists today**: the "Recordings" flyout inside `RecordingControl.tsx` lists title/status/remaining-downloads with a Download button only — no `<video>` player. The existing download route (`GET /recordings/:id/download`) is already permission/expiry/count-gated and proxies bytes server-side (the raw `fileUrl` is never sent to the client).

Confirmed with the user:
- Capture approach: keep `getDisplayMedia` (the only capture method that includes chat/video tiles/sidebar, per the platform constraint above), but hint the browser toward "this tab" and guide the user to pick it, rather than switching to a prompt-free but overlay-blind `canvas.captureStream()` approach.
- Permission relaxation is scoped to exactly two rooms (`kaitech`, `dcm`) via a hardcoded slug list — same pattern as the existing Kaitech-Lobby-limit feature, not a new database field.
- List/download visibility is unchanged: a relaxed-permission member sees/downloads only their own recordings; admins still see every recording in the room.
- The record control moves to a standalone top-of-screen position, near the existing "Start Meeting" control.
- Preview is a genuinely separate action from download — previewing a recording must never count against its 3-download limit.

## Design

### 1. Capture: `getDisplayMedia` with a "this tab" hint

`useScreenRecording.ts`'s capture call gains `preferCurrentTab: true` (a real, supported Chrome API that biases the browser's own "choose what to share" picker toward the current tab as the default/highlighted option) plus a `selfBrowserSurface`/`displaySurface` hint where supported. This does not remove the browser's permission prompt — no web API can — but it makes the correct choice the path of least resistance, and the in-app UI (the button that starts the recording) gains a short inline instruction telling the user to pick "This Tab" specifically, since that is the one capture-source choice that keeps recording the KaiSpace tab's content regardless of which OS window or browser tab later has focus. No change to the audio-mixing logic (mic track pulled from the existing WebRTC stream, unchanged) or the upload/finalize flow.

### 2. Permission: relaxed "may start recording" for two named rooms

A new function in `shared/permissions.ts`, alongside the existing `hasFeatureAccess`/`FEATURE_MIN_ROLE`, rather than editing `FEATURE_MIN_ROLE['recording:start']` itself (which the list/download routes also depend on and must stay untouched):

```typescript
// Temporary, room-scoped relaxation — mirrors the Kaitech Lobby limit's own
// hardcoded-slug pattern. Revert by deleting this constant and the OR-branch
// below that references it, falling back to plain hasFeatureAccess everywhere.
const RELAXED_RECORDING_ROOM_SLUGS = ['kaitech', 'dcm'];

export function canStartRecording(role: Role, roomSlug: string): boolean {
  return hasFeatureAccess(role, 'recording:start')
    || (RELAXED_RECORDING_ROOM_SLUGS.includes(roomSlug) && roleAtLeast(role, 'member'));
}
```

`server/src/socket/recordingHandler.ts`'s `RECORDING_START` handler calls `canStartRecording(role, room)` (`room` is already the slug in scope there) instead of `hasFeatureAccess(role, 'recording:start')` directly. Its per-socket `RECORDING_STARTED` visibility broadcast (who gets notified in real time that a recording just began) is **unchanged** — it stays admin+-or-target, matching the "member only sees their own" decision, since the target (always the recorder themselves, recording is self-only) already sees it via the existing `isTarget` branch regardless.

Client-side, `App.tsx`'s `canRecord` prop changes from the bare `isAdmin` to `isAdmin || (!isGuest && RELAXED_RECORDING_ROOM_SLUGS.includes(roomSlug))` (a client-side mirror of the same allowlist — purely a UI-gate; the server-side check above is the actual authority, so a stale/bypassed client check can never grant more than the server allows).

`server/src/routes/recordings.ts`'s list/download visibility logic is **not touched at all** — it keeps checking `hasFeatureAccess(role, 'recording:start')` (admin-only) for "see everyone's," with the existing `targetUserId === req.userId` fallback already correctly giving every recorder (relaxed-permission member or not) access to their own recordings.

### 3. Control placement: standalone variant, near Start Meeting

`RecordingControl.tsx`'s existing (currently unused) `standalone` variant is mounted in `App.tsx`, positioned near `MeetingControl`'s existing `top-16 left-1/2 -translate-x-1/2` anchor (exact offset/stacking is an implementation detail worked out when both controls can be visible at once — `MeetingControl` only renders inside a meeting-type zone, while the recording control is not zone-gated and stays visible throughout the room, so the two won't always occupy the same moment on screen). `Sidebar.tsx`'s Recording row (`Sidebar.tsx:568-587`) is removed — the feature moves, it does not gain a second entry point.

### 4. In-app preview, decoupled from the download limit

A new server route, `GET /recordings/:id/preview`, mirroring `GET /recordings/:id/download`'s exact permission check (self-or-admin, `status === 'done'`) and reusing the same `openDownloadStream`/disk-serving logic to proxy bytes — but **never touching `downloadCount`/`maxDownloads`**. The existing "Recordings" list UI (moving along with the control per §3) gains a "Preview" action per finished recording that fetches from this new route and plays it in an in-app `<video>` element, alongside the existing, unchanged Download button.

### 5. Lark Drive storage

No change — already fully wired end-to-end (`server/src/lib/larkDrive.ts`, `POST /uploads/recording`), confirmed with the user as already sufficient.

## Error handling

- If the user picks a capture source other than "This Tab" in the browser's picker despite the in-app guidance, recording still proceeds exactly as it does today (browsers give no way to reject/re-prompt based on which surface was chosen) — this is a UX nudge, not an enforced constraint, and is called out as such rather than silently promising perfect behavior.
- `canStartRecording`'s server-side check is the sole authority; a stale or tampered client that shows the Record button in an unauthorized room/role still gets rejected by `recordingHandler.ts`'s existing `admin:error` rejection path, unchanged.
- The new preview route re-checks `status === 'done'` exactly like download does — a still-processing or failed recording returns the same 400 shape download already uses, no new error format.

## Out of scope

- No change to the Lark VC Meetings feature (`MeetingControl.tsx`, `MomRecord`, `MeetingHistoryPanel`) at all.
- No new database field or per-room settings row — the two-room scoping is a hardcoded, temporary allowlist, explicitly mirroring the Lobby-limit feature's own precedent, not a general "recording policy" system.
- No change to the existing 3-download/3-day download limit itself, nor to who may download (self-or-admin, unchanged) — only a new, separate, uncounted preview path is added alongside it.
- No attempt to eliminate the browser's screen/tab-share permission prompt — this is a documented platform constraint, not a gap in this app's code.
