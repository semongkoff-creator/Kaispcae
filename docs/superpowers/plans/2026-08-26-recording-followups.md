# Recording Follow-ups (Sidebar Revert, MP4, Record Area Panel Restyle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revert Record/Recordings from their standalone top-of-screen position back into the Sidebar's "Room Features" flyout; make recording output real MP4 where the recording browser supports it (WebM fallback otherwise); restyle `RecordAreaPanel` to match a user-provided reference image (orange/red pill + live elapsed timer + icon-only controls).

**Architecture:** Three fully independent tasks, each touching a disjoint set of files — any order is fine, and a reviewer could approve/reject one without the others. Task 1 is a near-literal restoration of code this session itself removed earlier (recovered verbatim via `git show 829cd166`), plus threading through pause/resume props that didn't exist yet when that code was removed. Task 2 traces one client-side mimeType choice all the way through the upload/storage/download pipeline, fixing 4 separate hardcoded WebM assumptions that would otherwise silently break or mislabel an MP4 recording. Task 3 adds a small, fully self-contained `useState`+`setInterval` timer inside `RecordAreaPanel.tsx` — no new props, no changes outside that one file.

**Tech Stack:** React/TypeScript (client), Express/multer (server) — no new dependencies, no schema/migration changes, no ffmpeg or any transcoding tool.

## Global Constraints

- No server-side transcoding, no `ffmpeg` dependency of any kind — MP4 support is purely "use whatever container the recording browser's `MediaRecorder` natively produced," never a conversion step. A browser with no MP4 `MediaRecorder` support (e.g. Firefox) must keep working exactly as today, producing WebM.
- No change to `RecordAreaPanel`'s positioning, z-index, or the zone-detection logic feeding it (`recordZoneId` in `App.tsx`, `ZoneWatcher.tsx`) — its layout was independently box-model-verified twice already this session; Task 3 only changes colors/content inside the already-correct positioned elements.
- No change to the "Start Recording" (idle, not-yet-recording) button's visual style in `RecordAreaPanel.tsx` — only the active/recording-state visuals change, matching the reference image showing the active state.
- No change to recording permissions (`canStartRecording`), the one-recording-per-room server-side lock, or any recording lifecycle/socket logic (`recordingHandler.ts`, `RECORDING_START`/`RECORDING_STARTED`/`RECORDING_FINALIZE`) — Task 1 only moves where a UI control is mounted; Task 2 only changes what bytes/labels get produced and served.
- `RecordingControl.tsx` itself is not modified by any task — its `variant="sidebar"` code path already exists and already works; only its call site moves (Task 1), and it transparently receives whatever `blob.type` Task 2 produces.
- No `Recording` Prisma model change, no new `Recording.status` value, no migration — Task 2 only makes existing metadata (Content-Type headers, filenames) match what the file actually is.

---

### Task 1: Sidebar revert

**Files:**
- Modify: `client/src/components/ui/Sidebar.tsx` (imports, `SidebarProps` interface, destructured params, JSX row insertion)
- Modify: `client/src/App.tsx` (remove standalone mount + its comment, remove now-unused import, fix 2 stale comment references in `RecordAreaPanel`'s own comment block, add new props to the `<Sidebar>` call site)

**Interfaces:**
- Consumes: `RecordingControl`'s existing `variant="sidebar"` prop and its full existing prop set (`recordingTargets`, `activeRecording`, `isRecordingMine`, `isPaused`, `uploading`, `roomSlug`, `onStart`, `onStop`, `onPause`, `onResume`) — all already implemented and unmodified in `client/src/components/ui/RecordingControl.tsx`. Consumes `App.tsx`'s already-existing state/handlers (`recordingTargets`, `activeRecording`, `isRecordingMine`, `isRecordingPaused`, `recordingUploading`, `roomSlug`, `requestRecording`, `stopMyRecording`, `pauseRecording`, `resumeRecording`, `canRecordHere`) — none of these are touched by this task, only re-wired to a new destination.
- Produces: nothing new for Task 2 or Task 3 — both are independent of this task.

- [ ] **Step 1: Restore the 3 removed imports in `Sidebar.tsx`**

`client/src/components/ui/Sidebar.tsx` currently starts:

```typescript
import { ReactNode } from 'react';
import { List, XLg, XCircleFill, Tools, GeoAltFill, ImageFill, BoxArrowRight, HouseDoorFill, SunFill, MoonFill, EyeFill, EyeSlashFill, PipFill, LockFill, UnlockFill, Table as TableIcon, ShieldLock, CalendarEvent, ClockHistory, ChatDotsFill, PersonCheck, Airplane, ArrowLeftRight, DoorOpenFill, DoorClosedFill, Link45deg, VolumeUpFill, QuestionCircleFill, PeopleFill, BarChartFill, GearFill, HourglassSplit } from 'react-bootstrap-icons';
import { AvatarEditorButton } from '../avatar/AvatarEditorButton';
import { PresenceButton } from '../avatar/PresenceButton';
import { Theme } from '@/hooks/useTheme';
import { ManualStatus } from '@/data/presence';
import { Role } from '@virtualmeet/shared';
import { Tooltip } from '@/components/ui/Tooltip';
```

Change to (restore `RecordCircleFill` to the icon import, and restore the 2 import lines between `PresenceButton` and `Theme`):

```typescript
import { ReactNode } from 'react';
import { List, XLg, XCircleFill, Tools, GeoAltFill, ImageFill, BoxArrowRight, HouseDoorFill, SunFill, MoonFill, EyeFill, EyeSlashFill, PipFill, RecordCircleFill, LockFill, UnlockFill, Table as TableIcon, ShieldLock, CalendarEvent, ClockHistory, ChatDotsFill, PersonCheck, Airplane, ArrowLeftRight, DoorOpenFill, DoorClosedFill, Link45deg, VolumeUpFill, QuestionCircleFill, PeopleFill, BarChartFill, GearFill, HourglassSplit } from 'react-bootstrap-icons';
import { AvatarEditorButton } from '../avatar/AvatarEditorButton';
import { PresenceButton } from '../avatar/PresenceButton';
import { RecordingControl } from './RecordingControl';
import { ActiveRecordingInfo } from '@/stores/gameStore';
import { Theme } from '@/hooks/useTheme';
import { ManualStatus } from '@/data/presence';
import { Role } from '@virtualmeet/shared';
import { Tooltip } from '@/components/ui/Tooltip';
```

- [ ] **Step 2: Restore the props to `SidebarProps`**

In the `SidebarProps` interface, find this exact existing block:

```typescript
  showAddMediaPanel: boolean;
  onToggleAddMedia: () => void;

  // Back to the room list (Lobby) without logging out — distinct from
  // onLogout below, which clears the session entirely.
  onLeaveRoom: () => void;
```

Insert the restored props (the 8 `829cd166` removed, plus 3 new ones for pause/resume — that capability didn't exist when the original block was removed) between them:

```typescript
  showAddMediaPanel: boolean;
  onToggleAddMedia: () => void;

  canRecord: boolean;
  recordingTargets: { userId: string; name: string }[];
  activeRecording: ActiveRecordingInfo | null;
  isRecordingMine: boolean;
  recordingUploading: boolean;
  roomSlug: string;
  onStartRecording: (targetUserId: string, title: string) => void;
  onStopRecording: () => void;
  isRecordingPaused: boolean;
  onPauseRecording: () => void;
  onResumeRecording: () => void;

  // Back to the room list (Lobby) without logging out — distinct from
  // onLogout below, which clears the session entirely.
  onLeaveRoom: () => void;
```

- [ ] **Step 3: Restore the destructured params**

In the `Sidebar` component's destructured props, find this exact existing block:

```typescript
  showAddMediaPanel,
  onToggleAddMedia,
  onLeaveRoom,
```

Change to:

```typescript
  showAddMediaPanel,
  onToggleAddMedia,
  canRecord,
  recordingTargets,
  activeRecording,
  isRecordingMine,
  recordingUploading,
  roomSlug,
  onStartRecording,
  onStopRecording,
  isRecordingPaused,
  onPauseRecording,
  onResumeRecording,
  onLeaveRoom,
```

- [ ] **Step 4: Restore the Recording row in the "Room Features" flyout JSX**

Find this exact existing block (the "Add Media" row, immediately followed by the "TEMPORARY DIAGNOSTIC" comment):

```typescript
            {!isGuest && (
              <Tooltip label="Tambah Media" detail="Tempel gambar, video, atau file ke dalam room." side="right" wrapperClassName="w-full">
                <MenuRow icon={<ImageFill size={15} />} label="Add Media" active={showAddMediaPanel} onClick={closeAnd(onToggleAddMedia)} />
              </Tooltip>
            )}

            {/* TEMPORARY DIAGNOSTIC — remove once the "guest still sees
```

Insert the restored Recording row (its own explanatory comment, then the exact historical JSX block, now with 3 pause/resume props added) between them:

```typescript
            {!isGuest && (
              <Tooltip label="Tambah Media" detail="Tempel gambar, video, atau file ke dalam room." side="right" wrapperClassName="w-full">
                <MenuRow icon={<ImageFill size={15} />} label="Add Media" active={showAddMediaPanel} onClick={closeAnd(onToggleAddMedia)} />
              </Tooltip>
            )}

            {/* Screen recording — restored here after a brief detour to a
                standalone top-of-screen control (commit 829cd166 moved it
                out; this reverts that). variant="sidebar" renders as a
                compact icon pair (Record, Recordings) anchored at the row's
                right edge, with its own flyout popovers portaled to
                document.body — see RecordingControl.tsx's own header
                comment for why the portal is needed specifically inside
                this scrollable dropdown. */}
            {canRecord && (
              <div className="flex items-center gap-3 px-3 py-2">
                <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-purple-50 dark:bg-gray-700 text-purple-600 dark:text-purple-300">
                  <RecordCircleFill size={15} />
                </span>
                <span className="flex-1 text-sm text-gray-700 dark:text-gray-200">Recording</span>
                <div className="flex items-center gap-1 shrink-0">
                  <RecordingControl
                    variant="sidebar"
                    recordingTargets={recordingTargets}
                    activeRecording={activeRecording}
                    isRecordingMine={isRecordingMine}
                    isPaused={isRecordingPaused}
                    uploading={recordingUploading}
                    roomSlug={roomSlug}
                    onStart={onStartRecording}
                    onStop={onStopRecording}
                    onPause={onPauseRecording}
                    onResume={onResumeRecording}
                  />
                </div>
              </div>
            )}

            {/* TEMPORARY DIAGNOSTIC — remove once the "guest still sees
```

(Read the surrounding code first to confirm the exact current content matches — this file may have shifted slightly since this plan was written.)

- [ ] **Step 5: Remove the now-unused `RecordingControl` import in `App.tsx`**

Delete this exact line from `client/src/App.tsx` (its imports section, currently line 16):

```typescript
import { RecordingControl } from './components/ui/RecordingControl';
```

- [ ] **Step 6: Remove the standalone mount block + its comment from `App.tsx`**

Find this exact existing block in `client/src/App.tsx` (sits between `MeetingControl`'s block and `RecordAreaPanel`'s block):

```typescript
      {/* Screen recording — moved out of the Sidebar's "Room Features"
          dropdown to a standalone control near the top of the screen,
          next to Start Meeting. Not zone-gated, unlike MeetingControl.
          Final whole-branch review caught the original translate-x-24/z-30
          colliding with MeetingControl's own ACTIVE-meeting pill ("Meeting
          berlangsung · Join via Lark · End", ~300px wide vs. the idle
          "Start Meeting" button's ~127px this offset was tuned against) —
          MeetingControl's z-40 sat above this control's old z-30, so the
          wider pill could paint over and swallow clicks on Record. Pushed
          further right (clears the active pill's half-width with margin)
          and matched to the same z-40 so it's no longer structurally
          guaranteed to lose that stacking fight. Still worth a live visual
          check in a room with an active Lark meeting — this is a fixed
          offset next to a variable-width neighbor, not a flex-measured one
          (MeetingControl self-positions and is out of scope to change). */}
      {canRecordHere && !editorMode && (
        <div className="absolute top-16 left-1/2 translate-x-48 z-40 pointer-events-auto">
          <RecordingControl
            recordingTargets={recordingTargets}
            activeRecording={activeRecording}
            isRecordingMine={isRecordingMine}
            isPaused={isRecordingPaused}
            uploading={recordingUploading}
            roomSlug={roomSlug}
            onStart={(targetUserId, title) => requestRecording(targetUserId, title, emitRecordingStart)}
            onStop={stopMyRecording}
            onPause={pauseRecording}
            onResume={resumeRecording}
          />
        </div>
      )}

      {/* A5/§7 — Task 4 of the Record Area Zone + Recording Pause/Resume
```

Delete everything from `{/* Screen recording — moved out...` through the blank line right after the closing `)}`, leaving `{/* A5/§7 — Task 4 of the Record Area Zone + Recording Pause/Resume` as the very next non-blank line after `MeetingControl`'s block's existing trailing blank line. Net effect: the whole standalone-control block is gone; `RecordAreaPanel`'s block is now the next thing after `MeetingControl`'s.

- [ ] **Step 7: Fix the 2 stale "standalone" references inside `RecordAreaPanel`'s own comment block**

That comment block (now immediately following `MeetingControl`'s block after Step 6) currently reads exactly:

```typescript
      {/* A5/§7 — Task 4 of the Record Area Zone + Recording Pause/Resume
          plan: a zone-gated recording surface, shown only while the local
          avatar stands inside a 'record'-type zone (Task 1's Room Editor
          tool, Task 2's zone-entry detection). Deliberately one-click (no
          title prompt, unlike the standalone RecordingControl above) —
          mirrors MeetingControl's own "Start Meeting" button, which also has
          no prompt. Reuses the exact same recording state as the standalone
          control (requestRecording/stopMyRecording/pauseRecording/
          resumeRecording, recordingTargets, canRecordHere) — there is only
          one useScreenRecording() call in the whole app, this is just an
          additional surface for it. Originally positioned in its own
          vertical band below MeetingControl's top-16 row (translate-y-14)
          — task review found that band overlaps the Summon/Follow
          consent-toast stack (also top-16, centered, z-50), which a single
          incoming request toast reaches into, not just several stacked
          ones. Moved to the LEFT of center instead, anchored via
          `right-1/2 -translate-x-48` (NOT `left-1/2 -translate-x-48` — a
          first attempt at this fix used `left-1/2`, which anchors the
          panel's LEFT edge and leaves it extending rightward into the very
          toasts/pill it needs to clear, and was caught and corrected in
          review). `right-1/2` anchors the panel's RIGHT edge — the one
          facing center — at a fixed 192px offset, so the gap to
          MeetingControl's row and the toast column (both centered,
          symmetric around center) holds regardless of the panel's own
          width, mirroring how the standalone control's `left-1/2
          translate-x-48` anchors ITS near (left) edge 192px to the right
          of center. */}
```

Replace it with (fixes the "standalone RecordingControl above"/"standalone control" references, which become inaccurate once Step 6 removes that block — the recording control it's referring to now lives in the Sidebar, not "above" in this same file; the box-model positioning reasoning itself is untouched and still 100% correct, so it's preserved, just reframed as historical context for the mirror comparison):

```typescript
      {/* A5/§7 — Task 4 of the Record Area Zone + Recording Pause/Resume
          plan: a zone-gated recording surface, shown only while the local
          avatar stands inside a 'record'-type zone (Task 1's Room Editor
          tool, Task 2's zone-entry detection). Deliberately one-click (no
          title prompt, unlike the Sidebar's own Recording control) —
          mirrors MeetingControl's own "Start Meeting" button, which also has
          no prompt. Reuses the exact same recording state as the Sidebar's
          Recording control (requestRecording/stopMyRecording/pauseRecording/
          resumeRecording, recordingTargets, canRecordHere) — there is only
          one useScreenRecording() call in the whole app, this is just an
          additional surface for it. Originally positioned in its own
          vertical band below MeetingControl's top-16 row (translate-y-14)
          — task review found that band overlaps the Summon/Follow
          consent-toast stack (also top-16, centered, z-50), which a single
          incoming request toast reaches into, not just several stacked
          ones. Moved to the LEFT of center instead, anchored via
          `right-1/2 -translate-x-48` (NOT `left-1/2 -translate-x-48` — a
          first attempt at this fix used `left-1/2`, which anchors the
          panel's LEFT edge and leaves it extending rightward into the very
          toasts/pill it needs to clear, and was caught and corrected in
          review). `right-1/2` anchors the panel's RIGHT edge — the one
          facing center — at a fixed 192px offset, so the gap to
          MeetingControl's row and the toast column (both centered,
          symmetric around center) holds regardless of the panel's own
          width. (This originally mirrored the standalone recording
          control's own `left-1/2 translate-x-48` on the opposite side —
          that control has since moved into the Sidebar's "Room Features"
          menu and no longer floats here, but this panel's own position and
          the box-model reasoning above are unaffected either way.) */}
```

- [ ] **Step 8: Wire the new props into `App.tsx`'s `<Sidebar>` call site**

Find this exact existing block in the `<Sidebar ... />` JSX call:

```typescript
        showAddMediaPanel={showAddMediaPanel}
        onToggleAddMedia={() => openPanel('addMedia')}
        onLeaveRoom={onLeave}
```

Change to:

```typescript
        showAddMediaPanel={showAddMediaPanel}
        onToggleAddMedia={() => openPanel('addMedia')}
        canRecord={canRecordHere}
        recordingTargets={recordingTargets}
        activeRecording={activeRecording}
        isRecordingMine={isRecordingMine}
        recordingUploading={recordingUploading}
        roomSlug={roomSlug}
        onStartRecording={(targetUserId, title) => requestRecording(targetUserId, title, emitRecordingStart)}
        onStopRecording={stopMyRecording}
        isRecordingPaused={isRecordingPaused}
        onPauseRecording={pauseRecording}
        onResumeRecording={resumeRecording}
        onLeaveRoom={onLeave}
```

(`canRecordHere`, `recordingTargets`, `activeRecording`, `isRecordingMine`, `isRecordingPaused`, `recordingUploading`, `roomSlug`, `requestRecording`, `stopMyRecording`, `pauseRecording`, `resumeRecording`, `emitRecordingStart` all already exist in `App.tsx` — this step only threads them into a new call site, no new state.)

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck --workspace=client`

Slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add client/src/components/ui/Sidebar.tsx client/src/App.tsx
git commit -m "revert: move Record/Recordings back into the Sidebar's Room Features menu"
```

---

### Task 2: MP4, best-effort (with WebM fallback)

**Files:**
- Modify: `client/src/hooks/useScreenRecording.ts` (mimeType selection, `onstop`'s Blob type)
- Modify: `client/src/services/api.ts` (`uploadRecordingBlob`'s upload filename extension)
- Modify: `server/src/routes/uploads.ts` (`recordingUpload`'s `fileFilter`, its error message)
- Modify: `server/src/routes/recordings.ts` (new helper function, both `download` and `preview` routes, one stale comment)

**Interfaces:**
- Consumes: nothing from Task 1 or Task 3 — fully independent.
- Produces: nothing new for other tasks. No signature changes cross files — `api.uploadRecording(blob)` keeps its existing single-`Blob`-argument signature; the extension is derived internally from `blob.type`, which `useScreenRecording.ts` already sets correctly via Step 2 below.

- [ ] **Step 1: Try MP4 first in the mimeType selection**

`client/src/hooks/useScreenRecording.ts` currently has, inside `startCapture`:

```typescript
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
```

Change to:

```typescript
      // MP4 first, WebM fallback — isTypeSupported() never throws, so a
      // browser with no MP4 MediaRecorder support (e.g. Firefox) silently
      // falls through to the existing WebM chain with zero behavior change.
      const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')
        ? 'video/mp4;codecs=avc1,mp4a.40.2'
        : MediaRecorder.isTypeSupported('video/mp4')
        ? 'video/mp4'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';
```

- [ ] **Step 2: Use the recorder's own authoritative mimeType for the final Blob**

In the same file, `recorder.onstop` currently reads:

```typescript
      recorder.onstop = async () => {
        displayStream?.getTracks().forEach((t) => t.stop());
        displayStream = null;
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        chunksRef.current = [];
```

Change to:

```typescript
      recorder.onstop = async () => {
        displayStream?.getTracks().forEach((t) => t.stop());
        displayStream = null;
        // recorder.mimeType is the browser's own authoritative value — it
        // may normalize/drop codec parameters even if the request above
        // included them, so this is more reliable than reusing the
        // `mimeType` const from startCapture.
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' });
        chunksRef.current = [];
```

- [ ] **Step 3: Derive the upload filename's extension from the blob's real type**

`client/src/services/api.ts`'s `uploadRecordingBlob` currently reads:

```typescript
async function uploadRecordingBlob(blob: Blob): Promise<{ url: string }> {
  const token = localStorage.getItem('vm_token');
  const form = new FormData();
  form.append('file', blob, 'recording.webm');
  // A8 — route the recording into the room's Lark Drive folder.
  const roomSlug = localStorage.getItem('vm_last_room_slug');
```

Change to:

```typescript
async function uploadRecordingBlob(blob: Blob): Promise<{ url: string }> {
  const token = localStorage.getItem('vm_token');
  const form = new FormData();
  // Extension must match the blob's real container format — the server's
  // disk storage derives the saved file's on-disk extension from THIS
  // filename (see routes/uploads.ts's storage.filename), not from the
  // Content-Type header, so a mismatch here would silently mislabel the
  // stored file even though the bytes themselves are correct.
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  form.append('file', blob, `recording.${ext}`);
  // A8 — route the recording into the room's Lark Drive folder.
  const roomSlug = localStorage.getItem('vm_last_room_slug');
```

- [ ] **Step 4: Widen the server's upload filter to accept MP4**

`server/src/routes/uploads.ts` currently reads:

```typescript
const recordingUpload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'video/webm'),
});

uploads.post('/uploads/recording', authenticateToken, recordingUpload.single('file'), async (req: AuthRequest, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided, or not a video/webm recording' });
  }
```

Change to:

```typescript
const RECORDING_MIME_TYPES = new Set(['video/webm', 'video/mp4']);

const recordingUpload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (_req, file, cb) => cb(null, RECORDING_MIME_TYPES.has(file.mimetype)),
});

uploads.post('/uploads/recording', authenticateToken, recordingUpload.single('file'), async (req: AuthRequest, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided, or not a supported recording format (webm/mp4)' });
  }
```

- [ ] **Step 5: Add a shared extension helper in `recordings.ts`**

`server/src/routes/recordings.ts` currently starts:

```typescript
import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { Readable } from 'node:stream';
import { getPrisma } from '../lib/prisma';
import { hasFeatureAccess } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveRoomRole as resolveRole } from '../lib/roles';
import { openDownloadStream } from '../lib/larkDrive';
import { findRoomInOrg } from '../lib/orgScope';

const recordings = Router();

```

Add the helper right after `const recordings = Router();`:

```typescript
import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { Readable } from 'node:stream';
import { getPrisma } from '../lib/prisma';
import { hasFeatureAccess } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveRoomRole as resolveRole } from '../lib/roles';
import { openDownloadStream } from '../lib/larkDrive';
import { findRoomInOrg } from '../lib/orgScope';

const recordings = Router();

// MP4-or-WebM only — matches routes/uploads.ts's recordingUpload
// fileFilter (the only two formats a recording can ever actually be).
// Defaults to webm for anything unrecognized (e.g. a missing/malformed
// Content-Type), matching larkDrive.ts's own "never break download over
// metadata surprises" precedent (openDownloadStream defaults contentType
// to 'application/octet-stream' rather than throwing).
function extensionForContentType(mime: string): 'mp4' | 'webm' {
  return mime.includes('mp4') ? 'mp4' : 'webm';
}

```

- [ ] **Step 6: Update the stale comment above the list route**

In the same file, the `GET /rooms/:slug/recordings` route currently has this comment:

```typescript
    // fileUrl is withheld on purpose. It points at /api/uploads/<uuid>.webm —
    // the raw file, which the download route below deliberately gates behind
    // a role check, an expiry, and an atomically-incremented maxDownloads
    // counter. Handing the direct path to the client made every one of those
    // checks optional: burn the three downloads, then fetch the uuid forever.
    // No client reads this field (it's only ever sent UP, at
    // RECORDING_FINALIZE), so nothing needs it on the way down. Download
    // strictly via GET /recordings/:id/download.
```

Change to:

```typescript
    // fileUrl is withheld on purpose. It points at /api/uploads/<uuid>.EXT
    // (webm or mp4, depending on what the recording browser's
    // MediaRecorder actually produced) — the raw file, which the download
    // route below deliberately gates behind a role check, an expiry, and
    // an atomically-incremented maxDownloads counter. Handing the direct
    // path to the client made every one of those checks optional: burn the
    // three downloads, then fetch the uuid forever. No client reads this
    // field (it's only ever sent UP, at RECORDING_FINALIZE), so nothing
    // needs it on the way down. Download strictly via GET
    // /recordings/:id/download.
```

- [ ] **Step 7: Make the download route's Content-Type/filename dynamic**

In the same file, the `GET /recordings/:id/download` route currently has:

```typescript
    const safeName = `${(row.title || 'recording').replace(/[^\w.-]+/g, '_')}.webm`;
    if (row.fileUrl.startsWith('drive:')) {
      const dl = await openDownloadStream(row.fileUrl.slice('drive:'.length), req.organizationId!);
      if (!dl) return res.status(404).json({ error: 'Recording file not found' });
      res.setHeader('Content-Type', 'video/webm');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DOM vs node:stream/web ReadableStream typing
      return Readable.fromWeb(dl.body as any).pipe(res);
    }
    const filename = path.basename(row.fileUrl);
    const filePath = path.join(process.cwd(), 'uploads', filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Recording file not found' });
    return res.download(filePath, safeName);
```

Change to:

```typescript
    const baseName = (row.title || 'recording').replace(/[^\w.-]+/g, '_');
    if (row.fileUrl.startsWith('drive:')) {
      const dl = await openDownloadStream(row.fileUrl.slice('drive:'.length), req.organizationId!);
      if (!dl) return res.status(404).json({ error: 'Recording file not found' });
      const safeName = `${baseName}.${extensionForContentType(dl.contentType)}`;
      res.setHeader('Content-Type', dl.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DOM vs node:stream/web ReadableStream typing
      return Readable.fromWeb(dl.body as any).pipe(res);
    }
    const filename = path.basename(row.fileUrl);
    const filePath = path.join(process.cwd(), 'uploads', filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Recording file not found' });
    // The real extension is already embedded in the stored filename (see
    // routes/uploads.ts's storage.filename) — no separate lookup needed.
    // res.download infers the correct Content-Type from filePath's own
    // extension automatically (via Express's underlying send/mime lookup);
    // only the DISPLAY filename (Content-Disposition) needs deriving here.
    const ext = path.extname(filename).replace(/^\./, '') || 'webm';
    const safeName = `${baseName}.${ext}`;
    return res.download(filePath, safeName);
```

- [ ] **Step 8: Make the preview route's Content-Type dynamic**

In the same file, the `GET /recordings/:id/preview` route currently has:

```typescript
    if (row.fileUrl.startsWith('drive:')) {
      const dl = await openDownloadStream(row.fileUrl.slice('drive:'.length), req.organizationId!);
      if (!dl) return res.status(404).json({ error: 'Recording file not found' });
      res.setHeader('Content-Type', 'video/webm');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DOM vs node:stream/web ReadableStream typing
      return Readable.fromWeb(dl.body as any).pipe(res);
    }
    const filename = path.basename(row.fileUrl);
    const filePath = path.join(process.cwd(), 'uploads', filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Recording file not found' });
    res.setHeader('Content-Type', 'video/webm');
    return fs.createReadStream(filePath).pipe(res);
```

Change to:

```typescript
    if (row.fileUrl.startsWith('drive:')) {
      const dl = await openDownloadStream(row.fileUrl.slice('drive:'.length), req.organizationId!);
      if (!dl) return res.status(404).json({ error: 'Recording file not found' });
      res.setHeader('Content-Type', dl.contentType);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DOM vs node:stream/web ReadableStream typing
      return Readable.fromWeb(dl.body as any).pipe(res);
    }
    const filename = path.basename(row.fileUrl);
    const filePath = path.join(process.cwd(), 'uploads', filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Recording file not found' });
    // Unlike the download route above, this streams raw bytes directly
    // (fs.createReadStream, not res.sendFile/res.download), so there's no
    // automatic Content-Type inference available here — must derive it
    // explicitly from the stored file's real extension.
    const contentType = path.extname(filename).toLowerCase() === '.mp4' ? 'video/mp4' : 'video/webm';
    res.setHeader('Content-Type', contentType);
    return fs.createReadStream(filePath).pipe(res);
```

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck --workspace=client`
Run: `npm run typecheck --workspace=server`

Slow on this machine (3-5+ minutes each) — let each run to completion. Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add client/src/hooks/useScreenRecording.ts client/src/services/api.ts server/src/routes/uploads.ts server/src/routes/recordings.ts
git commit -m "feat: record MP4 where the browser supports it, WebM fallback otherwise"
```

---

### Task 3: `RecordAreaPanel` restyle — orange pill + live timer

**Files:**
- Modify: `client/src/components/ui/RecordAreaPanel.tsx` (entire file — imports, new helper, new local state, restyled active-recording branch)

**Interfaces:**
- Consumes: nothing from Task 1 or Task 2 — fully independent. Uses only the existing `RecordAreaPanelProps` (`canRecord`, `hasTarget`, `isRecordingMine`, `isPaused`, `uploading`, `onStart`, `onStop`, `onPause`, `onResume`) — no new props needed, since the timer is derived purely from `isRecordingMine`/`isPaused`, both already passed in by `App.tsx` today.
- Produces: nothing for other tasks.

- [ ] **Step 1: Read the current file and confirm it matches**

`client/src/components/ui/RecordAreaPanel.tsx` currently reads in full:

```tsx
import { RecordCircleFill, StopCircleFill, PauseFill, PlayCircleFill } from 'react-bootstrap-icons';

interface RecordAreaPanelProps {
  canRecord: boolean;
  hasTarget: boolean;
  isRecordingMine: boolean;
  isPaused: boolean;
  uploading: boolean;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
}

// Standing inside a "Record Area" zone (Room Editor tool, Task 1 of this
// plan) shows this panel — completely separate from MeetingControl's
// Lark-meeting panel (different zone type, different feature entirely).
// Reuses the SAME recording state App.tsx already centralizes for the
// existing standalone RecordingControl (single source of truth — starting
// here or from the standalone control hits the identical
// requestRecording/stopMyRecording/pauseRecording/resumeRecording calls, so
// the server's existing one-recording-per-room lock behaves identically
// regardless of which surface triggered it).
export function RecordAreaPanel({ canRecord, hasTarget, isRecordingMine, isPaused, uploading, onStart, onStop, onPause, onResume }: RecordAreaPanelProps) {
  if (!canRecord) return null;

  if (isRecordingMine) {
    return (
      <div className="absolute top-16 right-1/2 -translate-x-48 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-600 text-white text-xs font-medium shadow-lg pointer-events-auto">
        <span className={`w-1.5 h-1.5 rounded-full bg-white ${isPaused ? '' : 'animate-pulse'}`} />
        {isPaused ? 'Rekaman dijeda' : 'Merekam'}
        <button onClick={isPaused ? onResume : onPause} disabled={uploading} title={isPaused ? 'Lanjutkan' : 'Jeda'} className="ml-1 cursor-pointer disabled:opacity-60">
          {isPaused ? <PlayCircleFill size={14} /> : <PauseFill size={14} />}
        </button>
        <button onClick={onStop} disabled={uploading} title={uploading ? 'Uploading...' : 'Stop'} className="cursor-pointer disabled:opacity-60">
          <StopCircleFill size={14} />
        </button>
      </div>
    );
  }

  if (!hasTarget) return null;

  return (
    <button
      onClick={onStart}
      title="Mulai rekam"
      className="absolute top-16 right-1/2 -translate-x-48 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm text-purple-700 dark:text-purple-300 text-xs font-medium border border-purple-200 dark:border-gray-600 shadow-sm cursor-pointer pointer-events-auto"
    >
      <RecordCircleFill size={14} /> Start Recording
    </button>
  );
}
```

If it doesn't match exactly, stop and report — someone else may have touched this file since this plan was written.

- [ ] **Step 2: Replace the whole file**

Replace the entire contents of `client/src/components/ui/RecordAreaPanel.tsx` with:

```tsx
import { useEffect, useState } from 'react';
import { RecordCircleFill, StopCircleFill, PauseFill, PlayCircleFill } from 'react-bootstrap-icons';

interface RecordAreaPanelProps {
  canRecord: boolean;
  hasTarget: boolean;
  isRecordingMine: boolean;
  isPaused: boolean;
  uploading: boolean;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
}

function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

// Standing inside a "Record Area" zone (Room Editor tool, Task 1 of the
// Record Area Zone plan) shows this panel — completely separate from
// MeetingControl's Lark-meeting panel (different zone type, different
// feature entirely). Reuses the SAME recording state App.tsx already
// centralizes for the Sidebar's Recording control (single source of
// truth — starting here or from the Sidebar hits the identical
// requestRecording/stopMyRecording/pauseRecording/resumeRecording calls,
// so the server's existing one-recording-per-room lock behaves
// identically regardless of which surface triggered it).
export function RecordAreaPanel({ canRecord, hasTarget, isRecordingMine, isPaused, uploading, onStart, onStop, onPause, onResume }: RecordAreaPanelProps) {
  // Live elapsed-time readout, entirely local to this panel — nothing
  // outside it needs this number, so it doesn't belong in
  // useScreenRecording.ts's shared hook state. Ticks once a second while
  // actively recording; freezes (stops incrementing, does NOT reset)
  // while paused, so the same readout keeps showing instead of switching
  // to different text on pause. Resets to 0 whenever a FRESH recording
  // starts (isRecordingMine's false->true transition) or ends. Must sit
  // above both early returns below — React's Rules of Hooks require every
  // hook to run unconditionally on every render.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!isRecordingMine) {
      setElapsedSeconds(0);
      return;
    }
    if (isPaused) return;
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [isRecordingMine, isPaused]);

  if (!canRecord) return null;

  if (isRecordingMine) {
    return (
      <div className="absolute top-16 right-1/2 -translate-x-48 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-orange-600 text-white text-xs font-medium shadow-lg pointer-events-auto">
        <span className={`w-1.5 h-1.5 rounded-full bg-white ${isPaused ? '' : 'animate-pulse'}`} />
        {formatElapsed(elapsedSeconds)}
        <button onClick={isPaused ? onResume : onPause} disabled={uploading} title={isPaused ? 'Lanjutkan' : 'Jeda'} className="ml-1 cursor-pointer disabled:opacity-60">
          {isPaused ? <PlayCircleFill size={14} /> : <PauseFill size={14} />}
        </button>
        <button onClick={onStop} disabled={uploading} title={uploading ? 'Uploading...' : 'Stop'} className="cursor-pointer disabled:opacity-60">
          <StopCircleFill size={14} />
        </button>
      </div>
    );
  }

  if (!hasTarget) return null;

  return (
    <button
      onClick={onStart}
      title="Mulai rekam"
      className="absolute top-16 right-1/2 -translate-x-48 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm text-purple-700 dark:text-purple-300 text-xs font-medium border border-purple-200 dark:border-gray-600 shadow-sm cursor-pointer pointer-events-auto"
    >
      <RecordCircleFill size={14} /> Start Recording
    </button>
  );
}
```

What changed: `bg-red-600` → `bg-orange-600` for the active-recording pill; the `{isPaused ? 'Rekaman dijeda' : 'Merekam'}` text is replaced by `{formatElapsed(elapsedSeconds)}`; a new self-contained timer (`elapsedSeconds` state + the `useEffect` above) drives it. The idle "Start Recording" button, both early returns, both Pause/Resume/Stop buttons' behavior, and all positioning classes (`top-16 right-1/2 -translate-x-48 z-40`) are byte-for-byte unchanged.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=client`

Slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/ui/RecordAreaPanel.tsx
git commit -m "feat: restyle Record Area panel to orange pill with live elapsed timer"
```
