import type { Role } from '../permissions';
import type { RoomTemplateId } from '../defaultRoomLayout';

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
  // True while the Run key (R) is held during active movement — only
  // meaningful alongside isMoving; purely cosmetic (faster walk-cycle
  // animation) plus the actual higher PLAYER_RUN_SPEED already reflected in
  // x/y updates, no separate server validation (see movementHandler.ts).
  isRunning?: boolean;
  // True while this player has "raised their hand" (ZEP/Gather-style meeting
  // cue) — rendered as a ✋ badge over the avatar AND on their video tile in
  // Meeting View. Persistent toggle (unlike the one-shot jump/nudge/emote),
  // so it lives on the player record and is included in room:state for late
  // joiners; cleared on the client when the player leaves.
  handRaised?: boolean;
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

// Which curated art/asset set a room renders with. 'modern-interiors' is the
// original LimeZu-based tileset (default, for backward compatibility with
// every room created before this field existed); 'scifi-office' is the
// Space Station 14-derived tileset (client/public/assets/tilesets/
// scifi-office/, CC-BY-SA 3.0 — see ATTRIBUTION.md there and the Credits
// section in Lobby.tsx). Additive: adding a theme here never removes or
// alters the modern-interiors asset set.
export type RoomTheme = 'modern-interiors' | 'scifi-office';

// A single pinned chat message ("notice") shown as a persistent banner —
// distinct from a speech bubble (which is per-sender and auto-expires) or
// a Furniture banner (static signage placed via the Room Editor). Only one
// notice is pinned per room at a time; pinning a new message replaces
// whatever was pinned before. See §1.3's "pin as notice" requirement —
// admin-only, enforced server-side (roomHandler.ts), not just hidden in the UI.
export interface Notice {
  messageId: string;
  text: string;
  senderName: string;
  pinnedByName: string;
  pinnedAt: number;
}

// Full room state transmitted over the network
export interface RoomState {
  id: string;
  name: string;
  tiles: RoomTile[][];
  players: Avatar[];
  adminUserIds?: string[];
  masterAdminUserId?: string;
  staffUserIds?: string[];
  furniture?: Furniture[];
  zones?: Zone[];
  theme?: RoomTheme;
  // Which layout this room was created with (see defaultRoomLayout.ts's
  // ROOM_TEMPLATES) — undefined for rooms created before this field
  // existed. Threaded through the same way `theme` already is so
  // RoomEditor.tsx's "Reset to Default" can rebuild the room's OWN
  // template instead of always falling back to Main Office.
  template?: RoomTemplateId;
  notice?: Notice | null;
  // Zoom-style meeting lock (see SocketEvents.ROOM_LOCK_SET) — true means no
  // new non-admin can join. In-memory server state, sent so a joining
  // client's UI shows the 🔒 indicator immediately.
  locked?: boolean;
  // The RECEIVING socket's own resolved role in this room (see
  // shared/permissions.ts) — computed server-side per-socket, not
  // broadcast, so a client always gets its own current tier without
  // re-deriving it from adminUserIds/masterAdminUserId/staffUserIds itself.
  role?: Role;
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

  // Raise-hand toggle — same relay+persist shape as status above.
  PLAYER_HAND = 'player:hand',
  PLAYER_HAND_UPDATED = 'player:hand_updated',

  // Zoom-style "Lock Meeting": admin toggles ROOM_LOCK_SET, everyone in the
  // room gets ROOM_LOCK_UPDATED (for the 🔒 indicator + owner control state),
  // and a NON-admin who tries to join a locked room gets ROOM_LOCKED_DENIED
  // instead of room:state and is bounced back to the Lobby.
  ROOM_LOCK_SET = 'room:lock_set',
  ROOM_LOCK_UPDATED = 'room:lock_updated',
  ROOM_LOCKED_DENIED = 'room:locked_denied',

  // "Knock to enter": a denied joiner can knock (ROOM_KNOCK) — admins in the
  // room get ROOM_KNOCK_REQUEST and may admit (ROOM_KNOCK_ADMIT), which
  // adds them to the lock allowlist and pings the knocker (ROOM_KNOCK_ADMITTED)
  // to auto-retry the join.
  ROOM_KNOCK = 'room:knock',
  ROOM_KNOCK_REQUEST = 'room:knock_request',
  ROOM_KNOCK_ADMIT = 'room:knock_admit',
  ROOM_KNOCK_ADMITTED = 'room:knock_admitted',

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

  // Jump — purely cosmetic, fire-and-forget one-shot hop (same broadcast
  // shape as EMOTE_PLAY above), never validated/stored server-side since
  // there's no persistent state to reconcile — a late joiner just never
  // sees a jump that already finished, same as an emote.
  PLAYER_JUMP = 'player:jump',

  // Nudge ("senggol") — ZEP-style poke: the client determines who's
  // standing on the tile it's facing and names them as the target; same
  // trust level as PLAYER_JUMP above (cosmetic, no persistent state, no
  // server-side validation of the target).
  PLAYER_NUDGE = 'player:nudge',

  ZONE_ENTER = 'zone:enter',
  ZONE_EXIT = 'zone:exit',

  // Per-ZONE lock ("lagi rapat, jangan diganggu"), separate from the
  // whole-room lock above. Anyone standing in a zone may lock it and becomes
  // its keyholder; someone who walks in afterwards is bounced and may knock
  // (ZONE_KNOCK). The keyholder — NOT an admin — decides (ZONE_KNOCK_DECIDE).
  // Two independent gates: the room lock is the front door of the map, a zone
  // lock is the door of a meeting room inside it.
  ZONE_LOCK_SET = 'zone:lock_set',
  ZONE_LOCK_UPDATED = 'zone:lock_updated',
  ZONE_LOCKED_DENIED = 'zone:locked_denied',
  ZONE_KNOCK = 'zone:knock',
  ZONE_KNOCK_REQUEST = 'zone:knock_request',
  ZONE_KNOCK_DECIDE = 'zone:knock_decide',
  ZONE_KNOCK_DECIDED = 'zone:knock_decided',

  ROOM_UPDATE = 'room:update',
  ROOM_UPDATED = 'room:updated',

  ADMIN_GRANT = 'admin:grant',
  ADMIN_REVOKE = 'admin:revoke',
  ADMIN_CHANGED = 'admin:changed',

  // Staff sits between admin and member (see shared/permissions.ts's Role
  // hierarchy) — broadcast on the same ADMIN_CHANGED event above (its
  // payload carries staffUserIds alongside adminUserIds/masterAdminUserId)
  // rather than a parallel event, since it's the exact same "room's role
  // assignments changed" notification either way.
  STAFF_GRANT = 'staff:grant',
  STAFF_REVOKE = 'staff:revoke',

  // §4 — Teleport. One request event for both admin locations and owner
  // bookmarks (payload's `kind` distinguishes them — see TeleportRequest);
  // server resolves the real x/y from its own stored data rather than
  // trusting client-supplied coordinates, same "server-authoritative"
  // principle as regular movement (§1). Broadcast via a dedicated
  // PLAYER_TELEPORTED event (not PLAYER_MOVED) so every client — including
  // the mover's own — snaps instantly instead of interpolating a fast
  // slide across the map like a normal walk would.
  TELEPORT_REQUEST = 'teleport:request',
  PLAYER_TELEPORTED = 'player:teleported',

  ROOM_DELETE = 'room:delete',
  ROOM_DELETED = 'room:deleted',

  NOTICE_PIN = 'notice:pin',
  NOTICE_UNPIN = 'notice:unpin',
  NOTICE_UPDATED = 'notice:updated',

  // Follow now requires the target's consent before tracking starts:
  // FOLLOW_REQUEST asks the server to start a request rather than following
  // immediately; the server relays it to the target as FOLLOW_INCOMING, and
  // the target's own accept/decline comes back as FOLLOW_RESPOND. Only once
  // accepted does the server actually create the follow relationship and
  // send FOLLOW_UPDATED/FOLLOWER_CHANGED, same as before. FOLLOW_RESULT lets
  // the requester's own client show whether they were accepted, declined,
  // or timed out with no reply.
  FOLLOW_REQUEST = 'follow:request',
  FOLLOW_INCOMING = 'follow:incoming',
  FOLLOW_RESPOND = 'follow:respond',
  FOLLOW_RESULT = 'follow:result',
  FOLLOW_UNFOLLOW = 'follow:unfollow',
  FOLLOW_UPDATED = 'follow:updated',
  FOLLOWER_CHANGED = 'follow:follower_changed',

  // §5 — Summon. Requires the target's consent before moving them: SUMMON_USER
  // asks the server to start a request rather than teleporting immediately;
  // the server relays it to the target as SUMMON_REQUEST, and the target's
  // accept/decline comes back as SUMMON_RESPOND — only on accept does the
  // server actually move them via the same PLAYER_TELEPORTED broadcast
  // Teleport already uses (snap, no lerp). SUMMON_RESULT lets the
  // requester's own client show whether they were accepted, declined, or
  // timed out with no reply. (Summon-the-whole-room was removed — see
  // roomHandler.ts's git history if it ever needs to come back.)
  SUMMON_USER = 'summon:user',
  SUMMON_REQUEST = 'summon:request',
  SUMMON_RESPOND = 'summon:respond',
  SUMMON_RESULT = 'summon:result',

  // §6 — Add Media. Portal (spec's ~10s ephemeral variant) is deliberately
  // NOT included — this app already has a permanent portal tile placed via
  // the Room Editor (see createDefaultRoom.ts's 'portal' TileType), and
  // Screenshot is a pure client-side canvas capture with nothing to
  // persist or broadcast, so neither needs a socket event.
  MEDIA_LIST = 'media:list',
  MEDIA_ADD = 'media:add',
  MEDIA_ADDED = 'media:added',
  MEDIA_REMOVE = 'media:remove',
  MEDIA_REMOVED = 'media:removed',
  // Whiteboard strokes are additive (two people drawing at once never
  // "conflict" the way concurrent text edits do), so a plain broadcast of
  // each completed stroke gives real-time multi-user sync without needing
  // a CRDT/OT library — see the doc comment on WhiteboardStroke below.
  WHITEBOARD_STROKE = 'whiteboard:stroke',
  WHITEBOARD_STROKE_ADDED = 'whiteboard:stroke_added',
  WHITEBOARD_CLEAR = 'whiteboard:clear',
  WHITEBOARD_CLEARED = 'whiteboard:cleared',

  // §6 (RTC upgrade) — spotlighting a player makes them FULL_VISIBLE to
  // everyone in the room regardless of distance (spec's own
  // computeVisibility bypass rule). Kept as its own tiny event pair rather
  // than folded into ADMIN_CHANGED — it's a room-wide broadcast state, not
  // a per-user role change, so it doesn't fit that payload's shape.
  SPOTLIGHT_TOGGLE = 'rtc:spotlight_toggle',
  SPOTLIGHT_CHANGED = 'rtc:spotlight_changed',

  // §7 — Screen Recording, adapted to client-side capture (see the
  // Recording Prisma model's doc comment for why). RECORDING_STARTED/ENDED
  // are sent per-socket, not broadcast, since who gets to see a REC
  // indicator at all is role/identity-dependent — see recordingHandler.ts.
  RECORDING_START = 'recording:start',
  RECORDING_STARTED = 'recording:started',
  RECORDING_STOP = 'recording:stop',
  RECORDING_FINALIZE = 'recording:finalize',
  RECORDING_ENDED = 'recording:ended',
  RECORDING_FAILED = 'recording:failed',

  // Persisted Channel/DM/Thread chat (see ChatMessage's sibling doc comment
  // below) — separate from CHAT_MESSAGE/CHAT_BROADCAST above, which now only
  // carries the zone-private and proximity-bubble cases; the old whole-room
  // broadcast is superseded by the room's default "general" Channel. JOIN/LEAVE
  // scope a socket to one channel/DM socket.io room at a time (only the
  // currently-open tab needs live updates), mirroring zoneHandler.ts's
  // enter/exit tracking.
  CHANNEL_JOIN = 'channel:join',
  CHANNEL_LEAVE = 'channel:leave',
  CHANNEL_MESSAGE_SEND = 'channel:message_send',
  CHANNEL_MESSAGE_NEW = 'channel:message_new',
  CHANNEL_CREATED = 'channel:created',
  CHANNEL_DELETED = 'channel:deleted',
  // "X is typing…" — client pings while composing (throttled), server relays
  // to the other members of that channel's socket room. Purely transient, no
  // persistence; the receiver auto-expires it after a few seconds.
  CHANNEL_TYPING = 'channel:typing',
  CHANNEL_TYPING_UPDATE = 'channel:typing_update',

  // Room join approval (see server/src/lib/roomMembership.ts).
  JOIN_DENIED = 'room:join_denied',
  JOIN_REQUESTED = 'room:join_requested',
  JOIN_DECISION = 'room:join_decision',
  JOIN_QUEUE_CHANGED = 'room:join_queue_changed',
  DM_JOIN = 'dm:join',
  DM_LEAVE = 'dm:leave',
  DM_MESSAGE_SEND = 'dm:message_send',
  DM_MESSAGE_NEW = 'dm:message_new',
  // Broadcast once, only when a DM conversation is first created (not on
  // every find-or-create hit) — see routes/chat.ts's POST /rooms/:slug/dms.
  // Without this the OTHER participant would have no live way to discover
  // a new incoming DM at all (only the starter's own client already has
  // it), and would only see it after their next reload.
  DM_STARTED = 'dm:started',
  // "X is typing…" for a 1:1 DM — same transient relay shape as the channel
  // typing events above.
  DM_TYPING = 'dm:typing',
  DM_TYPING_UPDATE = 'dm:typing_update',

  // Delete a persisted channel/DM message you sent (MESSAGE_DELETE, own
  // messages only) — the server removes it (cascading any thread replies) and
  // broadcasts MESSAGE_DELETED to that channel/DM's socket room so every
  // client drops it live.
  MESSAGE_DELETE = 'message:delete',
  MESSAGE_DELETED = 'message:deleted',

  // Edit a persisted channel/DM message you sent (MESSAGE_EDIT, own messages
  // only) — the server rewrites its text and broadcasts MESSAGE_EDITED so
  // every client updates it live.
  MESSAGE_EDIT = 'message:edit',
  MESSAGE_EDITED = 'message:edited',

  // Temporary removal from the room by an admin+ user (see
  // shared/permissions.ts's 'room:kick') — not a ban, the target can rejoin
  // any time. PLAYER_KICK is the admin's request; PLAYER_KICKED is sent only
  // to the removed player's own socket (never broadcast) so their client can
  // show a "you were removed" notice — everyone else in the room just sees
  // the ordinary PLAYER_LEFT broadcast, since roomHandler.ts's kick handler
  // reuses handleLeave's exact same cleanup.
  PLAYER_KICK = 'player:kick',
  PLAYER_KICKED = 'player:kicked',
}

// Sent only to the removed player's own socket — see PLAYER_KICKED above.
export interface PlayerKickedPayload {
  byName: string;
}

// My own follow relationship (I am the follower) — sent only to me, never
// broadcast, since it's private info about my own client's behavior. null
// means "not following anyone". 'standby' means the target went offline;
// see followHandler.ts — position tracking pauses but the relationship is
// kept so it resumes automatically the moment the target reconnects,
// instead of the follower having to click Follow again (§3's explicit rule).
export interface FollowInfo {
  targetUserId: string;
  targetName: string;
  status: 'active' | 'standby';
}

// Broadcast to everyone in the room whenever a given player's follower set
// changes — lets any client show "N people following" on that player
// without a private per-viewer round trip.
export interface FollowerChangedPayload {
  targetUserId: string;
  followerUserIds: string[];
}

// §4.1 — a shared, staff+ visible saved spot in the current room. Capped at
// 20 per room (enforced server-side in server/src/routes/teleport.ts, not
// representable in the type itself).
export interface TeleportLocation {
  id: string;
  roomId: string;
  name: string;
  x: number;
  y: number;
  icon?: string | null;
  orderIndex: number;
  createdBy: string;
}

// §4.2 — a personal bookmark visible only to the room's own owner, scoped
// to (ownerId, roomId) — never copied to other rooms, see the Prisma
// model's doc comment for why.
export interface OwnerBookmark {
  id: string;
  roomId: string;
  label: string;
  x: number;
  y: number;
  orderIndex: number;
}

export interface TeleportRequest {
  // 'seat' — jump straight to whichever piece of furniture in this room is
  // currently assigned to the requester (see Furniture.assignedToUserId).
  // No locationId: unlike admin/bookmark locations, "my seat" isn't looked
  // up by a client-supplied id — the server resolves it directly from the
  // requester's own uid, since a user can only ever have one meaningful
  // answer to "where's MY seat" and there's nothing to scope/guess.
  kind: 'admin' | 'bookmark' | 'seat';
  locationId?: string;
}

// How long a Summon/Follow request waits for the target to respond before
// the server auto-declines it — shared so the target's own countdown UI and
// the server's timeout agree on the same duration.
export const CONSENT_REQUEST_TIMEOUT_MS = 20 * 1000;

// §5 — Summon consent. Sent to the target so they can accept/decline before
// anything happens to their position.
export interface SummonRequestPayload {
  requestId: string;
  actorName: string;
}

// A locked-room knock, shown to admins with Admit/Ignore (see
// SocketEvents.ROOM_KNOCK_REQUEST). userId is the knocker's account id —
// what an admit adds to the lock allowlist.
export interface KnockRequestPayload {
  userId: string;
  name: string;
}

export interface SummonRespondPayload {
  requestId: string;
  accept: boolean;
}

// Sent back to whoever asked to summon someone, so their own client can show
// what happened to the request.
export interface SummonResultPayload {
  targetName: string;
  accepted: boolean;
  reason?: 'declined' | 'timeout' | 'offline';
}

// Follow consent — same shape as Summon's, see CONSENT_REQUEST_TIMEOUT_MS.
export interface FollowRequestPayload {
  requestId: string;
  actorUserId: string;
  actorName: string;
}

export interface FollowRespondPayload {
  requestId: string;
  accept: boolean;
}

export interface FollowResultPayload {
  targetName: string;
  accepted: boolean;
  reason?: 'declined' | 'timeout' | 'offline';
}

// §6 — Add Media. One table/type union with `type` as discriminator, per
// the spec's own "MapMediaObject" model — 'portal' and 'screenshot' are
// deliberately absent, see the SocketEvents doc comment above for why.
export type MediaType = 'image' | 'youtube' | 'whiteboard' | 'file';

export interface MediaPayload {
  url?: string; // image / file — served from this app's own /uploads static route
  fileName?: string; // file only — original name, for the download link's label
  videoId?: string; // youtube only — parsed from whatever URL shape the user pasted
  strokes?: WhiteboardStroke[]; // whiteboard only — full history, appended to on each stroke
}

export interface MapMediaObject {
  id: string;
  roomId: string;
  type: MediaType;
  x: number;
  y: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  expiresAt: string | null; // image/file: now+24h; youtube/whiteboard: permanent (null)
  payload: MediaPayload;
}

// A single freehand stroke — points in tile-relative pixel space (0..WHITEBOARD_SIZE)
// so it renders the same regardless of which client's camera drew it.
export interface WhiteboardStroke {
  points: { x: number; y: number }[];
  color: string;
  width: number;
}

// §6 — fixed canvas size a whiteboard's stroke points are captured/drawn in,
// independent of any client's actual on-screen zoom/camera — this is what
// makes a stroke drawn on one client render identically on another.
export const WHITEBOARD_SIZE = 480;

// §7 — Screen Recording. See the Prisma model's doc comment for the
// client-side-capture adaptation this represents.
export const RECORDING_MAX_DURATION_MS = 80 * 60 * 1000; // 80 min, matches spec's 4800s cap
export const RECORDING_DOWNLOAD_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
export const RECORDING_MAX_DOWNLOADS = 3;

export type RecordingStatus = 'recording' | 'processing' | 'done' | 'failed';

export interface Recording {
  id: string;
  roomId: string;
  startedBy: string;
  startedByName: string;
  targetUserId: string;
  targetName: string;
  title: string;
  status: RecordingStatus;
  startedAt: string;
  endedAt: string | null;
  // Never sent to the client: GET /rooms/:slug/recordings strips it, because
  // the raw /api/uploads/<uuid>.webm path bypasses the role/expiry/
  // maxDownloads gate on GET /recordings/:id/download (see
  // server/src/routes/recordings.ts). Optional here because this type also
  // describes the row server-side, where the field is real — a client reading
  // it gets undefined, and should use the download route instead.
  fileUrl?: string | null;
  downloadExpiresAt: string | null;
  downloadCount: number;
  maxDownloads: number;
}

// Grid and rendering constants — shared so server can also validate bounds
export const TILE_SIZE = 32;
// "Main Office" ZEP-inspired layout (see defaultRoomLayout.ts): two meeting
// rooms, an open main desk zone with 4 team clusters, a dev team room, an
// external meeting room, a 5-pod focus zone, a lounge, and an entrance/
// reception strip spanning the bottom.
export const MAP_WIDTH = 50;
export const MAP_HEIGHT = 36;
export const PLAYER_SPEED = 150; // pixels per second
// Run (hold R while moving) — no dedicated run animation frames exist in
// the LimeZu Character Generator pack (only idle/walk rows), so running is
// the walk animation cycled faster (see AvatarSprite.ts's RUN_FRAME_MS)
// plus this actual higher step speed; there's nothing for the server to
// validate beyond what it already does for normal movement (bounds +
// tile-collision — see movementHandler.ts's doc comment on why per-tick
// max-distance was never enforced even before Run existed).
export const PLAYER_RUN_SPEED = 260; // pixels per second

// Jump (Space, when not sitting/near a chair) — cosmetic one-shot vertical
// hop, rendered client-side only (see AvatarSprite.ts/GameCanvas.tsx);
// shared here purely so the local trigger and the remote PLAYER_JUMP
// listener animate the exact same arc.
export const JUMP_DURATION_MS = 420;
export const JUMP_HEIGHT_PX = 14;

export interface JumpEvent {
  playerId: string;
  timestamp: number;
}

// Nudge ("senggol", Z key) — cosmetic one-shot side-to-side shake on the
// target's avatar, same rendering split as Jump above (shared constants so
// the local shake and the remote PLAYER_NUDGE listener animate identically).
export const NUDGE_DURATION_MS = 400;
export const NUDGE_SHAKE_PX = 6;

export interface NudgeEvent {
  fromId: string;
  targetId: string;
  timestamp: number;
}

// Proximity / WebRTC constants
export const PROXIMITY_THRESHOLD = 3; // tiles — within 3 tiles: full video + audio
export const PROXIMITY_THRESHOLD_PX = 96; // 3 tiles × 32px
// §6 (RTC upgrade) — beyond PROXIMITY_THRESHOLD but within this: still
// connected, rendered translucent, audio faded near-zero. The spec's own
// example numbers (6/10 tiles) were written for an unspecified room scale;
// this app's rooms are already tuned around PROXIMITY_THRESHOLD=3, so this
// keeps that scale and applies the same ~1.7x ratio the spec used (10/6)
// rather than copying its absolute tile counts.
export const TRANSLUCENT_THRESHOLD = 5;
export const DISCONNECT_DEBOUNCE_MS = 500;

// §6 — mirrors the spec's own three-state enum name
// (full_visible/translucent/not_visible) for computeVisibility's result.
export type VisibilityStatus = 'full_visible' | 'translucent' | 'not_visible';

export interface ProximityPlayer {
  id: string;
  distanceTiles: number;
  visibility: VisibilityStatus;
  // true when connected because both players share a private Zone (see
  // useProximity.ts) rather than because they're within a distance
  // threshold — WebRTC uses this to skip distance-based audio falloff.
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

// Live lock state of one zone, broadcast to the room so every client can draw
// the padlock and know who to knock on. `allowedUserIds` is the admit list the
// keyholder has built up; it is never sent from the client.
export interface ZoneLockState {
  zoneId: string;
  locked: boolean;
  lockedByUserId?: string;
  lockedByName?: string;
}

export interface ZoneKnockRequest {
  zoneId: string;
  zoneName: string;
  userId: string;
  playerId: string;
  playerName: string;
}

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

// Persisted Channel/DM/Thread chat — distinct from ChatMessage above (which
// stays ephemeral, in-memory only, for zone-private/proximity-bubble chat).
// A ChannelMessage belongs to exactly one of channelId/conversationId; a
// reply sets parentId to its parent's id (one level deep — the UI doesn't
// nest replies-of-replies). replyCount is only populated on top-level
// messages returned from the list endpoints, not on individual replies.
// A conversation list row's preview line — "Rizal: lu coba tanya". Carried on
// the LIST endpoints so the messenger's sidebar can render every row on first
// paint; without it a conversation stays blank until it's been opened once,
// since message history is only fetched per-target on open.
export interface ConversationPreview {
  senderName: string;
  // Already collapsed to a single line by the server: an attachment-only
  // message previews as its filename rather than as empty text.
  text: string;
  createdAt: number;
}

export interface Channel {
  id: string;
  roomId: string;
  name: string;
  isDefault: boolean;
  createdAt: number;
  lastMessage?: ConversationPreview;
}

export interface DirectConversationSummary {
  id: string;
  roomId: string;
  otherUser: { id: string; displayName: string };
  createdAt: number;
  lastMessage?: ConversationPreview;
}

// Symmetric broadcast shape for DM_STARTED — carries both participants
// since (unlike DirectConversationSummary, which is per-viewer) this is
// the same wire payload delivered to everyone in the room; each client
// picks out "the other one" for itself.
export interface DirectConversationStarted {
  id: string;
  roomId: string;
  userA: { id: string; displayName: string };
  userB: { id: string; displayName: string };
  createdAt: number;
}

export interface ChannelMessage {
  id: string;
  channelId?: string;
  conversationId?: string;
  parentId?: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: number;
  replyCount?: number;
  // Set by the server's MESSAGE_EDITED broadcast so the UI can show an
  // "(edited)" marker for the live session. Not persisted (no schema column),
  // so it resets on reload — the edited TEXT itself is persisted, only the
  // marker is session-scoped.
  edited?: boolean;
  // Optional file attachment — uploaded via the same POST /api/uploads
  // endpoint Add Media uses (see server/src/routes/uploads.ts), so this is
  // just the resulting URL plus the original filename (the stored file
  // itself is renamed to a random UUID on disk). A message has text, an
  // attachment, or both — never neither.
  attachmentUrl?: string;
  attachmentName?: string;
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

export { createDefaultOfficeLayout, findSpawnPixel, createRoomLayoutFromTemplate, ROOM_TEMPLATES } from '../defaultRoomLayout';
export type { RoomTemplateId } from '../defaultRoomLayout';
export { BLOCKED_TILES, isTileBlocked, findZoneEntryTile, findAdjacentFreeTile } from '../tileCollision';
export type { Role, FeatureKey } from '../permissions';
export { roleAtLeast, hasFeatureAccess, FEATURE_MIN_ROLE } from '../permissions';
export type { BaseRole, BaseAction, PermissionCtx, FieldAccess, RecordEditRule } from '../basePermissions';
export { baseRoleAtLeast, can, canViewField, canEditField, canEditRecord, BASE_ROLE_LABELS } from '../basePermissions';
export type { ShiftDef, AttendanceStatus, WorkTotals, Geofence, Coords, GeofenceResult } from '../attendanceRules';
export {
  STATUS_LABELS, shiftBounds, isWorkday, lateMinutes, clockInStatus, earlyLeaveMinutes,
  computeTotals, finalStatus, workDayOf, distanceM, checkGeofence, canViewAttendanceOf,
  MAX_ACCURACY_M, LOCATION_RETENTION_DAYS,
} from '../attendanceRules';
export type { CalendarRole, CalendarAction, CalendarCtx, Rsvp } from '../calendarPermissions';
export { calendarRoleAtLeast, canCalendar, canSeeEventDetails, CALENDAR_ROLE_LABELS, RSVP_LABELS } from '../calendarPermissions';
export type { EditScope, RecurringMaster, Occurrence } from '../recurrence';
export { expandOccurrences, truncateRuleBefore, normaliseRule, describeRule } from '../recurrence';
export type { DocRole, DocAction, DocCtx } from '../docPermissions';
export { docRoleAtLeast, canDoc, DOC_ROLE_LABELS } from '../docPermissions';
export type { WorkspaceRole, WorkspaceAction, WorkspaceCtx } from '../workspacePermissions';
export { canWorkspace, WORKSPACE_ACTIONS, WORKSPACE_ROLE_LABELS } from '../workspacePermissions';
export type { BaseCellValue, BaseOp, BaseOpType, MutationRequest, WsOpsMessage, WsPresenceMessage, PresenceUser } from '../baseOps';
export { OP_ACTION } from '../baseOps';
