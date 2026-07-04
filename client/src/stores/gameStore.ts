import { create } from 'zustand';
import { Avatar, RoomTile, RoomState, ChatMessage, EmoteEvent, SpeechBubble, Furniture, Zone, TileType } from '@virtualmeet/shared';

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

  // Connection
  isConnected: boolean;
  setConnected: (connected: boolean) => void;

  // Media / WebRTC
  micMuted: boolean;
  setMicMuted: (muted: boolean) => void;
  cameraOn: boolean;
  setCameraOn: (on: boolean) => void;
  localSpeaking: boolean;
  setLocalSpeaking: (speaking: boolean) => void;
  speakingPlayers: Set<string>;
  setPlayerSpeaking: (id: string, speaking: boolean) => void;

  // Chat
  chatMessages: ChatMessage[];
  addChatMessage: (msg: ChatMessage) => void;
  // Per-zone "Private" chat history, kept separate from the general room
  // chat above — see ChatPanel.tsx's All/Private tabs.
  zoneChatHistory: Record<string, ChatMessage[]>;
  addZoneChatMessage: (zoneId: string, msg: ChatMessage) => void;
  speechBubbles: Record<string, SpeechBubble>;
  setSpeechBubble: (playerId: string, bubble: SpeechBubble | null) => void;

  // Emotes
  emoteEvents: EmoteEvent[];
  addEmote: (event: EmoteEvent) => void;
  removeExpiredEmotes: (now: number) => void;

  // Room editor
  furniture: Furniture[];
  setFurniture: (f: Furniture[]) => void;
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

  isAdmin: boolean;
  masterAdminUserId: string;
  adminPlayerIds: Set<string>;
  applyAdminChanged: (data: { adminUserIds: string[]; masterAdminUserId: string }) => void;
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

  isConnected: false,
  setConnected: (connected) => set({ isConnected: connected }),

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

  chatMessages: [],
  addChatMessage: (msg) =>
    set((state) => ({
      chatMessages: [...state.chatMessages.slice(-99), msg],
    })),

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

  emoteEvents: [],
  addEmote: (event) =>
    set((state) => ({
      emoteEvents: [...state.emoteEvents, event],
    })),
  removeExpiredEmotes: (now) =>
    set((state) => ({
      emoteEvents: state.emoteEvents.filter((e) => now - e.timestamp < 3000),
    })),

  furniture: [],
  setFurniture: (f) => set({ furniture: f }),
  addFurniture: (item) =>
    set((state) => {
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

  isAdmin: false,
  masterAdminUserId: '',
  adminPlayerIds: new Set<string>(),
  applyAdminChanged: (data) =>
    set((state) => {
      const adminSet = new Set(data.adminUserIds);
      const uid = state.localUserId;
      const isAdminNow = adminSet.has(uid);

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
        isAdmin: isAdminNow,
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

    set((prev) => ({
      roomId: roomState.id,
      roomName: roomState.name,
      tiles: roomState.tiles.length > 0 ? roomState.tiles : prev.tiles,
      furniture: roomState.furniture ?? prev.furniture,
      zones: roomState.zones ?? prev.zones,
      playerRecords: records,
      isAdmin: localIsAdmin,
      adminPlayerIds: adminIds,
      masterAdminUserId: roomState.masterAdminUserId ?? prev.masterAdminUserId,
    }));

    console.log('[store] setRoomState — adminPlayerIds:', Array.from(adminIds), 'masterAdminUserId:', roomState.masterAdminUserId, 'localIsAdmin:', localIsAdmin);
  },

  playerCount: () => Object.keys(get().playerRecords).length,
}));
