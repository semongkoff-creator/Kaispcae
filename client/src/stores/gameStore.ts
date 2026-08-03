import { create } from 'zustand';
import { Avatar, RoomTile, RoomState, ChatMessage, EmoteEvent, SpeechBubble, Furniture, Zone, TileType, RoomTheme, RoomTemplateId, Notice, FollowInfo, Role, FollowRequestPayload, FollowResultPayload, SummonRequestPayload, SummonResultPayload, KnockRequestPayload, MapMediaObject, WhiteboardStroke, Channel, ChannelMessage, DirectConversationSummary, WorkMode, InteractivePasswordResultPayload, InteractiveDoorPasswordResultPayload, InteractiveChoiceResultPayload, SoundboardSoundData, MusicSessionState, ReferenceImageData } from '@virtualmeet/shared';

// §7 — only ever populated for clients who are allowed to see it at all
// (the target being recorded, or an admin+) — see recordingHandler.ts's
// per-socket RECORDING_STARTED emit, which simply never reaches anyone else.
export const MIN_MAP_ZOOM = 0.6;
export const MAX_MAP_ZOOM = 2;
const clampMapZoom = (z: number) => Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, z));

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
  | 'dailyTask'
  | 'leave'
  | 'teleport'
  | 'addMedia'
  | 'adminPanel'
  | 'meeting'
  | 'calendar'
  | 'adminConsole'
  | 'attendance'
  | 'larkAttendance'
  | 'messenger'
  | 'joinQueue'
  | 'soundboard';

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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

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

  // Remote player position targets (for interpolation)
  playerTargets: Record<string, { x: number; y: number }>;
  setPlayerTarget: (id: string, x: number, y: number) => void;

  // Interpolate all remote players one step toward their targets
  interpolatePlayers: () => void;

  // Tiles
  tiles: RoomTile[][];
  setTiles: (tiles: RoomTile[][]) => void;

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

  // Set when an admin removes us from the room via Kick (see
  // shared/permissions.ts's 'room:kick') — mirrors roomDeletedNotice's
  // "show a notice, then navigate back to the Lobby" pattern in App.tsx.
  kickedNotice: string | null;
  setKickedNotice: (notice: string | null) => void;

  // Zoom-style "Lock Meeting" (see shared SocketEvents.ROOM_LOCK_SET).
  // roomLocked drives the 🔒 indicator + the owner's Lock/Unlock control;
  // roomLockedNotice bounces a denied joiner back to the Lobby, same
  // mechanism as roomDeletedNotice/kickedNotice above.
  roomLocked: boolean;
  setRoomLocked: (locked: boolean) => void;
  roomLockedNotice: string | null;
  setRoomLockedNotice: (notice: string | null) => void;

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
  // A11 — the user's last MANUAL choice (Available/Lunch/Away). Distinct from
  // the effective `workMode`: while inside a meeting/focus zone the effective
  // status is auto ('in_meeting'/'focus'), but this manual value is remembered
  // and re-applies the moment they leave the zone.
  manualStatus: 'available' | 'lunch' | 'away';
  setManualStatus: (status: 'available' | 'lunch' | 'away') => void;
  // Fitur 3B — reason picked from the Away popup, alongside manualStatus
  // 'away'. null when away has no specific reason (prompt timed out) or when
  // manualStatus isn't 'away' at all.
  awayReason: string | null;
  setAwayReason: (reason: string | null) => void;
  // A5 — active recorded meetings, keyed by zoneId. Set/cleared by the
  // MEETING_STARTED/ENDED socket broadcasts so everyone in the room sees the
  // "join via Lark" banner.
  activeMeetings: Record<string, { momRecordId: string; url: string; startedBy: string }>;
  setMeetingStarted: (zoneId: string, info: { momRecordId: string; url: string; startedBy: string }) => void;
  setMeetingEnded: (zoneId: string) => void;
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
  zoomMapBy: (factor: number) => void;
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

  // Follow/Summon consent requests — see PendingRequestToast.tsx. Both
  // "incoming" (someone else wants to do this to ME, needs Accept/Decline)
  // and "result" (I asked, here's what happened) are transient, App.tsx
  // auto-clears them, same pattern as the old summonWarning/summonNotice
  // toasts this replaces.
  incomingFollowRequest: FollowRequestPayload | null;
  setIncomingFollowRequest: (req: FollowRequestPayload | null) => void;
  followResult: FollowResultPayload | null;
  setFollowResult: (result: FollowResultPayload | null) => void;
  incomingSummonRequest: SummonRequestPayload | null;
  setIncomingSummonRequest: (req: SummonRequestPayload | null) => void;
  // A locked-room "knock" shown to admins (see shared KnockRequestPayload).
  incomingKnock: KnockRequestPayload | null;
  setIncomingKnock: (req: KnockRequestPayload | null) => void;
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

  // Soundboard — this room's custom uploaded sounds (defaults live purely
  // client-side as SOUNDBOARD_DEFAULT_SOUNDS, no server round trip needed).
  // Synced from SOUNDBOARD_LIST on join, kept live via SOUNDBOARD_SOUND_ADDED.
  soundboardSounds: SoundboardSoundData[];
  setSoundboardSounds: (sounds: SoundboardSoundData[]) => void;
  addSoundboardSound: (sound: SoundboardSoundData) => void;
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
  applyAdminChanged: (data: { adminUserIds: string[]; masterAdminUserId: string; staffUserIds?: string[] }) => void;
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
    set((state) => ({
      localPlayer: { ...state.localPlayer, ...partial },
    })),

  playerRecords: {},
  setPlayerRecords: (players) => set({ playerRecords: players }),
  upsertPlayer: (player) =>
    set((state) => {
      const records = { ...state.playerRecords };
      records[player.id] = { ...records[player.id], ...player };
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
  setPlayerTarget: (id, x, y) =>
    set((state) => ({
      playerTargets: { ...state.playerTargets, [id]: { x, y } },
    })),

  interpolatePlayers: () => {
    const state = get();
    const records = { ...state.playerRecords };
    const targets = state.playerTargets;
    let changed = false;

    for (const id of Object.keys(targets)) {
      const player = records[id];
      const target = targets[id];
      if (!player || !target) continue;

      const newX = lerp(player.x, target.x, 0.2);
      const newY = lerp(player.y, target.y, 0.2);

      // Snap if very close
      if (Math.abs(newX - target.x) < 0.5 && Math.abs(newY - target.y) < 0.5) {
        records[id] = { ...player, x: target.x, y: target.y };
      } else {
        records[id] = { ...player, x: newX, y: newY };
      }
      changed = true;
    }

    if (changed) {
      set({ playerRecords: records });
    }
  },

  tiles: [],
  setTiles: (tiles) => set({ tiles }),

  roomId: 'default',
  roomName: 'Default Room',
  theme: 'scifi-office',
  roomTemplate: undefined,
  liveReferenceImage: null,

  isConnected: false,
  setConnected: (connected) => set({ isConnected: connected }),

  roomStateReceived: false,
  setRoomStateReceived: (roomStateReceived) => set({ roomStateReceived }),

  roomDeletedNotice: null,
  setRoomDeletedNotice: (notice) => set({ roomDeletedNotice: notice }),
  sitNotice: null,
  setSitNotice: (notice) => set({ sitNotice: notice }),

  kickedNotice: null,
  setKickedNotice: (notice) => set({ kickedNotice: notice }),

  roomLocked: false,
  setRoomLocked: (locked) => set({ roomLocked: locked }),
  roomLockedNotice: null,
  setRoomLockedNotice: (notice) => set({ roomLockedNotice: notice }),

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
  activeMeetings: {},
  setMeetingStarted: (zoneId, info) => set((s) => ({ activeMeetings: { ...s.activeMeetings, [zoneId]: info } })),
  setMeetingEnded: (zoneId) => set((s) => {
    const next = { ...s.activeMeetings };
    delete next[zoneId];
    return { activeMeetings: next };
  }),
  musicSessionsByZone: {},
  setMusicSessionState: (state) =>
    set((s) => ({ musicSessionsByZone: { ...s.musicSessionsByZone, [state.zoneId]: state } })),
  mapZoom: 1,
  setMapZoom: (zoom) => set({ mapZoom: clampMapZoom(zoom) }),
  zoomMapBy: (factor) => set((s) => ({ mapZoom: clampMapZoom(s.mapZoom * factor) })),
  speakingPlayers: new Set<string>(),
  setPlayerSpeaking: (id, speaking) =>
    set((state) => {
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
  incomingSummonRequest: null,
  setIncomingSummonRequest: (req) => set({ incomingSummonRequest: req }),
  incomingKnock: null,
  setIncomingKnock: (req) => set({ incomingKnock: req }),
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

  followerUserIds: [],
  setFollowerUserIds: (ids) => set({ followerUserIds: ids }),

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

  soundboardSounds: [],
  setSoundboardSounds: (sounds) => set({ soundboardSounds: sounds }),
  addSoundboardSound: (sound) =>
    set((state) => (state.soundboardSounds.some((s) => s.id === sound.id)
      ? state
      : { soundboardSounds: [...state.soundboardSounds, sound] })),

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
  localRole: 'member',
  applyAdminChanged: (data) =>
    set((state) => {
      const adminSet = new Set(data.adminUserIds);
      const staffSet = new Set(data.staffUserIds ?? []);
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

    set((prev) => ({
      roomId: roomState.id,
      roomName: roomState.name,
      theme: roomState.theme ?? prev.theme,
      roomTemplate: roomState.template ?? prev.roomTemplate,
      tiles: roomState.tiles.length > 0 ? roomState.tiles : prev.tiles,
      furniture: roomState.furniture ?? prev.furniture,
      zones: roomState.zones ?? prev.zones,
      playerRecords: records,
      isAdmin: localIsAdmin,
      adminPlayerIds: adminIds,
      staffPlayerIds: staffIds,
      // roomState.role is the server's own authoritative resolution (see
      // its doc comment) — prefer it, but fall back to re-deriving from
      // the raw sets for the (should-never-happen) case it's missing.
      localRole: roomState.role ?? (localIsAdmin ? 'admin' : prev.localRole),
      masterAdminUserId: roomState.masterAdminUserId ?? prev.masterAdminUserId,
      notice: roomState.notice !== undefined ? roomState.notice : prev.notice,
      roomLocked: roomState.locked ?? false,
      liveReferenceImage: roomState.referenceImage ?? null,
    }));

    console.log('[store] setRoomState — adminPlayerIds:', Array.from(adminIds), 'masterAdminUserId:', roomState.masterAdminUserId, 'localIsAdmin:', localIsAdmin);
  },

  playerCount: () => Object.keys(get().playerRecords).length,
}));
