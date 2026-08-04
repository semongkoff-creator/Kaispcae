import type { Role } from '../permissions';
import type { RoomTemplateId } from '../defaultRoomLayout';
import type { ReferenceImageData, ImpassableAreaRect } from '../mapLayers';

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
  // True while sitting in a chair (see Furniture.isInteractable) — movement
  // input is ignored client-side while true, and x/y are snapped to the
  // chair's tile, so remote clients just render this player idle at that
  // exact position rather than needing a separate "sitting" sprite.
  isSitting?: boolean;
  // Which chair (Furniture.id) this player is currently sitting in, broadcast
  // alongside isSitting. Two sitting players whose chairs share a Furniture
  // .tableId form a private audio/video group — the same effect as sharing a
  // zone (see useProximity). Also how "is this chair already taken" is checked
  // before letting someone sit. Cleared when they stand.
  seatFurnitureId?: string;
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
  // A3/A11 — presence status. Kept the name `workMode` (the field predates A11)
  // but widened to the full presence set. 'focus' still means Do-Not-Disturb:
  // no proximity auto-connect (useProximity), and Summon/Slap/Follow are
  // rejected against it. Broadcast + kept on the player record like
  // status/handRaised, so it's in room:state for late joiners.
  // Absent/undefined is treated as 'available' (no badge).
  workMode?: WorkMode;
  // Short reason picked from the Away popup ("External Meeting", "Makan", or
  // free text) when workMode is 'away' — only meaningful alongside
  // workMode === 'away'; cleared whenever workMode changes to anything else.
  // Never set for the auto 'in_meeting'/'focus' zone-driven states.
  awayReason?: string;
  // ZEP-style Spotlight — an admin-toggled broadcast override (see
  // shared/permissions.ts's 'presence:spotlight'). While true, EVERY other
  // client's useProximity forces this player to 'full_visible' regardless of
  // distance, zone membership, or either side's Focus/DND state — a PA
  // announcement, not a proximity connection. Kept on the player record like
  // workMode/handRaised so it's in room:state for late joiners.
  spotlightActive?: boolean;
}

// A11 — presence status. 'in_meeting' + 'focus' are auto-set from the zone
// the avatar is in (meeting/focus zone), but can also be picked manually from
// the Status list — same value either way, so a manual pick gets the exact
// same DND behaviour a zone-triggered one does. 'available' | 'lunch' |
// 'away' | 'wfh' | 'break' are always manual. Only 'focus' triggers DND
// behaviour (see useProximity / Summon / Slap / Follow) — the rest are
// display-only labels. 'wfh'/'break' replace the old free-text custom-status
// field (Avatar.status, removed) — those were just unstructured strings for
// the same "what am I doing" signal this enum already covers.
export type WorkMode = 'available' | 'in_meeting' | 'focus' | 'lunch' | 'away' | 'wfh' | 'break';

// Away-reason popup (idle-AFK or manual "Away" pick, see App.tsx) — how long
// to wait for the user to pick a reason before defaulting to a plain 'away'
// with no reason (they're genuinely not there to answer), and the max length
// a free-text "Lainnya" reason is trimmed to.
export const AWAY_REASON_PROMPT_TIMEOUT_MS = 30_000;
export const AWAY_REASON_MAX_LENGTH = 60;

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
  // Custom-uploaded wall skin (Fitur 15) — only meaningful when type === 'wall'.
  // Absent means the theme's default wall art (unchanged from before this
  // existed). Never affects collision — that's still purely `type === 'wall'`.
  wallPaletteId?: string;
  // portalTarget = destination ROOM slug (cross-room portal). For an INTERNAL
  // portal (same room), portalTargetX/Y hold the destination tile instead.
  // portalLabel is an optional name shown by the "Press F" prompt. All only
  // meaningful when type === 'portal'.
  portalTarget?: string;
  portalTargetX?: number;
  portalTargetY?: number;
  portalLabel?: string;
  // ZEP-style door password — only meaningful when type === 'door'. See
  // TileEffect's own doc comment (shared/mapLayers.ts) for the persisted
  // shape and redactDoorPasswords for why doorPassword itself never reaches
  // a normal player's client.
  doorPasswordEnabled?: boolean;
  doorPassword?: string;
  doorPasswordDescription?: string;
  doorFailureMessage?: string;
  // Sittable tile effect (see mapLayers.ts's TileEffect) — a seat with no
  // Furniture piece at all, for rooms traced entirely over a reference-image
  // photo. GameCanvas.tsx's sit-trigger scan treats this the same as an
  // isInteractable Furniture piece; sitDirection is used directly (absolute,
  // no rotation to combine with — unlike Furniture.sitFacing).
  isSittable?: boolean;
  sitDirection?: Direction;
  // Claimable-seat marker (see mapLayers.ts's TileEffect 'claimableSeat') —
  // stable id of the marker at this tile, if any. Purely descriptive
  // ("a marker exists here"); live ownership (who's claimed it) is tracked
  // entirely server-side, in-memory, never on this field.
  claimableSeatId?: string;
}

// Valid tile types and their visual/semantic meaning. 'portal' and 'spawn'
// are always walkable (never added to BLOCKED_TILES).
// 'blocked' (ZEP editor, Potong 4) is an INVISIBLE impassable tile — it blocks
// movement like a wall but renders nothing (the floor shows through). Used by
// the Impassable tile effect. Always in BLOCKED_TILES; the game render skips it.
export type TileType = 'floor' | 'wall' | 'door' | 'desk' | 'chair' | 'portal' | 'spawn' | 'blocked';

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
  // Item #9 (precise-collision follow-up) — pixel-space Impassable Area
  // rectangles, for the client's own local movement prediction (the server
  // independently re-checks these authoritatively — see
  // movementHandler.ts). Absent/undefined on a room saved before this
  // field existed; treated as [] everywhere it's read.
  impassableAreaRects?: ImpassableAreaRect[];
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
  // Floor-plan reference image, forwarded ONLY when the admin opted into
  // ReferenceImageData.showInGame (see roomHandler.ts's ROOM_STATE emit and
  // mapLayers.ts) — null whenever the room has none, or has one that's
  // editor-only. When present, GameCanvas.tsx renders it for every player.
  referenceImage?: ReferenceImageData | null;
  // Room-wide avatar sprite scale (see LayerData.avatarScale) — undefined
  // means 1 (unchanged size). Always forwarded, no opt-in gate.
  avatarScale?: number;
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

  // Raise-hand toggle — same relay+persist shape as status above.
  PLAYER_HAND = 'player:hand',
  PLAYER_HAND_UPDATED = 'player:hand_updated',
  // Bug 14 — a short, polite chime for people in the SAME zone as whoever just
  // raised their hand (server-scoped to the zone + per-sender cooldown), so a
  // presenter hears "someone wants to speak" without watching the screen. The
  // visual ✋ badge still goes to the whole room via PLAYER_HAND_UPDATED above;
  // this is only the sound cue.
  HAND_RAISED_ALERT = 'player:hand_alert',

  // A3 — Focus/Public work mode. Same relay+persist shape as status/hand.
  WORK_MODE_CHANGE = 'work_mode:change',
  WORK_MODE_CHANGED = 'work_mode:changed',

  // ZEP-style Spotlight — an ADMIN toggles this on a TARGET player (unlike
  // WORK_MODE_CHANGE/PLAYER_HAND, which are self-service), so the payload
  // carries a targetUserId and the permission check happens server-side
  // (see shared/permissions.ts's 'presence:spotlight'). Broadcast to the
  // WHOLE room including the target's own socket (not `socket.to()`,
  // unlike work-mode/hand) since the target never applied this locally
  // themselves — they only learn about it from this event.
  SPOTLIGHT_TOGGLE = 'presence:spotlight_toggle',
  SPOTLIGHT_CHANGED = 'presence:spotlight_changed',

  // A5 — official meeting (Lark VC) started/ended in a meeting zone. Server
  // broadcasts to the room so everyone sees the "join via Lark" banner.
  MEETING_STARTED = 'meeting:started',
  MEETING_ENDED = 'meeting:ended',

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
  // to auto-retry the join. ROOM_KNOCK_CANCEL is the knocker withdrawing a
  // request before the host responds (no payload — the server already knows
  // which pending knock is theirs, keyed by their own socket); every admin
  // who got the original ROOM_KNOCK_REQUEST gets ROOM_KNOCK_CANCELLED so
  // their approval toast can't act on a request that's already gone.
  ROOM_KNOCK = 'room:knock',
  ROOM_KNOCK_REQUEST = 'room:knock_request',
  ROOM_KNOCK_CANCEL = 'room:knock_cancel',
  ROOM_KNOCK_CANCELLED = 'room:knock_cancelled',
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
  // Announces which MediaStream carries a screen share, so receivers can tell
  // a screen from a camera by fact rather than inference — see
  // RtcScreenSharePayload.
  RTC_SCREEN_SHARE = 'rtc:screen-share',

  CHAT_BUBBLE = 'chat:bubble',
  EMOTE_PLAY = 'emote:play',

  // Soundboard — Discord-style short-clip player. SOUNDBOARD_PLAY only ever
  // carries a soundId (never a URL — the client resolves it locally from
  // either SOUNDBOARD_DEFAULT_SOUNDS, a static shared list, or its own
  // soundboardSounds list for a custom upload, so a spoofed id just fails to
  // resolve and no-ops rather than pointing anyone at an arbitrary URL).
  // Server-side audience is getNearbyRecipients (proximityBroadcast.ts) —
  // the SAME zone/proximity rule Bug 14's raise-hand chime uses, reused on
  // purpose rather than reimplemented. SOUNDBOARD_SOUND_ADDED is a plain
  // whole-room broadcast (like MEDIA_ADDED) so every client's panel picks up
  // a fresh custom upload live, without needing to reopen it.
  SOUNDBOARD_PLAY = 'soundboard:play',
  SOUNDBOARD_PLAYED = 'soundboard:played',
  SOUNDBOARD_SOUND_ADDED = 'soundboard:sound_added',
  // Initial sync of this room's custom sounds, sent once right after
  // ROOM_STATE on join — same "list arrives right after room:state" shape
  // as MEDIA_LIST.
  SOUNDBOARD_LIST = 'soundboard:list',

  // Music Bot (!play/!skip/!pause/!resume/!queue/!stop chat commands, see
  // server/src/socket/musicHandler.ts) — one snapshot event covers every
  // state change (a track started, paused, resumed, skipped, queued, or the
  // whole thing stopped) rather than a separate event per action; the
  // client just replaces its local per-zone music state with whatever this
  // carries. Broadcast only to sockets currently in that zone (same
  // getSocketIdsInZone audience as zone-private chat), never the whole room.
  MUSIC_STATE = 'music:state',

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
  // Potongan A2 — the requester's own way out of a pending knock (before the
  // keyholder ever decides), and the keyholder-side signal that a pending
  // knock is moot for any reason other than their own decision: the
  // requester cancelled it, disconnected, or the zone unlocked/its keyholder
  // left while it was still pending. Either way the keyholder's card for it
  // should just disappear — same UI effect, three different triggers.
  ZONE_KNOCK_CANCEL = 'zone:knock_cancel',
  ZONE_KNOCK_CANCELLED = 'zone:knock_cancelled',

  // Claimable seat markers (Room Editor's 'claimableSeat' tile effect —
  // mapLayers.ts). Ownership is in-memory only (server/src/socket/
  // seatClaim.ts), exactly like the zone lock above: "right now, in this
  // session", never persisted, released automatically on disconnect.
  CLAIM_SEAT = 'seat:claim',
  RELEASE_SEAT = 'seat:release',
  SEAT_CLAIMS_UPDATED = 'seat:claims_updated',
  SEAT_CLAIM_DENIED = 'seat:claim_denied',

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
  // A4 — free double-click-to-teleport to an arbitrary (non-blocked) tile.
  // Client sends target pixel coords; server validates + re-broadcasts as
  // PLAYER_TELEPORTED so every client SNAPS (no lerp), same as other teleports.
  PLAYER_TELEPORT_TO = 'player:teleport_to',

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

  // A10 — Slap/Tap ("colek"): a lightweight, ephemeral attention-nudge to one
  // person (vibrate + soft sound + shake + toast). SLAP is the sender's request
  // (by nickname, like SUMMON_USER); the server relays SLAPPED only to the
  // target socket after a Focus + 30s-per-target cooldown check. Nothing is
  // persisted (optional activity_log only). SLAP_SENT goes back to the sender
  // ONLY (never broadcast to the room) so they get a local confirmation sound —
  // sound for a slap must be audible on exactly 2 devices: sender + target.
  SLAP = 'slap',
  SLAPPED = 'slapped',
  SLAP_SENT = 'slap:sent',

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
  // Fitur 15B — Password prompt objects never send their real password to
  // any client (see roomHandler.ts's redaction on ROOM_STATE/ROOM_UPDATED).
  // Verification is this one round trip: client sends its attempt, the
  // server compares against the room's OWN stored layerData (fetched fresh,
  // never trusting a client-cached copy) and replies correct/incorrect.
  INTERACTIVE_PASSWORD_CHECK = 'interactive:password_check',
  INTERACTIVE_PASSWORD_RESULT = 'interactive:password_result',
  // ZEP-style door password — same request/reply shape and server-side
  // verification approach as the furniture password pair above (never trust
  // a client compare, re-read the room's own stored data fresh, redact the
  // real value from every broadcast), but keyed by tile (x,y) instead of a
  // furnitureId since a door is a TileEffect, not a Furniture piece. A
  // correct attempt also unlocks that door for the rest of THIS socket's
  // session (see server/src/socket/doorLock.ts) — reflected here only as
  // "movement past that tile now succeeds", not a further event.
  INTERACTIVE_DOOR_PASSWORD_CHECK = 'interactive:door_password_check',
  INTERACTIVE_DOOR_PASSWORD_RESULT = 'interactive:door_password_result',
  // Fitur 15B — same request/reply shape as the password pair above, for
  // Multiple choice pop-up's isCorrect flags.
  INTERACTIVE_CHOICE_CHECK = 'interactive:choice_check',
  INTERACTIVE_CHOICE_RESULT = 'interactive:choice_result',
  // Fitur 15B — last of the 6 types. Client only ever sends {furnitureId};
  // the server resolves the real apiUrl itself and does the POST server-side
  // (never the browser — SSRF + CORS both argue against a client-side fetch
  // to an admin-supplied external URL).
  INTERACTIVE_API_CALL = 'interactive:api_call',
  INTERACTIVE_API_CALL_RESULT = 'interactive:api_call_result',
  // Fitur 15B — 'change_object'. No _RESULT event: the piece disappearing
  // from everyone's ROOM_UPDATED furniture list (the server mutates the
  // room's actual saved layerData, not just a per-socket reply) IS the
  // feedback — there's nothing else to tell the triggering client.
  INTERACTIVE_CHANGE_OBJECT = 'interactive:change_object',
  // Whiteboard strokes are additive (two people drawing at once never
  // "conflict" the way concurrent text edits do), so a plain broadcast of
  // each completed stroke gives real-time multi-user sync without needing
  // a CRDT/OT library — see the doc comment on WhiteboardStroke below.
  WHITEBOARD_STROKE = 'whiteboard:stroke',
  WHITEBOARD_STROKE_ADDED = 'whiteboard:stroke_added',
  WHITEBOARD_CLEAR = 'whiteboard:clear',
  WHITEBOARD_CLEARED = 'whiteboard:cleared',

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
  // Item #5 — JOIN_REQUESTED used to be a room-wide broadcast nobody actually
  // listened for (the badge in App.tsx polled instead). It's now targeted
  // directly at each admin socket currently connected to the room (mirrors
  // ROOM_KNOCK_REQUEST's fan-out in roomHandler.ts) and carries enough to
  // render a popup without a follow-up fetch — see JoinRequestPopupPayload.
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

// Item #5 — a room-join request, shown to every currently-connected admin of
// that room with Terima/Tolak (see SocketEvents.JOIN_REQUESTED). Deciding
// either way goes through the same REST route the manual queue panel already
// uses (POST /rooms/:slug/join-requests/:userId) — this is a notification +
// shortcut, not a second approval path.
export interface JoinRequestPopupPayload {
  userId: string;
  name: string;
  roomSlug: string;
  roomName: string;
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
// Potong 6 — 'website' (open a URL) and 'bgm' (area background music) added.
export type MediaType = 'image' | 'youtube' | 'whiteboard' | 'file' | 'website' | 'bgm';

export interface MediaPayload {
  url?: string; // image / file — /api/uploads/<name> or /api/files/<token> (Lark Drive, A8)
  fileName?: string; // file only — original name, for the download link's label
  videoId?: string; // youtube only — parsed from whatever URL shape the user pasted
  strokes?: WhiteboardStroke[]; // whiteboard only — full history, appended to on each stroke
  // Potong 6
  websiteUrl?: string; // 'website' — always https:// (validated on placement)
  audioUrl?: string; // 'bgm' — uploaded audio, same Lark Drive path as attachments
  areaW?: number; // 'bgm' — area size in tiles (music plays while inside x..x+areaW)
  areaH?: number;
  volume?: number; // 'bgm' — default playback volume 0..1
  // Bug media #1 — 'bgm' only. Epoch ms, set ONCE server-side (mediaHandler.ts's
  // MEDIA_ADD) the moment this area is placed — never updated afterward
  // (there's no pause/skip for ambient BGM, unlike MusicSessionState's Music
  // Bot). Every client computes its own playback position as
  // `(Date.now() - startedAt) % audio.duration` instead of always starting
  // fresh at 0 — so re-entering the room (or a second person joining) lands
  // at roughly the same position everyone else hears, same shared-clock
  // pattern MusicSessionState already uses for the Music Bot, just without
  // the pause/resume bookkeeping this feature doesn't need. Absent on BGM
  // areas placed before this field existed — falls back to today's
  // start-at-0 behavior, no backfill needed.
  startedAt?: number;
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

// Grid and rendering constants — shared so server can also validate bounds.
// TILE_SIZE is the LOGICAL/on-screen size of one grid cell in pixels — every
// position, camera, and collision calculation across client and server is
// expressed in this unit, so bumping it (32 -> 48, the Fitur 4 sprite/tile
// upgrade) automatically keeps all of that math consistent with no other
// changes needed. It is NOT the same thing as the pixel dimensions of the
// actual source art in the tileset/character PNGs — see SOURCE_TILE_SIZE
// below for that; conflating the two silently reads the wrong region out of
// a spritesheet (see mapRender.ts's drawTile/drawFurnitureLayer).
export const TILE_SIZE = 48;
// Fixed to the actual pixel grid every tileset/character spritesheet in
// client/public/assets/{tilesets,characters} is authored at. This must NEVER
// change unless the source art itself is replaced with art on a different
// grid — it is independent of TILE_SIZE above, which only controls how large
// that same source art is drawn (and where things are placed) on screen.
export const SOURCE_TILE_SIZE = 32;
// "Main Office" ZEP-inspired layout (see defaultRoomLayout.ts): two meeting
// rooms, an open main desk zone with 4 team clusters, a dev team room, an
// external meeting room, a 5-pod focus zone, a lounge, and an entrance/
// reception strip spanning the bottom.
export const MAP_WIDTH = 50;
export const MAP_HEIGHT = 36;
export const PLAYER_SPEED = 175; // pixels per second — was 150, nudged up per feedback
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
// Bug: this used to be a hardcoded `96` ("3 tiles × 32px") — a leftover from
// before the grid was rescaled from 32px to 48px tiles (see TILE_SIZE
// above). The actual connect distance (useProximity.ts's calcDistanceTiles,
// which divides by TILE_SIZE) was already correct at 3×48=144px; only this
// VISUAL ring (GameCanvas.tsx's "Proximity ring") was still drawn at the
// stale 96px radius — 33% smaller than where players actually connect, so
// someone could look clearly outside the ring and still be in a call.
// Derived from PROXIMITY_THRESHOLD so the two can never drift apart again.
export const PROXIMITY_THRESHOLD_PX = PROXIMITY_THRESHOLD * TILE_SIZE;
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

// Tells everyone in the room which MediaStream id is a screen share, so a
// receiver can classify an incoming video track as fact instead of guessing.
//
// The guess it replaces was arrival order — first video track = camera,
// second = screen. That held only because the camera used to be acquired at
// join and merely disabled when "off", so it always arrived first. Once the
// camera started being genuinely released while off, anyone sharing a screen
// with their camera off sent the SCREEN as their first video track, and it was
// filed as a camera: shown with a volume slider and never appearing as a
// shared screen at all, with no error anywhere.
//
// Broadcast to the room rather than sent per-peer: someone who walks into
// range mid-presentation has to learn about it too, and they have no earlier
// message to have missed.
export interface RtcScreenSharePayload {
  // Socket id of the presenter.
  fromId: string;
  // MediaStream.id of the screen capture. Null when the share stops.
  streamId: string | null;
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
  // Set automatically by the client when placing a built-in chair palette
  // entry (tilePaletteManifest.ts's `sittable`) — but ALSO now a manual
  // Room Editor toggle in ObjectSettingsPanel ("Sittable"), so any placed
  // piece can become sittable, custom-uploaded objects included (which have
  // no palette-level `sittable` of their own to inherit from).
  isInteractable?: boolean;
  // Which way the avatar faces once seated on THIS piece, combined with its
  // current rotation/flipH (see GameCanvas.tsx's computeSitFacingDirection)
  // — 'front' faces the direction the object's art faces at its current
  // rotation, 'back' is the opposite, 'side' is perpendicular (flipH picks
  // which of the two perpendicular sides). Only meaningful when
  // isInteractable is true; absent/undefined on every isInteractable piece
  // placed before this existed (all built-in chairs) preserves their
  // original behavior EXACTLY — direction still derives from the player's
  // own approach direction, not the object's orientation, since there's no
  // stored sitFacing to compute from. Only pieces where an admin explicitly
  // sets this (via the new toggle, which defaults it to 'front') opt into
  // orientation-aware seating.
  sitFacing?: 'front' | 'side' | 'back';
  // Groups chairs into a "table": chairs sharing a tableId form one private
  // audio/video group whenever 2+ of their occupants are seated, exactly like
  // a private zone (see useProximity's table branch). Set by admins in the
  // Room Editor. Capacity is simply how many chairs carry this id — there is
  // no separate maxSeats field to fall out of sync. Only meaningful on
  // isInteractable chairs.
  tableId?: string;
  // Permanent seat assignment (ZEP-style "this is my desk"), distinct from
  // Avatar.isSitting which is just transient occupancy. Only set on
  // isInteractable pieces — see FURNITURE_ASSIGN/FURNITURE_UNASSIGN.
  // assignedToName is cached here (not looked up live) so an assigned
  // desk still shows whose it is even while that person is offline.
  assignedToUserId?: string;
  assignedToName?: string;
  // ZEP editor (Potong 3) — true for pieces placed on the "Top objects" layer,
  // which render ABOVE the avatar (roof edges, tree crowns, hanging lamps). Set
  // by the layerDataToLegacy adaptor from LayerData.topObjects; absent for
  // ordinary below-avatar objects. See GameCanvas's furniture passes.
  topLayer?: boolean;

  // Fitur 15B — ZEP-style placement controls ("Rotate & Flip" / "Size(%)" /
  // "Reposition(px)"), generic to ANY placed piece (not just Interactive
  // Objects — a decorative object can be rotated/resized too). Absent means
  // "as authored" (0°, no flip, 100%, no offset) — every piece placed before
  // this existed renders byte-for-byte unchanged.
  rotation?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  flipV?: boolean;
  sizePercent?: { w: number; h: number };
  offsetPx?: { x: number; y: number };
  // ZEP's "Name" / "Hide object name" — an admin-chosen label, distinct from
  // any interactiveConfig text. Read by InteractiveObjectModal's title, and
  // by 'show_name' below (interactiveType === 'show_name' reveals THIS same
  // field as a floating label above the piece — no config field of its own,
  // it's just a trigger on an already-existing piece of data). hideObjectName
  // is a hard override: if set, 'show_name' is a no-op regardless of trigger.
  name?: string;
  hideObjectName?: boolean;

  // Fitur 15B — ZEP-style "Interactive Object". Absent = ordinary furniture,
  // same as before this existed. Only 'text_popup' is implemented so far;
  // more of ZEP's Pop-up Settings / Website Functions / Developer Functions
  // types land incrementally, one at a time, per the feature's own spec.
  interactiveType?: InteractiveObjectType;
  // Chebyshev tile distance (see useProximity.calcDistanceTiles) that counts
  // as "in range" of this object. Default 1 tile when unset.
  triggerRange?: number;
  triggerMethod?: TriggerMethod;
  interactiveConfig?: InteractiveObjectConfig;
}

export type InteractiveObjectType = 'text_popup' | 'image_popup' | 'website' | 'website_tab' | 'password' | 'multiple_choice' | 'api_call' | 'show_name' | 'show_word_balloon' | 'change_object' | 'animation';
export type TriggerMethod = 'press_f' | 'automatic';

export interface MultipleChoiceOption {
  text: string;
  // Fitur 15B — never sent to a normal player's client (see
  // redactInteractiveSecrets, which zeroes every option's isCorrect before
  // ROOM_STATE/ROOM_UPDATED) — only the admin-gated Room Editor sees the real
  // flags. INTERACTIVE_CHOICE_CHECK is the only way a client learns whether
  // its pick was right.
  isCorrect: boolean;
}

// Per-type config bag — only the field(s) relevant to `interactiveType` are
// ever set. A flat optional bag (not a discriminated union) so adding the
// next type is one new optional field, not a type migration.
export interface InteractiveObjectConfig {
  // text_popup
  text?: string;
  // image_popup — an /api/uploads or /api/files URL (same upload service as
  // everything else; validated server-side the same way media payloads are,
  // see mediaHandler.isUploadUrl).
  imageUrl?: string;
  // website ("Open website in a new window") / website_tab ("Open website
  // in a new tab") share this same `url` field — url must be https:// (same
  // rule the existing website MEDIA type already enforces server-side).
  // fullscreen/width/height are only meaningful for 'website': fullscreen=
  // true opens a plain new tab (no size constraint, closest a browser gets
  // to ZEP's "fullscreen" without a real Fullscreen API call a popup can't
  // make on someone else's page); fullscreen=false uses width/height as the
  // popup window's size. 'website_tab' ignores all three — it's always a
  // plain window.open(url, '_blank') new tab, ZEP's own documented fallback
  // "when the website does not open properly" in a sized popup.
  url?: string;
  fullscreen?: boolean;
  width?: number;
  height?: number;
  // password — `password` itself must NEVER reach a normal player's client.
  // roomHandler.ts's ROOM_STATE emit and rooms.ts's ROOM_UPDATED broadcast
  // both strip it (see redactInteractiveSecrets); only the Room Editor's own
  // admin-gated GET /editor-data returns the real value, for the admin to
  // read/edit it. Verification is the INTERACTIVE_PASSWORD_CHECK round trip
  // below — the client never compares the attempt itself.
  passwordDescription?: string;
  password?: string;
  correctText?: string; // shown via a text_popup after a correct password/answer
  failureMessage?: string;
  // multiple_choice — options' isCorrect redacted the same way password is
  // (see MultipleChoiceOption's own doc comment). incorrectMessage is its own
  // field (not `failureMessage`) to keep each type's field names traceable
  // straight back to ZEP's own label for it.
  question?: string;
  options?: MultipleChoiceOption[];
  incorrectMessage?: string;
  // api_call — apiUrl is NEVER fetched from the browser (SSRF risk + CORS):
  // the client only ever sends {furnitureId} over INTERACTIVE_API_CALL; the
  // server looks up the room's own stored apiUrl and performs the POST
  // itself. Must be https:// (same rule as website's url).
  apiUrl?: string;
  // show_word_balloon — 'random' picks a color once per trigger (see
  // gameStore.momentaryReveals' `variant`), so it doesn't flicker every
  // frame while the balloon is shown; 'default' is always the same plain
  // white bubble the player-chat speech bubbles already use.
  wordBalloonType?: 'default' | 'random';
  wordBalloonText?: string;
  // change_object — unlike every other type, this MUTATES the room's actual
  // saved map (removes the piece), for every player, not just the trigger-er.
  // Only 'disappear' exists so far (ZEP's own confirmed example); a future
  // "replace with another object" option is a natural follow-up but needs a
  // palette picker this pass doesn't have reference detail for.
  afterAction?: 'disappear';
  // animation — a horizontal sprite-sheet strip (spriteFrameCount frames,
  // each spriteFrameWidth x spriteFrameHeight px, laid left-to-right).
  // Simplified from ZEP's own "moving objects through sprite files": this
  // pass plays the animation as a floating overlay above the piece for a
  // fixed window on trigger (same momentaryReveals mechanism as show_name/
  // show_word_balloon), rather than permanently replacing the piece's own
  // base sprite — swapping the actual base render mid-animation would need
  // touching GameCanvas's two-pass (object/overhead) furniture draw order,
  // out of scope for this first cut. spriteFile must be an upload URL (same
  // rule as image_popup's imageUrl).
  spriteFile?: string;
  spriteFrameWidth?: number;
  spriteFrameHeight?: number;
  spriteFrameCount?: number;
}

export interface InteractivePasswordCheckPayload {
  furnitureId: string;
  attempt: string;
}
export interface InteractivePasswordResultPayload {
  furnitureId: string;
  correct: boolean;
  // Only one of these is meaningful, matching `correct`.
  correctText?: string;
  failureMessage?: string;
}

export interface InteractiveDoorPasswordCheckPayload {
  x: number;
  y: number;
  attempt: string;
}
export interface InteractiveDoorPasswordResultPayload {
  x: number;
  y: number;
  correct: boolean;
  failureMessage?: string;
}

export interface InteractiveChoiceCheckPayload {
  furnitureId: string;
  selectedIndex: number;
}
export interface InteractiveChoiceResultPayload {
  furnitureId: string;
  correct: boolean;
  // Only one of these is meaningful, matching `correct`.
  correctText?: string;
  incorrectMessage?: string;
}

export interface InteractiveApiCallPayload {
  furnitureId: string;
}
export interface InteractiveChangeObjectPayload {
  furnitureId: string;
}
export interface InteractiveApiCallResultPayload {
  furnitureId: string;
  success: boolean;
  error?: string;
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

// Live claim state of one claimable-seat marker (see mapLayers.ts's
// TileEffect 'claimableSeat'), broadcast to the whole room on every change
// so every client sees the owner's name in real time. In-memory only on the
// server (server/src/socket/seatClaim.ts) — never persisted, never
// survives a restart, same posture as ZoneLockState above.
export interface SeatClaimState {
  seatId: string;
  userId: string;
  name: string;
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
  // Does standing in a different zone (or in this zone vs. outside it) cut
  // off audio, the way a real meeting room's walls would? undefined/true =
  // yes (every zone behaved this way before this field existed, so absent
  // means "isolates" for backward compatibility). false = this zone is
  // purely a name label — useProximity treats it as if it weren't a zone at
  // all, falling back to plain distance-based hearing. See the Room
  // Editor's 'Map location' tool, whose whole purpose is a named pin with
  // no audio effect (unlike 'Private area', which IS meant to isolate).
  audioIsolated?: boolean;
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
  // Potongan C3 — zone-private chat has no attachment field until now.
  // Unlike ChannelMessage's attachmentUrl/attachmentName (persisted, part of
  // the ChatMessage Prisma model), this zone chat is NEVER persisted at all
  // (see server/src/socket/chatHandler.ts) — purely a live relay to whoever
  // is currently in the zone. The FILE itself still lands permanently in
  // Lark Drive same as any other chat attachment; only the message pointing
  // to it disappears once the zone empties out / a client reloads.
  attachmentUrl?: string;
  attachmentName?: string;
  // Music Bot's own replies (see musicHandler.ts) — senderId is the fixed
  // sentinel MUSIC_BOT_SENDER_ID below, senderName is MUSIC_BOT_NAME; this
  // flag is what actually drives the distinct bubble styling client-side
  // (senderId/senderName alone are spoofable-looking but never actually
  // reach the client from anywhere except this one server-side sender).
  isBot?: boolean;
  // Optional small thumbnail shown under a bot reply (e.g. "Now playing" /
  // "Added to queue") — never present on a real user's message.
  botThumbnailUrl?: string;
}

// Music Bot — a chat-command-driven (!play/!skip/...) YouTube "listen
// together" queue, one independent MusicSession per zone (see
// musicHandler.ts). Deliberately NOT the same mechanism as the existing
// 'bgm' MapMediaObject (an ambient looped area effect placed by an admin in
// the Room Editor) — that one still exists unchanged as a manual-upload
// fallback; this is the interactive, chat-driven, YouTube-backed one.
export interface MusicTrack {
  videoId: string;
  title: string;
  thumbnail: string;
  requestedBy: string; // display name, not a userId — purely for the chat reply/queue list
}

export interface MusicSessionState {
  zoneId: string;
  // null = nothing playing (idle, or queue just ran dry).
  current: {
    track: MusicTrack;
    // Epoch ms this track effectively "started" — elapsed playback is
    // `Date.now() - startedAt`. On resume, startedAt is shifted FORWARD by
    // however long the pause lasted, so elapsed playback (and therefore the
    // auto-advance timer) stays correct instead of resetting to 0.
    startedAt: number;
    // Epoch ms the pause began, or null while actively playing.
    pausedAt: number | null;
    durationSec: number;
  } | null;
  queue: MusicTrack[];
}

export const MUSIC_BOT_SENDER_ID = 'music-bot';
export const MUSIC_BOT_NAME = '🎵 Music Bot';
export const MUSIC_PLAY_COOLDOWN_MS = 10_000;

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
  // Bug 6 — optimistic send. clientId round-trips from the sender's own send
  // through the server and back unchanged (see ChatMessage.clientId
  // server-side), so the client can match its own already-on-screen
  // optimistic bubble to the confirmed broadcast and swap it in place instead
  // of appending a duplicate. status is CLIENT-ONLY — the server never sends
  // it — it's the local echo shown the instant Send is clicked, before any
  // network round trip completes: 'pending' while in flight, 'failed' if it
  // never confirmed (upload error, or no broadcast within the timeout),
  // absent once the real server-confirmed message has replaced it.
  clientId?: string;
  status?: 'pending' | 'failed';
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

// Soundboard — Discord-style short-clip player (panel: client/src/components/
// ui/SoundboardPanel.tsx). Two kinds of playable sound share one namespace:
//  • "default" — a small fixed set shipped with the app, id/name/file only
//    (no DB row; every room offers the same set for free).
//  • "custom" — per-room uploads (Prisma SoundboardSound), fetched over REST
//    on join and kept live via SOUNDBOARD_SOUND_ADDED.
// SoundboardSoundData is the shape BOTH normalize to client-side so the panel
// renders one flat grid without caring which kind a given button is.
export interface SoundboardSoundData {
  id: string;
  name: string;
  url: string;
  durationMs: number;
  // Absent for default sounds (nobody "uploaded" them).
  createdByName?: string;
}

// Meme clips picked by the room admin (from myinstants.com), downloaded and
// committed under client/public/assets/sounds/ — actual files, not
// placeholders. durationMs is each file's real measured length (ffprobe),
// used to size the "now playing" indicator (see useSocket.ts).
export const SOUNDBOARD_DEFAULT_SOUNDS: SoundboardSoundData[] = [
  { id: 'default-cat-laugh', name: 'Cat Laugh', url: '/assets/sounds/cat-laugh-meme-1.mp3', durationMs: 3631 },
  { id: 'default-fahhh-pump', name: 'Fahhh', url: '/assets/sounds/fahhh-pump-sound.mp3', durationMs: 2124 },
  { id: 'default-kerja-kerja-kerja', name: 'Kerja Kerja Kerja', url: '/assets/sounds/kerja-kerja-kerja.mp3', durationMs: 14832 },
  { id: 'default-fart', name: 'Fart', url: '/assets/sounds/perfect-fart.mp3', durationMs: 336 },
  { id: 'default-kak-gem-paham', name: 'Kak, Gem, Paham?', url: '/assets/sounds/kak-gem-paham.mp3', durationMs: 975 },
  { id: 'default-aa-kasian-aa', name: 'Aa Kasian Aa', url: '/assets/sounds/aa-kasian-aa.mp3', durationMs: 8385 },
  { id: 'default-boxing-bell', name: 'Boxing Bell', url: '/assets/sounds/boxing-bell.mp3', durationMs: 8249 },
  { id: 'default-ronaldo-siuu', name: 'Siuuu', url: '/assets/sounds/ronaldo-siuuuu.mp3', durationMs: 6618 },
];

// Custom-upload limits (routes/soundboard.ts enforces both server-side —
// these are shared purely so the client can reject obviously-too-long/big
// files before even attempting the upload, for instant feedback).
export const SOUNDBOARD_MAX_DURATION_MS = 5000;
export const SOUNDBOARD_MAX_FILE_BYTES = 300 * 1024; // a few hundred KB
// Per-SENDER cooldown (not per-sound) — same shape as Bug 14's
// handSoundCooldown, just a shorter window since this is meant to be played
// with more freely than a raise-hand chime.
export const SOUNDBOARD_COOLDOWN_MS = 3000;

export interface SoundboardPlayPayload {
  soundId: string;
}
export interface SoundboardPlayedPayload {
  fromId: string;
  soundId: string;
}

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
  // Item #9 (precise-collision follow-up) — absent on the legacy socket
  // ROOM_UPDATE save path (roomHandler.ts), which never touches Impassable
  // Areas at all; present on every save that goes through
  // layerDataToLegacy. useSocket.ts's handler only applies it when present,
  // so the legacy path can never wipe a client's already-known rects.
  impassableAreaRects?: ImpassableAreaRect[];
}

export { createDefaultOfficeLayout, createKaitechOfficeLayout, findSpawnPixel, createRoomLayoutFromTemplate, ROOM_TEMPLATES } from '../defaultRoomLayout';
export type { RoomTemplateId } from '../defaultRoomLayout';
export { BLOCKED_TILES, isTileBlocked, isDoorTile, findZoneEntryTile, findAdjacentFreeTile, isPointInImpassableArea, doesRectOverlapImpassableArea } from '../tileCollision';
// ZEP Room Editor — Potong 1 layered map format + legacy adaptors.
export { MAP_FORMAT_VERSION, legacyToLayerData, layerDataToLegacy, AVATAR_SCALE_MIN, AVATAR_SCALE_MAX, getImpassableAreaRects } from '../mapLayers';
export type { LayerData, TileEffect, AreaEffect, CustomAssetEntry, ReferenceImageData, ImpassableAreaRect } from '../mapLayers';
export type { Role, FeatureKey } from '../permissions';
export { roleAtLeast, hasFeatureAccess, FEATURE_MIN_ROLE } from '../permissions';
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
