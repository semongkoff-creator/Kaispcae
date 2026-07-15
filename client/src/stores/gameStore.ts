import { create } from 'zustand';
import { Avatar, RoomTile, RoomState, ChatMessage, EmoteEvent, SpeechBubble, Furniture, Zone, TileType, RoomTheme, RoomTemplateId, Notice, FollowInfo, Role, FollowRequestPayload, FollowResultPayload, SummonRequestPayload, SummonResultPayload, MapMediaObject, WhiteboardStroke, Channel, ChannelMessage, DirectConversationSummary } from '@virtualmeet/shared';

// §7 — only ever populated for clients who are allowed to see it at all
// (the target being recorded, or an admin+) — see recordingHandler.ts's
// per-socket RECORDING_STARTED emit, which simply never reaches anyone else.
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

  // Set when an admin removes us from the room via Kick (see
  // shared/permissions.ts's 'room:kick') — mirrors roomDeletedNotice's
  // "show a notice, then navigate back to the Lobby" pattern in App.tsx.
  kickedNotice: string | null;
  setKickedNotice: (notice: string | null) => void;

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
  messagesByTarget: Record<string, ChannelMessage[]>;
  setTargetMessages: (key: string, messages: ChannelMessage[]) => void;
  prependTargetMessages: (key: string, messages: ChannelMessage[]) => void;
  appendTargetMessage: (key: string, message: ChannelMessage) => void;
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
  summonResult: SummonResultPayload | null;
  setSummonResult: (result: SummonResultPayload | null) => void;

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

  // §6 (RTC upgrade) — account userIds (not socket ids) currently
  // spotlighted in this room; see rtcHandler.ts's doc comment on why userId.
  spotlightedUserIds: string[];
  setSpotlightedUserIds: (ids: string[]) => void;

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

  isConnected: false,
  setConnected: (connected) => set({ isConnected: connected }),

  roomStateReceived: false,
  setRoomStateReceived: (roomStateReceived) => set({ roomStateReceived }),

  roomDeletedNotice: null,
  setRoomDeletedNotice: (notice) => set({ roomDeletedNotice: notice }),

  kickedNotice: null,
  setKickedNotice: (notice) => set({ kickedNotice: notice }),

  sittingFurnitureId: null,
  setSittingFurnitureId: (id) => set({ sittingFurnitureId: id }),
  sitReturnPos: null,
  setSitReturnPos: (pos) => set({ sitReturnPos: pos }),
  landOnSeat: (furnitureId, returnPos, x, y, direction) =>
    set((state) => ({
      sittingFurnitureId: furnitureId,
      sitReturnPos: returnPos,
      localPlayer: { ...state.localPlayer, x, y, direction, isMoving: false, isSitting: true },
    })),

  micMuted: false,
  setMicMuted: (muted) => set({ micMuted: muted }),
  cameraOn: true,
  setCameraOn: (on) => set({ cameraOn: on }),
  localSpeaking: false,
  setLocalSpeaking: (speaking) => set({ localSpeaking: speaking }),
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
  setChatPanelOpen: (chatPanelOpen) => set({ chatPanelOpen }),
  messagesByTarget: {},
  setTargetMessages: (key, messages) =>
    set((state) => ({ messagesByTarget: { ...state.messagesByTarget, [key]: messages.slice(-CHAT_TARGET_MAX) } })),
  prependTargetMessages: (key, messages) =>
    set((state) => {
      const existing = state.messagesByTarget[key] ?? [];
      return { messagesByTarget: { ...state.messagesByTarget, [key]: [...messages, ...existing].slice(-CHAT_TARGET_MAX) } };
    }),
  appendTargetMessage: (key, message) =>
    set((state) => {
      const existing = state.messagesByTarget[key] ?? [];
      return { messagesByTarget: { ...state.messagesByTarget, [key]: [...existing, message].slice(-CHAT_TARGET_MAX) } };
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
  summonResult: null,
  setSummonResult: (result) => set({ summonResult: result }),

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

  spotlightedUserIds: [],
  setSpotlightedUserIds: (ids) => set({ spotlightedUserIds: ids }),

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
  toggleEditorMode: () => set((s) => ({ editorMode: !s.editorMode })),
  selectedTileType: 'wall',
  setSelectedTileType: (t: TileType) => set({ selectedTileType: t, selectedPaletteId: undefined }),
  selectedPaletteId: undefined,
  setSelectedPaletteId: (id) => set({ selectedPaletteId: id }),
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
    }));

    console.log('[store] setRoomState — adminPlayerIds:', Array.from(adminIds), 'masterAdminUserId:', roomState.masterAdminUserId, 'localIsAdmin:', localIsAdmin);
  },

  playerCount: () => Object.keys(get().playerRecords).length,
}));
