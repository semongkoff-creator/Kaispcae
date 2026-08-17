import { create } from 'zustand';
import { Avatar, RoomTile, RoomState, ChatMessage, EmoteEvent, SpeechBubble, Furniture, Zone, TileType, RoomTheme, RoomTemplateId, Notice, RoomBroadcast, FollowInfo, Role, FollowRequestPayload, FollowResultPayload, RemoteHelpRequestPayload, RemoteHelpResultPayload, SummonRequestPayload, SummonResultPayload, JoinRequestPopupPayload, ZoneQueueRequestedPayload, ZoneQueueSessionActivePayload, GuestJoinRequest, MapMediaObject, ImpassableAreaRect, DoorAreaRect, WhiteboardStroke, Channel, ChannelMessage, ChatReadEntry, DirectConversationSummary, WorkMode, InteractivePasswordResultPayload, InteractiveDoorPasswordResultPayload, InteractiveDoorAreaPasswordResultPayload, InteractiveChoiceResultPayload, SoundboardSoundData, MusicSessionState, ReferenceImageData, DeskNoteData, RosterEntry, RosterUpdate, hasFeatureAccess } from '@kaispace/shared';
import type { ManualStatus } from '../data/presence';
import { getMutedUserIds, saveMutedUserIds } from '../services/mutedUsers';
import { appendMovementSnapshot, MovementSnapshot, sampleMovementSnapshots } from './movementSmoothing';
import type { UserPreferences } from '../services/api';

// §7 — only ever populated for clients who are allowed to see it at all
// (the target being recorded, or an admin+) — see recordingHandler.ts's
// per-socket RECORDING_STARTED emit, which simply never reaches anyone else.
// Bug — briefly 0.25 (25%), which isn't a multiple of the 10%-step grid
// below: zooming out landed EXACTLY on 0.25/0.1=2.5, the halfway point
// between grid steps, and needed a special-cased snap to ever reach it at
// all. That snap only reliably fired for the +/- BUTTONS' fixed 1.2× step;
// the mouse wheel/trackpad's smaller 1.1× step (and, worse, a trackpad's
// flurry of tiny rapid-fire wheel events per gesture) could land on raw
// values that never crossed the snap's threshold cleanly, leaving zoom
// stuck around 30% with no way down. 0.3 IS a multiple of the grid, so
// Math.round naturally lands on it from any input — no special-casing
// needed, and it's unreachable-25% become moot since there's no longer a
// non-grid floor to fail to reach.
export const MIN_MAP_ZOOM = 0.3;
export const MAX_MAP_ZOOM = 2;
// Below this, GameCanvas.tsx swaps the whole rendering to Overview mode —
// now the same value as MIN_MAP_ZOOM, so hitting the zoom floor by any path
// (button, wheel, trackpad) always lands in Overview mode. This is only the
// TRIGGER now, not the actual render zoom while Overview is active — the
// draw loop replaces it with a dynamically fit-to-viewport value so the
// whole map actually fills the screen (see GameCanvas.tsx's draw loop).
export const OVERVIEW_ZOOM_THRESHOLD = 0.3;
// Sharpness follow-up — mapZoom used to be fully continuous (each +/-
// click or wheel notch multiplied it by 1.2/1.1), so `mapZoom * dpr`
// landed on an arbitrary value like 1.728 almost every time, and
// GameCanvas draws every tile/sprite through that scale on top of its own
// already-non-integer 48/32 source-to-display ratio (TILE_SIZE vs
// SOURCE_TILE_SIZE — a separate, deliberately UNCHANGED tradeoff, see
// shared/types/index.ts). Snapping to clean 10% steps doesn't erase that
// underlying ratio, but it does make every zoom LEVEL land on the exact
// same round number every time (100%, 110%, 120%, ...) instead of
// compounding into odd fractional percentages the longer someone zooms,
// which is both crisper on average and far more predictable as a control.
const ZOOM_STEP = 0.1;
// Bug — `Math.round(z / ZOOM_STEP) * ZOOM_STEP` looks exact but isn't:
// 3 * 0.1 === 0.30000000000000004 in IEEE754 double precision, not 0.3, so
// landing on the floor (MIN_MAP_ZOOM = 0.3) produced a value a hair ABOVE
// 0.3 — GameCanvas.tsx's `zoom <= OVERVIEW_ZOOM_THRESHOLD` (0.3) then
// silently evaluated false right at the one zoom level Overview mode is
// actually supposed to trigger at. Every real step here is exact to 1
// decimal place, so rounding the result to 2 decimals is a safe way to
// kill the float dust without touching the actual snapped values.
// QA items (Full Office view — Batas hak full-view) — Overview mode (see
// OVERVIEW_ZOOM_THRESHOLD above) shows everyone in the office at once,
// including anyone hidden from regular members — so reaching it is gated
// the same admin+ tier as hidden-avatar visibility itself
// ('presence:full_view', shared/permissions.ts). A non-admin's zoom floor
// is clamped one grid step ABOVE the threshold, so they can still zoom out
// generously, just never far enough to trigger Overview.
const clampMapZoom = (z: number, role: Role) => {
  const floor = hasFeatureAccess(role, 'presence:full_view') ? MIN_MAP_ZOOM : MIN_MAP_ZOOM + ZOOM_STEP;
  const snapped = Math.max(floor, Math.min(MAX_MAP_ZOOM, Math.round(z / ZOOM_STEP) * ZOOM_STEP));
  return Math.round(snapped * 100) / 100;
};

export interface ActiveRecordingInfo {
  recordingId: string;
  targetUserId: string;
  targetName: string;
  startedByName: string;
  title: string;
}

export interface ActivityEvent {
  id: string;
  message: string;
  timestamp: number;
}

// Bug 12 — the set of mutually-exclusive main panels. Deliberately excludes
// small HUD popovers (Presence, Notifications, Activity feed, Device menu,
// Status, attachment menu), the avatar editor modal, the minimap/emote-wheel,
// the mini-mode popout window, the file lightbox, toasts and confirm modals —
// those are separate layers, not panels. Room-editor mode is tracked by
// `editorMode`, coordinated to be exclusive with these without being one of them.
export type PanelId =
  | 'chat'
  | 'participants'
  // The "Room Features" dropdown menu (Sidebar.tsx) — folded into the same
  // single-slot mutual exclusion as every panel it links to (Teleport,
  // Kalender, etc.). It used to be its own local boolean in Sidebar.tsx,
  // independent of activePanel, so it could stay open behind (and visually
  // collide with) whichever real panel was open — opening Teleport never
  // closed it and vice versa. Folding it in here means opening ANY panel
  // (including this menu itself) now automatically closes whatever else was
  // open, the same guarantee every other entry in this union already had.
  | 'roomFeatures'
  | 'teleport'
  | 'addMedia'
  | 'adminPanel'
  | 'meeting'
  | 'calendar'
  | 'adminConsole'
  | 'attendance'
  | 'messenger'
  | 'joinQueue'
  | 'soundboard'
  // Productivity Analytics — Bagian B.1's Individual tier is for EVERY
  // employee ("cermin evaluasi diri"), unlike adminConsole above which is
  // gated to workspaceRole==='admin' and invisible to ordinary members —
  // so this is its own panel, not a tab inside AdminConsole. Team/
  // company-wide tiers land inside AdminConsole instead (Phase 3), since
  // those really are manager/admin-only surfaces.
  | 'myAnalytics'
  // Operator-only, cross-org organization list (see
  // specs/2026-08-12-operator-org-list-design.md) — gated on
  // currentUser.isOperator, not workspaceRole, unlike adminConsole above.
  | 'operatorConsole'
  // Fix panel numpuk, round 2 — these six used to be independent
  // useState(false) booleans in App.tsx (or, for activityFeed, entirely
  // self-contained inside the component itself with no external control at
  // all), so none of them closed when another panel opened, and none of
  // the "real" panels closed them either — confirmed live: Soundboard
  // (already activePanel-gated) and Recent Activity (not gated at all)
  // stayed open together. Folding all six into this same union is the
  // exhaustive fix — every future entry added here automatically joins the
  // same mutual exclusion, so this class of bug can't reopen one panel at
  // a time again.
  | 'activityFeed'
  | 'avatarSetup'
  | 'userGuide'
  | 'memberList'
  | 'settings'
  | 'bookingForm';

// Keeps the feed skimmable and bounds its memory — old entries just fall
// off the end rather than needing a separate pruning pass (see
// activityEvents's own doc comment above).
const ACTIVITY_FEED_MAX = 50;

// Per-channel/DM in-memory cache cap (see messagesByTarget's doc comment) —
// older history is still on the server via GET .../messages, this just
// bounds how much a long session keeps resident in the client store.
const CHAT_TARGET_MAX = 200;

const AVATAR_COLORS = ['#ff6b6b', '#4ecdc4', '#ffe66d', '#a786df', '#6bcb77', '#4d96ff'];

function randomColor(): string {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

const REMOTE_MOVEMENT_RENDER_DELAY_MS = 120;

export interface GameState {
  localPlayerId: string;
  setLocalPlayerId: (id: string) => void;

  localPlayer: Avatar;
  setLocalPlayer: (partial: Partial<Avatar>) => void;

  // All players (excluding local) keyed by id for O(1) lookup
  playerRecords: Record<string, Avatar>;
  setPlayerRecords: (players: Record<string, Avatar>) => void;
  upsertPlayer: (player: Avatar) => void;
  removePlayer: (id: string) => void;

  // Remote player position snapshots. Rendering trails receipt time slightly
  // so jittery packets can be interpolated instead of chased one-by-one.
  playerTargets: Record<string, MovementSnapshot[]>;
  setPlayerTarget: (id: string, x: number, y: number, receivedAt?: number) => void;

  // Interpolate all remote players one step toward their targets
  interpolatePlayers: () => void;

  // Tiles
  tiles: RoomTile[][];
  setTiles: (tiles: RoomTile[][]) => void;

  // Item #9 (precise-collision follow-up) — Impassable Area rectangles,
  // pixel space, for the client's own local movement PREDICTION (see
  // useMovement.ts's wouldCollide) — the server independently re-checks the
  // same rectangles authoritatively (movementHandler.ts), this is purely so
  // the local avatar doesn't visibly walk into one for a frame before the
  // server's rejection catches up.
  impassableAreaRects: ImpassableAreaRect[];
  setImpassableAreaRects: (rects: ImpassableAreaRect[]) => void;

  // Room Editor's "Wall Area" tool — a subset of impassableAreaRects above
  // (already merged in for collision), kept separately here purely so
  // GameCanvas.tsx has something to draw — the one visible flavor of
  // impassable rect, unlike a plain Impassable Area which stays invisible.
  wallAreaRects: ImpassableAreaRect[];
  setWallAreaRects: (rects: ImpassableAreaRect[]) => void;

  // "Door Area" tool — the resizable-area successor to the per-tile 'door'
  // TileEffect. Conditional collision (only blocks a socket that hasn't
  // unlocked this specific area id — see unlockedDoorAreaIds below), so
  // unlike impassableAreaRects it's NOT pre-merged for collision here;
  // GameCanvas.tsx filters it by unlock state itself before checking.
  doorAreaRects: DoorAreaRect[];
  setDoorAreaRects: (rects: DoorAreaRect[]) => void;
  // Client-local, per-session unlock tracking (mirrors the per-tile
  // unlockedDoors Set already in GameCanvas.tsx, just promoted to the store
  // so App.tsx's password-check response handler can update it) — the
  // server independently enforces the same thing authoritatively
  // (movementHandler.ts's isDoorAreaUnlocked); this is purely so the local
  // avatar's own collision prediction matches without a round trip.
  unlockedDoorAreaIds: Set<string>;
  unlockDoorAreaLocally: (areaId: string) => void;

  // Room meta
  roomId: string;
  roomName: string;
  // Which curated asset set to render this room with — see RoomTheme in
  // shared/types/index.ts and client/src/data/themeAssets.ts. Set from
  // room:state (see setRoomState below); defaults to the original tileset
  // so the optimistic local room shown before that arrives still renders.
  theme: RoomTheme;
  // Which layout this room was created with (see defaultRoomLayout.ts's
  // ROOM_TEMPLATES) — undefined for rooms created before this existed.
  // Lets RoomEditor.tsx's "Reset to Default" rebuild the room's OWN
  // template instead of always reverting to Main Office.
  roomTemplate: RoomTemplateId | undefined;

  // Floor-plan reference image, set from room:state's `referenceImage` only
  // when the admin opted into showInGame (see RoomState's doc comment) —
  // null otherwise. GameCanvas.tsx renders this for every player when set.
  liveReferenceImage: ReferenceImageData | null;
  // Room-wide avatar sprite scale (see RoomState.avatarScale) — 1 = unchanged
  // size. AvatarSprite.ts multiplies every rendered avatar's dimensions by
  // this.
  avatarScale: number;

  // Connection
  isConnected: boolean;
  setConnected: (connected: boolean) => void;

  // Whether the REAL room:state for the room currently being joined has
  // arrived yet — distinct from roomState itself, which App.tsx also seeds
  // once at startup with a hardcoded placeholder layout so GameCanvas has
  // something to render before any socket connection exists at all. That
  // placeholder is always the Main Office layout regardless of which
  // room/template the player is actually about to join, so Game.tsx gates
  // rendering the canvas on THIS flag instead of just "roomState exists" —
  // otherwise every join to a non-default-template room would flash the
  // wrong layout shape for a frame (and could even spawn the player inside
  // a wall, since wall positions differ per template). Reset to false by
  // useSocket.ts at the start of every new room-join attempt, set true only
  // by its ROOM_STATE handler.
  roomStateReceived: boolean;
  setRoomStateReceived: (received: boolean) => void;

  // Set when the server reports this room was deleted (by its owner) while
  // we were in it. Game watches this and navigates back to the Lobby via
  // React state (no full page reload) instead of leaving the player stuck
  // looking at a canvas nothing else will ever update.
  roomDeletedNotice: string | null;
  setRoomDeletedNotice: (notice: string | null) => void;

  // Transient "couldn't sit" reason (e.g. the chair is already taken). Shown
  // as a self-dismissing HUD banner in App.tsx, not a navigation like the
  // notices below it.
  sitNotice: string | null;
  setSitNotice: (notice: string | null) => void;

  // Live ownership of claimable-seat markers (see mapLayers.ts's TileEffect
  // 'claimableSeat'), keyed by seatId. Server-authoritative, in-memory only
  // — refreshed wholesale on every SEAT_CLAIMS_UPDATED broadcast.
  seatClaims: Record<string, { userId: string; name: string }>;
  setSeatClaims: (claims: { seatId: string; userId: string; name: string }[]) => void;

  // Set when an admin removes us from the room via Kick (see
  // shared/permissions.ts's 'room:kick') — mirrors roomDeletedNotice's
  // "show a notice, then navigate back to the Lobby" pattern in App.tsx.
  kickedNotice: string | null;
  setKickedNotice: (notice: string | null) => void;

  // QA (Moderasi checklist item 11, "Kick/mute admin") — set when an admin
  // force-mutes us (shared/permissions.ts's 'room:force_mute'). Unlike
  // kickedNotice this does NOT bounce anyone anywhere — App.tsx's own
  // effect both performs the actual mute (the server can only ask, see
  // PLAYER_FORCE_MUTED's own doc comment) and shows a brief self-dismissing
  // toast, same shape as miniModeError/screenShareError.
  forceMutedNotice: string | null;
  setForceMutedNotice: (notice: string | null) => void;

  // QA (Data A/V checklist item 7, "Rekaman & consent") — genuinely
  // room-wide (unlike activeRecording below, which stays role/identity-
  // filtered — see its own doc comment). Just a boolean, no recordingId/
  // title/names — enough for a "room ini sedang direkam" banner visible to
  // literally everyone, regardless of role.
  roomRecordingActive: boolean;
  setRoomRecordingActive: (active: boolean) => void;

  // QA items #9/#10 (multi-tab) — this specific TAB's connection lost to a
  // newer one for the same account/guest token (see shared
  // SocketEvents.SESSION_TAKEN_OVER). Same "show a notice, then leave"
  // pattern as kickedNotice above, but deliberately its own flag: unlike a
  // real kick/room-lock denial, the token itself is still valid — the
  // handler must NOT clear vm_token (see App.tsx, shared localStorage would
  // also log the winning tab out).
  sessionTakenOverNotice: string | null;
  setSessionTakenOverNotice: (notice: string | null) => void;

  // QA (Load checklist item 1, "Concurrency tim penuh") — mirrors
  // sessionTakenOverNotice's shape above, for the room-full denial
  // (JOIN_DENIED with reason 'room-full'). No "knock to enter" option makes
  // sense here (the room being full isn't the host's call to override) —
  // just an informative message and a way back to the Lobby.
  roomFullNotice: string | null;
  setRoomFullNotice: (notice: string | null) => void;

  // Akses & Password Pintu audit item #9 — emergency door override (see
  // shared SocketEvents.DOOR_OVERRIDE_SET). When true, every password door
  // in the room is treated as unlocked client-side too (GameCanvas.tsx's
  // isBlocked prediction), matching what the server independently enforces.
  doorOverride: boolean;
  setDoorOverride: (active: boolean) => void;

  // Sitting — localPlayer.isSitting/x/y/direction (Avatar fields, already
  // synced to other players) hold the visible state; these two are local
  // bookkeeping only, never broadcast. sittingFurnitureId names which chair
  // to stand up from; sitReturnPos is where to put the player back once
  // they do (their position right before sitting, one tile off the chair —
  // the chair's own tile is normally movement-blocked, so simply leaving
  // them there on stand-up would strand them on a blocked tile).
  sittingFurnitureId: string | null;
  setSittingFurnitureId: (id: string | null) => void;
  sitReturnPos: { x: number; y: number } | null;
  setSitReturnPos: (pos: { x: number; y: number } | null) => void;
  // "My Seat" teleport-then-sit (see useSocket.ts's PLAYER_TELEPORTED
  // handler) needs sittingFurnitureId/sitReturnPos/localPlayer's position
  // updated together in ONE render, not three separate set() calls — each
  // of those is its own Zustand update, so calling setSittingFurnitureId,
  // setSitReturnPos, and setLocalPlayer back-to-back let GameCanvas render
  // at least one frame with isSitting/sittingFurnitureId already updated
  // but localPlayer.x/y still at the OLD position, i.e. a visible flash of
  // the player sitting at the wrong spot before snapping to the seat.
  landOnSeat: (furnitureId: string, returnPos: { x: number; y: number }, x: number, y: number, direction: Avatar['direction']) => void;

  // Media / WebRTC
  micMuted: boolean;
  setMicMuted: (muted: boolean) => void;
  cameraOn: boolean;
  setCameraOn: (on: boolean) => void;
  localSpeaking: boolean;
  setLocalSpeaking: (speaking: boolean) => void;
  // A3/A11 — local presence status (effective). Kept here for quick access AND
  // mirrored onto localPlayer.workMode so the local avatar renders its own
  // status badge.
  workMode: WorkMode;
  setWorkMode: (mode: WorkMode) => void;
  // A11 — the user's last MANUAL choice (see MANUAL_STATUSES in
  // data/presence.ts). Distinct from the effective `workMode`: while inside a
  // meeting/focus zone the effective status is forced to 'in_meeting'/'focus'
  // regardless of this value, which is remembered and re-applies the moment
  // they leave the zone.
  manualStatus: ManualStatus;
  setManualStatus: (status: ManualStatus) => void;
  // Fitur 3B — reason picked from the Away popup, alongside manualStatus
  // 'away'. null when away has no specific reason (prompt timed out) or when
  // manualStatus isn't 'away' at all.
  awayReason: string | null;
  setAwayReason: (reason: string | null) => void;
  // Music Bot — one MusicSessionState per zone that currently has one (see
  // musicHandler.ts), keyed by zoneId. Replaced wholesale on every
  // MUSIC_STATE broadcast rather than patched in place — the server always
  // sends the full current+queue snapshot, same convention as room:state.
  musicSessionsByZone: Record<string, MusicSessionState>;
  setMusicSessionState: (state: MusicSessionState) => void;
  // Main game view camera zoom — purely a local rendering preference (how
  // much of the map is visible on screen), NOT sent to the server and NOT
  // part of collision/movement math (those stay in world/tile units
  // regardless of zoom), so it's safe to be per-client with no multiplayer
  // desync risk — unlike TILE_SIZE, which every client must share.
  mapZoom: number;
  setMapZoom: (zoom: number) => void;
  // Bug — zoomMapBy(factor) multiplied the raw zoom by a continuous factor
  // (1.2 for the +/- buttons, 1.1 for the wheel/trackpad) and re-snapped to
  // the nearest 10% grid step. That round-trip has fixed points: at 50%,
  // 0.5/1.1 = 0.4545... rounds back UP to 50% (4.545 > 4.5), so the wheel
  // could never move off it at all — permanently stuck, not just slow.
  // 40% has the same fixed point. The buttons' bigger 1.2× step happens to
  // dodge this across the current zoom range, but nothing guaranteed that.
  // stepMapZoom moves by an exact integer number of grid steps instead —
  // no float multiplication in the loop at all, so there's no fixed point
  // to get stuck on, ever, regardless of how the range changes later.
  stepMapZoom: (steps: number) => void;
  speakingPlayers: Set<string>;
  setPlayerSpeaking: (id: string, speaking: boolean) => void;

  // Zone-private "Private" tab chat history in ChatPanel.tsx — the old
  // whole-room ephemeral chat this used to sit alongside is gone, replaced
  // by persisted Channel/DM chat (see messagesByTarget below).
  zoneChatHistory: Record<string, ChatMessage[]>;
  addZoneChatMessage: (zoneId: string, msg: ChatMessage) => void;
  speechBubbles: Record<string, SpeechBubble>;
  setSpeechBubble: (playerId: string, bubble: SpeechBubble | null) => void;

  // Persisted Channel/DM/Thread chat (see ChatPanel.tsx, server/src/routes/
  // chat.ts) — separate from the ephemeral chatMessages/zoneChatHistory
  // above, which stay scoped to the ephemeral zone-private/proximity-bubble
  // case only. messagesByTarget is keyed by `channel:<id>` or `dm:<id>` and
  // holds top-level messages for whichever target is currently open in
  // ChatPanel; capped like activityEvents so a long session doesn't grow it
  // unbounded.
  channels: Channel[];
  setChannels: (channels: Channel[]) => void;
  dmConversations: DirectConversationSummary[];
  setDmConversations: (conversations: DirectConversationSummary[]) => void;
  activeChatTarget: { type: 'channel' | 'dm'; id: string } | null;
  setActiveChatTarget: (target: { type: 'channel' | 'dm'; id: string } | null) => void;
  chatPanelOpen: boolean;
  setChatPanelOpen: (open: boolean) => void;
  // Bug 12 — "one panel at a time": the single main panel currently open, or
  // null. Opening any panel replaces (closes) the previous one. Small HUD
  // popovers, the file lightbox, toasts and confirm modals are NOT panels and
  // live on their own layers — see PanelId for the exhaustive list. chatPanelOpen
  // stays in sync (it's exactly `activePanel === 'chat'`) so chat's existing
  // unread wiring keeps working. Room-editor mode (editorMode) is mutually
  // exclusive with panels too, coordinated in openPanel/toggleEditorMode.
  activePanel: PanelId | null;
  openPanel: (id: PanelId) => void;
  closePanel: () => void;
  // Unread message counts per chat target ("channel:<id>"/"dm:<id>") — bumped
  // when a message arrives for a target the user isn't currently viewing, and
  // cleared when they open/switch to it. Drives the badges on the Chat button
  // and the channel/DM pills (deferred in the original chat plan).
  unreadByTarget: Record<string, number>;
  bumpUnread: (key: string) => void;
  clearUnread: (key: string) => void;
  // "X is typing…" — per target ("channel:<id>"/"dm:<id>"), a map of the
  // typer's userId to an expiry timestamp. noteTyping refreshes the expiry on
  // each ping; the UI treats entries past their expiry as no longer typing
  // (there's no explicit "stopped typing" event — it just lapses).
  typingByTarget: Record<string, Record<string, number>>;
  noteTyping: (key: string, userId: string) => void;
  messagesByTarget: Record<string, ChannelMessage[]>;
  setTargetMessages: (key: string, messages: ChannelMessage[]) => void;
  prependTargetMessages: (key: string, messages: ChannelMessage[]) => void;
  // Read receipts — who has read up to where, per chat target ("channel:<id>"
  // /"dm:<id>"), keyed further by userId so a single CHAT_READ_UPDATED patches
  // one entry without touching the rest. setReadState replaces the whole map
  // for a target (the CHAT_READ_STATE_SYNC sent right after joining);
  // updateReadEntry patches one user's entry live.
  readStateByTarget: Record<string, Record<string, number>>;
  setReadState: (key: string, entries: ChatReadEntry[]) => void;
  updateReadEntry: (key: string, userId: string, lastReadAt: number) => void;
  appendTargetMessage: (key: string, message: ChannelMessage) => void;
  // Bug 6 — optimistic send. addPendingMessage shows the bubble the instant
  // Send is clicked (id === clientId, a temp id, status:'pending'), before any
  // network round trip. markMessageFailed/markMessagePending flip that same
  // entry's status in place (never remove it) so a failed send stays visible
  // with a retry affordance rather than silently vanishing.
  addPendingMessage: (key: string, message: ChannelMessage) => void;
  markMessageFailed: (key: string, clientId: string) => void;
  markMessagePending: (key: string, clientId: string) => void;
  // Remove a deleted message live (see shared MESSAGE_DELETED). parentId set
  // → it was a thread reply (also decrements the parent's replyCount);
  // otherwise a top-level message (also drops its cached thread).
  removeTargetMessage: (key: string, messageId: string, parentId?: string) => void;
  // Rewrite a message's text live (see shared MESSAGE_EDITED) + flag it
  // edited. parentId set → a thread reply; otherwise a top-level message.
  editTargetMessage: (key: string, messageId: string, text: string, parentId?: string) => void;
  // Set a message's pinned state live (see shared MESSAGE_PINNED). parentId
  // set → a thread reply; otherwise a top-level message. Same shape as
  // editTargetMessage above, one field instead of two.
  setMessagePinned: (key: string, messageId: string, pinned: boolean, parentId?: string) => void;
  // Bumps a top-level message's cached replyCount when a reply to it
  // arrives live — without this, "N replies" on the parent goes stale the
  // instant anyone (including the sender) replies, and never recovers
  // without a full reload (messagesByTarget only refetches on a cache
  // miss, and an existing target's cache is never a miss once loaded).
  bumpReplyCount: (targetKey: string, parentId: string) => void;
  // Thread replies, keyed by parent message id — populated once on expand
  // (ChatPanel fetches history via GET /messages/:id/replies) and then kept
  // live via socket, so a reply shows up immediately for the sender AND
  // anyone else with that same thread open, with no polling/setTimeout
  // guesswork about whether the write has landed yet.
  repliesByParent: Record<string, ChannelMessage[]>;
  setParentReplies: (parentId: string, replies: ChannelMessage[]) => void;
  appendParentReply: (parentId: string, reply: ChannelMessage) => void;

  // Pinned notice banner (see shared/types/index.ts's Notice doc comment) —
  // set from room:state on join and kept live via notice:updated.
  notice: Notice | null;
  setNotice: (notice: Notice | null) => void;

  // My own Follow relationship (I am the follower) — server-validated, see
  // followHandler.ts. GameCanvas.tsx reads followInfo.targetUserId every
  // frame to drive auto-trailing movement while it's non-null and
  // status === 'active'. followerUserIds is who's currently following ME
  // (for a small UI indicator), keyed by whichever userId is being tracked.
  followInfo: FollowInfo | null;
  setFollowInfo: (info: FollowInfo | null) => void;
  followerUserIds: string[];
  setFollowerUserIds: (ids: string[]) => void;
  // Locate ("Temukan") — ParticipantPanel's search-by-name action. A
  // one-shot signal, not persistent state like followInfo: GameCanvas's
  // frame loop picks it up, walks the local player toward that player's
  // CURRENT position via the same A* pathfinding double-click-to-move
  // uses, and highlights their avatar briefly. requestId (not just the
  // playerId) so locating the SAME person twice in a row still re-fires —
  // otherwise setting an unchanged value wouldn't even re-render.
  locateRequest: { playerId: string; requestId: number } | null;
  setLocateRequest: (playerId: string | null) => void;

  // Personal "mute a disruptive person" — see services/mutedUsers.ts's doc
  // comment. Purely client-side (never broadcast — the muted person can't
  // tell): filters THEIR chat messages/nudges/slaps out of MY OWN view
  // only, everything else about them stays exactly the same. Keyed by
  // stable account userId (not socket id), since a mute is meant to
  // survive their reconnect. Persisted to localStorage on every change so
  // it survives a reload too.
  mutedUserIds: Set<string>;
  muteUser: (userId: string) => void;
  unmuteUser: (userId: string) => void;

  // Follow/Summon consent requests — see PendingRequestToast.tsx. Both
  // "incoming" (someone else wants to do this to ME, needs Accept/Decline)
  // and "result" (I asked, here's what happened) are transient, App.tsx
  // auto-clears them, same pattern as the old summonWarning/summonNotice
  // toasts this replaces.
  incomingFollowRequest: FollowRequestPayload | null;
  setIncomingFollowRequest: (req: FollowRequestPayload | null) => void;
  followResult: FollowResultPayload | null;
  setFollowResult: (result: FollowResultPayload | null) => void;
  incomingRemoteHelpRequest: RemoteHelpRequestPayload | null;
  setIncomingRemoteHelpRequest: (req: RemoteHelpRequestPayload | null) => void;
  remoteHelpResult: RemoteHelpResultPayload | null;
  setRemoteHelpResult: (result: RemoteHelpResultPayload | null) => void;
  // Active session, tracked identically on both sides — `role` says whether
  // THIS client is the one being helped (sees the credential form) or the
  // one helping (waits for the credential to arrive). null = no active
  // session. Cleared on REMOTE_HELP_END from either side, or when this
  // client itself clicks "Selesai".
  activeRemoteHelp: { role: 'target' | 'helper'; otherName: string } | null;
  setActiveRemoteHelp: (v: { role: 'target' | 'helper'; otherName: string } | null) => void;
  // The credential the TARGET typed in, once relayed — read once by the
  // HELPER's own UI to display it, then not needed again. Split fields (not
  // one string) so the helper's UI can build a rustdesk://<id> deep link
  // from just the id — see RemoteHelpCredentialPayload's own doc comment
  // for why the password specifically never travels through a link. Never
  // localStorage/sessionStorage (see design spec's Security section).
  receivedRemoteHelpCredential: { rustdeskId: string; password: string } | null;
  setReceivedRemoteHelpCredential: (v: { rustdeskId: string; password: string } | null) => void;
  // Authoritative "your credential actually reached the helper" signal —
  // set true only by the server's REMOTE_HELP_CREDENTIAL_ACK, reset to
  // false whenever a fresh session starts (see App.tsx's accept-click
  // handler). RemoteHelpCredentialForm gates its "Terkirim" confirmation on
  // this, never on the act of clicking submit (final-review Fix 3).
  remoteHelpCredentialAcked: boolean;
  setRemoteHelpCredentialAcked: (v: boolean) => void;
  incomingSummonRequest: SummonRequestPayload | null;
  setIncomingSummonRequest: (req: SummonRequestPayload | null) => void;
  // Item #5 — room-join requests popped up for admins (see
  // JoinRequestPopupPayload). An array, not a single slot like the others
  // above: several people can request to join at once and every one of them
  // needs to stay actionable, not just the latest.
  incomingJoinRequests: JoinRequestPopupPayload[];
  addIncomingJoinRequest: (req: JoinRequestPopupPayload) => void;
  removeIncomingJoinRequest: (userId: string, roomSlug: string) => void;
  // "Ngobrol dengan CEO" queue, zone-level — same "array, persists until
  // acted on" shape as incomingJoinRequests above, popped up for admins via
  // SocketEvents.ZONE_QUEUE_REQUESTED.
  incomingQueueRequests: ZoneQueueRequestedPayload[];
  addIncomingQueueRequest: (req: ZoneQueueRequestedPayload) => void;
  removeIncomingQueueRequest: (entryId: string) => void;
  // "Ngobrol dengan CEO" queue, zone-level — currently-active sessions
  // keyed by userId, so GameCanvas can look up "is this avatar mid-session"
  // while drawing and render a small floating countdown above them (works
  // for both the requester and whoever they're visiting, e.g. the CEO).
  // Seeded from ROOM_STATE.activeZoneSessions on join, kept live via
  // ZONE_QUEUE_SESSION_ACTIVE / ZONE_QUEUE_SESSION_CLEARED.
  activeZoneSessions: Map<string, ZoneQueueSessionActivePayload>;
  setActiveZoneSessions: (sessions: ZoneQueueSessionActivePayload[]) => void;
  upsertActiveZoneSession: (session: ZoneQueueSessionActivePayload) => void;
  clearActiveZoneSessionByZone: (zoneId: string) => void;
  // Guest Link & Ruang Tunggu — the GUEST'S OWN client-side wait state
  // (App.tsx renders a waiting/rejected screen off this instead of <Game>).
  guestWaitState: 'waiting' | 'admitted' | 'rejected' | null;
  setGuestWaitState: (state: 'waiting' | 'admitted' | 'rejected' | null) => void;
  // Admin side — pending guest requests popped up for admins currently
  // connected to the room (see GuestJoinRequest). Array, not a single slot,
  // same reasoning as incomingJoinRequests above.
  pendingGuests: GuestJoinRequest[];
  addPendingGuest: (req: GuestJoinRequest) => void;
  removePendingGuest: (guestId: string) => void;
  summonResult: SummonResultPayload | null;
  setSummonResult: (result: SummonResultPayload | null) => void;
  // Fitur 15B — reply to MY OWN INTERACTIVE_PASSWORD_CHECK, same
  // request/reply shape as summonResult above.
  interactivePasswordResult: InteractivePasswordResultPayload | null;
  setInteractivePasswordResult: (result: InteractivePasswordResultPayload | null) => void;
  interactiveChoiceResult: InteractiveChoiceResultPayload | null;
  setInteractiveChoiceResult: (result: InteractiveChoiceResultPayload | null) => void;
  // ZEP-style door password — reply to my own INTERACTIVE_DOOR_PASSWORD_CHECK.
  interactiveDoorPasswordResult: InteractiveDoorPasswordResultPayload | null;
  setInteractiveDoorPasswordResult: (result: InteractiveDoorPasswordResultPayload | null) => void;
  // Doors solved THIS session ("x,y" keys) — a correct password result adds
  // one here so GameCanvas's local collision prediction stops blocking it
  // and doesn't re-prompt on the next approach. The server independently
  // tracks the same thing (doorLock.ts) for authoritative movement
  // validation; this is purely the client's own UI-responsiveness copy.
  unlockedDoors: Set<string>;
  unlockDoorClientSide: (x: number, y: number) => void;
  // "Door Area" — area-id counterpart to the two fields above.
  interactiveDoorAreaPasswordResult: InteractiveDoorAreaPasswordResultPayload | null;
  setInteractiveDoorAreaPasswordResult: (result: InteractiveDoorAreaPasswordResultPayload | null) => void;

  // §6 — Add Media. Full list synced from MEDIA_LIST (on join) then kept
  // live via MEDIA_ADDED/MEDIA_REMOVED; whiteboard strokes are mutated
  // in-place on the matching object's payload.strokes rather than resent
  // in full, since WHITEBOARD_STROKE_ADDED only ever carries the one new
  // stroke (see mediaHandler.ts's append-only design).
  mediaObjects: MapMediaObject[];
  setMediaObjects: (objects: MapMediaObject[]) => void;
  addMediaObject: (object: MapMediaObject) => void;
  removeMediaObject: (id: string) => void;
  appendWhiteboardStroke: (mediaId: string, stroke: WhiteboardStroke) => void;
  clearWhiteboardStrokes: (mediaId: string) => void;

  // §7 — Screen Recording. null means either nothing is being recorded, or
  // it is but I'm not allowed to know (plain member, not the target).
  activeRecording: ActiveRecordingInfo | null;
  setActiveRecording: (info: ActiveRecordingInfo | null) => void;

  // QA #7/#8/#9 — desk notes, placed freeform like mediaObjects (not tied to
  // furniture — see DeskNote's own doc comment in schema.prisma). Full list
  // synced from ROOM_STATE.notes on join, kept live via NOTE_ADDED/
  // NOTE_UPDATED/NOTE_DELETED — same "full sync then live patches" shape as
  // mediaObjects above.
  notes: DeskNoteData[];
  setNotes: (notes: DeskNoteData[]) => void;
  addNote: (note: DeskNoteData) => void;
  updateNote: (note: DeskNoteData) => void;
  removeNoteById: (id: string) => void;

  // QA (Presence checklist item #8, "Member list akurat") — workspace-wide
  // online/room registry, userId -> where they currently are. Absent from
  // this map means offline (cross-referenced against the full roster from
  // api.getWorkspacePeople() in MemberListPanel, not stored here). Filled
  // once from ROSTER_SNAPSHOT (requested when the panel opens — see
  // useSocket's emitRosterListRequest) and kept live via ROSTER_UPDATED
  // deltas from then on, same "snapshot then live patches" shape as notes.
  roster: Record<string, { roomSlug: string; roomName: string; zoneName?: string }>;
  setRosterSnapshot: (entries: RosterEntry[]) => void;
  applyRosterUpdate: (update: RosterUpdate) => void;

  // Emotes
  emoteEvents: EmoteEvent[];
  addEmote: (event: EmoteEvent) => void;
  removeExpiredEmotes: (now: number) => void;

  // Jump — cosmetic one-shot hop (see GameCanvas.tsx/AvatarSprite.ts). A Map
  // keyed by playerId (not an ever-growing array like emoteEvents above)
  // since only the MOST RECENT jump per player is ever relevant — a new
  // jump before the old one finished just restarts the same player's entry
  // instead of needing a second slot.
  jumpingPlayers: Map<string, number>;
  triggerJump: (playerId: string, timestamp: number) => void;

  // Fitur 15B — momentary display-only Interactive Object types
  // ('show_name', 'show_word_balloon'). Keyed by furnitureId → {expireAt,
  // variant?}, same Map-of-most-recent shape as jumpingPlayers above. Set by
  // App.tsx's handleInteractiveTrigger whenever one fires (press_f or
  // automatic — both just call this with a fixed duration); GameCanvas reads
  // it each frame to know whether to still draw that piece's floating
  // label/balloon. `variant` is opaque here — e.g. show_word_balloon's
  // "Random" style picks a color ONCE at trigger time (so it doesn't
  // flicker every frame) and threads it through as this string. Expired
  // entries are simply ignored at read time, never pruned.
  momentaryReveals: Map<string, { expireAt: number; variant?: string }>;
  triggerMomentaryReveal: (furnitureId: string, durationMs: number, variant?: string) => void;

  // Nudge ("senggol") — same Map-of-most-recent-timestamp shape as
  // jumpingPlayers above, keyed by the player being nudged (the one whose
  // avatar shakes + gets the spark burst), not the one who pressed Z.
  nudgedPlayers: Map<string, number>;
  // The nudge GESTURE (see GameCanvas.tsx) shows on the NUDGER's own body
  // instead — this parallel map is keyed by fromId (who pressed Z), set
  // together with nudgedPlayers from the same event.
  nudgerPlayers: Map<string, number>;
  triggerNudge: (targetId: string, timestamp: number, fromId?: string) => void;

  // Name of whoever last nudged ME (the local player) — drives a transient
  // on-screen toast (see App.tsx), so being nudged is obvious even while the
  // tab is focused, when the OS-level notification (browserNotifications.ts)
  // deliberately stays silent. Same one-shot-then-auto-clear pattern as
  // summonResult above.
  nudgedBy: string | null;
  setNudgedBy: (name: string | null) => void;
  // A10 — name of whoever last "colek"-ed (slapped) the local user; drives a
  // brief toast, separate from nudgedBy so the copy can differ.
  slappedBy: string | null;
  setSlappedBy: (name: string | null) => void;

  // Bug — the server's 'admin:error' event (a permission check rejecting an
  // admin-only action: Spotlight, Kick, room lock, ...) used to only ever
  // reach console.warn. Clicking a button you don't actually have server-
  // side permission for (a stale client-side role check, a room-admin list
  // that hasn't caught up, etc.) then did NOTHING visible at all —
  // indistinguishable from "the feature is just broken". Same brief-toast
  // pattern as slappedBy/nudgedBy above.
  adminErrorMessage: string | null;
  setAdminErrorMessage: (message: string | null) => void;

  // QA #9/#10 — CEO/admin text broadcast; drives a prominent room-wide
  // toast (see App.tsx), same one-shot-then-auto-clear pattern as
  // nudgedBy/slappedBy above. Not persisted anywhere — a client that wasn't
  // connected when it was sent simply never sees it (see RoomBroadcast's own
  // doc comment, shared/types/index.ts).
  roomBroadcast: RoomBroadcast | null;
  setRoomBroadcast: (broadcast: RoomBroadcast | null) => void;

  // Soundboard — this room's custom uploaded sounds (defaults live purely
  // client-side as SOUNDBOARD_DEFAULT_SOUNDS, no server round trip needed).
  // Synced from SOUNDBOARD_LIST on join, kept live via SOUNDBOARD_SOUND_ADDED.
  soundboardSounds: SoundboardSoundData[];
  setSoundboardSounds: (sounds: SoundboardSoundData[]) => void;
  addSoundboardSound: (sound: SoundboardSoundData) => void;
  removeSoundboardSound: (id: string) => void;
  // Who currently has a sound playing, for the blinking-speaker avatar
  // indicator — same Map-of-most-recent-expiry shape as momentaryReveals
  // above. A reactive selector (not a lazy .getState() pull) since GameCanvas
  // must re-render every frame this is active even while that avatar stands
  // still.
  playingSoundboard: Map<string, number>;
  triggerSoundboardPlaying: (playerId: string, expireAt: number) => void;

  // Recent Activity Feed — a lightweight, client-only log of room events
  // (join/leave, media added, notice pinned, recording start/end) built
  // entirely from socket events this client already receives (see
  // useSocket.ts's handlers) rather than a new server-persisted history —
  // scoped to "this session, in this ONE room" (unlike chat, which is now
  // persisted per-room). Capped at ACTIVITY_FEED_MAX so a long-running room
  // doesn't grow this unbounded (unlike emoteEvents above, which never got
  // the same treatment). Cleared by useSocket.ts at the start of every new
  // room-join attempt — without that, switching rooms (portal travel, or
  // leaving and rejoining a different one) left the previous room's stale
  // events mixed in with the new room's own.
  activityEvents: ActivityEvent[];
  addActivity: (message: string) => void;
  clearActivity: () => void;

  // Room editor
  furniture: Furniture[];
  setFurniture: (f: Furniture[]) => void;
  // Patches one furniture item's permanent seat assignment (undefined
  // userId/name clears it) — see FURNITURE_ASSIGN/FURNITURE_UNASSIGN.
  setFurnitureAssignment: (id: string, userId: string | undefined, name: string | undefined) => void;
  addFurniture: (item: Furniture) => void;
  removeFurnitureAt: (x: number, y: number) => void;
  setFloorPaletteId: (x: number, y: number, paletteId: string | undefined) => void;
  zones: Zone[];
  setZones: (z: Zone[]) => void;
  addZone: (zone: Zone) => void;
  removeZone: (id: string) => void;
  zoneDrawMode: boolean;
  toggleZoneDrawMode: () => void;
  // Rect awaiting the "name this zone" form in RoomEditor, set once a drag
  // finishes and cleared on confirm/cancel.
  pendingZoneRect: { x: number; y: number; width: number; height: number } | null;
  setPendingZoneRect: (rect: { x: number; y: number; width: number; height: number } | null) => void;

  // Same click-to-place flow as furniture, but for decorative banners (see
  // Furniture.kind === 'banner'): toggle bannerPlaceMode, click a tile, then
  // RoomEditor shows a form (text/colors/width) before it's actually added.
  bannerPlaceMode: boolean;
  toggleBannerPlaceMode: () => void;
  pendingBannerPos: { x: number; y: number } | null;
  setPendingBannerPos: (pos: { x: number; y: number } | null) => void;

  isAdmin: boolean;
  masterAdminUserId: string;
  adminPlayerIds: Set<string>;
  // Staff sits between admin and member (see shared/permissions.ts's Role
  // hierarchy) — tracked the same way adminPlayerIds already is.
  staffPlayerIds: Set<string>;
  // "Ngobrol dengan CEO" restricted-area bypass — deliberately NOT part of
  // the Role hierarchy (see roomHandler.ts's RoomAdminState.ceoUserIds doc
  // comment), tracked the same way staffPlayerIds is.
  ceoPlayerIds: Set<string>;
  localIsCeo: boolean;
  applyAdminChanged: (data: { adminUserIds: string[]; masterAdminUserId: string; staffUserIds?: string[]; ceoUserIds?: string[] }) => void;
  // My own resolved role in this room, straight from the server (see
  // RoomState.role's doc comment) — the authoritative source; isAdmin
  // above is derived from it for existing call sites that only care about
  // the admin/not-admin boolean.
  localRole: Role;
  localUserId: string;
  setLocalUserId: (id: string) => void;
  editorMode: boolean;
  toggleEditorMode: () => void;
  selectedTileType: TileType;
  setSelectedTileType: (t: TileType) => void;
  selectedPaletteId?: string;
  setSelectedPaletteId: (id: string | undefined) => void;
  // Room Editor: the "table" newly-placed chairs get grouped under. Chairs
  // placed while this is set share a tableId → they form one private
  // audio/video group when occupied (see Furniture.tableId). Editor-only UI
  // state, never persisted on its own.
  activeTableId?: string;
  setActiveTableId: (id: string | undefined) => void;
  tileHistory: TileType[][][];
  tileHistoryIndex: number;
  pushTileHistory: (tiles: TileType[][]) => void;
  undo: () => void;
  redo: () => void;

  // Full sync from server
  setRoomState: (state: RoomState) => void;

  // Player count (derived from playerRecords)
  playerCount: () => number;

  // Settings feature — live mirror of user.preferences.tooltipsEnabled
  // (App.tsx syncs it in on load/change). Lives here, not threaded as a prop
  // through the HUD tree, because the toolbar's ~9 buttons sit under several
  // layers of unrelated parents — a store read is one line per button vs.
  // plumbing a new prop through every intermediate component. Defaults true
  // so behavior is unchanged (tooltips already always showed) until someone
  // explicitly turns this off in Settings.
  tooltipsEnabled: boolean;
  setTooltipsEnabled: (enabled: boolean) => void;

  // Settings feature (Tahap 4) — live mirror of
  // user.preferences.notifKinds, same reasoning as tooltipsEnabled above:
  // useSocket.ts's event handlers already read other flags off this store
  // via getState() inside socket callbacks, so this is one more field there
  // rather than a prop threaded through the whole socket-setup call chain.
  // A kind absent from this object (fresh account, or one that's never
  // touched this specific toggle) means "on" — see isNotifKindEnabled.
  notifKinds: NonNullable<UserPreferences['notifKinds']>;
  setNotifKinds: (kinds: UserPreferences['notifKinds']) => void;
  isNotifKindEnabled: (kind: keyof NonNullable<UserPreferences['notifKinds']>) => boolean;
}

export const useGameStore = create<GameState>((set, get) => ({
  localPlayerId: '',
  setLocalPlayerId: (id) => set({ localPlayerId: id }),

  localPlayer: {
    id: 'local',
    name: 'You',
    x: 80,
    y: 64,
    direction: 'down',
    color: randomColor(),
    isMoving: false,
  },
  setLocalPlayer: (partial) =>
    set((state) => {
      const localPlayer = { ...state.localPlayer, ...partial };
      if (localPlayer.isMoving !== true) localPlayer.isRunning = false;
      return { localPlayer };
    }),

  playerRecords: {},
  setPlayerRecords: (players) => set({ playerRecords: players }),
  upsertPlayer: (player) =>
    set((state) => {
      const records = { ...state.playerRecords };
      const nextPlayer = { ...records[player.id], ...player };
      if (nextPlayer.isMoving !== true) nextPlayer.isRunning = false;
      records[player.id] = nextPlayer;
      return { playerRecords: records };
    }),
  removePlayer: (id) =>
    set((state) => {
      const records = { ...state.playerRecords };
      delete records[id];
      // Also clean up targets
      const targets = { ...state.playerTargets };
      delete targets[id];
      return { playerRecords: records, playerTargets: targets };
    }),

  playerTargets: {},
  setPlayerTarget: (id, x, y, receivedAt = Date.now()) =>
    set((state) => ({
      playerTargets: {
        ...state.playerTargets,
        [id]: appendMovementSnapshot(state.playerTargets[id] ?? [], { x, y, receivedAt }),
      },
    })),

  interpolatePlayers: () => {
    const state = get();
    const records = { ...state.playerRecords };
    const targets = { ...state.playerTargets };
    const renderTime = Date.now() - REMOTE_MOVEMENT_RENDER_DELAY_MS;
    let recordsChanged = false;
    let targetsChanged = false;

    for (const id of Object.keys(targets)) {
      const player = records[id];
      const snapshots = targets[id];
      if (!player || !snapshots?.length) {
        delete targets[id];
        targetsChanged = true;
        continue;
      }

      const sample = sampleMovementSnapshots(snapshots, renderTime);
      if (!sample) {
        delete targets[id];
        targetsChanged = true;
        continue;
      }

      records[id] = { ...player, x: sample.x, y: sample.y };
      if (sample.done) {
        delete targets[id];
        targetsChanged = true;
      }
      recordsChanged = true;
    }

    if (recordsChanged || targetsChanged) {
      set({
        ...(recordsChanged ? { playerRecords: records } : {}),
        ...(targetsChanged ? { playerTargets: targets } : {}),
      });
    }
  },

  tiles: [],
  setTiles: (tiles) => set({ tiles }),
  impassableAreaRects: [],
  setImpassableAreaRects: (rects) => set({ impassableAreaRects: rects }),
  wallAreaRects: [],
  setWallAreaRects: (rects) => set({ wallAreaRects: rects }),
  doorAreaRects: [],
  setDoorAreaRects: (rects) => set({ doorAreaRects: rects }),
  unlockedDoorAreaIds: new Set(),
  unlockDoorAreaLocally: (areaId) => set((s) => {
    if (s.unlockedDoorAreaIds.has(areaId)) return {};
    const next = new Set(s.unlockedDoorAreaIds); next.add(areaId);
    return { unlockedDoorAreaIds: next };
  }),

  roomId: 'default',
  roomName: 'Default Room',
  theme: 'scifi-office',
  roomTemplate: undefined,
  liveReferenceImage: null,
  avatarScale: 1,

  isConnected: false,
  setConnected: (connected) => set({ isConnected: connected }),

  roomStateReceived: false,
  setRoomStateReceived: (roomStateReceived) => set({ roomStateReceived }),

  roomDeletedNotice: null,
  setRoomDeletedNotice: (notice) => set({ roomDeletedNotice: notice }),
  sitNotice: null,
  setSitNotice: (notice) => set({ sitNotice: notice }),
  seatClaims: {},
  setSeatClaims: (claims) => set({
    seatClaims: Object.fromEntries(claims.map((c) => [c.seatId, { userId: c.userId, name: c.name }])),
  }),

  kickedNotice: null,
  setKickedNotice: (notice) => set({ kickedNotice: notice }),
  forceMutedNotice: null,
  setForceMutedNotice: (notice) => set({ forceMutedNotice: notice }),
  roomRecordingActive: false,
  setRoomRecordingActive: (active) => set({ roomRecordingActive: active }),

  sessionTakenOverNotice: null,
  setSessionTakenOverNotice: (notice) => set({ sessionTakenOverNotice: notice }),

  roomFullNotice: null,
  setRoomFullNotice: (notice) => set({ roomFullNotice: notice }),

  doorOverride: false,
  setDoorOverride: (active) => set({ doorOverride: active }),

  sittingFurnitureId: null,
  setSittingFurnitureId: (id) => set({ sittingFurnitureId: id }),
  sitReturnPos: null,
  setSitReturnPos: (pos) => set({ sitReturnPos: pos }),
  landOnSeat: (furnitureId, returnPos, x, y, direction) =>
    set((state) => ({
      sittingFurnitureId: furnitureId,
      sitReturnPos: returnPos,
      // seatFurnitureId on the avatar too (not just sittingFurnitureId) so the
      // "My Seat" teleport path joins table audio groups exactly like a manual
      // SPACE-sit does.
      localPlayer: { ...state.localPlayer, x, y, direction, isMoving: false, isSitting: true, seatFurnitureId: furnitureId },
    })),

  micMuted: false,
  setMicMuted: (muted) => set({ micMuted: muted }),
  cameraOn: true,
  setCameraOn: (on) => set({ cameraOn: on }),
  localSpeaking: false,
  setLocalSpeaking: (speaking) => set({ localSpeaking: speaking }),
  workMode: 'available',
  setWorkMode: (mode) => set((s) => ({
    workMode: mode,
    // 'available' shows no badge (plain online); everything else does.
    localPlayer: { ...s.localPlayer, workMode: mode === 'available' ? undefined : mode },
  })),
  manualStatus: 'available',
  setManualStatus: (status) => set({ manualStatus: status }),
  awayReason: null,
  setAwayReason: (reason) => set((s) => ({
    awayReason: reason,
    localPlayer: { ...s.localPlayer, awayReason: reason ?? undefined },
  })),
  musicSessionsByZone: {},
  setMusicSessionState: (state) =>
    set((s) => ({ musicSessionsByZone: { ...s.musicSessionsByZone, [state.zoneId]: state } })),
  mapZoom: 1,
  setMapZoom: (zoom) => set((s) => ({ mapZoom: clampMapZoom(zoom, s.localRole) })),
  stepMapZoom: (steps) => set((s) => {
    const currentStep = Math.round(s.mapZoom / ZOOM_STEP);
    return { mapZoom: clampMapZoom((currentStep + steps) * ZOOM_STEP, s.localRole) };
  }),
  speakingPlayers: new Set<string>(),
  // Tile flicker diagnosis (measured — see VideoGrid.tsx's own comment on
  // VideoTile) — this used to build a brand-new Set and call set() on EVERY
  // invocation, even a redundant one (e.g. speaking===true re-affirmed while
  // already true). Every non-guest component in the render tree that reads
  // this state through a *reference* rather than a derived boolean (App.tsx
  // read the whole Set at its top level, straight into every re-render of
  // the entire room UI) saw a "changed" Set on every call regardless of
  // whether membership actually flipped, since a fresh Set is never
  // reference-equal to the previous one even with identical contents. Bailing
  // out here when nothing actually changes removes those redundant
  // notifications at the source, for every subscriber, without each one
  // needing its own workaround.
  setPlayerSpeaking: (id, speaking) =>
    set((state) => {
      const already = state.speakingPlayers.has(id);
      if (already === speaking) return state;
      const next = new Set(state.speakingPlayers);
      if (speaking) next.add(id);
      else next.delete(id);
      return { speakingPlayers: next };
    }),

  zoneChatHistory: {},
  addZoneChatMessage: (zoneId, msg) =>
    set((state) => {
      const existing = state.zoneChatHistory[zoneId] ?? [];
      return {
        zoneChatHistory: {
          ...state.zoneChatHistory,
          [zoneId]: [...existing.slice(-99), msg],
        },
      };
    }),

  channels: [],
  setChannels: (channels) => set({ channels }),
  dmConversations: [],
  setDmConversations: (dmConversations) => set({ dmConversations }),
  activeChatTarget: null,
  setActiveChatTarget: (activeChatTarget) => set({ activeChatTarget }),
  chatPanelOpen: false,
  // Kept in lockstep with activePanel: opening chat makes it the sole panel;
  // closing it clears activePanel only if chat was the one showing.
  setChatPanelOpen: (open) =>
    set((s) => (open
      ? { chatPanelOpen: true, activePanel: 'chat', editorMode: false }
      : { chatPanelOpen: false, activePanel: s.activePanel === 'chat' ? null : s.activePanel })),

  activePanel: null,
  // Toggle semantics: opening the panel that's already open closes it. Opening
  // any other panel replaces it, and turns off both chat and room-editor mode
  // so exactly one main surface is visible at a time.
  openPanel: (id) =>
    set((s) => {
      const next = s.activePanel === id ? null : id;
      return { activePanel: next, chatPanelOpen: next === 'chat', editorMode: false };
    }),
  closePanel: () => set({ activePanel: null, chatPanelOpen: false }),
  unreadByTarget: {},
  bumpUnread: (key) =>
    set((state) => ({ unreadByTarget: { ...state.unreadByTarget, [key]: (state.unreadByTarget[key] ?? 0) + 1 } })),
  clearUnread: (key) =>
    set((state) => {
      if (!state.unreadByTarget[key]) return {};
      const next = { ...state.unreadByTarget };
      delete next[key];
      return { unreadByTarget: next };
    }),
  typingByTarget: {},
  noteTyping: (key, userId) =>
    set((state) => ({
      typingByTarget: {
        ...state.typingByTarget,
        [key]: { ...(state.typingByTarget[key] ?? {}), [userId]: Date.now() + 3500 },
      },
    })),
  readStateByTarget: {},
  setReadState: (key, entries) =>
    set((state) => ({
      readStateByTarget: {
        ...state.readStateByTarget,
        [key]: Object.fromEntries(entries.map((e) => [e.userId, e.lastReadAt])),
      },
    })),
  updateReadEntry: (key, userId, lastReadAt) =>
    set((state) => ({
      readStateByTarget: {
        ...state.readStateByTarget,
        [key]: { ...(state.readStateByTarget[key] ?? {}), [userId]: lastReadAt },
      },
    })),
  messagesByTarget: {},
  setTargetMessages: (key, messages) =>
    set((state) => ({ messagesByTarget: { ...state.messagesByTarget, [key]: messages.slice(-CHAT_TARGET_MAX) } })),
  prependTargetMessages: (key, messages) =>
    set((state) => {
      const existing = state.messagesByTarget[key] ?? [];
      return { messagesByTarget: { ...state.messagesByTarget, [key]: [...messages, ...existing].slice(-CHAT_TARGET_MAX) } };
    }),
  // Idempotent by message id. A message id is the server's, so the same id
  // arriving twice is always the same message — never two — and appending it
  // blindly paints a duplicate that no reload reproduces, which is a
  // miserable bug to chase.
  //
  // The concrete second delivery: a send retried with the same clientId is
  // deduped server-side and echoed back to the sender alone (see
  // channelChatHandler.ts's createMessageDeduped), so the sender can legitimately
  // see the same id twice — once from the original broadcast, once from the echo.
  //
  // Bug 6 — a confirmed message whose clientId matches a still-pending local
  // bubble (this sender's own optimistic echo) REPLACES that entry in place
  // rather than appending a second one: same list position, temp id swapped
  // for the real one, status cleared. Anyone else's incoming message (no
  // matching pending entry) just falls through to the plain append below. A
  // blob: preview URL (see the file-upload optimistic path) is revoked here,
  // now that the real attachmentUrl has taken over — revoking any earlier
  // would blank the image while the bubble still legitimately said "Mengirim…".
  appendTargetMessage: (key, message) =>
    set((state) => {
      const existing = state.messagesByTarget[key] ?? [];
      if (message.clientId) {
        const pendingIdx = existing.findIndex((m) => m.id === message.clientId && m.status != null);
        if (pendingIdx !== -1) {
          const stale = existing[pendingIdx];
          if (stale.attachmentUrl?.startsWith('blob:')) URL.revokeObjectURL(stale.attachmentUrl);
          const updated = [...existing];
          updated[pendingIdx] = message;
          return { messagesByTarget: { ...state.messagesByTarget, [key]: updated } };
        }
      }
      if (existing.some((m) => m.id === message.id)) return {};
      return { messagesByTarget: { ...state.messagesByTarget, [key]: [...existing, message].slice(-CHAT_TARGET_MAX) } };
    }),
  addPendingMessage: (key, message) =>
    set((state) => {
      const existing = state.messagesByTarget[key] ?? [];
      return { messagesByTarget: { ...state.messagesByTarget, [key]: [...existing, message].slice(-CHAT_TARGET_MAX) } };
    }),
  markMessageFailed: (key, clientId) =>
    set((state) => {
      const existing = state.messagesByTarget[key]; if (!existing) return {};
      const idx = existing.findIndex((m) => m.id === clientId && m.status === 'pending');
      if (idx === -1) return {};
      const updated = [...existing];
      updated[idx] = { ...updated[idx], status: 'failed' };
      return { messagesByTarget: { ...state.messagesByTarget, [key]: updated } };
    }),
  markMessagePending: (key, clientId) =>
    set((state) => {
      const existing = state.messagesByTarget[key]; if (!existing) return {};
      const idx = existing.findIndex((m) => m.id === clientId && m.status === 'failed');
      if (idx === -1) return {};
      const updated = [...existing];
      updated[idx] = { ...updated[idx], status: 'pending' };
      return { messagesByTarget: { ...state.messagesByTarget, [key]: updated } };
    }),
  bumpReplyCount: (targetKey, parentId) =>
    set((state) => {
      const existing = state.messagesByTarget[targetKey];
      if (!existing) return {};
      const idx = existing.findIndex((m) => m.id === parentId);
      if (idx === -1) return {};
      const updated = [...existing];
      updated[idx] = { ...updated[idx], replyCount: (updated[idx].replyCount ?? 0) + 1 };
      return { messagesByTarget: { ...state.messagesByTarget, [targetKey]: updated } };
    }),

  editTargetMessage: (key, messageId, text, parentId) =>
    set((state) => {
      const patch: Partial<GameState> = {};
      if (parentId) {
        const replies = state.repliesByParent[parentId];
        if (replies) {
          const idx = replies.findIndex((r) => r.id === messageId);
          if (idx !== -1) {
            const updated = [...replies];
            updated[idx] = { ...updated[idx], text, edited: true };
            patch.repliesByParent = { ...state.repliesByParent, [parentId]: updated };
          }
        }
      } else {
        const list = state.messagesByTarget[key];
        if (list) {
          const idx = list.findIndex((m) => m.id === messageId);
          if (idx !== -1) {
            const updated = [...list];
            updated[idx] = { ...updated[idx], text, edited: true };
            patch.messagesByTarget = { ...state.messagesByTarget, [key]: updated };
          }
        }
      }
      return patch;
    }),
  setMessagePinned: (key, messageId, pinned, parentId) =>
    set((state) => {
      const patch: Partial<GameState> = {};
      if (parentId) {
        const replies = state.repliesByParent[parentId];
        if (replies) {
          const idx = replies.findIndex((r) => r.id === messageId);
          if (idx !== -1) {
            const updated = [...replies];
            updated[idx] = { ...updated[idx], isPinned: pinned || undefined };
            patch.repliesByParent = { ...state.repliesByParent, [parentId]: updated };
          }
        }
      } else {
        const list = state.messagesByTarget[key];
        if (list) {
          const idx = list.findIndex((m) => m.id === messageId);
          if (idx !== -1) {
            const updated = [...list];
            updated[idx] = { ...updated[idx], isPinned: pinned || undefined };
            patch.messagesByTarget = { ...state.messagesByTarget, [key]: updated };
          }
        }
      }
      return patch;
    }),
  removeTargetMessage: (key, messageId, parentId) =>
    set((state) => {
      const patch: Partial<GameState> = {};
      if (parentId) {
        // A reply: drop it from its thread cache and decrement the parent's
        // cached reply count so "N replies" stays accurate.
        const replies = state.repliesByParent[parentId];
        if (replies) patch.repliesByParent = { ...state.repliesByParent, [parentId]: replies.filter((r) => r.id !== messageId) };
        const list = state.messagesByTarget[key];
        if (list) {
          const idx = list.findIndex((m) => m.id === parentId);
          if (idx !== -1) {
            const updated = [...list];
            updated[idx] = { ...updated[idx], replyCount: Math.max(0, (updated[idx].replyCount ?? 0) - 1) };
            patch.messagesByTarget = { ...state.messagesByTarget, [key]: updated };
          }
        }
      } else {
        // A top-level message: remove it, and drop any expanded-thread cache
        // it owned (its replies are cascade-deleted server-side anyway).
        const list = state.messagesByTarget[key];
        if (list) patch.messagesByTarget = { ...state.messagesByTarget, [key]: list.filter((m) => m.id !== messageId) };
        if (state.repliesByParent[messageId]) {
          const nextReplies = { ...state.repliesByParent };
          delete nextReplies[messageId];
          patch.repliesByParent = nextReplies;
        }
      }
      return patch;
    }),
  repliesByParent: {},
  setParentReplies: (parentId, replies) =>
    set((state) => ({ repliesByParent: { ...state.repliesByParent, [parentId]: replies } })),
  appendParentReply: (parentId, reply) =>
    set((state) => {
      const existing = state.repliesByParent[parentId];
      // Only append if this thread has actually been loaded (someone has it
      // expanded) — otherwise this would silently start a cache entry for
      // every reply anywhere, defeating the point of loading on demand.
      if (!existing) return {};
      return { repliesByParent: { ...state.repliesByParent, [parentId]: [...existing, reply] } };
    }),

  speechBubbles: {},
  setSpeechBubble: (playerId, bubble) =>
    set((state) => {
      const bubbles = { ...state.speechBubbles };
      if (bubble) {
        bubbles[playerId] = bubble;
      } else {
        delete bubbles[playerId];
      }
      return { speechBubbles: bubbles };
    }),

  notice: null,
  setNotice: (notice) => set({ notice }),

  followInfo: null,
  setFollowInfo: (info) => set({ followInfo: info }),
  incomingFollowRequest: null,
  setIncomingFollowRequest: (req) => set({ incomingFollowRequest: req }),
  followResult: null,
  setFollowResult: (result) => set({ followResult: result }),
  incomingRemoteHelpRequest: null,
  setIncomingRemoteHelpRequest: (req) => set({ incomingRemoteHelpRequest: req }),
  remoteHelpResult: null,
  setRemoteHelpResult: (result) => set({ remoteHelpResult: result }),
  activeRemoteHelp: null,
  setActiveRemoteHelp: (v) => set({ activeRemoteHelp: v }),
  receivedRemoteHelpCredential: null,
  setReceivedRemoteHelpCredential: (v) => set({ receivedRemoteHelpCredential: v }),
  remoteHelpCredentialAcked: false,
  setRemoteHelpCredentialAcked: (v) => set({ remoteHelpCredentialAcked: v }),
  incomingSummonRequest: null,
  setIncomingSummonRequest: (req) => set({ incomingSummonRequest: req }),
  incomingJoinRequests: [],
  addIncomingJoinRequest: (req) => set((s) => ({
    // Re-posting while pending is idempotent server-side (see roomMembers.ts),
    // so guard the same way here rather than letting a duplicate card stack.
    incomingJoinRequests: s.incomingJoinRequests.some((r) => r.userId === req.userId && r.roomSlug === req.roomSlug)
      ? s.incomingJoinRequests
      : [...s.incomingJoinRequests, req],
  })),
  removeIncomingJoinRequest: (userId, roomSlug) => set((s) => ({
    incomingJoinRequests: s.incomingJoinRequests.filter((r) => !(r.userId === userId && r.roomSlug === roomSlug)),
  })),
  incomingQueueRequests: [],
  addIncomingQueueRequest: (req) => set((s) => (
    s.incomingQueueRequests.some((r) => r.entryId === req.entryId)
      ? s
      : { incomingQueueRequests: [...s.incomingQueueRequests, req] }
  )),
  removeIncomingQueueRequest: (entryId) => set((s) => ({
    incomingQueueRequests: s.incomingQueueRequests.filter((r) => r.entryId !== entryId),
  })),
  activeZoneSessions: new Map<string, ZoneQueueSessionActivePayload>(),
  setActiveZoneSessions: (sessions) => set({
    activeZoneSessions: new Map(sessions.map((s) => [s.userId, s])),
  }),
  upsertActiveZoneSession: (session) => set((s) => {
    const next = new Map(s.activeZoneSessions);
    next.set(session.userId, session);
    return { activeZoneSessions: next };
  }),
  // Cleared by zoneId, not userId — the sweep/skip/admin paths that fire
  // ZONE_QUEUE_SESSION_CLEARED only know which zone freed up, not who was
  // sitting in it (they may not even still be connected).
  clearActiveZoneSessionByZone: (zoneId) => set((s) => {
    let changed = false;
    const next = new Map(s.activeZoneSessions);
    for (const [userId, session] of next) {
      if (session.zoneId === zoneId) {
        next.delete(userId);
        changed = true;
      }
    }
    return changed ? { activeZoneSessions: next } : s;
  }),
  guestWaitState: null,
  setGuestWaitState: (state) => set({ guestWaitState: state }),
  pendingGuests: [],
  addPendingGuest: (req) => set((s) => ({
    pendingGuests: s.pendingGuests.some((r) => r.guestId === req.guestId) ? s.pendingGuests : [...s.pendingGuests, req],
  })),
  removePendingGuest: (guestId) => set((s) => ({
    pendingGuests: s.pendingGuests.filter((r) => r.guestId !== guestId),
  })),
  summonResult: null,
  setSummonResult: (result) => set({ summonResult: result }),
  interactivePasswordResult: null,
  setInteractivePasswordResult: (result) => set({ interactivePasswordResult: result }),
  interactiveChoiceResult: null,
  setInteractiveChoiceResult: (result) => set({ interactiveChoiceResult: result }),
  interactiveDoorPasswordResult: null,
  setInteractiveDoorPasswordResult: (result) => set({ interactiveDoorPasswordResult: result }),
  unlockedDoors: new Set(),
  unlockDoorClientSide: (x, y) =>
    set((state) => {
      const next = new Set(state.unlockedDoors);
      next.add(`${x},${y}`);
      return { unlockedDoors: next };
    }),
  interactiveDoorAreaPasswordResult: null,
  setInteractiveDoorAreaPasswordResult: (result) => set({ interactiveDoorAreaPasswordResult: result }),

  followerUserIds: [],
  setFollowerUserIds: (ids) => set({ followerUserIds: ids }),
  locateRequest: null,
  setLocateRequest: (playerId) => set({ locateRequest: playerId ? { playerId, requestId: Date.now() } : null }),
  mutedUserIds: new Set(getMutedUserIds()),
  muteUser: (userId) => set((state) => {
    const next = new Set(state.mutedUserIds);
    next.add(userId);
    saveMutedUserIds([...next]);
    return { mutedUserIds: next };
  }),
  unmuteUser: (userId) => set((state) => {
    const next = new Set(state.mutedUserIds);
    next.delete(userId);
    saveMutedUserIds([...next]);
    return { mutedUserIds: next };
  }),

  mediaObjects: [],
  setMediaObjects: (objects) => set({ mediaObjects: objects }),
  addMediaObject: (object) => set((state) => ({ mediaObjects: [...state.mediaObjects, object] })),
  removeMediaObject: (id) => set((state) => ({ mediaObjects: state.mediaObjects.filter((m) => m.id !== id) })),
  appendWhiteboardStroke: (mediaId, stroke) =>
    set((state) => ({
      mediaObjects: state.mediaObjects.map((m) =>
        m.id === mediaId ? { ...m, payload: { ...m.payload, strokes: [...(m.payload.strokes ?? []), stroke] } } : m,
      ),
    })),
  clearWhiteboardStrokes: (mediaId) =>
    set((state) => ({
      mediaObjects: state.mediaObjects.map((m) => (m.id === mediaId ? { ...m, payload: { ...m.payload, strokes: [] } } : m)),
    })),

  activeRecording: null,
  setActiveRecording: (info) => set({ activeRecording: info }),

  notes: [],
  setNotes: (notes) => set({ notes }),
  addNote: (note) => set((state) => ({ notes: [...state.notes, note] })),
  updateNote: (note) => set((state) => ({ notes: state.notes.map((n) => (n.id === note.id ? note : n)) })),
  removeNoteById: (id) => set((state) => ({ notes: state.notes.filter((n) => n.id !== id) })),

  roster: {},
  setRosterSnapshot: (entries) => set({
    roster: Object.fromEntries(entries.map((e) => [e.userId, { roomSlug: e.roomSlug, roomName: e.roomName, zoneName: e.zoneName }])),
  }),
  applyRosterUpdate: (update) => set((state) => {
    const next = { ...state.roster };
    if (update.online) next[update.userId] = { roomSlug: update.roomSlug, roomName: update.roomName, zoneName: update.zoneName };
    else delete next[update.userId];
    return { roster: next };
  }),

  emoteEvents: [],
  addEmote: (event) =>
    set((state) => ({
      emoteEvents: [...state.emoteEvents, event],
    })),
  removeExpiredEmotes: (now) =>
    set((state) => ({
      emoteEvents: state.emoteEvents.filter((e) => now - e.timestamp < 3000),
    })),

  jumpingPlayers: new Map(),
  triggerJump: (playerId, timestamp) =>
    set((state) => {
      const next = new Map(state.jumpingPlayers);
      next.set(playerId, timestamp);
      return { jumpingPlayers: next };
    }),

  momentaryReveals: new Map(),
  triggerMomentaryReveal: (furnitureId, durationMs, variant) =>
    set((state) => {
      const next = new Map(state.momentaryReveals);
      next.set(furnitureId, { expireAt: Date.now() + durationMs, variant });
      return { momentaryReveals: next };
    }),

  nudgedPlayers: new Map(),
  nudgerPlayers: new Map(),
  triggerNudge: (targetId, timestamp, fromId) =>
    set((state) => {
      const nextTargets = new Map(state.nudgedPlayers);
      nextTargets.set(targetId, timestamp);
      if (!fromId) return { nudgedPlayers: nextTargets };
      const nextNudgers = new Map(state.nudgerPlayers);
      nextNudgers.set(fromId, timestamp);
      return { nudgedPlayers: nextTargets, nudgerPlayers: nextNudgers };
    }),

  nudgedBy: null,
  setNudgedBy: (name) => set({ nudgedBy: name }),
  slappedBy: null,
  setSlappedBy: (name) => set({ slappedBy: name }),
  adminErrorMessage: null,
  setAdminErrorMessage: (message) => set({ adminErrorMessage: message }),

  roomBroadcast: null,
  setRoomBroadcast: (broadcast) => set({ roomBroadcast: broadcast }),

  soundboardSounds: [],
  setSoundboardSounds: (sounds) => set({ soundboardSounds: sounds }),
  addSoundboardSound: (sound) =>
    set((state) => (state.soundboardSounds.some((s) => s.id === sound.id)
      ? state
      : { soundboardSounds: [...state.soundboardSounds, sound] })),
  removeSoundboardSound: (id) =>
    set((state) => ({ soundboardSounds: state.soundboardSounds.filter((s) => s.id !== id) })),

  playingSoundboard: new Map(),
  triggerSoundboardPlaying: (playerId, expireAt) =>
    set((state) => {
      const next = new Map(state.playingSoundboard);
      next.set(playerId, expireAt);
      return { playingSoundboard: next };
    }),

  activityEvents: [],
  addActivity: (message) =>
    set((state) => ({
      activityEvents: [
        { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, message, timestamp: Date.now() },
        ...state.activityEvents,
      ].slice(0, ACTIVITY_FEED_MAX),
    })),
  clearActivity: () => set({ activityEvents: [] }),

  furniture: [],
  setFurniture: (f) => set({ furniture: f }),
  setFurnitureAssignment: (id, userId, name) =>
    set((state) => ({
      furniture: state.furniture.map((f) =>
        f.id === id ? { ...f, assignedToUserId: userId, assignedToName: name } : f,
      ),
    })),
  addFurniture: (item) =>
    set((state) => {
      // Banners are pure decoration (signage), not physical objects — never
      // block movement, so don't touch tile types (they may sit over a wall
      // tile, as "a poster mounted on the wall" would).
      if (item.kind === 'banner') {
        return { furniture: [...state.furniture, item] };
      }
      const tiles = state.tiles.map((row) => row.map((t) => ({ ...t })));
      for (let dx = 0; dx < item.tilesW; dx++) {
        const tx = item.x + dx;
        if (tiles[item.y]?.[tx]) tiles[item.y][tx].type = 'desk';
      }
      return { furniture: [...state.furniture, item], tiles };
    }),
  removeFurnitureAt: (x, y) =>
    set((state) => {
      const target = state.furniture.find((f) => f.y === y && x >= f.x && x < f.x + f.tilesW);
      if (!target) return state;
      if (target.kind === 'banner') {
        return { furniture: state.furniture.filter((f) => f.id !== target.id) };
      }
      const tiles = state.tiles.map((row) => row.map((t) => ({ ...t })));
      for (let dx = 0; dx < target.tilesW; dx++) {
        const tx = target.x + dx;
        if (tiles[target.y]?.[tx]) tiles[target.y][tx].type = 'floor';
      }
      return { furniture: state.furniture.filter((f) => f.id !== target.id), tiles };
    }),
  setFloorPaletteId: (x, y, paletteId) =>
    set((state) => {
      if (!state.tiles[y]?.[x]) return state;
      const tiles = state.tiles.map((row) => row.map((t) => ({ ...t })));
      tiles[y][x].floorPaletteId = paletteId;
      return { tiles };
    }),
  zones: [],
  setZones: (z) => set({ zones: z }),
  addZone: (zone) => set((state) => ({ zones: [...state.zones, zone] })),
  removeZone: (id) => set((state) => ({ zones: state.zones.filter((z) => z.id !== id) })),
  zoneDrawMode: false,
  toggleZoneDrawMode: () => set((s) => ({ zoneDrawMode: !s.zoneDrawMode })),
  pendingZoneRect: null,
  setPendingZoneRect: (rect) => set({ pendingZoneRect: rect }),

  bannerPlaceMode: false,
  toggleBannerPlaceMode: () => set((s) => ({ bannerPlaceMode: !s.bannerPlaceMode })),
  pendingBannerPos: null,
  setPendingBannerPos: (pos) => set({ pendingBannerPos: pos }),

  isAdmin: false,
  masterAdminUserId: '',
  adminPlayerIds: new Set<string>(),
  staffPlayerIds: new Set<string>(),
  ceoPlayerIds: new Set<string>(),
  localIsCeo: false,
  localRole: 'member',
  applyAdminChanged: (data) =>
    set((state) => {
      const adminSet = new Set(data.adminUserIds);
      const staffSet = new Set(data.staffUserIds ?? []);
      const ceoSet = new Set(data.ceoUserIds ?? []);
      const uid = state.localUserId;
      const isAdminNow = adminSet.has(uid);
      const localRole: Role = uid === data.masterAdminUserId ? 'owner' : isAdminNow ? 'admin' : staffSet.has(uid) ? 'staff' : 'member';

      // Update isAdmin on all player records
      const records = { ...state.playerRecords };
      for (const [pid, p] of Object.entries(records)) {
        if (adminSet.has(p.userId ?? '')) {
          records[pid] = { ...p, isAdmin: true };
        } else if (p.isAdmin) {
          records[pid] = { ...p, isAdmin: false };
        }
      }

      return {
        masterAdminUserId: data.masterAdminUserId,
        adminPlayerIds: adminSet,
        staffPlayerIds: staffSet,
        ceoPlayerIds: ceoSet,
        localIsCeo: ceoSet.has(uid),
        isAdmin: isAdminNow,
        localRole,
        playerRecords: records,
      };
    }),
  localUserId: '',
  setLocalUserId: (id) => set({ localUserId: id }),
  editorMode: false,
  // Entering room-editor mode is exclusive with the main panels (Bug 12):
  // turning it on closes whatever panel was open.
  toggleEditorMode: () =>
    set((s) => {
      const editorMode = !s.editorMode;
      return editorMode ? { editorMode, activePanel: null, chatPanelOpen: false } : { editorMode };
    }),
  selectedTileType: 'wall',
  setSelectedTileType: (t: TileType) => set({ selectedTileType: t, selectedPaletteId: undefined }),
  selectedPaletteId: undefined,
  setSelectedPaletteId: (id) => set({ selectedPaletteId: id }),
  activeTableId: undefined,
  setActiveTableId: (id) => set({ activeTableId: id }),
  tileHistory: [],
  tileHistoryIndex: -1,
  pushTileHistory: (tiles) =>
    set((s) => {
      const history = s.tileHistory.slice(0, s.tileHistoryIndex + 1);
      history.push(tiles);
      if (history.length > 20) history.shift();
      return { tileHistory: history, tileHistoryIndex: history.length - 1 };
    }),
  undo: () =>
    set((s) => {
      if (s.tileHistoryIndex <= 0) return s;
      const idx = s.tileHistoryIndex - 1;
      const snap = s.tileHistory[idx];
      const tiles: RoomTile[][] = snap.map((row, y) =>
        row.map((type, x) => ({ x, y, type }))
      );
      return { tileHistoryIndex: idx, tiles };
    }),
  redo: () =>
    set((s) => {
      if (s.tileHistoryIndex >= s.tileHistory.length - 1) return s;
      const idx = s.tileHistoryIndex + 1;
      const snap = s.tileHistory[idx];
      const tiles: RoomTile[][] = snap.map((row, y) =>
        row.map((type, x) => ({ x, y, type }))
      );
      return { tileHistoryIndex: idx, tiles };
    }),

  setRoomState: (roomState) => {
    const state = get();
    const records: Record<string, Avatar> = {};
    let localIsAdmin = false;
    const adminIds = new Set(roomState.adminUserIds ?? []);

    for (const player of roomState.players) {
      if (player.id === state.localPlayerId) {
        localIsAdmin = player.isAdmin ?? false;
        continue;
      }
      records[player.id] = player;
    }

    const staffIds = new Set(roomState.staffUserIds ?? []);
    const ceoIds = new Set(roomState.ceoUserIds ?? []);

    set((prev) => ({
      roomId: roomState.id,
      roomName: roomState.name,
      theme: roomState.theme ?? prev.theme,
      roomTemplate: roomState.template ?? prev.roomTemplate,
      tiles: roomState.tiles.length > 0 ? roomState.tiles : prev.tiles,
      furniture: roomState.furniture ?? prev.furniture,
      zones: roomState.zones ?? prev.zones,
      impassableAreaRects: roomState.impassableAreaRects ?? prev.impassableAreaRects,
      wallAreaRects: roomState.wallAreaRects ?? prev.wallAreaRects,
      doorAreaRects: roomState.doorAreaRects ?? prev.doorAreaRects,
      // A fresh join starts with every door area locked again, same as the
      // per-tile Set in GameCanvas.tsx — the server's own per-socket unlock
      // state is ALSO fresh on a new connection (doorLock.ts is keyed by
      // socket id), so this stays in sync rather than optimistically
      // carrying over a previous session's unlocks.
      unlockedDoorAreaIds: new Set(),
      playerRecords: records,
      isAdmin: localIsAdmin,
      adminPlayerIds: adminIds,
      staffPlayerIds: staffIds,
      ceoPlayerIds: ceoIds,
      localIsCeo: roomState.isCeo ?? ceoIds.has(prev.localUserId),
      // Seed from ROOM_STATE for late-joiners/refreshes; live updates after
      // this come from ZONE_QUEUE_SESSION_ACTIVE/CLEARED via useSocket.ts.
      activeZoneSessions: roomState.activeZoneSessions
        ? new Map(roomState.activeZoneSessions.map((s) => [s.userId, s]))
        : prev.activeZoneSessions,
      // roomState.role is the server's own authoritative resolution (see
      // its doc comment) — prefer it, but fall back to re-deriving from
      // the raw sets for the (should-never-happen) case it's missing.
      localRole: roomState.role ?? (localIsAdmin ? 'admin' : prev.localRole),
      masterAdminUserId: roomState.masterAdminUserId ?? prev.masterAdminUserId,
      notice: roomState.notice !== undefined ? roomState.notice : prev.notice,
      doorOverride: roomState.doorOverride ?? false,
      liveReferenceImage: roomState.referenceImage ?? null,
      avatarScale: roomState.avatarScale ?? 1,
      notes: roomState.notes ?? prev.notes,
    }));

    console.log('[store] setRoomState — adminPlayerIds:', Array.from(adminIds), 'masterAdminUserId:', roomState.masterAdminUserId, 'localIsAdmin:', localIsAdmin);
  },

  playerCount: () => Object.keys(get().playerRecords).length,

  tooltipsEnabled: true,
  setTooltipsEnabled: (enabled) => set({ tooltipsEnabled: enabled }),

  notifKinds: {},
  setNotifKinds: (kinds) => set({ notifKinds: kinds ?? {} }),
  isNotifKindEnabled: (kind) => get().notifKinds[kind] !== false,
}));
