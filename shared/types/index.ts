// Direction the avatar is facing or moving
export type Direction = 'up' | 'down' | 'left' | 'right';

// Avatar customization types
export type BodyShape = 'circle' | 'rounded-square' | 'hexagon';
export type Accessory = 'none' | 'cap' | 'crown' | 'headphones' | 'halo' | 'bow';
export type Expression = 'neutral' | 'happy' | 'cool' | 'thinking' | 'sleepy';

// How the avatar is rendered on canvas. 'shape' is the original hand-drawn
// canvas primitive avatar; 'layered' composites pixel-art PNG sprites
// (body/eyes/outfit/hair/accessory) from the Character Generator asset pack;
// 'premade' uses a ready-made character from the free 16x16 pack.
export type SpriteMode = 'shape' | 'layered' | 'premade';

export interface AvatarConfig {
  // Legacy shape-drawn avatar (kept so old saved configs keep working)
  bodyShape: BodyShape;
  color: string;
  accessory: Accessory;
  expression: Expression;
  name: string;
  statusTag: string;

  // Pixel-art sprite system. All optional so old configs without them fall
  // back to the shape-drawn avatar until migrated (see useAvatarConfig).
  spriteMode?: SpriteMode;
  // Filenames within client/public/assets/characters/generator/<Category>/
  bodyId?: string;
  eyesId?: string;
  outfitId?: string;
  hairId?: string;
  spriteAccessoryId?: string;
  // Filename prefix within client/public/assets/characters/premade/free-pack-16x16/
  // (used when spriteMode === 'premade')
  premadeId?: string;
}

// Represents a player avatar in the virtual space
export interface Avatar {
  id: string;
  name: string;
  x: number;
  y: number;
  direction: Direction;
  color: string;
  isMoving: boolean;
  avatarConfig?: AvatarConfig;
  isAdmin?: boolean;
  isMasterAdmin?: boolean;
  userId?: string;
  // Free-text custom status shown as a small badge above the name tag
  // (e.g. "WFH", "In a meeting", "🎧 Focus") — independent of admin/online state.
  status?: string;
  // True while sitting in a chair (see Furniture.isInteractable) — movement
  // input is ignored client-side while true, and x/y are snapped to the
  // chair's tile, so remote clients just render this player idle at that
  // exact position rather than needing a separate "sitting" sprite.
  isSitting?: boolean;
}

// A single tile on the room grid. `type` stays authoritative for collision
// (BLOCKED_TILES) so old saved rooms keep working unchanged. `floorPaletteId`
// is optional and only overrides which floor texture is drawn — it never
// affects walkability. `portalTarget` (only meaningful when type === 'portal')
// is the slug of the room to travel to when a player steps on this tile.
export interface RoomTile {
  x: number;
  y: number;
  type: TileType;
  floorPaletteId?: string;
  portalTarget?: string;
}

// Valid tile types and their visual/semantic meaning. 'portal' and 'spawn'
// are always walkable (never added to BLOCKED_TILES).
export type TileType = 'floor' | 'wall' | 'door' | 'desk' | 'chair' | 'portal' | 'spawn';

// Full room state transmitted over the network
export interface RoomState {
  id: string;
  name: string;
  tiles: RoomTile[][];
  players: Avatar[];
  adminUserIds?: string[];
  masterAdminUserId?: string;
  furniture?: Furniture[];
  zones?: Zone[];
}

// All socket event names used between client and server
export enum SocketEvents {
  CONNECT = 'connect',
  DISCONNECT = 'disconnect',

  JOIN_ROOM = 'room:join',
  ROOM_STATE = 'room:state',
  LEAVE_ROOM = 'room:leave',

  PLAYER_MOVE = 'player:move',
  PLAYER_MOVED = 'player:moved',
  PLAYER_STOP = 'player:stop',
  PLAYER_STOPPED = 'player:stopped',

  PLAYER_JOINED = 'player:joined',
  PLAYER_LEFT = 'player:left',

  CHAT_MESSAGE = 'chat:message',
  CHAT_BROADCAST = 'chat:broadcast',

  AVATAR_UPDATE = 'avatar:update',
  AVATAR_UPDATED = 'avatar:updated',

  PLAYER_STATUS_UPDATE = 'player:status_update',
  PLAYER_STATUS_UPDATED = 'player:status_updated',

  PLAYER_SIT = 'player:sit',
  PLAYER_SAT = 'player:sat',

  // Permanent seat assignment — see Furniture.assignedToUserId/assignedToName
  FURNITURE_ASSIGN = 'furniture:assign',
  FURNITURE_ASSIGNED = 'furniture:assigned',
  FURNITURE_UNASSIGN = 'furniture:unassign',
  FURNITURE_UNASSIGNED = 'furniture:unassigned',

  RTC_OFFER = 'rtc:offer',
  RTC_ANSWER = 'rtc:answer',
  RTC_ICE_CANDIDATE = 'rtc:ice-candidate',

  CHAT_BUBBLE = 'chat:bubble',
  EMOTE_PLAY = 'emote:play',

  ZONE_ENTER = 'zone:enter',
  ZONE_EXIT = 'zone:exit',

  ROOM_UPDATE = 'room:update',
  ROOM_UPDATED = 'room:updated',

  ADMIN_GRANT = 'admin:grant',
  ADMIN_REVOKE = 'admin:revoke',
  ADMIN_CHANGED = 'admin:changed',

  ROOM_DELETE = 'room:delete',
  ROOM_DELETED = 'room:deleted',
}

// Grid and rendering constants — shared so server can also validate bounds
export const TILE_SIZE = 32;
// Sized for ~20 concurrent occupants with their own desk (see
// defaultRoomLayout.ts's two 10-desk zones) plus a meeting room and lounge,
// not just the original ~6-desk office.
export const MAP_WIDTH = 42;
export const MAP_HEIGHT = 28;
export const PLAYER_SPEED = 150; // pixels per second

// Proximity / WebRTC constants
export const PROXIMITY_THRESHOLD = 3; // tiles — within 3 tiles: video + audio
export const PROXIMITY_THRESHOLD_PX = 96; // 3 tiles × 32px
export const DISCONNECT_DEBOUNCE_MS = 500;

export interface ProximityPlayer {
  id: string;
  distanceTiles: number;
  inProximity: boolean;
  // true when connected because both players share a private Zone (see
  // useProximity.ts) rather than because they're within PROXIMITY_THRESHOLD
  // tiles of each other — WebRTC uses this to skip distance-based audio falloff.
  viaZone?: boolean;
}

// RTC signaling payloads
export interface RtcSignal {
  fromId: string;
  toId: string;
  payload: unknown;
}

// A furniture piece placed on the map, referencing a visual palette entry
// (client/src/data/tilePaletteManifest.ts) rather than a fixed enum, so any
// curated tileset piece can be placed. Anchored at (x, y) as its BOTTOM-LEFT
// tile: the bottom row occupies `tilesW` tiles wide and is where collision is
// applied (see roomHandler/RoomEditor); any rows above that (tilesH > 1)
// are purely visual "overhead" — drawn above avatars — so tall pieces like a
// chair back or wardrobe let players walk visually behind them.
//
// `kind: 'banner'` is a different sub-type: decorative signage/posters an
// admin can drop anywhere via the Room Editor (team name, a tagline,
// announcements) — distinct from a Zone's label, which only appears at the
// top of a private zone. Banners are rendered as a DOM overlay (like Zone
// labels) instead of a tileset sprite crop, and never block movement, so
// `paletteId` is unused for them (kept as a stable placeholder id string)
// and `tilesH` is always 1.
export interface Furniture {
  id: string;
  paletteId: string;
  x: number;
  y: number;
  tilesW: number;
  tilesH: number;
  kind?: 'banner';
  text?: string;
  textColor?: string;
  bgColor?: string;
  imageUrl?: string;
  // True for chair-like pieces a player can sit in (see Avatar.isSitting).
  // Set automatically by the client when placing a chair palette entry —
  // not exposed as a Room Editor toggle, since "which pieces are chairs" is
  // a property of the art (tilePaletteManifest.ts), not an admin choice.
  isInteractable?: boolean;
  // Permanent seat assignment (ZEP-style "this is my desk"), distinct from
  // Avatar.isSitting which is just transient occupancy. Only set on
  // isInteractable pieces — see FURNITURE_ASSIGN/FURNITURE_UNASSIGN.
  // assignedToName is cached here (not looked up live) so an assigned
  // desk still shows whose it is even while that person is offline.
  assignedToUserId?: string;
  assignedToName?: string;
}

// Zones. 'meeting' zones render a big banner across the top of the area
// (label required to look right); 'desk'/'focus' render a small floating
// pill label instead; 'general' (or no type, for zones created before this
// field existed) keeps the plain dashed-outline + centered name that was
// already there.
export type ZoneType = 'meeting' | 'desk' | 'focus' | 'general';

export interface Zone {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  color?: string;
  type?: ZoneType;
}

// Chat. When zoneId is set, the message is private to that zone — the
// server only broadcasts it to sockets currently tracked as inside that
// zone (see zoneHandler.ts getSocketIdsInZone), and the client keeps it in
// a separate per-zone history instead of the general room chat.
export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderColor: string;
  text: string;
  timestamp: number;
  isProximity?: boolean;
  zoneId?: string;
}

// Emotes
export type EmoteType = 'wave' | 'clap' | 'laugh' | 'heart' | 'party' | 'think' | 'sleep' | 'fire';

export interface EmoteEvent {
  playerId: string;
  emote: EmoteType;
  x: number;
  y: number;
  timestamp: number;
}

export const EMOTE_EMOJI: Record<EmoteType, string> = {
  wave: '👋', clap: '👏', laugh: '😂', heart: '❤️',
  party: '🎉', think: '🤔', sleep: '😴', fire: '🔥',
};

export const EMOTE_LABELS: Record<EmoteType, string> = {
  wave: 'Wave', clap: 'Clap', laugh: 'Laugh', heart: 'Heart',
  party: 'Party', think: 'Think', sleep: 'Sleep', fire: 'Fire',
};

export const EMOTE_LIST: EmoteType[] = ['wave', 'clap', 'laugh', 'heart', 'party', 'think', 'sleep', 'fire'];

// Speech bubble (floating above avatar)
export interface SpeechBubble {
  playerId: string;
  text: string;
  expireAt: number;
}

// Payload for room:update — tile paint + furniture placement changes made in
// the Room Editor, sent together so they stay consistent on save/reload.
export interface RoomUpdatePayload {
  tiles: RoomTile[][];
  furniture: Furniture[];
  zones: Zone[];
}

export { createDefaultOfficeLayout } from '../defaultRoomLayout';
