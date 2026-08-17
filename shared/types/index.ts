import type { Role } from '../permissions';
import type { RoomTemplateId } from '../defaultRoomLayout';
import type { ReferenceImageData, ImpassableAreaRect, DoorAreaRect } from '../mapLayers';

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
  // Whether this player's mic is currently muted — broadcast on every toggle
  // (see MicButton/handleMicToggle) and kept on the player record like
  // handRaised/workMode, so ParticipantPanel and VideoTile can show a muted
  // badge for someone even outside WebRTC proximity range, not just peers
  // you're actually connected to. Undefined (not explicitly muted=false)
  // until the first toggle, same convention as handRaised.
  micMuted?: boolean;
  // Manual "hide myself" toggle — broadcast + persisted like micMuted/
  // handRaised above. A hidden player's avatar is skipped entirely by
  // OTHER clients' render loop (see GameCanvas.tsx), UNLESS the viewer is
  // admin+ (shared/permissions.ts's roleAtLeast) — admins/war-room can
  // always see everyone regardless of this flag. Purely a client-side
  // rendering suppression: position updates, proximity, and WebRTC are
  // all untouched, so this is "don't show my avatar to regular members",
  // not a full stealth/incognito mode.
  hidden?: boolean;
  // Guest Link & Ruang Tunggu — true for a socket admitted via a room
  // invite link rather than a real account (see roomHandler.ts's JOIN_ROOM
  // guest branch). Drives the "Guest" badge in ParticipantPanel and hides
  // the DM/Message button for them (a guest has no real userId to DM).
  isGuest?: boolean;
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
// QA #1 (Status) — 'wfo'/'wfa'/'cuti' added so the login-time status picker
// (App.tsx's StatusPickModal) can offer the full WFO/WFH/WFA/Cuti/Meeting
// set the checklist asks for. 'cuti' is display-only here — it does NOT
// create or check a real leave approval (see routes/attendanceAdmin.ts);
// this is purely the same-shape badge every other WorkMode value already is.
export type WorkMode = 'available' | 'in_meeting' | 'focus' | 'lunch' | 'away' | 'wfh' | 'wfo' | 'wfa' | 'cuti' | 'break';

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
  // Follow-up — undefined/'automatic' fires the password prompt the moment
  // a player gets adjacent (original, unchanged behavior); 'press_f'
  // requires an explicit F press instead, same mechanism Interactive
  // Objects already use (see Furniture.triggerMethod).
  doorTriggerMethod?: 'automatic' | 'press_f';
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

// QA #9/#10 — a one-shot admin/CEO announcement (BROADCAST_SEND/RECEIVED),
// distinct from Notice above: Notice is a single PERSISTENT pinned slot
// (replaces itself, resent on join so late arrivals see it); a broadcast is
// a repeatable, ephemeral push — every send is its own event, nothing is
// stored in RoomState, so a client that joins after one was sent simply
// never sees it (same posture as a toast/PA announcement in real life).
export interface RoomBroadcast {
  text: string;
  senderName: string;
  sentAt: number;
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
  // "Ngobrol dengan CEO" restricted-area bypass (see roomHandler.ts's
  // RoomAdminState.ceoUserIds doc comment) — independent of admin/staff,
  // NOT part of the Role hierarchy.
  ceoUserIds?: string[];
  furniture?: Furniture[];
  zones?: Zone[];
  // Item #9 (precise-collision follow-up) — pixel-space Impassable Area
  // rectangles, for the client's own local movement prediction (the server
  // independently re-checks these authoritatively — see
  // movementHandler.ts). Absent/undefined on a room saved before this
  // field existed; treated as [] everywhere it's read.
  impassableAreaRects?: ImpassableAreaRect[];
  // Room Editor's "Wall Area" tool — a subset of the rects above (already
  // merged into impassableAreaRects for collision) also broken out here on
  // their own, since this is the one flavor GameCanvas.tsx actually draws —
  // an Impassable Area proper stays invisible on purpose.
  wallAreaRects?: ImpassableAreaRect[];
  // Follow-up — "Door Area" tool (resizable-area successor to the per-tile
  // 'door' TileEffect). Same client-prediction posture as
  // impassableAreaRects above (server re-checks authoritatively — see
  // movementHandler.ts); doorPassword itself is stripped before this ever
  // reaches a normal player (redactDoorAreaPasswords), same guarantee the
  // per-tile version already has.
  doorAreaRects?: DoorAreaRect[];
  theme?: RoomTheme;
  // Which layout this room was created with (see defaultRoomLayout.ts's
  // ROOM_TEMPLATES) — undefined for rooms created before this field
  // existed. Threaded through the same way `theme` already is so
  // RoomEditor.tsx's "Reset to Default" can rebuild the room's OWN
  // template instead of always falling back to Main Office.
  template?: RoomTemplateId;
  notice?: Notice | null;
  // Emergency door override (see SocketEvents.DOOR_OVERRIDE_SET) — true means
  // every password door in the room is currently open for everyone.
  // In-memory server state, resent fresh every time a client joins.
  doorOverride?: boolean;
  // The RECEIVING socket's own resolved role in this room (see
  // shared/permissions.ts) — computed server-side per-socket, not
  // broadcast, so a client always gets its own current tier without
  // re-deriving it from adminUserIds/masterAdminUserId/staffUserIds itself.
  role?: Role;
  // The RECEIVING socket's own CEO-bypass membership — same "resolved
  // server-side, not re-derived from ceoUserIds" posture as `role` above.
  isCeo?: boolean;
  // "Ngobrol dengan CEO" queue, zone-level — any currently-'active' session
  // in this room at the moment of joining, so a late joiner (or a page
  // refresh) still sees the floating countdown above whoever's in there,
  // not just clients that were already connected for the live
  // ZONE_QUEUE_SESSION_ACTIVE broadcast.
  activeZoneSessions?: ZoneQueueSessionActivePayload[];
  // Floor-plan reference image, forwarded ONLY when the admin opted into
  // ReferenceImageData.showInGame (see roomHandler.ts's ROOM_STATE emit and
  // mapLayers.ts) — null whenever the room has none, or has one that's
  // editor-only. When present, GameCanvas.tsx renders it for every player.
  referenceImage?: ReferenceImageData | null;
  // Room-wide avatar sprite scale (see LayerData.avatarScale) — undefined
  // means 1 (unchanged size). Always forwarded, no opt-in gate.
  avatarScale?: number;
  // QA #7/#8/#9 — every DeskNote currently stuck on a furniture piece in
  // this room, so a fresh join sees them immediately without a separate
  // fetch. Absent/[] on a room with none.
  notes?: DeskNoteData[];
}

// QA #7/#8/#9 — a sticky note placed on the map, same "place at my current
// tile" convention as Add Media (see AddMediaPanel.tsx) rather than
// attached to a specific furniture piece. x/y are TILE coordinates, same
// units as MapMediaObject's own x/y.
export interface DeskNoteData {
  id: string;
  x: number;
  y: number;
  authorUserId: string;
  authorName: string;
  text: string;
  updatedAt: number;
}

// QA (Presence checklist item #8, "Member list akurat") — one entry per currently-ONLINE user, workspace-wide (not
// room-scoped — see roomHandler.ts's userRoomMap and SocketEvents.ROSTER_*
// above). Absent from the snapshot/never delta'd in means offline; the
// client cross-references this against the full user roster (GET
// /api/workspace/people) to know who's offline too.
export interface RosterEntry {
  userId: string;
  roomSlug: string;
  roomName: string;
  // Bug follow-up (member list "room kamu" never changing) — which zone
  // WITHIN roomName this user is currently standing in (e.g. "Meeting
  // Room", "CEO Office"), if any. Undefined/absent means "not in any named
  // zone right now" — the room-level label is still accurate on its own,
  // this only adds the finer-grained location on top of it.
  zoneName?: string;
}

// The live delta broadcast (ROSTER_UPDATED) — `online: false` entries omit
// roomSlug/roomName (there's nothing to report), `online: true` always
// carries them.
export type RosterUpdate =
  | { userId: string; online: true; roomSlug: string; roomName: string; zoneName?: string }
  | { userId: string; online: false };

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

  // Mic mute toggle — same relay+persist shape as hand above, so
  // ParticipantPanel/VideoTile can show a muted badge for a peer regardless
  // of WebRTC proximity range.
  PLAYER_MIC = 'player:mic',
  PLAYER_MIC_UPDATED = 'player:mic_updated',

  // Manual "hide myself" toggle — same relay+persist shape as hand/mic
  // above. See Avatar.hidden's doc comment for what this actually does.
  PLAYER_HIDDEN = 'player:hidden',
  PLAYER_HIDDEN_UPDATED = 'player:hidden_updated',

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

  // QA #9/#10 — CEO/admin-only text broadcast ("pengumuman teks ke semua").
  // Text counterpart to Spotlight above (that's the voice/PA version — see
  // its own comment); same admin-only posture ('broadcast:text' in
  // shared/permissions.ts, re-checked server-side) and same io.to(room)
  // delivery (everyone, including any admin who sent it, sees the banner —
  // simpler than special-casing the sender's own client). Also relayed to
  BROADCAST_SEND = 'broadcast:send',
  BROADCAST_RECEIVED = 'broadcast:received',

  // Akses & Password Pintu audit item #9 — emergency override: an admin
  // toggles EVERY password door in the room open at once, bypassing
  // doorLock.ts's normal per-socket unlock entirely (see movementHandler.ts's
  // isBlockedForSocket). Everyone in the room, including the toggler, gets
  // the new state so a banner + the admin's own toggle control stay in sync,
  // and it's resent fresh in ROOM_STATE on join.
  DOOR_OVERRIDE_SET = 'door:override_set',
  DOOR_OVERRIDE_UPDATED = 'door:override_updated',

  // Guest Link & Ruang Tunggu — a guest socket's JOIN_ROOM (see roomHandler.ts)
  // either lands them in this waiting room (GUEST_JOIN_WAITING, fans
  // GUEST_JOIN_REQUESTED out to every admin currently connected to the room)
  // or — if already on the room's in-memory guestAllowlist from a prior
  // GUEST_JOIN_DECIDE admit — proceeds straight through like a normal member
  // join. GUEST_JOIN_ADMITTED pings the waiting guest's own socket to retry
  // JOIN_ROOM, GUEST_JOIN_REJECTED ends it with a reason, GUEST_JOIN_CANCELLED
  // tells notified admins the guest left/disconnected before a decision was made.
  GUEST_JOIN_WAITING = 'guest:join_waiting',
  GUEST_JOIN_REQUESTED = 'guest:join_requested',
  GUEST_JOIN_DECIDE = 'guest:join_decide',
  GUEST_JOIN_ADMITTED = 'guest:join_admitted',
  GUEST_JOIN_REJECTED = 'guest:join_rejected',
  GUEST_JOIN_CANCELLED = 'guest:join_cancelled',

  // QA items #9/#10 (multi-tab) — sent to a socket right before it's force-
  // disconnected because a NEWER tab/connection joined with the same
  // account (or guest token). Distinct from SESSION_SUPERSEDED (a raw
  // string, not in this enum — that one fires when a totally NEW LOGIN
  // elsewhere rotated the account's session and invalidated this token
  // everywhere). This one doesn't touch the token/session at all — the
  // token is still valid, this specific TAB's connection just lost to a
  // newer one, so the client must NOT clear vm_token (shared localStorage
  // would also log the winning tab out) — just show a notice and stop.
  SESSION_TAKEN_OVER = 'session:taken_over',

  PLAYER_SIT = 'player:sit',
  PLAYER_SAT = 'player:sat',

  // Permanent seat assignment — see Furniture.assignedToUserId/assignedToName
  FURNITURE_ASSIGN = 'furniture:assign',
  FURNITURE_ASSIGNED = 'furniture:assigned',
  FURNITURE_UNASSIGN = 'furniture:unassign',
  FURNITURE_UNASSIGNED = 'furniture:unassigned',

  // QA #7/#8/#9 — a sticky note placed on the map (see DeskNoteData below),
  // same "Add Media, lands at your current tile" flow as image/whiteboard/
  // file rather than tied to a furniture piece. NOTE_ADD creates a new one
  // (any real user); NOTE_EDIT/NOTE_DELETE are author-only ("Pembuat
  // edit/hapus; lain baca saja"), re-checked server-side. Delivered via
  // ROOM_STATE.notes on join, kept live via NOTE_ADDED/NOTE_UPDATED/
  // NOTE_DELETED.
  NOTE_ADD = 'note:add',
  NOTE_ADDED = 'note:added',
  NOTE_EDIT = 'note:edit',
  NOTE_UPDATED = 'note:updated',
  NOTE_DELETE = 'note:delete',
  NOTE_DELETED = 'note:deleted',

  RTC_OFFER = 'rtc:offer',
  RTC_ANSWER = 'rtc:answer',
  RTC_ICE_CANDIDATE = 'rtc:ice-candidate',
  // Announces which MediaStream carries a screen share, so receivers can tell
  // a screen from a camera by fact rather than inference — see
  // RtcScreenSharePayload.
  RTC_SCREEN_SHARE = 'rtc:screen-share',

  // QA (Load checklist item 3, "War Room share massal") — a room-scoped
  // cap on SIMULTANEOUS screen shares (see rtcHandler.ts's activeScreeners
  // map), previously nonexistent — starting a share was pure client-side
  // getDisplayMedia + broadcast, unbounded. The client asks BEFORE opening
  // the OS screen picker (no point prompting for permission just to deny
  // it after); the server answers directly to the asking socket only,
  // never broadcast. RTC_SCREEN_SHARE (above) is unchanged — it's still
  // how a GRANTED share is announced/retracted to the rest of the room.
  RTC_SCREEN_SHARE_REQUEST = 'rtc:screen_share_request',
  RTC_SCREEN_SHARE_GRANTED = 'rtc:screen_share_granted',
  RTC_SCREEN_SHARE_DENIED = 'rtc:screen_share_denied',
  // QA (Stabilitas checklist item 12) — fire-and-forget, one per peer
  // connection that ended up relaying through TURN (see webrtcService's
  // reportSelectedPath). No payload, no response — purely a counter tick
  // for /api/health visibility (see rtcHandler.ts).
  TURN_RELAY_USED = 'rtc:turn_relay_used',

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
  // Mirrors SOUNDBOARD_SOUND_ADDED — plain whole-room broadcast (io.to, not
  // socket.to, so the deleter's own other tabs/clients also sync) so every
  // open panel drops the removed sound live, same as an upload appearing.
  SOUNDBOARD_SOUND_REMOVED = 'soundboard:sound_removed',
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

  // QA #8 — Zone.memberOnly zones (e.g. "ODOO TEAM"/"AI TEAM") auto-gate a
  // GUEST specifically, no manual lock needed — ZONE_LOCKED_DENIED's
  // `reason` gets a new 'member_only' value for this case. Structurally
  // mirrors the ZONE_KNOCK/DECIDE pair above, but a member-only zone has no
  // keyholder to notify/decide, so every connected admin is notified
  // (getConnectedAdminSocketIds, same fan-out roomHandler.ts's Guest Link
  // waiting-room already uses) and any of them may decide — not "whoever
  // locked it", since nobody did. ZONE_APPROVAL_CANCEL/CANCELLED mirror
  // ZONE_KNOCK_CANCEL/CANCELLED's same three trigger cases (requester
  // backs out, disconnects, or the zone stops being member-only under them).
  ZONE_APPROVAL_REQUEST = 'zone:approval_request',
  ZONE_APPROVAL_REQUESTED = 'zone:approval_requested',
  ZONE_APPROVAL_DECIDE = 'zone:approval_decide',
  ZONE_APPROVAL_DECIDED = 'zone:approval_decided',
  ZONE_APPROVAL_CANCEL = 'zone:approval_cancel',
  ZONE_APPROVAL_CANCELLED = 'zone:approval_cancelled',

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

  // "Ngobrol dengan CEO" restricted-area bypass (see roomHandler.ts's
  // RoomAdminState.ceoUserIds doc comment) — independent of admin/staff,
  // same ADMIN_CHANGED broadcast shape (payload also carries ceoUserIds).
  CEO_GRANT = 'ceo:grant',
  CEO_REVOKE = 'ceo:revoke',

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

  // Minta Bantuan Remote (specs/2026-08-17-remote-help-via-rustdesk-design.md)
  // — KaiSpace only brokers the consent handshake and a one-time credential
  // relay for an out-of-app RustDesk remote-help session; it never performs
  // any remote control itself. Same consent shape as Follow/Summon: REQUEST
  // asks the server to start a request, relayed to the target as INCOMING,
  // the target's accept/decline comes back as RESPOND, and the requester
  // (the helper) learns the outcome via RESULT. Once accepted, the target
  // submits their own RustDesk ID+password once via CREDENTIAL — relayed
  // straight to the helper's socket only, never stored anywhere. Either
  // side ends the (KaiSpace-tracked) session at any time via END — this
  // ends KaiSpace's own bookkeeping/notification only, never the actual
  // RustDesk connection, which only RustDesk's own client can end.
  REMOTE_HELP_REQUEST = 'remotehelp:request',
  REMOTE_HELP_INCOMING = 'remotehelp:incoming',
  REMOTE_HELP_RESPOND = 'remotehelp:respond',
  REMOTE_HELP_RESULT = 'remotehelp:result',
  REMOTE_HELP_CREDENTIAL = 'remotehelp:credential',
  REMOTE_HELP_END = 'remotehelp:end',

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

  // "Tarik Paksa" (Force-pull) — admin+ only ('force_pull', shared/
  // permissions.ts), deliberately NO consent step (that's what makes it
  // "force" instead of a second Summon): FORCE_PULL moves the target
  // straight away if they're online (same "land beside, not on top of"
  // mechanic + locked-zone bypass as Summon's accept path), or queues their
  // landing spot for their next join + leaves a notification if they're offline
  // right now. FORCE_PULL_RESULT tells the ADMIN's own client what
  // happened (delivered now vs queued); FORCE_PULLED tells the TARGET's
  // client it happened to them (right away if online, or on the join that
  // consumes the queued position if they were offline) so they can show a
  // "X menarik Anda ke sini" toast instead of silently finding themselves
  // moved.
  FORCE_PULL = 'force_pull:pull',
  FORCE_PULL_RESULT = 'force_pull:result',
  FORCE_PULLED = 'force_pull:pulled',

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
  // Item #6 (Akses & Password Pintu audit) follow-up — a correct door
  // password only ever told the SOLVER their own door opened; everyone else
  // in the room had no idea it happened. This is a one-way notice broadcast
  // to the rest of the room (never to the solver, who already has their own
  // INTERACTIVE_DOOR_PASSWORD_RESULT) so a toast can show "X membuka pintu".
  // No open/close visual state exists yet (see the door-open-animation item,
  // still deferred), so this is a notification only — not a synced door
  // sprite/state.
  DOOR_UNLOCKED_NOTICE = 'door:unlocked_notice',
  // Follow-up — "Door Area" tool. Same shape/verification posture as the
  // tile-based pair above, keyed by area id instead of (x,y) since a door
  // area is an AreaEffect, not a TileEffect. A correct attempt unlocks that
  // area id for the rest of this socket's session (see doorLock.ts's
  // isDoorAreaUnlocked) — reflected as "the whole rectangle stops blocking",
  // not a further event.
  INTERACTIVE_DOOR_AREA_PASSWORD_CHECK = 'interactive:door_area_password_check',
  INTERACTIVE_DOOR_AREA_PASSWORD_RESULT = 'interactive:door_area_password_result',
  // Area-id counterpart to DOOR_UNLOCKED_NOTICE above.
  DOOR_AREA_UNLOCKED_NOTICE = 'door:area_unlocked_notice',
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
  // QA (Data A/V checklist item 7, "Rekaman & consent") — RECORDING_STARTED
  // above deliberately stays role-filtered (see its own comment) since a
  // plain member never needs the recordingId/title/who's-recording-who
  // detail. But before this, a plain member got NO signal AT ALL that
  // recording was happening — even though whatever the recorder's own
  // browser captures (their screen, which in Meeting View shows everyone's
  // tile) could still sweep up other participants' video/audio. This is a
  // genuinely room-wide, minimal (just a boolean, no identity/title) signal
  // broadcast to literally everyone in the room, so "is this room being
  // recorded right now" always has a visible answer regardless of role.
  RECORDING_ACTIVE_CHANGED = 'recording:active_changed',

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
  // directly at each admin socket currently connected to the room and
  // carries enough to render a popup without a follow-up fetch — see
  // JoinRequestPopupPayload.
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

  // Pin/unpin a persisted channel/DM message (MESSAGE_PIN, toggle via the
  // `pinned` flag) — open to anyone in that channel/DM, not just the
  // sender. Distinct from NOTICE_PIN (an admin-only room-wide announcement
  // board, unrelated feature that happens to share the word "pin").
  MESSAGE_PIN = 'message:pin',
  MESSAGE_PINNED = 'message:pinned',

  // Read receipts ("dibaca oleh X, Y, Z") — CHAT_MARK_READ tells the server
  // "I've read up to now" for a channel/DM (one row per user per thread, see
  // ChatRead — not one row per message). CHAT_READ_STATE_SYNC is the current
  // read-state of everyone who's ever read this thread, sent once right
  // after CHANNEL_JOIN/DM_JOIN (mirrors how MEDIA_LIST arrives right after
  // ROOM_STATE); CHAT_READ_UPDATED is the live update broadcast to the
  // thread's room whenever anyone marks read. A message is "seen by" whoever
  // in that map has a lastReadAt >= the message's own createdAt — derived
  // client-side, never sent per-message.
  CHAT_MARK_READ = 'chat:mark_read',
  CHAT_READ_STATE_SYNC = 'chat:read_state_sync',
  CHAT_READ_UPDATED = 'chat:read_updated',

  // Temporary removal from the room by an admin+ user (see
  // shared/permissions.ts's 'room:kick') — not a ban, the target can rejoin
  // any time. PLAYER_KICK is the admin's request; PLAYER_KICKED is sent only
  // to the removed player's own socket (never broadcast) so their client can
  // show a "you were removed" notice — everyone else in the room just sees
  // the ordinary PLAYER_LEFT broadcast, since roomHandler.ts's kick handler
  // reuses handleLeave's exact same cleanup.
  PLAYER_KICK = 'player:kick',
  PLAYER_KICKED = 'player:kicked',

  // QA (Moderasi checklist item 11, "Kick/mute admin") — same shape as
  // PLAYER_KICK/PLAYER_KICKED above: PLAYER_FORCE_MUTE is the admin's
  // request, PLAYER_FORCE_MUTED is sent only to the target's own socket
  // (never broadcast). Unlike kick, the server can't unilaterally mute a
  // remote track it never had authority over (that state lives entirely on
  // the target's own device — see useWebRTC's toggleMic) — this only
  // ASKS the target's client to mute itself; PLAYER_MIC/PLAYER_MIC_UPDATED
  // (the existing self-mute broadcast) already carries the resulting badge
  // to everyone else once the target's client complies, no separate
  // broadcast needed here.
  PLAYER_FORCE_MUTE = 'player:force_mute',
  PLAYER_FORCE_MUTED = 'player:force_muted',

  // "Ngobrol dengan CEO" queue (see server/src/lib/roomQueue.ts) — sent only
  // to the removed player's own socket, same "never broadcast" shape as
  // PLAYER_KICKED above, when their timed slot in a restricted+queued room
  // runs out and the sweep force-removes them so the next person in line
  // can be called.
  QUEUE_SESSION_ENDED = 'queue:session_ended',

  // Zone-level counterpart — "CEO Office" turned out to be a ZONE, not a
  // separate Room (see server/src/lib/zoneMembership.ts). Sent only to the
  // affected socket when their timed zone slot ends; the client reacts by
  // nudging the avatar out of the zone and emitting ZONE_EXIT itself (see
  // roomHandler.ts's forceZoneExitForQueue doc comment for why this is
  // client-driven rather than a server-side teleport).
  ZONE_SESSION_ENDED = 'zone:session_ended',

  // Which zones in this room require staff+ or a queue ticket (see
  // schema.prisma's ZoneRestriction) — sent once at JOIN_ROOM (so a fresh
  // client always starts accurate) and re-broadcast to the whole room
  // whenever an admin edits a restriction, mirroring ZONE_LOCK_UPDATED's own
  // shape one level up (persistent config instead of an ephemeral lock).
  ZONE_RESTRICTIONS = 'zone:restrictions',

  // "Ngobrol dengan CEO" queue, zone-level — someone joined a zone's queue
  // (RoomQueueEntry with zoneId set). Fanned out to every admin socket
  // currently connected to the room (getConnectedAdminSocketIds, same
  // "only currently-connected admins" posture as JOIN_REQUESTED), with
  // Setujui/Tolak right on the toast — approving is what actually promotes
  // the entry to 'called' (see routes/roomMembers.ts's new
  // /queue/:entryId/approve; zone-level entries no longer auto-advance,
  // see roomQueue.ts's advanceQueue).
  ZONE_QUEUE_REQUESTED = 'zone:queue_requested',

  // "Ngobrol dengan CEO" queue, zone-level — broadcast to the WHOLE room
  // (not just the ticket holder) the moment a queue entry becomes 'active',
  // so every client can render a small floating countdown above that
  // player's own avatar (GameCanvas.tsx/AvatarSprite.ts) — not just the
  // holder's own ZoneLockBar card. CLEARED fires the moment that session
  // ends, whichever way it ends (early leave, admin skip, or the 20s expiry
  // sweep) — see roomHandler.ts's broadcastZoneQueueSessionCleared, the one
  // shared helper every one of those paths calls.
  ZONE_QUEUE_SESSION_ACTIVE = 'zone:queue_session_active',
  ZONE_QUEUE_SESSION_CLEARED = 'zone:queue_session_cleared',

  // v2 Bagian B.2 #5 — Office Activity Feed. A manager-only live "pulse",
  // NOT a persisted audit trail (see AuditLog for that) — pushed to
  // whichever manager sockets are subscribed to `analytics-feed:<managerId>`
  // (see server/src/socket/analyticsFeed.ts), event-level only (never chat
  // TEXT — Bagian A.4's privacy rule).
  ANALYTICS_ACTIVITY = 'analytics:activity',
  ANALYTICS_FEED_SUBSCRIBE = 'analytics:feed_subscribe',
  ANALYTICS_FEED_UNSUBSCRIBE = 'analytics:feed_unsubscribe',

  // QA (Presence checklist item #8, "Member list akurat") — workspace-wide "who's online + which room" roster (NOT the
  // in-room ParticipantPanel, which only ever sees people standing in the
  // SAME room). Named `roster:` rather than reusing the existing `presence:`
  // prefix on purpose — that prefix already means the Spotlight moderation
  // feature (SPOTLIGHT_TOGGLE/_CHANGED above) in this codebase, a totally
  // different concept from online/offline status. ROSTER_LIST_REQUEST asks
  // for a one-time full snapshot of everyone currently online (sent back to
  // the requester only, via ROSTER_SNAPSHOT); ROSTER_UPDATED is the ongoing
  // live delta broadcast to literally every connected socket (io.emit, not
  // room-scoped) whenever any one user's online/room state changes, so a
  // member-list panel open in Room A learns the instant someone in Room B
  // goes online/offline/switches rooms too. Global by design — see
  // roomHandler.ts's userRoomMap.
  ROSTER_LIST_REQUEST = 'roster:list_request',
  ROSTER_SNAPSHOT = 'roster:snapshot',
  ROSTER_UPDATED = 'roster:updated',
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

// "Ngobrol dengan CEO" queue, zone-level — see SocketEvents.ZONE_QUEUE_REQUESTED.
export interface ZoneQueueRequestedPayload {
  entryId: string;
  userId: string;
  name: string;
  topic: string | null;
  durationMin: number;
  roomSlug: string;
  roomName: string;
  zoneId: string;
  zoneName: string;
  // v2 — always 'booking' in practice (a 'quick' entry is full-auto FCFS
  // and never pages the CEO for a decision — see roomQueue.ts's
  // advanceQueue), included so the toast can render the scheduled window.
  mode?: 'quick' | 'booking';
  bookingStart?: number;
  bookingEnd?: number;
}

// See SocketEvents.ZONE_QUEUE_SESSION_ACTIVE — room-wide, so every client
// can render a countdown above the right avatar regardless of whether
// that's their own or someone else's (e.g. the CEO's).
export interface ZoneQueueSessionActivePayload {
  zoneId: string;
  userId: string;
  playerName: string;
  endsAt: number;
}
export interface ZoneQueueSessionClearedPayload {
  zoneId: string;
}

// v2 Bagian B.2 #5 — Office Activity Feed. `detail` is a short, pre-
// formatted, human-readable fragment (e.g. a zone/room name) — never chat
// text, never anything else Bagian A.4 would call content rather than
// metadata.
export type AnalyticsActivityType = 'status_change' | 'connection' | 'chat' | 'poke';
export interface AnalyticsActivityPayload {
  type: AnalyticsActivityType;
  userId: string;
  userName: string;
  timestamp: number;
  detail?: string;
  // Only set for type 'connection' — the other person involved.
  otherUserId?: string;
  otherUserName?: string;
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

// Remote-help consent — same shape as Follow's, plus a 'busy' reason (the
// target already has an active remote-help session with someone else).
export interface RemoteHelpRequestPayload {
  requestId: string;
  actorUserId: string;
  actorName: string;
}

export interface RemoteHelpRespondPayload {
  requestId: string;
  accept: boolean;
}

export interface RemoteHelpResultPayload {
  targetName: string;
  accepted: boolean;
  reason?: 'declined' | 'timeout' | 'offline' | 'busy';
}

// The target's own RustDesk ID+password, relayed once to the helper's
// socket only — the server never persists this string anywhere (see
// remoteHelpHandler.ts's REMOTE_HELP_CREDENTIAL handler).
export interface RemoteHelpCredentialPayload {
  credential: string;
}

// Sent to whichever party did NOT click "Selesai" (or disconnected), so
// their banner can clear with a clear reason instead of just vanishing.
export interface RemoteHelpEndPayload {
  endedByName: string;
}

// §6 — Add Media. One table/type union with `type` as discriminator, per
// the spec's own "MapMediaObject" model — 'portal' and 'screenshot' are
// deliberately absent, see the SocketEvents doc comment above for why.
// Potong 6 — 'website' (open a URL) and 'bgm' (area background music) added.
export type MediaType = 'image' | 'youtube' | 'whiteboard' | 'file' | 'website' | 'bgm';

export interface MediaPayload {
  url?: string; // image / file — /api/uploads/<name>
  fileName?: string; // file only — original name, for the download link's label
  videoId?: string; // youtube only — parsed from whatever URL shape the user pasted
  strokes?: WhiteboardStroke[]; // whiteboard only — full history, appended to on each stroke
  // Potong 6
  websiteUrl?: string; // 'website' — always https:// (validated on placement)
  audioUrl?: string; // 'bgm' — uploaded audio, same upload path as attachments
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
// Both bumped +20% per feedback (230->276, 345->414) — walk and
// click-to-move pathfinding share this same PLAYER_SPEED constant
// (useMovement.ts's tryMoveToward uses it too), so they stay in lockstep
// automatically; no separate pathfinding speed to keep in sync. Animation
// cadence scaled to match — see AvatarSprite.ts's WALK_FRAME_MS/
// RUN_FRAME_MS, also divided by 1.2 — so the walk cycle doesn't fall out of
// step with the now-faster stride (feet sliding instead of stepping).
export const PLAYER_SPEED = 276; // pixels per second — was 230, nudged up again per feedback (ZEP-like brisker pace)
// Run (hold R while moving) — no dedicated run animation frames exist in
// the LimeZu Character Generator pack (only idle/walk rows), so running is
// the walk animation cycled faster (see AvatarSprite.ts's RUN_FRAME_MS)
// plus this actual higher step speed; there's nothing for the server to
// validate beyond what it already does for normal movement (bounds +
// tile-collision — see movementHandler.ts's doc comment on why per-tick
// max-distance was never enforced even before Run existed).
export const PLAYER_RUN_SPEED = 414; // pixels per second — was 345, keeps the same ~1.5x ratio over PLAYER_SPEED

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

export interface PlayerMovePayload {
  x: number;
  y: number;
  direction: Direction;
  isRunning?: boolean;
  // Monotonic client-side sequence number. Receivers use this to drop stale
  // movement packets that arrive after a newer position.
  seq?: number;
}

export interface PlayerMovedPayload extends PlayerMovePayload {
  id: string;
  serverTime: number;
}

export interface PlayerStoppedPayload {
  id: string;
  x?: number;
  y?: number;
  direction: Direction;
  serverTime?: number;
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
// §6 (RTC upgrade) — used to be a wider outer band (5 tiles) beyond
// PROXIMITY_THRESHOLD where a peer stayed connected/audible-but-fading even
// though they'd already walked outside the visible ring — audio (and,
// worse, the Soundboard's un-faded full-volume clips) reached noticeably
// past what the ring on screen promised. Collapsed to equal
// PROXIMITY_THRESHOLD so the audible range can never again drift wider than
// the ring that's supposed to represent it — same "derive so they can't
// drift apart" fix PROXIMITY_THRESHOLD_PX above already got.
export const TRANSLUCENT_THRESHOLD = PROXIMITY_THRESHOLD;
// Was 500 — long enough to absorb a boundary-hugging peer's normal jitter,
// but shorter than it needs to be to also absorb the position hiccup a
// server restart can cause (see useWebRTC.ts's resync-glitch guard, which
// handles that case specifically). 1000ms still reads as prompt for a
// genuine walk-away.
export const DISCONNECT_DEBOUNCE_MS = 1000;

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
export interface DoorUnlockedNoticePayload {
  x: number;
  y: number;
  byName: string;
}
export interface InteractiveDoorPasswordResultPayload {
  x: number;
  y: number;
  correct: boolean;
  failureMessage?: string;
}

// "Door Area" — area-id counterpart to the (x,y)-keyed payloads above.
export interface InteractiveDoorAreaPasswordCheckPayload {
  areaId: string;
  attempt: string;
}
export interface DoorAreaUnlockedNoticePayload {
  areaId: string;
  byName: string;
}
export interface InteractiveDoorAreaPasswordResultPayload {
  areaId: string;
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

// "Ngobrol dengan CEO" queue, zone-level (see schema.prisma's
// ZoneRestriction) — persistent admin config, independent of the ephemeral
// keyholder lock ZoneLockState represents above.
export interface ZoneRestrictionState {
  zoneId: string;
  minRole: string;
  queueEnabled: boolean;
  // "Ngobrol dengan CEO" v2 — true means this zone is always freely
  // walkable; minRole/queueEnabled above are ignored. See ZONE_LOCKED_DENIED
  // (never fired for this zone) and the booking/quick queue endpoints.
  bookingMode: boolean;
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

export interface GuestJoinRequest {
  guestId: string;
  name: string;
}

// QA #8 — a guest asking to enter a Zone.memberOnly zone. guestId is the
// synthetic uid (see server's roomHandler.ts guestUid()), playerId their
// live socket id (needed to route ZONE_APPROVAL_DECIDED back to them, same
// role playerId plays in ZoneKnockRequest above).
export interface ZoneApprovalRequest {
  zoneId: string;
  zoneName: string;
  guestId: string;
  playerId: string;
  guestName: string;
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
  // Optional max-occupant cap for this zone (Room Editor's "Private area"
  // tool, set once at creation via prompt — see RoomEditorPage.tsx).
  // Undefined/0 = unlimited, matching every zone before this field existed.
  // Enforced server-side in zoneHandler.ts's ZONE_ENTER — the server
  // counts current occupants itself (getSocketIdsInZone), never trusting a
  // client-reported count.
  capacity?: number;
  // QA #8 — "ODOO/AI TEAM hanya anggota; terkunci bagi guest." A GUEST
  // (Role: 'guest', reachable only via a Guest Link) needs admin approval
  // to enter this zone; member/staff/admin/owner enter freely, exactly like
  // any other zone. Undefined/false = every zone before this field existed
  // (open to guests, same as a member). Enforced server-side in
  // zoneHandler.ts's ZONE_ENTER, alongside (not instead of) the manual lock
  // and capacity checks above — a zone can be member-only AND separately
  // locked/capacity-limited at the same time.
  memberOnly?: boolean;
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
  // on disk same as any other chat attachment; only the message pointing
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
  // Slack/Discord-style per-thread pin — distinct from the room Notice
  // board's own pin (SocketEvents.NOTICE_PIN), which is a totally separate
  // admin-announcement feature reusing the word "pin" for something else.
  // This one lives on the message itself (ChatMessage.isPinned in the
  // Prisma schema), open to anyone in the thread, not just the sender —
  // curating important messages for the group isn't a privileged action.
  isPinned?: boolean;
}

// Read receipts — one entry per user who has ever read a given channel/DM,
// not one per message (see server's ChatRead model). A message is "seen by"
// whoever's lastReadAt is >= that message's own createdAt, computed
// client-side from this small per-thread list.
export interface ChatReadEntry {
  userId: string;
  lastReadAt: number;
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
  wallAreaRects?: ImpassableAreaRect[];
  // Same "absent on the legacy socket ROOM_UPDATE path, present on every
  // save through layerDataToLegacy" posture as impassableAreaRects above.
  doorAreaRects?: DoorAreaRect[];
}

export { createDefaultOfficeLayout, createCorporateOfficeLayout, findSpawnPixel, createRoomLayoutFromTemplate, ROOM_TEMPLATES } from '../defaultRoomLayout';
export type { RoomTemplateId } from '../defaultRoomLayout';
export { BLOCKED_TILES, isTileBlocked, isDoorTile, findZoneEntryTile, findAdjacentFreeTile, isPointInImpassableArea, doesRectOverlapImpassableArea } from '../tileCollision';
// ZEP Room Editor — Potong 1 layered map format + legacy adaptors.
export { MAP_FORMAT_VERSION, legacyToLayerData, layerDataToLegacy, AVATAR_SCALE_MIN, AVATAR_SCALE_MAX, getImpassableAreaRects, getDoorAreaRects } from '../mapLayers';
export type { LayerData, TileEffect, AreaEffect, CustomAssetEntry, ReferenceImageData, ImpassableAreaRect, DoorAreaRect } from '../mapLayers';
export type { Role, FeatureKey } from '../permissions';
export { roleAtLeast, hasFeatureAccess, FEATURE_MIN_ROLE } from '../permissions';
export type { ShiftDef, AttendanceStatus, WorkTotals, Geofence, Coords, GeofenceResult } from '../attendanceRules';
export {
  STATUS_LABELS, shiftBounds, isWorkday, lateMinutes, clockInStatus, earlyLeaveMinutes,
  computeTotals, finalStatus, workDayOf, distanceM, checkGeofence, canViewAttendanceOf,
  canViewAnalyticsOf, MAX_ACCURACY_M, LOCATION_RETENTION_DAYS,
} from '../attendanceRules';
export type { OvertimeGraceInput, OvertimeGrace } from '../analyticsRules';
export { applyOvertimeGrace } from '../analyticsRules';
export type { CalendarRole, CalendarAction, CalendarCtx, Rsvp } from '../calendarPermissions';
export { calendarRoleAtLeast, canCalendar, canSeeEventDetails, CALENDAR_ROLE_LABELS, RSVP_LABELS } from '../calendarPermissions';
export type { EditScope, RecurringMaster, Occurrence } from '../recurrence';
export { expandOccurrences, truncateRuleBefore, normaliseRule, describeRule } from '../recurrence';
export type { DocRole, DocAction, DocCtx } from '../docPermissions';
export { docRoleAtLeast, canDoc, DOC_ROLE_LABELS } from '../docPermissions';
export type { WorkspaceRole, WorkspaceAction, WorkspaceCtx } from '../workspacePermissions';
export { canWorkspace, WORKSPACE_ACTIONS, WORKSPACE_ROLE_LABELS } from '../workspacePermissions';
