# Record Area Zone + Recording Pause/Resume — Design

## Goal

Add a new, admin-drawable room zone type, "Record Area" — walking into it shows a floating panel with Start/Pause/Stop controls for the app's existing screen-recording feature, completely separate from the Lark VC Meetings zone/panel. Add real pause/resume to screen recording (doesn't exist today — only Start/Stop).

## Context

Investigation before this design found:

- **Zone types have no generic editor picker.** `Zone.type` (`shared/types/index.ts:1762`, `'meeting' | 'desk' | 'focus' | 'general'`) is a plain union, but the Room Editor has no dropdown for it — every existing zone type required bespoke, hardcoded tooling spread across `shared/mapLayers.ts` (`AreaEffect.effect`'s own separate union), `client/src/pages/RoomEditorPage.tsx` (a hardcoded `EFFECTS` toolbar array plus a per-effect `if/else if` dialog chain), and `client/src/stores/editorStore.ts` (`addArea`'s own hardcoded effect-union parameter, plus a hardcoded ternary that maps effect → `Zone.type`). A code comment there confirms the pattern: before the `meetingArea` tool was added, no editor tool could ever produce a `'meeting'`-type zone at all. "Record Area" needs the same treatment — a new `AreaEffect.effect` member, a new `ZoneType` member, a new toolbar entry, a new dialog branch, a new `addArea` ternary branch, and a legend color.
- Zones are not a database model — they live as JSON inside `Room.layerData.areas` (reconstructed into `Zone[]` at read time via `layerDataToLegacy()`), so this feature needs no migration.
- **Zone-entry detection already has one clean, proven extension point to mirror.** `client/src/components/ZoneWatcher.tsx:71-74` computes `meetingZone` via `findZoneAt({x,y}, zones.filter(z => z.type === 'meeting'))`, reports it out via `onMeetingZoneChange`, which `App.tsx` stores as `meetingZoneId` and uses to conditionally mount `<MeetingControl>`. This is the only place in the codebase that resolves "am I standing in a zone of type X" — a "Record Area" equivalent mirrors this exact shape with a different type filter.
- **Screen recording today has zero zone-gating** — the standalone `RecordingControl` built earlier this session is always visible in `kaitech`/`dcm` regardless of where the player stands, gated purely by `canStartRecording(role, roomSlug)`. This stays exactly as-is; the new zone panel is an additional, independent surface for the same underlying recording state, not a replacement.
- **Pause/resume is natively supported with zero upload-pipeline changes needed.** `useScreenRecording.ts` constructs a genuine, unwrapped `MediaRecorder` (`.pause()`/`.resume()` are standard methods on it). The existing chunk-accumulation design already produces exactly one final file regardless of pauses in between (`chunksRef` accumulates for the whole session; `onstop`, which only fires on `.stop()`, builds one Blob from whatever's accumulated) — no restructuring needed there.
- **Pause/resume can be entirely client-local.** The `Recording` Prisma model's status (`recording|processing|done|failed`) and the server's one-recording-per-room lock are both untouched by pause — the server has no visibility into `MediaRecorder` state today by design (capture lives entirely in the recorder's own browser), and confirmed with the user: other viewers don't need to see a "paused" indicator, only the recorder's own control panel does. No server or database change is needed for pause/resume at all.

Confirmed with the user:
- Entering the zone shows a panel; recording only starts on an explicit click (same pattern as "Start Meeting" — never auto-starts).
- The existing standalone `RecordingControl` (kaitech/dcm, always visible) stays exactly as-is; the new zone panel is additional, not a replacement.
- "Record Area" is a genuine new Room Editor tool (not a cheaper name-matching workaround) — admins can draw it into any room they have edit access to, the same way they draw Meeting/Focus areas today.
- Pause state is local to the recorder's own panel only — no broadcast to other viewers, no new `Recording.status` value.
- This work builds the capability only — no zone is drawn into any specific room as part of this plan; the user draws it themselves afterward via the Room Editor.

## Design

### 1. New Room Editor tool: "Record Area"

- `shared/mapLayers.ts`: `AreaEffect.effect` gains `'recordArea'` alongside the existing `'meetingArea'`/`'focusArea'`/etc. members.
- `shared/types/index.ts`: `ZoneType` gains `'record'` alongside `'meeting'`/`'desk'`/`'focus'`/`'general'`.
- `client/src/pages/RoomEditorPage.tsx`: a new entry in the `EFFECTS` toolbar array (id `'recordArea'`, its own label/color/hint, distinct from Meeting Area's), and a new `else if (s.selectedEffect === 'recordArea')` branch in the dialog chain — prompts for a name only (mirroring the simplest existing per-effect dialog, not the more elaborate meeting-area flow with its audio-isolation toggle, since a record area has no audio-isolation concept), then calls `addArea('recordArea', ...)`.
- `client/src/stores/editorStore.ts`: `addArea`'s effect-union parameter gains `'recordArea'`; the effect→`Zone.type` ternary gains `effect === 'recordArea' ? 'record' : ...` (inserted before the existing catch-all `'desk'` fallback); the legend-color ternary gains a matching branch for `'recordArea'`.

### 2. Zone-entry detection

`client/src/components/ZoneWatcher.tsx` gains a `recordZone` computation, structurally identical to the existing `meetingZone` block: `findZoneAt({x,y}, zones.filter(z => z.type === 'record'))`, reported via a new `onRecordZoneChange(recordZone?.id ?? null)` callback prop. `App.tsx` gains a matching `recordZoneId` state (mirroring `meetingZoneId`) wired to that callback.

### 3. New zone-gated panel

A new component (mirroring `MeetingControl.tsx`'s self-positioning style, not reusing `RecordingControl.tsx`'s sidebar/standalone variants directly) mounts in `App.tsx`, gated on `recordZoneId && !editorMode`. It consumes the SAME recording state already centralized in `App.tsx` (`requestRecording`, `stopMyRecording`, the new pause/resume callables from §4, `isRecordingMine`, `activeRecording`) — there is exactly one source of truth for "is a recording active," shared between this new panel and the existing standalone control, so starting/stopping/pausing from either surface stays consistent (the server's existing one-recording-per-room lock already prevents any duplicate-recording scenario regardless of which UI triggered it).

Rendered states: no active recording of mine → a "Start Recording" button (same permission gate as today, `canStartRecording(role, roomSlug)` — a room without recording permission for this user simply shows no usable Start action, same as the existing standalone control's behavior); recording active and paused → "Lanjutkan" (Resume) + "Stop"; recording active and not paused → "Jeda" (Pause) + "Stop". Positioned in its own screen region, deliberately not sharing `MeetingControl`'s row (avoiding the exact collision class the Recording Revamp's final review caught between the standalone recording control and the active-meeting pill).

### 4. Pause/resume in `useScreenRecording.ts`

New local state `isPaused`, and two new callables, `pauseRecording`/`resumeRecording`, calling `recorderRef.current?.pause()`/`.resume()` directly (both are standard `MediaRecorder` methods, already confirmed present on the existing recorder object). The existing 80-minute wall-clock auto-stop `setTimeout` is cleared when pausing and restarted at full duration when resuming — a deliberate simplification (a recording paused and resumed multiple times can end up running longer than 80 minutes of *wall-clock* time since the first Start, though not more than 80 minutes of actual *captured* time in any single active segment) rather than tracking precise cumulative elapsed-active-time; this keeps the change small and matches the cap's original purpose (bounding a single unattended capture session, not enforcing a hard total-duration limit). No change to `Recording.status`, no new socket events, no server involvement at all — purely local hook state, returned alongside the existing `isRecordingMine`/`uploading` fields.

`RecordingControl.tsx`'s existing Record/Stop button logic gains the same pause-awareness as the new zone panel (§3), so a user who started recording from the STANDALONE control also sees Pause/Resume there, not just from the zone panel — both surfaces read the one shared state.

## Error handling

- `MediaRecorder.pause()`/`.resume()` calls are no-ops (per spec) if the recorder isn't in the expected state (e.g. calling pause while already paused) — no new error handling needed beyond what the browser API already guarantees.
- Zone-entry detection failing to find any `'record'`-type zone behaves exactly like today's meeting-zone case: the panel simply doesn't mount (`recordZoneId` stays `null`), no error surfaced.
- The zone panel's Start button reuses the exact same permission/rejection path as the existing standalone control (`recordingHandler.ts`'s `RECORDING_START`, unchanged) — a rejected start (wrong room, no permission, lock already held) surfaces the same existing `admin:error` message either surface already handles.

## Out of scope

- No zone is drawn into any room as part of this work — building the tool/capability only, per the user's explicit choice.
- No change to the Lark VC Meetings feature (`MeetingControl.tsx`, `MomRecord`) at all — the new zone type is deliberately unconnected to it.
- No broadcast of pause state to other viewers, no new `Recording.status` value, no server or database change for pause/resume.
- No precise cumulative-active-time tracking for the 80-minute cap across multiple pause/resume cycles — the simplified "reset the timer on resume" behavior is intentional (see §4).
- No changes to the existing standalone `RecordingControl`'s visibility rules (still gated on `canStartRecording`, still kaitech/dcm-only per the existing hardcoded allowlist) — the new zone panel does not introduce a new permission bypass; a "Record Area" zone drawn into a room where a user lacks recording permission still shows no usable Start action for them.
