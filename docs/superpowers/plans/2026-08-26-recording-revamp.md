# Screen Recording Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For the `kaitech` and `dcm` rooms, let any member (not just admins) start a screen recording; make capture reliably include the whole app and survive a tab switch; move the record control to a standalone spot near the top of the screen; and add an uncounted in-app video preview to the existing recordings list.

**Architecture:** No schema/migration changes. A new `canStartRecording(role, roomSlug)` function in `shared/permissions.ts` (a hardcoded 2-slug allowlist, mirroring the existing Kaitech Lobby-limit precedent) replaces the direct `hasFeatureAccess(role, 'recording:start')` check at the one place recording actually STARTS (both server and client), while the existing list/download visibility logic is left completely untouched. A new server route mirrors the existing download route's permission check but skips the download-count/expiry gate. The existing (currently unused) `standalone` variant of `RecordingControl` gets mounted at the top of the screen instead of buried in the Sidebar, and gains a preview action.

**Tech Stack:** TypeScript (server: Express/Socket.IO/Prisma; client: React), no new dependencies.

## Global Constraints

- The relaxation is a hardcoded 2-slug array (`kaitech`, `dcm`), not a new database field — same reversibility posture as the Lobby-limit feature.
- Relaxing who may START a recording must NOT relax who may LIST or DOWNLOAD other people's recordings — `server/src/routes/recordings.ts`'s existing `hasFeatureAccess(role, 'recording:start') ? rows : rows.filter(r => r.targetUserId === req.userId)` logic (list) and its mirror (download) stay byte-for-byte unchanged.
- Previewing a recording must never increment `downloadCount` or be blocked by `downloadExpiresAt` — it is a wholly separate, uncounted action from downloading.
- No attempt to eliminate the browser's own screen/tab-share permission prompt — only bias it toward the correct default and guide the user to it.
- No change to the Lark VC Meetings feature (`MeetingControl.tsx`, `MomRecord`, `MeetingHistoryPanel`) at all.

---

### Task 1: Shared + server — relaxed "may start recording" check

**Files:**
- Modify: `shared/permissions.ts` (near `hasFeatureAccess`, after line 34's `roleAtLeast`/before or after the `FEATURE_MIN_ROLE` map — exact placement below)
- Modify: `server/src/socket/recordingHandler.ts:81`

**Interfaces:**
- Produces: `canStartRecording(role: Role, roomSlug: string): boolean`, exported from `shared/permissions.ts` and re-exported via `@virtualmeet/shared` (`shared/types/index.ts:2142`). Task 4 consumes this directly (client-side gate for the new standalone control).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Add `canStartRecording` to `shared/permissions.ts`**

Directly after the existing `FEATURE_MIN_ROLE` map's closing `};` (the map currently ends around line 157, right before `export type FeatureKey = keyof typeof FEATURE_MIN_ROLE;`), add:

```typescript
// Temporary, room-scoped relaxation of 'recording:start' for kaitech/dcm —
// mirrors the Kaitech Lobby limit's own hardcoded-slug pattern (see
// server/src/routes/rooms.ts's ACTIVE_KAITECH_ROOM_SLUGS). Deliberately a
// SEPARATE function from hasFeatureAccess/FEATURE_MIN_ROLE, not an edit to
// FEATURE_MIN_ROLE['recording:start'] itself — recordings.ts's list/download
// routes read that same map to decide who may see/download OTHER people's
// recordings, and that must stay admin-only. Revert by deleting this
// constant and function, and reverting recordingHandler.ts's RECORDING_START
// call back to a plain hasFeatureAccess(role, 'recording:start').
const RELAXED_RECORDING_ROOM_SLUGS = ['kaitech', 'dcm'];

export function canStartRecording(role: Role, roomSlug: string): boolean {
  return hasFeatureAccess(role, 'recording:start')
    || (RELAXED_RECORDING_ROOM_SLUGS.includes(roomSlug) && roleAtLeast(role, 'member'));
}
```

`shared/types/index.ts:2141-2142` already selectively re-exports `permissions.ts`'s symbols:

```typescript
export type { Role, FeatureKey } from '../permissions';
export { roleAtLeast, hasFeatureAccess, FEATURE_MIN_ROLE } from '../permissions';
```

Add `canStartRecording` to the second (value) line — do NOT create a new, separately-located re-export line elsewhere in this file (this exact mistake was made and then fixed in an earlier feature this session; the fix folded a stray top-of-file re-export into the correct existing per-module block — put this one directly in its correct block the first time):

```typescript
export type { Role, FeatureKey } from '../permissions';
export { roleAtLeast, hasFeatureAccess, FEATURE_MIN_ROLE, canStartRecording } from '../permissions';
```

- [ ] **Step 2: Use it in `RECORDING_START`**

`server/src/socket/recordingHandler.ts:80-84` currently reads:

```typescript
      const role = await resolveRole(prisma, uid, dbRoom.id, dbRoom.ownerId, dbRoom.organizationId);
      if (!hasFeatureAccess(role, 'recording:start')) {
        socket.emit('admin:error', { message: 'Admin role required to start a recording' });
        return;
      }
```

Change to:

```typescript
      const role = await resolveRole(prisma, uid, dbRoom.id, dbRoom.ownerId, dbRoom.organizationId);
      if (!canStartRecording(role, room)) {
        socket.emit('admin:error', { message: 'Admin role required to start a recording' });
        return;
      }
```

(`room` is already the room's slug, in scope at the top of this handler — confirm this by reading the handler's opening lines, where `room = socketToRoom.get(socket.id)`.) Update this file's import line for `hasFeatureAccess` to also import `canStartRecording` from `@virtualmeet/shared`. Do NOT change the per-socket `RECORDING_STARTED` visibility broadcast later in this same handler (the loop that checks `hasFeatureAccess(viewerRole, 'recording:start')` to decide who else gets notified) — that stays exactly as-is, since a relaxed-permission recorder still sees their own recording via the separate `isTarget` branch in that same loop.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=server`

Slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add shared/permissions.ts server/src/socket/recordingHandler.ts
git commit -m "feat: allow any member (not just admin) to start a recording in kaitech/dcm"
```

---

### Task 2: Server preview route + client API function

**Files:**
- Modify: `server/src/routes/recordings.ts` (new route, added after the existing `GET /recordings/:id/download` route, before `export default recordings;`)
- Modify: `client/src/services/api.ts` (new function near `downloadRecordingBlob`, plus a new `api.previewRecording` entry)

**Interfaces:**
- Produces: `api.previewRecording(id: string): Promise<string>` (client) — resolves to an object URL suitable for a `<video src={...}>` element. Task 5 consumes this.
- Consumes: nothing from Task 1 directly (independent server route), but logically follows it in the plan's ordering.

- [ ] **Step 1: Add the preview route**

The existing download route (`server/src/routes/recordings.ts:48-104`) does: look up the recording by id, confirm the room belongs to the caller's org, resolve role, check `row.targetUserId !== req.userId && !hasFeatureAccess(role, 'recording:start')` (403 otherwise), check `status === 'done'`, atomically increment `downloadCount` (410 if over limit/expired), then stream bytes from Lark Drive or disk with a `Content-Disposition: attachment` header.

Add a new route with the same permission/status check but NO count/expiry gate, and NO `attachment` disposition (so the browser plays it inline instead of downloading), right after the download route (before `export default recordings;`):

```typescript
// Preview — same permission shape as download (self-or-admin, must be
// 'done'), but deliberately skips the downloadCount/downloadExpiresAt gate
// entirely: previewing must never count against, or be blocked by, the
// 3-download/3-day limit that download enforces. Served inline (no
// Content-Disposition: attachment) so a <video> element plays it directly
// instead of triggering a save-file prompt.
recordings.get('/recordings/:id/preview', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const row = await prisma.recording.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'Recording not found' });

    const room = await prisma.room.findUnique({ where: { id: row.roomId } });
    if (!room || room.organizationId !== req.organizationId) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (row.targetUserId !== req.userId && !hasFeatureAccess(role, 'recording:start')) {
      return res.status(403).json({ error: 'Not authorized to preview this recording' });
    }

    if (row.status !== 'done' || !row.fileUrl) {
      return res.status(400).json({ error: 'Recording is not ready for preview' });
    }

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
  } catch (err) {
    console.error('[recordings] preview error:', err);
    return res.status(500).json({ error: 'Failed to preview recording' });
  }
});
```

- [ ] **Step 2: Add the client fetch function**

`client/src/services/api.ts:205-221` (`downloadRecordingBlob`) is the existing pattern for an authenticated fetch of this same kind of route (a plain `<video src="...">` can't attach an `Authorization` header, so this fetches the bytes with the header attached and hands back a blob-backed object URL instead). Add a new function directly after it:

```typescript
// Same authenticated-fetch necessity as downloadRecordingBlob above, but
// returns an object URL for a <video> element instead of triggering a save.
// Caller is responsible for URL.revokeObjectURL(...) once the preview is
// closed (see RecordingControl.tsx) — an object URL otherwise leaks for the
// tab's lifetime.
async function previewRecordingBlob(id: string): Promise<string> {
  const token = localStorage.getItem('vm_token');
  const res = await fetch(`${API_BASE}/recordings/${id}/preview`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError((body as any).error || `Preview failed: ${res.status}`, res.status);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
```

Then, near the existing `downloadRecording: (id: string, filename: string) => downloadRecordingBlob(id, filename),` entry in the exported `api` object, add:

```typescript
  previewRecording: (id: string) => previewRecordingBlob(id),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=server` and `npm run typecheck --workspace=client`

Both slow on this machine (3-5+ minutes each) — let them run to completion. Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/recordings.ts client/src/services/api.ts
git commit -m "feat: add an uncounted preview endpoint for finished recordings"
```

---

### Task 3: Client — capture-mechanism hint + guidance text

**Files:**
- Modify: `client/src/hooks/useScreenRecording.ts:96`
- Modify: `client/src/components/ui/RecordingControl.tsx:93-98` (`startWithTarget`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing consumed elsewhere in this plan.

- [ ] **Step 1: Bias the capture picker toward "this tab"**

`client/src/hooks/useScreenRecording.ts:96` currently reads:

```typescript
          displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
```

Change to:

```typescript
          // preferCurrentTab biases the browser's own "choose what to
          // share" picker toward this tab as the default/highlighted
          // choice — it does NOT remove the picker (no web API can; every
          // major browser requires this prompt as a security boundary),
          // but "this tab" is the one capture-source choice that keeps
          // recording this tab's content regardless of which OS window or
          // browser tab later has focus (unlike "Entire Screen" or "a
          // Window", both of which silently start showing whatever the
          // user switches to). TypeScript's DOM lib may not yet type
          // `preferCurrentTab` on DisplayMediaStreamOptions — if the
          // typecheck in Step 3 fails on this line, cast the options object
          // (e.g. `as DisplayMediaStreamOptions & { preferCurrentTab?: boolean }`)
          // rather than removing the option.
          displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, preferCurrentTab: true });
```

- [ ] **Step 2: Add in-app guidance to pick "This Tab"**

`client/src/components/ui/RecordingControl.tsx:93-98` (`startWithTarget`) currently reads:

```typescript
  const startWithTarget = async (targetUserId: string) => {
    const title = await showPrompt('Judul rekaman:', 'Sesi Meeting');
    setShowPicker(false);
    if (!title?.trim()) return;
    onStart(targetUserId, title.trim());
  };
```

Change the prompt's message to include the guidance (`showPrompt`'s signature is `showPrompt(message: string, defaultValue?: string, opts?: {...})` — confirmed in `client/src/stores/modalStore.ts:99-103` — it has no separate `detail`/body parameter, so the guidance goes directly into `message`):

```typescript
  const startWithTarget = async (targetUserId: string) => {
    const title = await showPrompt(
      'Judul rekaman:\n\nSaat browser minta pilih layar/tab, pilih "Tab ini" (This Tab) — supaya rekaman tidak terputus kalau kamu pindah ke tab lain.',
      'Sesi Meeting',
    );
    setShowPicker(false);
    if (!title?.trim()) return;
    onStart(targetUserId, title.trim());
  };
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=client`

Slow on this machine (3-5+ minutes) — let it run to completion. If `preferCurrentTab` causes a type error, apply the cast noted in Step 1's comment rather than removing the option; report which happened either way. Expected: no errors (with or without the cast).

- [ ] **Step 4: Commit**

```bash
git add client/src/hooks/useScreenRecording.ts client/src/components/ui/RecordingControl.tsx
git commit -m "feat: bias screen-recording capture toward this tab, guide the user to pick it"
```

---

### Task 4: Client — control placement

**Files:**
- Modify: `client/src/App.tsx` (new standalone mount near `MeetingControl`; remove the 8 recording-related props passed into `<Sidebar>`)
- Modify: `client/src/components/ui/Sidebar.tsx` (remove the Recording row and its now-unused props)
- Modify: `client/src/components/ui/RecordingControl.tsx` (flip the standalone variant's flyout panels to open downward, since they're moving from an unused bottom-anchored context to a real top-anchored one)

**Interfaces:**
- Consumes: `canStartRecording(role: Role, roomSlug: string): boolean` (Task 1), imported from `@virtualmeet/shared` — used client-side as a UI-gate mirror of the server-authoritative check, so the allowlist has exactly one copy.
- Produces: nothing consumed elsewhere in this plan.

- [ ] **Step 1: Mount the standalone control near `MeetingControl`**

`client/src/App.tsx:1828-1831` currently reads:

```tsx
      {/* A5 — meeting controls, only while standing inside a meeting-type zone */}
      {meetingZoneId && !editorMode && (
        <MeetingControl roomId={roomSlug} zoneId={meetingZoneId} />
      )}
```

Add the standalone recording control as its own sibling overlay, not zone-gated (recording is a general room feature, not specific to meeting zones — `MeetingControl` only appears inside a meeting zone, so the two won't always be visible at the same time):

```tsx
      {/* A5 — meeting controls, only while standing inside a meeting-type zone */}
      {meetingZoneId && !editorMode && (
        <MeetingControl roomId={roomSlug} zoneId={meetingZoneId} />
      )}

      {/* Screen recording — moved out of the Sidebar's "Room Features"
          dropdown to a standalone control near the top of the screen,
          next to Start Meeting. Not zone-gated, unlike MeetingControl. */}
      {canRecordHere && !editorMode && (
        <div className="absolute top-16 left-1/2 translate-x-24 z-30 pointer-events-auto">
          <RecordingControl
            recordingTargets={recordingTargets}
            activeRecording={activeRecording}
            isRecordingMine={isRecordingMine}
            uploading={recordingUploading}
            roomSlug={roomSlug}
            onStart={(targetUserId, title) => requestRecording(targetUserId, title, emitRecordingStart)}
            onStop={stopMyRecording}
          />
        </div>
      )}
```

`RecordingControl` needs importing into `App.tsx` — add `import { RecordingControl } from './components/ui/RecordingControl';` near the file's other component imports (check the existing import block for the correct relative path style used by neighboring imports in this file, e.g. how `MeetingControl` itself is imported).

Do NOT duplicate `RELAXED_RECORDING_ROOM_SLUGS` client-side — `App.tsx` already has a real `Role` value in scope, `localRole` (`App.tsx:567`, `const localRole = useGameStore((s) => s.localRole);`), already used with the shared `roleAtLeast` helper (already imported at `App.tsx:3`, e.g. `roleAtLeast(localRole, 'member')` at `App.tsx:2170`). Reuse `canStartRecording` (Task 1) directly instead, so the allowlist has exactly one copy, not two that could drift:

Add `canStartRecording` to `App.tsx:3`'s existing `@virtualmeet/shared` import (alongside `roleAtLeast` and the rest of that long import list), then add near where `isAdmin` is read (`App.tsx:969`):

```typescript
  const isAdmin = useGameStore((s) => s.isAdmin);
  // canStartRecording (shared/permissions.ts, Task 1) is the same function
  // recordingHandler.ts checks server-side — this client-side call can
  // never grant more than the server allows even if it drifts or is
  // bypassed, since the server re-checks independently on RECORDING_START.
  const canRecordHere = canStartRecording(localRole, roomSlug);
```

(Confirm `localRole` and `roomSlug` are both already in scope at this point in the component — both are used elsewhere nearby, e.g. `roomSlug` throughout this file and `localRole` at the call sites listed above.)

`App.tsx:2233-2240` currently passes 8 recording-related props into `<Sidebar>`:

```tsx
        canRecord={isAdmin}
        recordingTargets={recordingTargets}
        activeRecording={activeRecording}
        isRecordingMine={isRecordingMine}
        recordingUploading={recordingUploading}
        roomSlug={roomSlug}
        onStartRecording={(targetUserId, title) => requestRecording(targetUserId, title, emitRecordingStart)}
        onStopRecording={stopMyRecording}
```

(Confirm exact current line numbers before editing — other props on neighboring lines, like `isAdmin={isAdmin}` itself at `App.tsx:2168` and `canDoorOverride`/`canManageGuests`/`canBroadcast` around `App.tsx:2176-2181`, are for OTHER Sidebar features and must NOT be touched.) Delete all 8 of these lines — Sidebar no longer renders Recording at all (Step 2 below removes its consumption of them).

- [ ] **Step 2: Remove the Recording row and its props from `Sidebar.tsx`**

`client/src/components/ui/Sidebar.tsx:568-587` currently reads:

```tsx
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
                    uploading={recordingUploading}
                    roomSlug={roomSlug}
                    onStart={onStartRecording}
                    onStop={onStopRecording}
                  />
                </div>
              </div>
            )}
```

Delete this entire block.

Remove the now-unused `import { RecordingControl } from './RecordingControl';` (`Sidebar.tsx:5`) — confirm `RecordingControl` isn't referenced anywhere else in this file before removing the import.

Remove all 8 now-unused props from the `SidebarProps` interface (currently `Sidebar.tsx:184-191`: `canRecord`, `recordingTargets`, `activeRecording`, `isRecordingMine`, `recordingUploading`, `roomSlug`, `onStartRecording`, `onStopRecording`) and from the destructured parameter list (currently `Sidebar.tsx:296-303`). Confirm via grep that `roomSlug` genuinely has no other use in this file before removing it (it was confirmed, during design, to be used ONLY for the Recording block being removed) — if a NEW use of `roomSlug` was added to this file since, keep the prop and only remove the other 7.

Also remove the now-unused `RecordCircleFill` icon import if it has no other use in this file (check via grep — it was only used in the block just deleted).

- [ ] **Step 3: Flip the standalone variant's flyout panels to open downward**

`client/src/components/ui/RecordingControl.tsx`'s `pickerPanel` (non-sidebar branch, currently around line 202) and `listPanel` (non-sidebar branch, currently around line 248) both currently position their panel with `className="absolute bottom-full mb-1.5 ..."` — this opens the panel UPWARD from the button, which made sense when this variant was unused/undocumented, but the button is now mounted near the TOP of the screen (Step 1), where a panel opening upward would render off the top of the viewport.

Change both non-sidebar-branch panel `className`s from `bottom-full mb-1.5` to `top-full mt-1.5` (keep every other class on those lines — `left-0`/`right-0`, width, colors, shadow, border, z-index — unchanged; only the vertical anchor edge and its margin flip). Re-read the current file to confirm you're editing exactly these two `className` strings and not the sidebar-branch (portal-based) panels, which are unaffected by this change.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=client`

Slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/App.tsx client/src/components/ui/Sidebar.tsx client/src/components/ui/RecordingControl.tsx
git commit -m "feat: move the recording control from the Sidebar to a standalone top-of-screen control"
```

---

### Task 5: Client — in-app preview UI

**Files:**
- Modify: `client/src/components/ui/RecordingControl.tsx` (`listContent`'s per-recording row, plus a new preview modal)

**Interfaces:**
- Consumes: `api.previewRecording(id: string): Promise<string>` (Task 2).
- Produces: nothing consumed elsewhere in this plan — final task.

- [ ] **Step 1: Add preview state and handler**

Near the top of the `RecordingControl` function (alongside the existing `const [error, setError] = useState('');` at `RecordingControl.tsx:87`), add:

```typescript
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');
```

Near the existing `handleDownload` function (`RecordingControl.tsx:120-126`), add:

```typescript
  const handlePreview = async (rec: Recording) => {
    try {
      const url = await api.previewRecording(rec.id);
      setPreviewUrl(url);
      setPreviewTitle(rec.title);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat preview');
    }
  };

  const closePreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPreviewTitle('');
  };
```

- [ ] **Step 2: Add a Preview button next to the existing Download button**

`RecordingControl.tsx:227-231` currently reads:

```tsx
          {rec.status === 'done' && (
            <button onClick={() => handleDownload(rec)} title="Download" className="text-purple-500 hover:text-purple-700 cursor-pointer shrink-0">
              <Download size={13} />
            </button>
          )}
```

Change to add a Preview button alongside it:

```tsx
          {rec.status === 'done' && (
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => handlePreview(rec)} title="Preview" className="text-purple-500 hover:text-purple-700 cursor-pointer">
                <PlayCircleFill size={13} />
              </button>
              <button onClick={() => handleDownload(rec)} title="Download" className="text-purple-500 hover:text-purple-700 cursor-pointer">
                <Download size={13} />
              </button>
            </div>
          )}
```

Add `PlayCircleFill` to this file's existing icon import (`RecordingControl.tsx:3`, currently `import { RecordCircleFill, StopCircleFill, Download } from 'react-bootstrap-icons';`):

```typescript
import { RecordCircleFill, StopCircleFill, Download, PlayCircleFill, X } from 'react-bootstrap-icons';
```

(`X` is added here too, for the preview modal's close button in Step 3 — confirm it isn't already imported from elsewhere in this file before adding.)

- [ ] **Step 3: Render the preview modal**

At the end of the component's return value — for the `isSidebar` branch, after its closing `</>`; for the standalone branch, after the closing `</div>` that wraps `pickerPanel`/`listPanel` — add one shared preview modal, rendered in BOTH branches (since either variant's "Recordings" list can trigger a preview). The cleanest approach: render it once, outside the `if (isSidebar)` conditional, e.g. change:

```tsx
  if (isSidebar) {
    return (
      <>
        <div className="relative">
          {recordButton}
          {pickerPanel}
        </div>
        <div className="relative">
          {recordingsButton}
          {listPanel}
        </div>
      </>
    );
  }

  return (
    <div className="relative">
      <div className="flex gap-1.5">
        {recordButton}
        {recordingsButton}
      </div>
      {pickerPanel}
      {listPanel}
    </div>
  );
}
```

to:

```tsx
  const previewModal = previewUrl && createPortal(
    <div className="fixed inset-0 z-[10000] bg-black/80 flex items-center justify-center p-4" onClick={closePreview}>
      <div className="relative max-w-3xl w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <p className="text-white text-sm font-medium truncate">{previewTitle}</p>
          <button onClick={closePreview} title="Tutup" className="text-white hover:text-gray-300 cursor-pointer">
            <X size={20} />
          </button>
        </div>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- recordings have no caption track */}
        <video src={previewUrl} controls autoPlay className="w-full rounded-lg" />
      </div>
    </div>,
    document.body,
  );

  if (isSidebar) {
    return (
      <>
        <div className="relative">
          {recordButton}
          {pickerPanel}
        </div>
        <div className="relative">
          {recordingsButton}
          {listPanel}
        </div>
        {previewModal}
      </>
    );
  }

  return (
    <div className="relative">
      <div className="flex gap-1.5">
        {recordButton}
        {recordingsButton}
      </div>
      {pickerPanel}
      {listPanel}
      {previewModal}
    </div>
  );
}
```

`createPortal` is already imported in this file (`RecordingControl.tsx:2`, used by the sidebar-variant flyout panels) — no new import needed for it.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=client`

Slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ui/RecordingControl.tsx
git commit -m "feat: add in-app video preview for finished recordings, uncounted against the download limit"
```

---

## Manual Testing After Deploy

1. As a non-admin member in the `kaitech` room, confirm a standalone Record control now appears near the top of the screen (near Start Meeting), and confirm starting a recording succeeds (previously this would have been rejected or the button hidden entirely).
2. Repeat step 1 in the `dcm` room as one of the DCM restricted accounts.
3. Confirm the same non-admin member's "Recordings" list only ever shows recordings THEY started — not other people's — while an admin's list still shows every recording in the room.
4. As a non-admin member in a room OTHER than `kaitech`/`dcm`, confirm the Record control does NOT appear (or, if attempted via a stale client, the server still rejects it) — the relaxation must not leak beyond the two named rooms.
5. Start a recording, pick "This Tab" when prompted, switch to a different browser tab for a few seconds, switch back, stop the recording, and confirm the resulting video actually shows KaiSpace content throughout (not the other tab).
6. Once a recording finishes processing, click Preview and confirm it plays in-app; confirm the "X left" download-count label in the list is unaffected by having previewed it (only an actual Download decrements it).
7. Confirm the Sidebar's "Room Features" menu no longer has a Recording row at all.
