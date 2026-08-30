# Recording Follow-ups (Sidebar Revert, MP4, Record Area Panel Restyle) — Design

## Goal

Three follow-up fixes after live-testing this session's earlier Screen Recording Revamp and Record Area Zone features:

1. Revert Record/Recordings from their standalone top-of-screen position back into the Sidebar's "Room Features" flyout, exactly where they lived before this session moved them out.
2. Make recording output MP4 where the recording browser supports it, falling back to WebM otherwise (best-effort, no server-side transcoding).
3. Restyle `RecordAreaPanel` (the Record Area zone's floating panel) to match a user-provided reference image — an orange/red pill with a live elapsed-time counter and icon-only controls.

## Context

Investigation before this design found:

- **The exact prior Sidebar placement is recoverable from git history**, not something to reinvent. Commit `829cd166` ("feat: move the recording control from the Sidebar to a standalone top-of-screen control") removed a `canRecord && (...)` block from `client/src/components/ui/Sidebar.tsx` — a labeled row ("Recording" text + icon) at the end of the "Room Features" flyout's item list, with `<RecordingControl variant="sidebar" .../>` anchored on the row's right side. `RecordingControl.tsx` never deleted its `variant="sidebar"` code path (icon-only 40×40 buttons, flyout popovers portaled to `document.body` — see its own header comment explaining this portal exists specifically because it's nested inside the flyout's `overflow-y-auto` container) — it's just unused today, gated behind a prop no caller currently passes `'sidebar'` for.
- Since `829cd166`, pause/resume was added (this session's Record Area Zone plan) as new `isPaused`/`onPause`/`onResume` props on `RecordingControl` — the restored Sidebar row needs to thread these through too, since the original removed code predates that capability.
- The standalone mount being removed is `client/src/App.tsx`'s `canRecordHere && !editorMode && (<div className="absolute top-16 left-1/2 translate-x-48 z-40 ...">​<RecordingControl .../></div>)` block, plus its preceding explanatory comment (both concern the standalone positioning history — collision fixes vs. `MeetingControl`'s active pill — which becomes moot once this control isn't floating anymore).
- **MP4 support requires more than a client-side mimeType change** — traced the full pipeline and found 4 hardcoded WebM assumptions that would actively break an MP4 upload today, not just mislabel it:
  - `client/src/hooks/useScreenRecording.ts:163` picks `video/webm;codecs=vp8,opus` (or plain `video/webm`) unconditionally; `:174`'s `onstop` hardcodes `new Blob(chunksRef.current, { type: 'video/webm' })` regardless of what was actually recorded.
  - `client/src/services/api.ts:162` hardcodes the upload's FormData filename as `'recording.webm'` — multer's disk storage (`server/src/routes/uploads.ts:68-74`) derives the saved file's on-disk extension from this filename via `path.extname(file.originalname)`, so this hardcoding, not just the mimeType choice, is what actually determines the stored file's extension.
  - `server/src/routes/uploads.ts:109` — `recordingUpload`'s multer `fileFilter` is `cb(null, file.mimetype === 'video/webm')`, which would flatly REJECT an mp4 upload (400 "not a video/webm recording") before it ever reaches disk.
  - `server/src/routes/recordings.ts` hardcodes `Content-Type: video/webm` in 3 places (lines 91, 132, 139) and a `.webm` suffix on the download filename (line 87), for BOTH the disk-file case and the Lark Drive case.
  - The Lark Drive case already has the correct plumbing sitting unused: `server/src/lib/larkDrive.ts:193-220`'s `openDownloadStream()` already extracts and returns the real `contentType` from Lark's own response headers (`res.headers.get('content-type')`) — `recordings.ts` currently discards `dl.contentType` and hardcodes `video/webm` instead of using it.
  - The disk-file case doesn't need new plumbing at all for its Content-Type/extension — the real extension is already embedded in `row.fileUrl` (e.g. `/api/uploads/<uuid>.mp4`) once the filename fix above lands, recoverable via `path.extname()`.
  - No `ffmpeg` or any video-processing dependency exists anywhere in this codebase (checked `server/package.json`, `server/Dockerfile`) — confirmed via the user's own choice that none is being added. This is purely "use whatever container the recording browser natively produced," never a transcode.
- **`RecordAreaPanel.tsx` has no existing timer/elapsed-time concept anywhere in the app** — neither the standalone `RecordingControl` nor the Sidebar variant show one today (both just show a static "Merekam"/"REC: name" badge). This is new UI state, but it can live entirely inside `RecordAreaPanel.tsx` itself — it doesn't need to enter `useScreenRecording.ts`'s hook state, since nothing outside the panel needs to read it.

Confirmed with the user (2 rounds of clarifying questions):
- Both Record and Recordings move back to the Sidebar (not just one).
- The reference screenshot for `RecordAreaPanel` is a **style reference** for how the user wants that panel to look when entering a Record Area zone — not a bug report.
- MP4: best-effort client-side with WebM fallback (the lighter of the two options presented) — not a server-side transcode pipeline.

## Design

### 1. Sidebar revert

`client/src/components/ui/Sidebar.tsx`:
- `SidebarProps` regains the 8 props `829cd166` removed (`canRecord`, `recordingTargets`, `activeRecording`, `isRecordingMine`, `recordingUploading`, `roomSlug`, `onStartRecording`, `onStopRecording`), plus 2 new ones for pause/resume: `isRecordingPaused: boolean`, `onPauseRecording: () => void`, `onResumeRecording: () => void`.
- The exact removed JSX block is restored at its original position (end of the "Room Features" flyout's item list, immediately before the "TEMPORARY DIAGNOSTIC" block) — a `canRecord && (...)` row: icon-in-box + "Recording" label + `<RecordingControl variant="sidebar" recordingTargets={...} activeRecording={...} isRecordingMine={...} isPaused={isRecordingPaused} uploading={recordingUploading} roomSlug={roomSlug} onStart={onStartRecording} onStop={onStopRecording} onPause={onPauseRecording} onResume={onResumeRecording} />`.
- The `RecordCircleFill` icon import (removed in `829cd166`) is restored.

`client/src/App.tsx`:
- The standalone mount block (`canRecordHere && !editorMode && (<div className="absolute top-16 left-1/2 translate-x-48 ...">...</div>)`) and its preceding explanatory comment are removed entirely.
- The `<Sidebar>` call site gains the corresponding props, wired to state that already exists in `App.tsx` today: `canRecord={canRecordHere}`, `recordingTargets={recordingTargets}`, `activeRecording={activeRecording}`, `isRecordingMine={isRecordingMine}`, `recordingUploading={recordingUploading}`, `roomSlug={roomSlug}`, `onStartRecording={(targetUserId, title) => requestRecording(targetUserId, title, emitRecordingStart)}`, `onStopRecording={stopMyRecording}`, `isRecordingPaused={isRecordingPaused}`, `onPauseRecording={pauseRecording}`, `onResumeRecording={resumeRecording}`.
- `RecordAreaPanel` (the Record Area zone panel — a separate feature, unaffected by this revert) keeps its own independent mount exactly as-is.

### 2. MP4, best-effort

`client/src/hooks/useScreenRecording.ts`:
- Mime-type selection (`:163`) tries MP4 candidates first, falling back to the existing WebM chain, all gated by `MediaRecorder.isTypeSupported()` so an unsupported browser silently and safely falls through:
  ```ts
  const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')
    ? 'video/mp4;codecs=avc1,mp4a.40.2'
    : MediaRecorder.isTypeSupported('video/mp4')
    ? 'video/mp4'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : 'video/webm';
  ```
- `onstop` (`:174`) uses `recorder.mimeType` (the browser's own authoritative, possibly-normalized value — e.g. it may drop codec parameters even if the request included them) instead of the hardcoded `'video/webm'` literal, for both the `Blob`'s `type` and to derive a `'mp4' | 'webm'` extension passed into the upload call.
- `requestRecording`'s return / the `emitRecordingFinalize` call are unaffected — this is purely about what bytes/labels get produced, not the recording lifecycle.

`client/src/services/api.ts`:
- `uploadRecordingBlob(blob: Blob)` derives the extension from `blob.type` (`'mp4'` if it includes `'mp4'`, else `'webm'`) instead of the hardcoded `'recording.webm'` filename.

`server/src/routes/uploads.ts`:
- `recordingUpload`'s `fileFilter` widens from `file.mimetype === 'video/webm'` to accept both: `['video/webm', 'video/mp4'].includes(file.mimetype)`. The 400 response's error message is updated to match ("not a supported recording format").

`server/src/routes/recordings.ts`:
- A small shared helper, `extensionForContentType(mime: string): 'mp4' | 'webm'` (defaulting to `'webm'` for anything not recognized as mp4), used by both `download` and `preview`.
- Drive case (`row.fileUrl.startsWith('drive:')`): use `dl.contentType` (already returned by `openDownloadStream`, currently discarded) for the `Content-Type` header instead of the hardcoded `'video/webm'`, and feed it through `extensionForContentType()` to pick the download filename's extension.
- Disk case: derive the extension via `path.extname(filename)` (the real extension is already embedded in the stored filename once the upload-side fix lands) instead of hardcoding `.webm` in `safeName`; `preview`'s disk-case `Content-Type` header is set from the same derived extension (via a small extension→mimetype reverse mapping, or trusting Express's own static-file MIME inference — implementer's call, whichever is less code) instead of the hardcoded literal.
- The comment at `recordings.ts:30` ("fileUrl... points at /api/uploads/<uuid>.webm") is updated to note the extension now varies.

No `Recording` Prisma model change, no new `Recording.status` value, no schema migration — the actual container format was always implicit in the file itself; this only makes the metadata *around* it (Content-Type headers, filenames) honest about what's already there.

### 3. `RecordAreaPanel` restyle

`client/src/components/ui/RecordAreaPanel.tsx`:
- New local state, entirely self-contained (not threaded into `useScreenRecording.ts` — nothing outside this panel needs it): `elapsedSeconds`, incremented once per second via a `useEffect`+`setInterval` that runs only while `isRecordingMine && !isPaused`; reset to `0` when `isRecordingMine` transitions to `false` (a fresh recording always starts its displayed timer at `00:00:00`, matching the reference image's idle state).
- Formatted as `MM:SS` (or `HH:MM:SS` once ≥1 hour, matching the 80-minute cap headroom) via a small local formatting helper.
- Visual restyle of the `isRecordingMine` branch: background changes from red (`bg-red-600`) to `bg-orange-600` (a genuine orange, distinct from this same file's idle-state purple and from the standalone control's/Sidebar's existing pure-red recording indicators elsewhere), matching the reference image's warm orange/red tone; the pulsing dot + "Merekam"/"Rekaman dijeda" text is replaced by the pulsing dot + the live `elapsedSeconds` timer (both states — recording and paused — show the same running/frozen timer instead of switching to different text, matching the reference's single "Start 00:00:00"-style readout); Pause/Resume and Stop stay the same two icon-only buttons already built (no new capability, matching the reference's compact icon layout).
- The idle (`!isRecordingMine && hasTarget`) "Start Recording" button keeps its current style (white/purple, text label) — the reference image's "Start" state is the ACTIVE-but-not-yet-elapsed look, not a restyle of the idle entry button; only the active/recording state visually changes.
- Positioning (`top-16 right-1/2 -translate-x-48 z-40`, twice-fixed this session via box-model corrections and independently re-verified) is untouched — this is a pure color/content restyle of the same two already-correctly-positioned elements, not a layout change.

## Error handling

- MP4 mimetype probing (`MediaRecorder.isTypeSupported`) never throws — a browser with no MP4 support simply falls through every branch to the existing, already-working WebM path. No new failure mode is introduced; a browser that could record before can still record after.
- `extensionForContentType()` defaults to `'webm'` for any unrecognized Content-Type (e.g. a future third format, or a null/malformed header) rather than throwing — matches this codebase's existing "never break download because of metadata surprises" posture (`openDownloadStream` itself already defaults `contentType` to `'application/octet-stream'` if the header is missing).
- The Sidebar revert introduces no new error paths — it's the same `RecordingControl` component, same props shape (plus 3 additive pause/resume props with no new validation), same permission gate (`canRecord`/`canStartRecording`) as before.
- `RecordAreaPanel`'s new timer interval is cleaned up on every relevant transition (recording ends, component unmounts) via the `useEffect`'s own cleanup function — no leaked interval.

## Out of scope

- No server-side transcoding, no `ffmpeg` dependency — confirmed with the user as the deliberately lighter option. A recording made in a browser with no MP4 `MediaRecorder` support (e.g. Firefox) still comes out as WebM, exactly as today.
- No change to `RecordAreaPanel`'s positioning, z-index, or the zone-detection logic feeding it — this plan only restyles its already-correct, already-reviewed layout.
- No change to the "Start Recording" (idle) button's visual style — only the active/recording-state visuals change, per the reference image showing the active state.
- No change to recording permissions, the one-recording-per-room lock, or any server-side recording lifecycle logic.
- No change to the standalone `RecordingControl`'s own component code beyond how it's invoked (its `variant="sidebar"` path already existed and is unmodified; only the call site moves from `App.tsx` to `Sidebar.tsx`).
