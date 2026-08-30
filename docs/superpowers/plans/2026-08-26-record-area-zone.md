# Record Area Zone + Recording Pause/Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new, admin-drawable "Record Area" room-zone tool (completely separate from the Lark-meeting zone type) whose entry shows a Start/Pause/Stop panel for the existing screen-recording feature, and add real pause/resume to screen recording.

**Architecture:** No schema/migration changes (zones are JSON, not a DB model). Four independent layers, each mirroring an existing, proven pattern in this codebase: (1) a new Room Editor tool following the exact `focusArea` template; (2) zone-entry detection following the exact `meetingZone` template in `ZoneWatcher.tsx`; (3) pause/resume as new local state in the existing recording hook, with zero server involvement; (4) a new small panel component mirroring `MeetingControl.tsx`'s self-positioning style, consuming the same shared recording state as the existing standalone control.

**Tech Stack:** React/TypeScript (client only) — no server, no shared-type consumers outside the client, no new dependencies.

## Global Constraints

- No zone is drawn into any room as part of this work — this plan builds the tool/capability only.
- No change to the Lark VC Meetings feature (`MeetingControl.tsx`, `MomRecord`, `MeetingHistoryPanel`) at all — the new zone type must be completely unconnected to it.
- Pause/resume is entirely client-local: no new `Recording.status` value, no new socket events, no server or database change of any kind.
- The existing standalone `RecordingControl` (kaitech/dcm, gated by `canStartRecording`) stays fully functional and visible exactly as today — the new zone panel is an ADDITIONAL surface for the same underlying recording, not a replacement.
- The new zone panel must NOT introduce a new permission bypass — starting a recording from it goes through the exact same `canStartRecording(role, roomSlug)`-gated flow as the existing standalone control.

---

### Task 1: New Room Editor tool — "Record Area"

**Files:**
- Modify: `shared/mapLayers.ts:162` (`AreaEffect.effect` union)
- Modify: `shared/types/index.ts:1762` (`ZoneType` union)
- Modify: `client/src/pages/RoomEditorPage.tsx:31` (`EFFECTS` array), `client/src/pages/RoomEditorPage.tsx:1780-1782` (dialog branch, insert a sibling branch)
- Modify: `client/src/stores/editorStore.ts:208` (`addArea` signature), `client/src/stores/editorStore.ts:647` (zoneType ternary), `client/src/stores/editorStore.ts:655-661` (color ternary)

**Interfaces:**
- Produces: a new zone type, `'record'`, drawable in the Room Editor as the `'recordArea'` effect. Task 2 consumes this exact string (`zone.type === 'record'`) to detect zone entry.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Add the new effect and zone type to the shared unions**

`shared/mapLayers.ts:162` currently reads:

```typescript
  effect: 'privateArea' | 'mapLocation' | 'impassable' | 'focusArea' | 'wallArea' | 'meetingArea' | 'restrictedArea' | 'doorArea';
```

Add `'recordArea'`:

```typescript
  effect: 'privateArea' | 'mapLocation' | 'impassable' | 'focusArea' | 'wallArea' | 'meetingArea' | 'restrictedArea' | 'doorArea' | 'recordArea';
```

`shared/types/index.ts:1762` currently reads:

```typescript
export type ZoneType = 'meeting' | 'desk' | 'focus' | 'general';
```

Add `'record'`:

```typescript
export type ZoneType = 'meeting' | 'desk' | 'focus' | 'general' | 'record';
```

- [ ] **Step 2: Add the toolbar entry**

`client/src/pages/RoomEditorPage.tsx:31` currently reads (the `EFFECTS` array, both the id-union type annotation and its literal entries — re-read the file to confirm the exact current array before editing, since it's a single very long line/block):

```typescript
const EFFECTS: { id: 'startingPoint' | 'impassable' | 'mapLocation' | 'privateArea' | 'impassableArea' | 'focusArea' | 'meetingArea' | 'wallArea' | 'portal' | 'door' | 'sittable' | 'claimableSeat' | 'restrictedArea' | 'doorArea'; label: string; color: string; hint: string }[] = [
  { id: 'startingPoint', label: 'Starting point', color: 'rgba(16,185,129,0.9)', hint: 'Stamp per tile = titik spawn (bisa banyak; pemain muncul di salah satunya).' },
  { id: 'impassable', label: 'Impassable', color: 'rgba(239,68,68,0.85)', hint: 'Stamp per tile = penghalang tak terlihat (memblok gerak, tanpa tekstur).' },
  { id: 'impassableArea', label: 'Impassable Area', color: 'rgba(220,38,38,0.6)', hint: '...' },
  { id: 'wallArea', label: 'Wall Area', color: 'rgba(55,65,81,0.9)', hint: '...' },
  { id: 'mapLocation', label: 'Map location', color: 'rgba(192,132,252,0.95)', hint: '...' },
  { id: 'privateArea', label: 'Private area', color: 'rgba(96,165,250,0.95)', hint: '...' },
  { id: 'focusArea', label: 'Focus area', color: 'rgba(245,158,11,0.95)', hint: '...' },
  { id: 'meetingArea', label: 'Meeting area', color: 'rgba(20,184,166,0.95)', hint: 'Drag area lalu beri nama. Pemain yang masuk otomatis berstatus "In a meeting" dan muncul tombol Start Meeting (bikin Lark VC meeting sekali klik, auto-record). Bisa pilih kedap suara atau tidak (default: kedap suara, seperti rapat sungguhan).' },
  { id: 'restrictedArea', label: 'Restricted area', color: 'rgba(220,38,38,0.85)', hint: '...' },
  { id: 'portal', label: 'Portal', color: 'rgba(124,58,237,0.95)', hint: '...' },
  { id: 'door', label: 'Door', color: 'rgba(212,160,86,0.9)', hint: '...' },
  { id: 'doorArea', label: 'Door Area', color: 'rgba(212,160,86,0.6)', hint: '...' },
  { id: 'sittable', label: 'Sittable', color: 'rgba(56,189,248,0.9)', hint: '...' },
  { id: 'claimableSeat', label: 'Kursi Diklaim', color: 'rgba(250,204,21,0.95)', hint: '...' },
];
```

Add `'recordArea'` to the id union type, and a new entry to the array right after `meetingArea`'s entry (so the two related-but-distinct recording tools sit next to each other in the toolbar):

```typescript
const EFFECTS: { id: 'startingPoint' | 'impassable' | 'mapLocation' | 'privateArea' | 'impassableArea' | 'focusArea' | 'meetingArea' | 'recordArea' | 'wallArea' | 'portal' | 'door' | 'sittable' | 'claimableSeat' | 'restrictedArea' | 'doorArea'; label: string; color: string; hint: string }[] = [
  // ...(all existing entries unchanged, up through meetingArea)...
  { id: 'meetingArea', label: 'Meeting area', color: 'rgba(20,184,166,0.95)', hint: 'Drag area lalu beri nama. Pemain yang masuk otomatis berstatus "In a meeting" dan muncul tombol Start Meeting (bikin Lark VC meeting sekali klik, auto-record). Bisa pilih kedap suara atau tidak (default: kedap suara, seperti rapat sungguhan).' },
  { id: 'recordArea', label: 'Record area', color: 'rgba(239,68,68,0.95)', hint: 'Drag area lalu beri nama. Pemain yang masuk melihat panel Start/Jeda/Stop untuk merekam layar mereka sendiri — TIDAK terhubung ke Lark, beda total dari Meeting area.' },
  // ...(all remaining existing entries unchanged, from restrictedArea onward)...
];
```

Pick a color visually distinct from `meetingArea`'s teal (`rgba(20,184,166,...)`) and from `restrictedArea`'s red (`rgba(220,38,38,0.85)`) — the value above (`rgba(239,68,68,0.95)`, a slightly different red-orange) is a placeholder; if it reads as too similar to an existing color once you can see the editor's legend, pick a clearly distinct one instead (this is a cosmetic judgment call, not a strict requirement).

- [ ] **Step 3: Add the dialog branch**

`client/src/pages/RoomEditorPage.tsx:1780-1782` currently reads:

```typescript
          } else if (s.selectedEffect === 'focusArea') {
            const name = ((await showPrompt('Nama focus area:', 'Focus')) ?? '').trim();
            s.addArea('focusArea', sel, name || 'Focus');
          } else if (s.selectedEffect === 'meetingArea') {
```

Insert a new branch, mirroring `focusArea`'s exact simplicity (a name only, no audio-isolation/capacity/memberOnly prompts — a Record Area has none of those concepts), placed right after the `meetingArea` branch closes (before `restrictedArea`'s branch begins) so it reads in the same order as the toolbar:

```typescript
          } else if (s.selectedEffect === 'focusArea') {
            const name = ((await showPrompt('Nama focus area:', 'Focus')) ?? '').trim();
            s.addArea('focusArea', sel, name || 'Focus');
          } else if (s.selectedEffect === 'meetingArea') {
            const name = ((await showPrompt('Nama meeting area:', 'Meeting')) ?? '').trim();
            // Default OK = kedap suara, same reasoning as Private Area — a
            // meeting in progress shouldn't bleed into/from whatever's
            // happening just outside its walls.
            const isolate = await showConfirm('Area ini KEDAP SUARA?\n\nOK = ya — orang di luar area ini tidak akan saling dengar dengan yang di dalam.\nBatal = tidak — cuma jarak biasa yang menentukan siapa dengar siapa.');
            s.addArea('meetingArea', sel, name || 'Meeting', undefined, isolate);
          } else if (s.selectedEffect === 'recordArea') {
            const name = ((await showPrompt('Nama record area:', 'Record Area')) ?? '').trim();
            s.addArea('recordArea', sel, name || 'Record Area');
          } else if (s.selectedEffect === 'restrictedArea') {
```

(Read the surrounding code first to confirm the exact current line content matches — this file has a single very long chained `if/else if` and other tasks/sessions may have touched nearby lines.)

- [ ] **Step 4: Update `addArea`'s signature and the zoneType/color derivation**

`client/src/stores/editorStore.ts:208` currently reads:

```typescript
  addArea: (effect: 'mapLocation' | 'privateArea' | 'impassable' | 'focusArea' | 'meetingArea' | 'wallArea' | 'restrictedArea' | 'doorArea', rect: Selection, name: string, areaId?: string, audioIsolated?: boolean, capacity?: number, memberOnly?: boolean) => string;
```

Add `'recordArea'`:

```typescript
  addArea: (effect: 'mapLocation' | 'privateArea' | 'impassable' | 'focusArea' | 'meetingArea' | 'recordArea' | 'wallArea' | 'restrictedArea' | 'doorArea', rect: Selection, name: string, areaId?: string, audioIsolated?: boolean, capacity?: number, memberOnly?: boolean) => string;
```

`client/src/stores/editorStore.ts:647` currently reads:

```typescript
      const zoneType = effect === 'focusArea' ? 'focus' : effect === 'meetingArea' ? 'meeting' : 'desk';
```

Insert a `'recordArea'` branch before the final `'desk'` fallback:

```typescript
      const zoneType = effect === 'focusArea' ? 'focus' : effect === 'meetingArea' ? 'meeting' : effect === 'recordArea' ? 'record' : 'desk';
```

`client/src/stores/editorStore.ts:655-661` currently reads:

```typescript
      const color =
        effect === 'meetingArea' ? '#14b8a6'
        : effect === 'restrictedArea' ? '#dc2626'
        : effect === 'mapLocation' ? '#c084fc'
        : effect === 'privateArea' ? '#60a5fa'
        : effect === 'focusArea' ? '#f59e0b'
        : undefined;
```

Add a `'recordArea'` branch, using the SAME hex color you picked for the toolbar entry in Step 2 (converted from the rgba you chose there — keep the two in visual sync):

```typescript
      const color =
        effect === 'meetingArea' ? '#14b8a6'
        : effect === 'restrictedArea' ? '#dc2626'
        : effect === 'mapLocation' ? '#c084fc'
        : effect === 'privateArea' ? '#60a5fa'
        : effect === 'focusArea' ? '#f59e0b'
        : effect === 'recordArea' ? '#ef4444'
        : undefined;
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace=client`

Slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add shared/mapLayers.ts shared/types/index.ts client/src/pages/RoomEditorPage.tsx client/src/stores/editorStore.ts
git commit -m "feat: add Record Area as a new Room Editor zone tool"
```

---

### Task 2: Zone-entry detection

**Files:**
- Modify: `client/src/components/ZoneWatcher.tsx` (new `recordZone` computation + prop + effect)
- Modify: `client/src/App.tsx` (new `recordZoneId` state + wiring into `<ZoneWatcher>`)

**Interfaces:**
- Consumes: `Zone.type === 'record'` (Task 1).
- Produces: `recordZoneId: string | null` state in `App.tsx`, mirroring `meetingZoneId` exactly. Task 4 consumes this to gate the new panel's mount.

- [ ] **Step 1: Add the `recordZone` computation and callback to `ZoneWatcher.tsx`**

`client/src/components/ZoneWatcher.tsx`'s props interface currently includes (among others):

```typescript
  onMeetingZoneChange: (zoneId: string | null) => void;
```

Add a sibling prop:

```typescript
  onMeetingZoneChange: (zoneId: string | null) => void;
  onRecordZoneChange: (zoneId: string | null) => void;
```

Add it to the destructured function parameters too (alongside `onMeetingZoneChange` in the function signature).

The existing `meetingZone` computation currently reads:

```typescript
  // A5 — Meeting zone detection. The MeetingControl (Start/Join/End + history)
  // renders only while the local avatar is inside a Zone of type 'meeting'.
  // Purely derived; also feeds the A11 presence status below.
  const meetingZone = useMemo(
    () => findZoneAt({ x: localPlayer.x, y: localPlayer.y }, zones.filter((z) => z.type === 'meeting')),
    [localPlayer.x, localPlayer.y, zones],
  );
```

Add a sibling computation directly after it, following the identical shape:

```typescript
  // Record Area zone detection — mirrors meetingZone above exactly, but for
  // the SEPARATE screen-recording feature (never the Lark-meeting one). The
  // new zone-gated recording panel (App.tsx) renders only while the local
  // avatar is inside a Zone of type 'record'.
  const recordZone = useMemo(
    () => findZoneAt({ x: localPlayer.x, y: localPlayer.y }, zones.filter((z) => z.type === 'record')),
    [localPlayer.x, localPlayer.y, zones],
  );
```

The existing effect that reports `meetingZone` out currently reads:

```typescript
  // App renders <MeetingControl> off this; reported rather than returned so
  // App only re-renders when the meeting zone genuinely changes.
  useEffect(() => {
    onMeetingZoneChange(meetingZone?.id ?? null);
  }, [meetingZone?.id, onMeetingZoneChange]);

  return null;
}
```

Add a sibling effect for `recordZone` right before the `return null;`:

```typescript
  // App renders <MeetingControl> off this; reported rather than returned so
  // App only re-renders when the meeting zone genuinely changes.
  useEffect(() => {
    onMeetingZoneChange(meetingZone?.id ?? null);
  }, [meetingZone?.id, onMeetingZoneChange]);

  // Same reporting pattern as meetingZone above — App renders the new
  // Record Area panel off this.
  useEffect(() => {
    onRecordZoneChange(recordZone?.id ?? null);
  }, [recordZone?.id, onRecordZoneChange]);

  return null;
}
```

Do NOT touch the `workMode`/presence effect (the one computing `focusZone` and setting `'in_meeting'`/`'focus'`/manual status) — a Record Area zone has no presence-status side effect, unlike meeting/focus zones. This is a deliberate omission, not an oversight.

- [ ] **Step 2: Wire `recordZoneId` into `App.tsx`**

`App.tsx:437` currently reads:

```typescript
  const [meetingZoneId, setMeetingZoneId] = useState<string | null>(null);
```

Add a sibling state declaration:

```typescript
  const [meetingZoneId, setMeetingZoneId] = useState<string | null>(null);
  const [recordZoneId, setRecordZoneId] = useState<string | null>(null);
```

`App.tsx`'s `<ZoneWatcher>` mount currently reads:

```tsx
      <ZoneWatcher
        zoneLock={zoneLock}
        currentZoneIdRef={currentZoneIdRef}
        onZoneChange={setCurrentZone}
        onMeetingZoneChange={setMeetingZoneId}
        emitZoneEnter={emitZoneEnter}
        emitZoneExit={emitZoneExit}
        emitWorkMode={emitWorkMode}
      />
```

Add the new prop:

```tsx
      <ZoneWatcher
        zoneLock={zoneLock}
        currentZoneIdRef={currentZoneIdRef}
        onZoneChange={setCurrentZone}
        onMeetingZoneChange={setMeetingZoneId}
        onRecordZoneChange={setRecordZoneId}
        emitZoneEnter={emitZoneEnter}
        emitZoneExit={emitZoneExit}
        emitWorkMode={emitWorkMode}
      />
```

This task does NOT yet render anything off `recordZoneId` — that's Task 4. After this task, `recordZoneId` is computed and stored but unused (harmless — confirm this doesn't produce an "unused variable" typecheck error; if it does, this repo's `noUnusedLocals` setting is off per earlier investigation this session, so it should not).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=client`

Slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/ZoneWatcher.tsx client/src/App.tsx
git commit -m "feat: detect Record Area zone entry, mirroring the existing meeting-zone pattern"
```

---

### Task 3: Pause/resume for screen recording

**Files:**
- Modify: `client/src/hooks/useScreenRecording.ts` (new `isPaused` state + `pauseRecording`/`resumeRecording`)
- Modify: `client/src/components/ui/RecordingControl.tsx` (pause/resume button)
- Modify: `client/src/App.tsx` (wire the new callables/state into the existing `<RecordingControl>` mount)

**Interfaces:**
- Produces: `useScreenRecording()`'s returned object gains `isPaused: boolean`, `pauseRecording: () => void`, `resumeRecording: () => void`. Task 4 consumes these same three values (already computed once in `App.tsx` by this task) for the new zone panel — there is exactly one `useScreenRecording()` call in the whole app (in `App.tsx`), so both surfaces share identical state.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Add pause/resume to `useScreenRecording.ts`**

The hook's state declarations currently read (`useScreenRecording.ts:31-32`):

```typescript
  const [myRecordingId, setMyRecordingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
```

Add:

```typescript
  const [myRecordingId, setMyRecordingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
```

`stopCapture` currently reads (`useScreenRecording.ts:34-42`):

```typescript
  const stopCapture = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  }, []);
```

Add a reset of `isPaused` (stopping a recording — from any state — always clears any pause flag; harmless if it was already false):

```typescript
  const stopCapture = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    setIsPaused(false);
  }, []);
```

Add two new callables directly after `stopMyRecording` (`useScreenRecording.ts:62-66`):

```typescript
  const stopMyRecording = useCallback(() => {
    if (!myRecordingId) return;
    emitRecordingStop(myRecordingId);
    stopCapture();
  }, [myRecordingId, emitRecordingStop, stopCapture]);

  // Pause/resume — real MediaRecorder.pause()/.resume(), entirely
  // client-local (no server event, no Recording.status change): the server
  // has no visibility into the capture pipeline by this feature's own
  // existing architecture (capture lives only in the recorder's own
  // browser), and the one-recording-per-room lock is keyed on
  // status IN ('recording','processing'), unaffected by pause either way.
  // The wall-clock 80-minute auto-stop timer is cleared while paused and
  // restarted at FULL duration on resume — a deliberate simplification
  // (a recording paused/resumed several times can span more than 80 minutes
  // of wall-clock time since the original Start, though never more than 80
  // minutes of any single actively-capturing segment) rather than tracking
  // precise cumulative active time, matching the cap's original purpose of
  // bounding one unattended capture session.
  const pauseRecording = useCallback(() => {
    if (!recorderRef.current || recorderRef.current.state !== 'recording') return;
    recorderRef.current.pause();
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsPaused(true);
  }, []);

  const resumeRecording = useCallback(() => {
    if (!recorderRef.current || recorderRef.current.state !== 'paused') return;
    recorderRef.current.resume();
    timeoutRef.current = setTimeout(stopCapture, RECORDING_MAX_DURATION_MS);
    setIsPaused(false);
  }, [stopCapture]);
```

The hook's return statement currently reads (`useScreenRecording.ts:192-197`):

```typescript
  return {
    requestRecording,
    stopMyRecording,
    isRecordingMine: !!myRecordingId,
    uploading,
  };
}
```

Add the three new values:

```typescript
  return {
    requestRecording,
    stopMyRecording,
    pauseRecording,
    resumeRecording,
    isRecordingMine: !!myRecordingId,
    isPaused,
    uploading,
  };
}
```

Also reset `isPaused` to `false` inside `startCapture`'s success path, right before `recorder.start()` (a fresh recording never starts paused) — the relevant existing block (`useScreenRecording.ts:166-168`) currently reads:

```typescript
      recorder.start();
      recorderRef.current = recorder;
      setMyRecordingId(activeRecording.recordingId);
```

Change to:

```typescript
      setIsPaused(false);
      recorder.start();
      recorderRef.current = recorder;
      setMyRecordingId(activeRecording.recordingId);
```

- [ ] **Step 2: Add a Pause/Resume button to `RecordingControl.tsx`**

`RecordingControl.tsx`'s props interface currently reads (`RecordingControl.tsx:64-75`):

```typescript
interface RecordingControlProps {
  recordingTargets: RecordingTarget[];
  activeRecording: ActiveRecordingInfo | null;
  isRecordingMine: boolean;
  uploading: boolean;
  roomSlug: string;
  onStart: (targetUserId: string, title: string) => void;
  onStop: () => void;
  // 'sidebar': icon-only, popovers open to the right — see Sidebar.tsx.
  // Omit (or 'standalone') for the original labeled-button floating bar.
  variant?: 'standalone' | 'sidebar';
}
```

Add `isPaused`/`onPause`/`onResume`:

```typescript
interface RecordingControlProps {
  recordingTargets: RecordingTarget[];
  activeRecording: ActiveRecordingInfo | null;
  isRecordingMine: boolean;
  isPaused: boolean;
  uploading: boolean;
  roomSlug: string;
  onStart: (targetUserId: string, title: string) => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  // 'sidebar': icon-only, popovers open to the right — see Sidebar.tsx.
  // Omit (or 'standalone') for the original labeled-button floating bar.
  variant?: 'standalone' | 'sidebar';
}
```

Add `isPaused`, `onPause`, `onResume` to the destructured function parameters (`RecordingControl.tsx:82`) alongside the existing ones.

The `recordButton`'s `isRecordingMine` branch currently reads (`RecordingControl.tsx:149-159`):

```tsx
  const recordButton = isRecordingMine ? (
    <button
      onClick={onStop}
      disabled={uploading}
      title={uploading ? 'Uploading...' : 'Stop Recording'}
      className={isSidebar
        ? 'w-10 h-10 rounded-lg flex items-center justify-center bg-red-600 text-white disabled:opacity-60 cursor-pointer'
        : 'px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-red-600 text-white border-red-500 disabled:opacity-60'}
    >
      <StopCircleFill size={isSidebar ? 16 : 12} /> {!isSidebar && (uploading ? 'Uploading...' : 'Stop Recording')}
    </button>
  ) : activeRecording ? (
```

Replace it with a small flex row containing a Pause/Resume button alongside the existing Stop button:

```tsx
  const recordButton = isRecordingMine ? (
    <div className="flex items-center gap-1.5">
      <button
        onClick={isPaused ? onResume : onPause}
        title={isPaused ? 'Lanjutkan' : 'Jeda'}
        className={isSidebar
          ? 'w-10 h-10 rounded-lg flex items-center justify-center bg-amber-500 text-white cursor-pointer'
          : 'px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-amber-500 text-white border-amber-400'}
      >
        {isPaused ? <PlayCircleFill size={isSidebar ? 16 : 12} /> : <PauseFill size={isSidebar ? 16 : 12} />}
        {!isSidebar && (isPaused ? 'Lanjutkan' : 'Jeda')}
      </button>
      <button
        onClick={onStop}
        disabled={uploading}
        title={uploading ? 'Uploading...' : 'Stop Recording'}
        className={isSidebar
          ? 'w-10 h-10 rounded-lg flex items-center justify-center bg-red-600 text-white disabled:opacity-60 cursor-pointer'
          : 'px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-red-600 text-white border-red-500 disabled:opacity-60'}
      >
        <StopCircleFill size={isSidebar ? 16 : 12} /> {!isSidebar && (uploading ? 'Uploading...' : 'Stop Recording')}
      </button>
    </div>
  ) : activeRecording ? (
```

`PlayCircleFill` is already imported in this file (used by the Preview button). Add `PauseFill` to the existing icon import line (`RecordingControl.tsx:3`, currently `import { RecordCircleFill, StopCircleFill, Download, PlayCircleFill, X } from 'react-bootstrap-icons';`):

```typescript
import { RecordCircleFill, StopCircleFill, Download, PlayCircleFill, PauseFill, X } from 'react-bootstrap-icons';
```

- [ ] **Step 3: Wire the new props through `App.tsx`'s existing `<RecordingControl>` mount**

`App.tsx`'s `useScreenRecording()` call currently reads (`App.tsx:547-554` — re-read to confirm exact current line numbers, this region may have shifted slightly):

```typescript
  const { requestRecording, stopMyRecording, isRecordingMine, uploading: recordingUploading } = useScreenRecording({
    activeRecording,
    // ...(other options, unchanged)...
  });
```

Destructure the new values too:

```typescript
  const { requestRecording, stopMyRecording, pauseRecording, resumeRecording, isRecordingMine, isPaused: isRecordingPaused, uploading: recordingUploading } = useScreenRecording({
    activeRecording,
    // ...(other options, unchanged)...
  });
```

(Renamed to `isRecordingPaused` locally to avoid any naming collision with other local variables in this large file — confirm no existing `isPaused` identifier is already in scope here before choosing the final name; adjust if needed.)

The existing standalone `<RecordingControl>` mount (`App.tsx:1854-1866`, added by the earlier Recording Revamp feature) currently reads:

```tsx
      {canRecordHere && !editorMode && (
        <div className="absolute top-16 left-1/2 translate-x-48 z-40 pointer-events-auto">
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

Add the three new props:

```tsx
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
```

(Re-read this exact block in the current file before editing — confirm line numbers, since Tasks 1-2 don't touch this region but time has passed since it was last verified.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=client`

Slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useScreenRecording.ts client/src/components/ui/RecordingControl.tsx client/src/App.tsx
git commit -m "feat: add pause/resume to screen recording (client-local, no server change)"
```

---

### Task 4: New zone-gated Record Area panel

**Files:**
- Create: `client/src/components/ui/RecordAreaPanel.tsx`
- Modify: `client/src/App.tsx` (mount the new panel, gated on `recordZoneId`)

**Interfaces:**
- Consumes: `recordZoneId` (Task 2), `isRecordingMine`/`isPaused`/`uploading`/`requestRecording`/`stopMyRecording`/`pauseRecording`/`resumeRecording`/`recordingTargets`/`activeRecording` (Task 3, all already computed once in `App.tsx`).
- Produces: nothing consumed elsewhere in this plan — final task.

- [ ] **Step 1: Create `RecordAreaPanel.tsx`**

A small, self-contained component mirroring `MeetingControl.tsx`'s general shape (a floating pill, NOT reusing `RecordingControl.tsx`'s flyout-heavy sidebar/standalone variants — this panel has no target-picker or recordings-history list, both already available from the existing standalone control; it is purely Start / Pause+Stop / Resume+Stop):

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
      <div className="absolute top-16 left-1/2 -translate-x-1/2 translate-y-14 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-600 text-white text-xs font-medium shadow-lg pointer-events-auto">
        <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
        {isPaused ? 'Rekaman dijeda' : 'Merekam'}
        <button onClick={isPaused ? onResume : onPause} title={isPaused ? 'Lanjutkan' : 'Jeda'} className="ml-1 cursor-pointer">
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
      className="absolute top-16 left-1/2 -translate-x-1/2 translate-y-14 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm text-purple-700 dark:text-purple-300 text-xs font-medium border border-purple-200 dark:border-gray-600 shadow-sm cursor-pointer pointer-events-auto"
    >
      <RecordCircleFill size={14} /> Start Recording
    </button>
  );
}
```

Positioned at `top-16 ... translate-y-14` (below `MeetingControl`'s own `top-16` row, not beside it) — deliberately in its OWN vertical band rather than trying to share `MeetingControl`'s row horizontally, avoiding the exact collision class the Recording Revamp's final review caught between the standalone recording control and the active-meeting pill. If, once visible in a real browser, this still visually crowds another existing `top-*`-positioned overlay, adjust the offset — this exact pixel value is not a hard requirement, only a starting point clear of the two known neighbors (`MeetingControl`'s row and the toast/consent stack).

- [ ] **Step 2: Mount it in `App.tsx`, gated on `recordZoneId`**

Import the new component near `App.tsx`'s other component imports (alongside where `MeetingControl`/`RecordingControl` are imported):

```typescript
import { RecordAreaPanel } from './components/ui/RecordAreaPanel';
```

Mount it as a new sibling block right after the existing standalone-`RecordingControl` block (`App.tsx`, after the block Task 3 touched):

```tsx
      {recordZoneId && !editorMode && (
        <RecordAreaPanel
          canRecord={canRecordHere}
          hasTarget={recordingTargets.length > 0}
          isRecordingMine={isRecordingMine}
          isPaused={isRecordingPaused}
          uploading={recordingUploading}
          onStart={() => {
            if (recordingTargets.length > 0) requestRecording(recordingTargets[0].userId, 'Rekaman Zona', emitRecordingStart);
          }}
          onStop={stopMyRecording}
          onPause={pauseRecording}
          onResume={resumeRecording}
        />
      )}
```

(This panel always targets the first entry in `recordingTargets` — today that's always exactly "Myself", per the existing standalone control's own behavior when there's only one target; if `recordingTargets` ever grows to offer more than one target in the future, this panel's simpler always-target-the-first behavior would need revisiting, but that is out of scope here.) Re-read the exact current props/state names in `App.tsx` before wiring this in — confirm `recordingTargets`, `canRecordHere`, `emitRecordingStart` are the same identifiers Task 3 (and the earlier Recording Revamp feature) already established, not renamed since.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=client`

Slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/ui/RecordAreaPanel.tsx client/src/App.tsx
git commit -m "feat: show a Start/Pause/Stop recording panel when standing in a Record Area zone"
```

---

## Manual Testing After Deploy

1. Open the Room Editor in any room, confirm a new "Record area" tool appears in the toolbar (near "Meeting area"), draw one, name it, save.
2. Walk into the drawn Record Area zone as a user with recording permission (admin anywhere, or a member in kaitech/dcm) — confirm the new panel appears, and confirm walking into a `meetingArea` zone elsewhere still shows ONLY the Lark "Start Meeting" panel, never both at once (unless the two zones are deliberately drawn overlapping).
3. Click "Start Recording" in the new panel — confirm it starts immediately with no title prompt (deliberate: this panel is a one-click surface, matching `MeetingControl`'s own "Start Meeting" — no prompt there either — rather than the standalone control's title-prompt flow, which stays available as the more deliberate alternative entry point).
4. While recording, click Pause — confirm the panel switches to "Rekaman dijeda"/Resume state, and confirm the STANDALONE control (if also visible, e.g. in kaitech/dcm) shows the same paused state simultaneously (shared state, not independent).
5. Click Resume, then Stop — confirm the finished recording appears once (not twice) in the "Recordings" list, and previews/downloads correctly.
6. Confirm a user WITHOUT recording permission in that room sees no usable Start action from the zone panel (or the panel not rendering at all, per `canRecord` gating), matching the existing standalone control's own permission behavior.
