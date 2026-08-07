import { randomUUID } from 'crypto';
import { isUserInLockedZone, zoneKeyholderOf, admitUserToZone } from './zoneLock';
import { zoneIdOfSocket, getSocketIdsInZone } from './zoneHandler';
import { Server, Socket } from 'socket.io';
import { SocketEvents, Avatar, AvatarConfig, RoomTile, RoomUpdatePayload, RoomTheme, RoomTemplateId, Notice, Role, FeatureKey, TeleportRequest, hasFeatureAccess, isTileBlocked, createDefaultOfficeLayout, findAdjacentFreeTile, findSpawnPixel, TILE_SIZE, TRANSLUCENT_THRESHOLD, CONSENT_REQUEST_TIMEOUT_MS, SummonRespondPayload, WorkMode, LayerData, layerDataToLegacy, ImpassableAreaRect, InteractivePasswordCheckPayload, InteractiveDoorPasswordCheckPayload, InteractiveChoiceCheckPayload, InteractiveApiCallPayload, InteractiveChangeObjectPayload, SoundboardPlayPayload, SOUNDBOARD_COOLDOWN_MS, AWAY_REASON_MAX_LENGTH, RosterEntry, RosterUpdate } from '@virtualmeet/shared';
import {
  addPlayer, removePlayer, getPlayers, getRoomState, updatePlayerAvatarConfig, updatePlayerHand, updatePlayerMic, updatePlayerHidden, updatePlayerWorkMode, updatePlayerSpotlight, updatePlayerSitting,
  setCachedTiles, getCachedTiles, setCachedImpassableAreas, setCachedZones, saveLastKnownPosition, getLastKnownPosition, updatePlayerPosition,
} from '../store/roomStore';
import { getPrisma } from '../lib/prisma';
import { resolveEntry } from '../lib/roomMembership';
import { admitCalledEntry, advanceQueue } from '../lib/roomQueue';
import { refreshZoneRestrictionCache } from '../lib/zoneMembership';
import { logActivity } from '../lib/larkBase';
import { socketRateLimit } from '../middleware/rateLimit';
import { redactInteractiveSecrets, redactDoorPasswords } from '../lib/redactFurniture';
import { unlockDoor, clearUnlockedDoorsForRoom } from './doorLock';
import { getNearbyRecipients } from './proximityBroadcast';
import { sendUserDm } from '../lib/larkIm';
import { relayBroadcastToLark } from '../lib/larkChatSync';
import { sanitizeChat } from '../middleware/validate';

const canChangeAdmin = socketRateLimit(3); // max 3 admin grant/revoke calls/sec per socket
const canTeleport = socketRateLimit(2); // max 2 teleport requests/sec per socket
const canUpdateRoom = socketRateLimit(2); // max 2 room:update (DB write) calls/sec per socket
const canSummonUser = socketRateLimit(3); // max 3 single-target summon requests/sec per socket
const canForcePull = socketRateLimit(3); // "Tarik Paksa" — same burst guard as Summon above
const canKnock = socketRateLimit(1); // max 1 knock/sec per socket — no spamming the host
const canSlap = socketRateLimit(3); // A10 — burst guard; the real limit is the 30s/target cooldown below
const canCheckInteractive = socketRateLimit(3); // Fitur 15B — throttle brute-force guessing of a password/multiple-choice prompt
const canApiCall = socketRateLimit(1); // Fitur 15B — API call hits a THIRD-PARTY server; heavier than a DB compare, so a tighter cap
const canChangeObject = socketRateLimit(2); // Fitur 15B — mutates + saves the room's actual layerData
const canBroadcast = socketRateLimit(1); // QA #9/#10 — room-wide PA text push, deliberately tighter than any chat rate limit

// A10 — Slap ("colek") cooldown: 30s per (sender socket → target socket) pair,
// so you can't spam-poke the same person. Ephemeral (socket-id keyed); a
// reconnect resets it, which is fine for a cosmetic nudge. Entries are tiny and
// pruned lazily on read.
const slapCooldown = new Map<string, number>();
const SLAP_COOLDOWN_MS = 30_000;

// Bug 14 — per-sender cooldown for the raise-hand chime, keyed by the raiser's
// socket id. Spamming the ✋ button only re-rings the zone once per window
// (the visual badge still toggles freely — this only throttles the sound).
const handSoundCooldown = new Map<string, number>();
const HAND_SOUND_COOLDOWN_MS = 5_000;

// Soundboard — per-SENDER cooldown (not per-sound, so spamming button A then
// button B still gets throttled), keyed by socket id, same shape as
// handSoundCooldown above.
const soundboardCooldown = new Map<string, number>();

// §5.1 — Summon now requires the target's consent, so the actual move only
// happens once they accept. Keyed by TARGET socket id — a new request from
// someone else simply replaces whichever request that target hadn't
// answered yet, rather than queueing multiple.
interface PendingSummon {
  requestId: string;
  fromSocketId: string;
  fromName: string;
  x: number;
  y: number;
  direction: Avatar['direction'];
  timeout: ReturnType<typeof setTimeout>;
}
const pendingSummons = new Map<string, PendingSummon>();

// "Tarik Paksa" (Force-pull) — when the target is offline at pull time, their
// landing spot is queued via saveLastKnownPosition (the exact slot a normal
// reconnect already resumes from), but that alone gives them no explanation
// for why they didn't spawn where they left off. Keyed by uid (unlike
// pendingSummons above, which is keyed by socket id — an offline target has
// no socket id yet), consumed the moment their next JOIN_ROOM to this same
// room picks up the queued position, so FORCE_PULLED fires exactly once,
// right after they actually land.
const pendingForcePullNotices = new Map<string, string>(); // uid -> puller's display name

function clearPendingSummon(targetSocketId: string) {
  const pending = pendingSummons.get(targetSocketId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingSummons.delete(targetSocketId);
  }
}

// A pending "knock to enter" — keyed by the KNOCKER's own socket id (unlike
// pendingSummons, there's no single "target": a knock fans out to every
// connected admin at once, so this remembers exactly which admin sockets
// were told, so a cancel (or the knocker disconnecting) can tell precisely
// those same sockets to drop it — never a broadcast to the whole room.
interface PendingKnock {
  uid: string;
  name: string;
  notifiedAdminSocketIds: string[];
}
const pendingKnocks = new Map<string, PendingKnock>();

function cancelKnock(knockerSocketId: string, io: Server) {
  const pending = pendingKnocks.get(knockerSocketId);
  if (!pending) return;
  pendingKnocks.delete(knockerSocketId);
  for (const adminSocketId of pending.notifiedAdminSocketIds) {
    io.to(adminSocketId).emit(SocketEvents.ROOM_KNOCK_CANCELLED, { userId: pending.uid });
  }
}


const AVATAR_COLORS = ['#4ecdc4', '#ffe66d', '#a786df', '#6bcb77', '#4d96ff', '#ff6b6b'];

// Guest Link & Ruang Tunggu — a guest's uid throughout this file is this
// prefix + their JWT's guestId (never a real cuid, so it can never collide
// with — or be mistaken for — an actual User.id in any of the plain
// string-keyed Maps below, which is the whole reason to prefix it rather
// than use the bare guestId).
const GUEST_UID_PREFIX = 'guest:';
function guestUid(guestId: string): string { return `${GUEST_UID_PREFIX}${guestId}`; }
function isGuestUid(uid: string): boolean { return uid.startsWith(GUEST_UID_PREFIX); }
// QA (Akses tamu checklist item 2, "Guest terbatas") — cheaper than
// resolving a uid first (findUserIdBySocket + isGuestUid) for handlers that
// don't already have one on hand; reads the same server-verified guest JWT
// claim every other guest check in this codebase ultimately traces back to
// (see index.ts's io.use handshake middleware).
function isGuestSocket(socket: Socket): boolean { return !!(socket.data as { guestId?: string }).guestId; }

// Same "very few features" cut as isGuestSocket above, extended to
// self-registered (non-Lark) accounts nobody has promoted — see
// RoomAdminState.restrictedTierUserIds' own doc comment for why a manual
// account needs the same treatment as a Guest Link visitor by default.
// Takes `room` explicitly (rather than resolving it internally) since every
// call site already has — or trivially can get — the current room, and
// restrictedTierUserIds is per-room state populated at JOIN_ROOM.
function isRestrictedSocket(socket: Socket, room: string | null): boolean {
  if (isGuestSocket(socket)) return true;
  if (!room) return false;
  const uid = findUserIdBySocket(socket.id);
  if (!uid) return false;
  return getRoomAdmin(room).restrictedTierUserIds.has(uid);
}

const DEFAULT_ROOM = 'main-office';
const DEFAULT_ROOM_NAME = 'Main Office';

const playerNames = new Map<string, string>();
const playerColors = new Map<string, string>();
let colorIndex = 0;

const userSocketMap = new Map<string, string>();

// QA (Presence checklist item #8, "Member list akurat") — workspace-wide
// "which room is this (real, non-guest) user currently in" registry,
// maintained alongside userSocketMap above (same set/delete call sites:
// JOIN_ROOM success and handleLeave). Guests are never entered here — they
// have no User row, so they don't belong in a workspace member roster.
const userRoomMap = new Map<string, { roomSlug: string; roomName: string; zoneName?: string }>();

function broadcastRosterUpdate(io: Server, update: RosterUpdate) {
  io.emit(SocketEvents.ROSTER_UPDATED, update);
}

// Bug follow-up — the roster used to only ever record the top-level ROOM,
// so two people in the same office but different areas (e.g. one at their
// desk, one in "Meeting Room") both showed the same room-only label with no
// way to tell them apart. Called from zoneHandler.ts's ZONE_ENTER/ZONE_EXIT
// — the only two places that know a socket's zone membership — with
// `zoneName: null` on exit. A no-op for guests (never in userRoomMap) and
// for a socket whose room-level presence hasn't been recorded yet.
export function updateRosterZone(io: Server, socketId: string, zoneName: string | null): void {
  const uid = findUserIdBySocket(socketId);
  if (!uid) return;
  const existing = userRoomMap.get(uid);
  if (!existing) return;
  existing.zoneName = zoneName ?? undefined;
  broadcastRosterUpdate(io, { userId: uid, online: true, roomSlug: existing.roomSlug, roomName: existing.roomName, zoneName: existing.zoneName });
}

// Reconnect grace period — a bare network drop (wifi blip, tab backgrounded,
// laptop sleep) fires the socket's 'disconnect' event just like a real
// leave, but the audit's own complaint was exactly this: a brief outage
// made the avatar visibly vanish for everyone else even though the user
// was back within seconds. Delaying the actual handleLeave() cleanup by
// this window means a reconnect that lands before it fires never sees
// PLAYER_LEFT broadcast at all for the old session — JOIN_ROOM's existing
// stale-entry eviction (below) cancels the pending timer first, so the two
// paths can never both run for the same disconnect. LEAVE_ROOM (explicit)
// and PLAYER_KICKED are NOT delayed — only a bare 'disconnect' is graced.
// Keyed by uid (not socket.id) since that's what a reconnect's fresh
// JOIN_ROOM has to look the pending entry up by.
//
// QA item #8 (Ghost hilang) — was 15s (observed as ~15-20s including
// socket.io's own ping-timeout detection latency before 'disconnect' even
// fires), which meant a genuine hard disconnect (closed laptop, crashed
// tab, network gone for good) left a ghost avatar visible to everyone else
// for that whole window. Shortened to 4s — still enough slack to absorb a
// brief wifi blip or tab-backgrounding without the original flicker bug
// this grace period was built to fix, but far less stale-ghost time for a
// disconnect that was never coming back.
const RECONNECT_GRACE_MS = 4000;
const pendingDisconnects = new Map<string, { socketId: string; room: string; timer: NodeJS.Timeout }>();

interface RoomAdminState {
  masterAdminUserId: string;
  adminUserIds: Set<string>;
  // Staff sits between admin and member (see shared/permissions.ts) — no
  // current feature actually gates on 'staff' yet (the spec's own
  // teleport_admin/summon examples that would use it aren't built), but the
  // grant/revoke plumbing exists now so those features can reuse it later
  // instead of each inventing their own mid-tier role.
  staffUserIds: Set<string>;
  loadedFromDb: boolean;
  // Zoom-style "Lock Meeting" (see SocketEvents.ROOM_LOCK_SET) — when true,
  // JOIN_ROOM denies any non-admin. In-memory only, so a server restart
  // reopens every room; that's intentional (a lock is a live moderation
  // action for an ongoing session, not persistent room config).
  locked?: boolean;
  // Uids admitted past the lock via "Knock to enter" (see
  // SocketEvents.ROOM_KNOCK_ADMIT). Cleared whenever the room is unlocked, so
  // a re-lock requires knocking again.
  knockAllowlist?: Set<string>;
  // Akses & Password Pintu audit item #9 — emergency door override (see
  // SocketEvents.DOOR_OVERRIDE_SET). When true, movementHandler.ts's
  // isBlockedForSocket lets EVERY password door through regardless of
  // doorLock.ts's per-socket unlock state. In-memory only, same "resets on
  // restart" posture as `locked` above — an emergency mode isn't config that
  // should silently survive a redeploy.
  doorOverride?: boolean;
  // Self-registered (non-Lark) accounts nobody has promoted — see getRole's
  // own doc comment on why these are clamped to 'guest'. Populated per-join
  // (roomHandler's JOIN_ROOM, same "checked fresh each connection, not
  // persisted" posture as the global-admin accountRole check right next to
  // it) rather than loaded from DB here, since it depends on live User
  // fields that can change between sessions.
  restrictedTierUserIds: Set<string>;
  // Guest Link & Ruang Tunggu — guestIds (not socket ids, not full uids) an
  // admin has explicitly admitted via GUEST_JOIN_DECIDE. Checked on every
  // guest JOIN_ROOM: absent → held in the waiting room; present → proceeds
  // like a normal join. Revoked the instant the guest leaves (handleLeave)
  // — same "one-time entry pass, not a standing grant" rule as
  // knockAllowlist, so a returning guest is re-vetted every visit.
  guestAllowlist?: Set<string>;
  // Guest requests currently awaiting an admin decision, keyed by guestId.
  // notifiedAdminSocketIds mirrors PendingKnock's own field — remembered so
  // a later cancel (guest disconnects before a decision) tells exactly the
  // admin sockets that were actually notified, never a room-wide broadcast.
  pendingGuests?: Map<string, { socketId: string; name: string; requestedAt: number; notifiedAdminSocketIds: string[] }>;
}

const roomAdminMap = new Map<string, RoomAdminState>();

// Resolves a user's current Role in a room from the in-memory admin state
// — the single place this app decides "what tier is this person" (see
// shared/permissions.ts's Role hierarchy doc comment). 'guest' IS reachable
// here (see isGuestUid below) — the one case where login isn't mandatory.
function getRole(rs: RoomAdminState, uid: string): Role {
  // Guest Link & Ruang Tunggu — a guest uid (see isGuestUid below) is never
  // the room owner/admin/staff by construction (those Sets only ever hold
  // real account ids), but checking explicitly here — rather than falling
  // through to 'member' — is what makes every 'member'-tier gate in this
  // file (teleport:use, furniture:assign, etc.) correctly reject a guest
  // too, not just the higher-tier ones a wrong-but-lucky 'member' floor
  // would already have blocked.
  if (isGuestUid(uid)) return 'guest';
  if (uid === rs.masterAdminUserId) return 'owner';
  if (rs.adminUserIds.has(uid)) return 'admin';
  if (rs.staffUserIds.has(uid)) return 'staff';
  // Self-registered (non-Lark) account nobody has promoted — see
  // restrictedTierUserIds' own doc comment. Checked LAST, after every
  // explicit-privilege check above: creating a room (master admin) or being
  // granted admin/staff already means someone vouched for this account, and
  // that decision must win regardless of how they logged in.
  if (rs.restrictedTierUserIds.has(uid)) return 'guest';
  return 'member';
}

// Every server-side permission check in this file should call this instead
// of re-deriving its own role comparison — see shared/permissions.ts's doc
// comment for why (this is the fix for the exact gap it describes).
function canAccess(rs: RoomAdminState, uid: string | undefined, feature: FeatureKey): boolean {
  if (!uid) return false;
  return hasFeatureAccess(getRole(rs, uid), feature);
}

// QA #8 — the one piece of this file's role machinery zoneHandler.ts needs
// (to gate ZONE_APPROVAL_DECIDE to admins, and to recognize a guest at
// ZONE_ENTER) without exposing getRole/getRoomAdmin/RoomAdminState
// themselves. undefined uid → 'guest', same floor getRole would reach
// anyway via isGuestUid's own "no userId" reasoning, just without needing a
// real (or synthetic guest:) uid to get there.
export function getRoleInRoom(room: string, uid: string | undefined): Role {
  if (!uid) return 'guest';
  return getRole(getRoomAdmin(room), uid);
}

// One pinned Notice per room (see shared/types/index.ts's Notice doc
// comment) — in-memory, same convention as roomAdminMap above.
const roomNoticeMap = new Map<string, Notice>();

function getRoomAdmin(room: string): RoomAdminState {
  if (!roomAdminMap.has(room)) {
    roomAdminMap.set(room, { masterAdminUserId: '', adminUserIds: new Set(), staffUserIds: new Set(), restrictedTierUserIds: new Set(), loadedFromDb: false });
  }
  return roomAdminMap.get(room)!;
}

async function initRoomAdminFromDb(room: string): Promise<RoomAdminState> {
  const rs = getRoomAdmin(room);
  if (rs.loadedFromDb) return rs;

  try {
    const prisma = getPrisma();
    const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
    if (dbRoom?.ownerId) {
      rs.masterAdminUserId = dbRoom.ownerId;
      rs.adminUserIds.add(dbRoom.ownerId);
    }
    // Admin/staff grants are persisted via RoomMember.role (see
    // ADMIN_GRANT/STAFF_GRANT below) precisely so this in-memory state
    // survives a server restart instead of silently reverting everyone to
    // 'member' — without this load, a restart would have made every past
    // grant vanish with no trace, and REST endpoints (server/src/routes/
    // teleport.ts, which have no socket/in-memory state to check at all)
    // would have had no way to ever know someone was staff/admin.
    if (dbRoom?.id) {
      const members = await prisma.roomMember.findMany({ where: { roomId: dbRoom.id } });
      for (const m of members) {
        if (m.role === 'admin') rs.adminUserIds.add(m.userId);
        else if (m.role === 'staff') rs.staffUserIds.add(m.userId);
      }
    }
  } catch (e) {
    console.warn('[room] failed to load room owner from db:', e);
  }
  rs.loadedFromDb = true;
  return rs;
}

// Persists a role grant/revoke into RoomMember.role so it survives a
// server restart (see initRoomAdminFromDb above) — upsert rather than
// create, since the target may already have a RoomMember row (e.g. the
// room's owner, created at room-creation time) or may have none yet (a
// regular member who only ever joined via socket, which doesn't create one).
async function persistRoleGrant(roomSlug: string, userId: string, role: 'admin' | 'staff' | 'member'): Promise<void> {
  try {
    const prisma = getPrisma();
    const dbRoom = await prisma.room.findUnique({ where: { slug: roomSlug }, select: { id: true } });
    if (!dbRoom) return;
    await prisma.roomMember.upsert({
      where: { userId_roomId: { userId, roomId: dbRoom.id } },
      create: { userId, roomId: dbRoom.id, role },
      update: { role },
    });
  } catch (e) {
    console.error('[room] failed to persist role grant:', e);
  }
}

// "Tarik Paksa" (Force-pull) — best-effort Lark DM for a target who's
// offline right now. Fire-and-forget from the caller's perspective: a Lark
// outage or a user with no linked larkOpenId must never fail the force-pull
// itself (the queued landing spot is already saved regardless).
async function notifyForcePullOffline(targetUserId: string, actorName: string, roomSlug: string): Promise<void> {
  try {
    const prisma = getPrisma();
    const [target, dbRoom] = await Promise.all([
      prisma.user.findUnique({ where: { id: targetUserId }, select: { larkOpenId: true } }),
      prisma.room.findUnique({ where: { slug: roomSlug }, select: { name: true } }),
    ]);
    if (!target?.larkOpenId) return; // no linked Lark account — nothing to send
    const roomName = dbRoom?.name || roomSlug;
    await sendUserDm(target.larkOpenId, `${actorName} menarik Anda ke room "${roomName}" di KaiSpace. Buka KaiSpace untuk bergabung.`);
  } catch (e) {
    console.error('[room] force-pull Lark notify failed:', e);
  }
}

function findUserIdBySocket(socketId: string): string | undefined {
  for (const [uid, sid] of userSocketMap) {
    if (sid === socketId) return uid;
  }
}

function broadcastAdmin(io: Server, room: string, rs: RoomAdminState) {
  io.to(room).emit(SocketEvents.ADMIN_CHANGED, {
    adminUserIds: Array.from(rs.adminUserIds),
    masterAdminUserId: rs.masterAdminUserId,
    staffUserIds: Array.from(rs.staffUserIds),
  });
}

function broadcastRoomCount(io: Server, room: string) {
  const count = io.sockets.adapter.rooms.get(room)?.size ?? 0;
  io.emit('lobby:room_updated', { roomId: room, playerCount: count });
}

export function getPlayerName(id: string): string {
  return playerNames.get(id) || `Player-${id.slice(0, 4)}`;
}

export function getPlayerColor(id: string): string {
  return playerColors.get(id) || '#4ecdc4';
}

// Read-only lock check for the REST rooms list (routes/rooms.ts) so the Lobby
// can show a 🔒 badge. Deliberately does NOT use getRoomAdmin() — that would
// CREATE an empty admin-state entry for every room merely listed, and a room
// with no in-memory state has never been locked, so treat missing as false.
export function isRoomLocked(slug: string): boolean {
  return roomAdminMap.get(slug)?.locked === true;
}

// Read-only check for movementHandler.ts's isBlockedForSocket — same
// missing-means-false posture as isRoomLocked above (a room with no
// in-memory admin state has never had its emergency override turned on).
export function isDoorOverrideActive(slug: string): boolean {
  return roomAdminMap.get(slug)?.doorOverride === true;
}

// Item #5 — live admin sockets currently connected to a room, so a REST route
// (roomMembers.ts's join-request handler, which has no socket of its own) can
// fan a popup out directly to them exactly like ROOM_KNOCK_REQUEST does,
// instead of broadcasting to the whole room and relying on client-side
// gating. Read-only, same convention as isRoomLocked above: never creates a
// roomAdminMap entry for a room nobody has joined this server lifetime — no
// admin has ever connected there, so there's nothing to notify.
export function getConnectedAdminSocketIds(roomSlug: string): string[] {
  const rs = roomAdminMap.get(roomSlug);
  if (!rs) return [];
  const ids: string[] = [];
  for (const uid of rs.adminUserIds) {
    const sid = userSocketMap.get(uid);
    if (sid) ids.push(sid);
  }
  return ids;
}

// "Ngobrol dengan CEO" queue — force-remove a user whose timed slot just
// ended (called from queueSweep.ts, which lives outside this file and has
// no socket of its own). Reuses handleLeave's exact cleanup, same reasoning
// as PLAYER_KICK: to everyone else in the room, a timed-out queue slot must
// look identical to an ordinary leave. A no-op if they've already
// disconnected — the sweep already caught up on the DB side regardless.
export async function forceLeaveForQueue(io: Server, userId: string, roomSlug: string, roomName: string): Promise<void> {
  const targetSocketId = userSocketMap.get(userId);
  if (!targetSocketId) return;
  const targetSocket = io.sockets.sockets.get(targetSocketId);
  if (!targetSocket) return;
  targetSocket.emit(SocketEvents.QUEUE_SESSION_ENDED, { roomSlug, roomName });
  await handleLeave(io, targetSocket, roomSlug);
}

// Zone-level counterpart to forceLeaveForQueue above — a restricted ZONE
// (e.g. "CEO Office") inside an otherwise ordinary shared office must never
// evict someone from the whole room when their slot ends, only push them
// out of that one area. Deliberately soft/client-driven: the server can't
// reach into the client's Phaser scene to move the avatar, so this just
// tells the target's own client its zone session ended (App.tsx reacts by
// nudging the avatar out and emitting ZONE_EXIT itself, same as a normal
// voluntary walk-out — which is what actually clears zoneHandler.ts's
// socketZone membership). A no-op if they've already disconnected.
export function forceZoneExitForQueue(io: Server, userId: string, roomSlug: string, zoneId: string, zoneName: string): void {
  const targetSocketId = userSocketMap.get(userId);
  if (!targetSocketId) return;
  const targetSocket = io.sockets.sockets.get(targetSocketId);
  if (!targetSocket) return;
  targetSocket.emit(SocketEvents.ZONE_SESSION_ENDED, { roomSlug, zoneId, zoneName });
}

export function registerRoomHandlers(io: Server, socket: Socket) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string, playerName?: string, avatarConfig?: AvatarConfig, userId?: string) => {
    const room = roomId || DEFAULT_ROOM;

    // Guest Link & Ruang Tunggu — an entirely separate gate from the member
    // approval-gate below. A guest has no RoomMember row (no real User at
    // all), so it must never fall through to that account-only logic.
    const guestId = (socket.data as { guestId?: string }).guestId;
    const isGuest = !!guestId;

    if (isGuest) {
      const guestRoomSlug = (socket.data as { guestRoomSlug?: string }).guestRoomSlug;
      // The invite token only ever authorizes ONE room — a guest socket
      // trying any other slug (tampered client, stale param) is rejected
      // outright, never silently redirected to it.
      if (room !== guestRoomSlug) {
        socket.emit(SocketEvents.JOIN_DENIED, { roomSlug: room, reason: 'guest-room-mismatch' });
        return;
      }
      const rs = getRoomAdmin(room);
      if (!rs.guestAllowlist?.has(guestId!)) {
        // Not admitted yet — register (or refresh) the pending request and
        // notify every admin currently connected to this room, then STOP:
        // nothing below this block runs until an admin admits (see
        // GUEST_JOIN_DECIDE further down), at which point the guest's own
        // client re-emits this exact same JOIN_ROOM — same "ping + client
        // retries" mechanic as ROOM_KNOCK_ADMITTED — and this time
        // guestAllowlist.has(guestId) is true, so it falls through instead.
        const guestName = (socket.data as { guestName?: string }).guestName || 'Guest';
        if (!rs.pendingGuests) rs.pendingGuests = new Map();
        const notifiedAdminSocketIds = getConnectedAdminSocketIds(room);
        for (const sid of notifiedAdminSocketIds) {
          io.to(sid).emit(SocketEvents.GUEST_JOIN_REQUESTED, { guestId: guestId!, name: guestName });
        }
        rs.pendingGuests.set(guestId!, { socketId: socket.id, name: guestName, requestedAt: Date.now(), notifiedAdminSocketIds });
        socket.emit(SocketEvents.GUEST_JOIN_WAITING, { roomSlug: room });
        console.log(`[room] guest ${guestName} (${guestId}) waiting to enter ${room} — ${notifiedAdminSocketIds.length} admin(s) notified`);
        return;
      }
      // Admitted — fall through to the exact same join logic every member
      // uses below, with a synthetic uid and every account-specific step
      // (approval gate, RoomMember upsert) skipped entirely.
      socket.join(room);
      currentRoom = room;
    } else {
      // Approval gate — BEFORE socket.join, or a rejected user still lands in
      // the socket.io room and keeps receiving everything broadcast to it. The
      // REST routes alone would be theatre: this is the door.
      //
      // socket.data.userId only (never the `userId` param, which the client
      // supplies and can lie about — the comment further down explains why that
      // distinction already mattered here).
      const enteringUid = (socket.data as { userId?: string }).userId;
      const prisma = getPrisma();

      // Two lookups, two different failure policies — deliberately not one
      // try/catch around both. A single catch that denied on any error would
      // fail closed for the ~191 walk-in rooms too, so a DB blip would lock
      // everyone out of rooms that never asked to be gated.
      let approvalRoom: { id: string; ownerId: string; requiresApproval: boolean; restrictedAccess: boolean; restrictedMinRole: string; queueEnabled: boolean; slug: string; name: string } | null = null;
      try {
        approvalRoom = await prisma.room.findUnique({ where: { slug: room } });
      } catch (e) {
        // Can't tell whether this room is gated. Unknown slugs (DEFAULT_ROOM,
        // ad-hoc rooms) have always been walk-in, and this lookup is the only
        // thing that distinguishes them, so treat an unreadable answer the same
        // way — matching pre-existing behaviour rather than inventing a lockout.
        console.error('[room] could not read room for approval check:', e);
      }

      // QA (Akses ruang checklist item 1) — restrictedAccess must be
      // checked regardless of requiresApproval's own value: they're
      // independent flags (a room could be restrictedAccess=true but
      // requiresApproval=false, e.g. left at its default), and
      // resolveEntry itself already checks restrictedAccess FIRST — but
      // only if it's actually reached, which requiresApproval alone used
      // to gate. Without this OR, a restricted room with requiresApproval
      // off would skip resolveEntry entirely and fall through to the plain
      // walk-in path below, letting anyone in.
      if (approvalRoom?.requiresApproval || approvalRoom?.restrictedAccess) {
        // Past this point the room HAS asked to be gated, so errors fail closed:
        // an unverifiable entry into an approval-required room is exactly what
        // the gate exists to prevent.
        if (!enteringUid) {
          socket.emit(SocketEvents.JOIN_DENIED, { roomSlug: room, reason: 'needs-request' });
          return;
        }
        try {
          const entry = await resolveEntry(prisma, approvalRoom, enteringUid);
          if (!entry.allowed) {
            socket.emit(SocketEvents.JOIN_DENIED, { roomSlug: room, reason: entry.reason });
            return;
          }
          // "Ngobrol dengan CEO" queue — this is the actual moment the
          // requester walks in, so it's the correct place (not the poll
          // that got them here) to start their session clock. No-ops if
          // they're already 'active' (a reconnect), so it can never
          // double-fire or reset a running timer.
          if (entry.reason === 'queue-active') {
            await admitCalledEntry(prisma, approvalRoom.id, null, enteringUid);
          }
        } catch (e) {
          console.error('[room] approval check failed:', e);
          socket.emit(SocketEvents.JOIN_DENIED, { roomSlug: room, reason: 'error' });
          return;
        }
      }

      // Entering a walk-in room records membership. Without this, nobody who
      // ever walked into an open room has a RoomMember row — so the moment an
      // admin switches that room to require approval, every single person in it
      // is re-classified as a stranger and locked out on their next join. The
      // gate is meant to filter who comes in NEXT, not evict the office.
      //
      // Fire-and-forget: this is bookkeeping, and a failed write must never stop
      // someone entering a room that has no gate on it.
      if (approvalRoom && !approvalRoom.requiresApproval && enteringUid) {
        prisma.roomMember
          .upsert({
            where: { userId_roomId: { userId: enteringUid, roomId: approvalRoom.id } },
            create: { userId: enteringUid, roomId: approvalRoom.id, status: 'active', role: 'member' },
            // Never touches role or an existing status — a 'rejected' row must
            // not be laundered into 'active' just by the room being open today.
            update: {},
          })
          .catch((e) => console.error('[room] failed to record membership:', e));
      }

      socket.join(room);
      currentRoom = room;
    }

    if (playerName && !playerNames.has(socket.id)) {
      playerNames.set(socket.id, playerName);
    }
    if (!playerNames.has(socket.id)) {
      playerNames.set(socket.id, `Player-${socket.id.slice(0, 4)}`);
    }

    const name = playerNames.get(socket.id)!;
    const color = avatarConfig?.color || AVATAR_COLORS[colorIndex % AVATAR_COLORS.length];
    playerColors.set(socket.id, color);
    colorIndex++;

    // socket.data.userId comes from a server-verified JWT (see index.ts's
    // io.use handshake middleware) and always wins over the client-supplied
    // `userId` param — trusting the raw param let anyone claim to be a
    // room's owner (learned via the public GET /api/rooms/:slug response)
    // and grant themselves master-admin. A guest's uid is synthetic
    // (guestUid) — never derived from anything client-supplied either
    // (guestId comes from the server-verified guest JWT, same trust level).
    const uid = isGuest ? guestUid(guestId!) : ((socket.data as { userId?: string }).userId || userId || socket.id);

    // QA items #9/#10 (multi-tab: duplicating a tab shares the same session/
    // guest token and could join as a second, simultaneous connection for
    // the SAME account) — the newest connection wins. If a DIFFERENT,
    // still-live socket already holds this uid (in any room, not just this
    // one — one account should only ever have one live connection), force it to
    // disconnect immediately rather than letting two sockets for the same
    // uid coexist (which the room's own stale-entry eviction below is only
    // a best-effort, non-atomic defense against — see its own comment).
    // supersededByNewerTab tells that socket's own DISCONNECT handler to
    // skip the reconnect grace period entirely: this one truly isn't coming
    // back, a replacement already exists.
    const previousSocketId = userSocketMap.get(uid);
    if (previousSocketId && previousSocketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      if (previousSocket) {
        previousSocket.data.supersededByNewerTab = true;
        previousSocket.emit(SocketEvents.SESSION_TAKEN_OVER);
        previousSocket.disconnect(true);
      }
    }
    userSocketMap.set(uid, socket.id);

    // A fresh JOIN_ROOM for the same account within the grace window IS the
    // reconnect the timer below was waiting for — cancel it so handleLeave()
    // never fires for the old socket. The stale-entry eviction further down
    // still runs and removes that old (now-defunct) entry as it always did;
    // this only stops the SEPARATE, redundant cleanup the grace timer would
    // otherwise also attempt a few seconds from now.
    const pending = pendingDisconnects.get(uid);
    if (pending && pending.room === room) {
      clearTimeout(pending.timer);
      pendingDisconnects.delete(uid);
    }

    // Load master admin from database (ownerId), not first socket
    const rs = await initRoomAdminFromDb(room);
    // A guest must never become master admin — the ONLY reason this branch
    // exists is to bootstrap a brand-new room's very first-ever joiner, and
    // an external, unauthenticated visitor landing on an empty room before
    // any real member ever has must not be crowned its owner.
    if (!rs.masterAdminUserId && !isGuest) {
      rs.masterAdminUserId = uid;
      rs.adminUserIds.add(uid);
    }

    // Global admin accounts (see shared/permissions.ts's AccountRole) are
    // auto-elevated to at least room-level 'admin' in every room, without
    // needing a RoomMember grant — added directly into the same
    // adminUserIds Set the master-admin/RoomMember grants above already
    // populate, so getRole()/canAccess() treat them identically with no
    // extra branching there. Checked per-join (not cached in RoomAdminState
    // like the DB-backed grants) since accountRole can change between
    // sessions and this is a one-time cost per connection, not per action.
    // Skipped for guests — uid isn't a real User.id, so this would just be a
    // wasted lookup (and getRole's own isGuestUid check already forces
    // 'guest' regardless of anything this could add to adminUserIds).
    try {
      if (!isGuest) {
        const account = await getPrisma().user.findUnique({ where: { id: uid }, select: { accountRole: true, larkOpenId: true, workspaceRole: true } });
        if (account?.accountRole === 'admin') rs.adminUserIds.add(uid);
        // Guest-tier for self-registered accounts — POST /auth/register is
        // public (anyone can hit it), unlike Lark OAuth login which requires
        // actually being in the org's Lark tenant. A manual account is
        // otherwise indistinguishable from a real employee, so without this
        // "buat akun manual" is a free bypass around every guest restriction
        // this app has. Only clamps the DEFAULT — an admin explicitly
        // promoting the account (workspaceRole/accountRole, or a room-level
        // staff/admin grant, both checked above/below this) always wins.
        if (account && !account.larkOpenId && account.accountRole !== 'admin' && account.workspaceRole !== 'admin') {
          rs.restrictedTierUserIds.add(uid);
        } else {
          rs.restrictedTierUserIds.delete(uid);
        }
      }
    } catch (e) {
      console.warn('[room] failed to check global admin status:', e);
    }

    const isAdmin = rs.adminUserIds.has(uid);
    const isMasterAdmin = uid === rs.masterAdminUserId;

    // Zoom-style "Lock Meeting" gate — a locked room turns away any non-admin
    // BEFORE they're added to the player store or announced to the room, so a
    // denied joiner never appears to anyone (no ghost avatar, no PLAYER_JOINED
    // broadcast). Admins/owner always get in (someone has to be able to unlock
    // it, and moderators need to reach a room they're managing). We undo the
    // socket.join(room) done at the top of this handler and clear currentRoom
    // so this socket receives no further room traffic.
    if (rs.locked && !isAdmin && !rs.knockAllowlist?.has(uid)) {
      console.log(`[room] denied ${name} (${socket.id}) — ${room} is locked`);
      socket.emit(SocketEvents.ROOM_LOCKED_DENIED, { roomId: room });
      socket.leave(room);
      currentRoom = null;
      return;
    }

    // Fetch the saved room once — reused for spawn point lookup below and
    // for the tiles/furniture/zones sent in room:state once player data is ready.
    let dbRoom: { id: string; name?: string; maxPlayers?: number; tilemapData: unknown; furniture: unknown; zones: unknown; theme?: string | null; template?: string | null; layerData?: unknown } | null = null;
    try {
      dbRoom = await getPrisma().room.findUnique({ where: { slug: room } });
    } catch (e) { console.warn('[room] failed to load room from db:', e); }

    // QA (Load checklist item 1, "Concurrency tim penuh") — `maxPlayers` has
    // existed on the Room record since the editor first offered to set it,
    // but was NEVER actually enforced anywhere — a room could be joined by
    // arbitrarily many sockets regardless of this field. Same "joined then
    // denied then leave" shape as the room-lock check above (this socket
    // already did socket.join(room) earlier in this handler, so the adapter
    // count here INCLUDES it — that's intentional: "size > cap" correctly
    // reads as "this join is what pushed it over," not "it was already
    // over before I got here"). Admins/owner are exempt, same reasoning as
    // the lock check: someone has to be able to get in to free up space
    // (kick an idle session, raise the cap) when a room is genuinely full.
    if (!isAdmin) {
      const cap = dbRoom?.maxPlayers ?? 50;
      const currentSize = io.sockets.adapter.rooms.get(room)?.size ?? 0;
      if (currentSize > cap) {
        console.log(`[room] denied ${name} (${socket.id}) — ${room} is full (${currentSize}/${cap})`);
        socket.emit(SocketEvents.JOIN_DENIED, { roomSlug: room, reason: 'room-full' });
        socket.leave(room);
        currentRoom = null;
        return;
      }
    }

    // QA (Presence checklist item #8, "Member list akurat") — record this
    // (real, non-guest) account as online in `room`, and tell everyone else
    // connected (not just this room) so an open member-list panel anywhere
    // updates immediately. Reuses the dbRoom fetch just above — no extra
    // query. Deliberately AFTER the lock/approval checks above (a denied
    // join must never appear "online in this room"), but the userSocketMap
    // registration above already ran regardless — matches its own posture
    // (that map isn't gated on room admission either, it's single-session
    // bookkeeping for the account as a whole).
    if (!isGuest) {
      const roomName = dbRoom?.name || room;
      userRoomMap.set(uid, { roomSlug: room, roomName });
      broadcastRosterUpdate(io, { userId: uid, online: true, roomSlug: room, roomName });
    }

    // Resolve the room's actual tile grid NOW (it used to happen later, only
    // for the room:state payload) — the spawn rescue below needs it. Hoisted,
    // not duplicated: the room:state emit further down reuses these.
    const theme: RoomTheme = dbRoom?.theme === 'scifi-office' ? 'scifi-office' : 'modern-interiors';
    const template = (dbRoom?.template as RoomTemplateId | null) ?? undefined;
    let savedTiles: RoomTile[][] | undefined;
    let savedFurniture: any[] | undefined;
    let savedZones: any[] | undefined;
    // Item #9 (precise-collision follow-up) — pixel-space Impassable Area
    // rectangles, resolved alongside tiles/furniture/zones from the same
    // layerDataToLegacy call. A legacy room with no layerData at all never
    // had this feature, so it's simply [] on that path below.
    let savedImpassableAreaRects: ImpassableAreaRect[] = [];
    // Room Editor's "Wall Area" tool — same [] -on-legacy-rooms posture as
    // savedImpassableAreaRects above, resolved from the same layerDataToLegacy
    // call.
    let savedWallAreaRects: ImpassableAreaRect[] = [];
    // ZEP Room Editor (Potong 1) — once a room is converted, layerData is its
    // source of truth. The adaptor reconstructs the EXACT same runtime shape
    // (tiles/furniture/zones), so everything downstream — render, collision,
    // zones, sit, teleport — is untouched. Rooms without layerData take the
    // unchanged legacy path below.
    if (dbRoom?.layerData) {
      const derived = layerDataToLegacy(dbRoom.layerData as unknown as LayerData);
      savedTiles = derived.tiles;
      savedFurniture = derived.furniture;
      savedZones = derived.zones;
      savedImpassableAreaRects = derived.impassableAreaRects;
      savedWallAreaRects = derived.wallAreaRects;
    } else {
      if (dbRoom?.tilemapData && Array.isArray(dbRoom.tilemapData) && (dbRoom.tilemapData as any[]).length > 0) {
        savedTiles = (dbRoom.tilemapData as any[]).map((row: any[], y: number) =>
          row.map((t: any, x: number) => ({ ...t, x, y, type: t.type || 'floor' }))
        );
      }
      if (dbRoom?.furniture && Array.isArray(dbRoom.furniture)) {
        savedFurniture = dbRoom.furniture as any[];
      }
      if (dbRoom?.zones && Array.isArray(dbRoom.zones)) {
        savedZones = dbRoom.zones as any[];
      }
    }
    // Rooms created before the default-office-layout seed (or the legacy
    // DEFAULT_ROOM slug, which has no DB row at all) still have empty or
    // missing map data — fall back to the same layout newly-created rooms
    // are seeded with (see shared/defaultRoomLayout.ts) instead of an
    // empty floor. Uses the room's own theme so a scifi-office room missing
    // its saved layout still falls back to a scifi-office-themed default.
    const fallback = (!savedTiles || !savedFurniture || !savedZones) ? createDefaultOfficeLayout(theme) : null;
    const tiles = savedTiles || fallback!.tiles;

    // Resume where this account last left THIS room, if known (see
    // roomStore.ts's lastKnownPosition doc comment) — otherwise fall back
    // to the room's spawn tile. Keyed by the real account id (uid), not
    // socket.id, since socket.id is different on every reconnect and would
    // never match a previous entry — without this, refreshing/reconnecting
    // always reset the player back to spawn regardless of where they'd
    // walked to, which the "Move" spec explicitly calls out as wrong.
    //
    // QA item #4 — this used to call a LOCAL findSpawnPixel that scanned
    // the raw, stale `dbRoom.tilemapData` column, which the ZEP Room Editor
    // save path (routes/rooms.ts) never writes to (only `layerData` is
    // saved) — so an admin's placed "Starting Point" marker was silently
    // never consulted; every join fell through to the hardcoded (3,3)
    // fallback. Now uses the SHARED findSpawnPixel (defaultRoomLayout.ts,
    // also used by routes/rooms.ts's own on-resize spawn rescue) against
    // `tiles` — the already-resolved array that DOES include Starting
    // Point markers via layerDataToLegacy's kind:'startingPoint' → 'spawn'
    // conversion. It also already returns its own (3,3) fallback, so the
    // old hardcoded `?? {...}` here is redundant and dropped.
    const remembered = getLastKnownPosition(uid, room);
    let spawn = remembered ?? findSpawnPixel(tiles);

    // Bug 8 — the remembered position can be INSIDE a blocked tile: sitting
    // puts the avatar on the chair's own tile (chair is in BLOCKED_TILES),
    // and a disconnect/refresh/laptop-sleep mid-sit stores exactly that as
    // the last known position. The fresh session then starts with
    // isSitting=false and no sitReturnPos, standing inside collision
    // geometry where every movement attempt is rejected — the "stuck in the
    // chair after sitting a while" report (long sits are precisely when a
    // reconnect happens). Rescue to the nearest adjacent free tile, same
    // helper the My Seat/summon landings already use.
    {
      const spawnTileX = Math.floor(spawn.x / TILE_SIZE);
      const spawnTileY = Math.floor(spawn.y / TILE_SIZE);
      if (isTileBlocked(tiles, spawnTileX, spawnTileY)) {
        const free = findAdjacentFreeTile(tiles, spawnTileX, spawnTileY);
        spawn = { x: free.x * TILE_SIZE + TILE_SIZE / 2, y: free.y * TILE_SIZE + TILE_SIZE / 2 };
        console.log(`[room] rescued ${uid}'s spawn off blocked tile (${spawnTileX},${spawnTileY}) -> (${free.x},${free.y}) in ${room}`);
      }
    }

    // `name` is already the resolved display name (real account name takes
    // priority client-side in useSocket.ts). avatarConfig.name defaults to
    // the placeholder 'You' used for the Avatar Editor's own live preview —
    // it must not win over the real name just because a player never opened
    // that editor, so it's only a fallback for the (unreachable in practice,
    // since login is mandatory) case where `name` itself is empty.
    const newPlayer: Avatar = {
      id: socket.id, name: name || avatarConfig?.name || 'Player',
      x: spawn.x, y: spawn.y, direction: (remembered?.direction as Avatar['direction']) || 'down',
      color, isMoving: false, avatarConfig: avatarConfig || undefined,
      isAdmin, userId: uid, isGuest: isGuest || undefined,
    };

    console.log(`[room] ${newPlayer.name} (${socket.id}) uid=${uid} ${isAdmin ? isMasterAdmin ? '⭐' : '👑' : ''} joined ${room}`);

    // Evict any stale entries for the SAME account (uid) before adding this
    // one — a reconnect or refresh comes in on a brand-new socket.id, so the
    // previous socket's player entry lingers in the room store until its own
    // 'disconnect' fires, which can be tens of seconds later (ping timeout)
    // or never (hard network drop). Without this, every reconnect stacks
    // another "ghost" avatar of the same person (the reported 15 identical
    // players bug). One account = one avatar per room: drop the old entries
    // now and tell everyone (including this socket) to remove those ghost
    // ids. Guests (uid === socket.id) never collide, so they're unaffected.
    try {
      const existing = await getPlayers(room);
      for (const ghost of existing) {
        if (ghost.userId === uid && ghost.id !== socket.id) {
          await removePlayer(room, ghost.id);
          io.to(room).emit(SocketEvents.PLAYER_LEFT, ghost.id);
          // Also detach the ghost socket from the room if it somehow still
          // lingers, so it stops receiving/echoing room traffic.
          const ghostSock = io.sockets.sockets.get(ghost.id);
          if (ghostSock) ghostSock.leave(room);
        }
      }
    } catch (e) {
      console.warn('[room] failed to evict stale player entries:', e);
    }

    socket.to(room).emit(SocketEvents.PLAYER_JOINED, newPlayer);
    broadcastRoomCount(io, room);

    addPlayer(room, newPlayer).then(async () => {
      const state = await getRoomState(room, DEFAULT_ROOM_NAME);

      const playersWithMeta = state.players.map((p) => {
        const puid = findUserIdBySocket(p.id) ?? p.id;
        return { ...p, userId: puid, isAdmin: rs.adminUserIds.has(puid), isMasterAdmin: puid === rs.masterAdminUserId };
      });

      // tiles/savedFurniture/savedZones/theme/template/fallback were resolved
      // ABOVE, before the spawn was computed (Bug 8 — the blocked-spawn
      // rescue needs the real grid). This block only consumes them now.

      // Populate movementHandler.ts's collision cache with this room's
      // actual layout — without this, server-side movement validation has
      // nothing to check against and fails open (see getCachedTiles's doc
      // comment there).
      setCachedTiles(room, tiles);
      setCachedImpassableAreas(room, savedImpassableAreaRects);
      setCachedZones(room, savedZones || fallback!.zones);

      // "Ngobrol dengan CEO" queue, zone-level — load this room's
      // ZoneRestriction rows into the fast in-memory cache ZONE_ENTER
      // consults (see roomStore.ts's getCachedZoneRestriction doc comment).
      // One-time cost per join, same posture as the global-admin accountRole
      // check elsewhere in this handler — not worth persisting/streaming
      // live, a rejoin naturally picks up any admin change.
      try {
        const prisma = getPrisma();
        const roomRow = await prisma.room.findUnique({ where: { slug: room }, select: { id: true } });
        if (roomRow) {
          const restrictions = await refreshZoneRestrictionCache(prisma, room, roomRow.id);
          socket.emit(SocketEvents.ZONE_RESTRICTIONS, { zones: restrictions });
        }
      } catch (e) {
        console.warn('[room] failed to load zone restrictions:', e);
      }

      // QA #7/#8/#9 — every desk note currently on a furniture piece in this
      // room, so a fresh join sees them without a separate fetch. Its own
      // table (see DeskNote in schema.prisma), independent of the
      // legacy-furniture/layerData split above — never at risk of the
      // "wrote to the store ROOM_STATE isn't reading from" bug that
      // furnitureHandler.ts's seat-assignment fix (elsewhere in this same
      // pass) had to work around.
      const notes = dbRoom
        ? await getPrisma().deskNote.findMany({ where: { roomId: dbRoom.id } }).catch((e) => { console.warn('[room] failed to load desk notes:', e); return []; })
        : [];

      socket.emit(SocketEvents.ROOM_STATE, {
        ...state, tiles: redactDoorPasswords(tiles), furniture: redactInteractiveSecrets(savedFurniture || fallback!.furniture), zones: savedZones || fallback!.zones, players: playersWithMeta,
        impassableAreaRects: savedImpassableAreaRects,
        wallAreaRects: savedWallAreaRects,
        adminUserIds: Array.from(rs.adminUserIds), masterAdminUserId: rs.masterAdminUserId, staffUserIds: Array.from(rs.staffUserIds), theme, template,
        notice: roomNoticeMap.get(room) ?? null,
        locked: !!rs.locked,
        doorOverride: !!rs.doorOverride,
        role: getRole(rs, uid),
        // Fitur 15 — this room's custom Floor/Wall/Object uploads. Every
        // joining player needs these registered into PALETTE_BY_ID (see
        // useSocket.ts's ROOM_STATE handler) before `tiles`/`furniture` above
        // can resolve any custom paletteId they reference — not just the
        // admin who's in the (separate) Room Editor tab.
        customAssets: (dbRoom?.layerData as unknown as LayerData | undefined)?.customAssets ?? [],
        // Floor-plan reference image — editor-only unless the admin opted
        // into showInGame (see mapLayers.ts), in which case the photo itself
        // becomes part of the visible map for every joining player, same as
        // customAssets above. Only forwarded when the flag is on, so a
        // toggled-off image never leaks to game clients even if present.
        referenceImage: (() => {
          const ri = (dbRoom?.layerData as unknown as LayerData | undefined)?.referenceImage;
          return ri?.showInGame ? ri : null;
        })(),
        // Room-wide avatar sprite scale (see mapLayers.ts) — always forwarded,
        // no opt-in gate (purely cosmetic, no privacy/content concern like
        // referenceImage above). Undefined in layerData means 1 (unchanged).
        avatarScale: (dbRoom?.layerData as unknown as LayerData | undefined)?.avatarScale,
        notes: notes.map((n) => ({ id: n.id, x: n.x, y: n.y, authorUserId: n.authorUserId, authorName: n.authorName, text: n.text, updatedAt: n.updatedAt.getTime() })),
      });

      // "Tarik Paksa" (Force-pull) — this join just consumed a queued
      // landing spot from an offline force-pull (see saveLastKnownPosition
      // in the FORCE_PULL handler above); tell the client now that
      // ROOM_STATE has already given it a map/tiles to render against, so
      // the toast doesn't fire before there's anything on screen yet.
      // One-shot: deleted immediately so a later, unrelated reconnect to
      // the same remembered position never re-fires it.
      const forcePullNotice = pendingForcePullNotices.get(uid);
      if (forcePullNotice) {
        pendingForcePullNotices.delete(uid);
        socket.emit(SocketEvents.FORCE_PULLED, { byName: forcePullNotice });
      }

      // Soundboard — this room's custom sounds, sent once right after
      // ROOM_STATE (same "list arrives right after room:state" shape as
      // MEDIA_LIST in mediaHandler.ts). Default sounds need no server round
      // trip at all — SOUNDBOARD_DEFAULT_SOUNDS is a static shared constant
      // the client already has.
      if (dbRoom) {
        getPrisma().soundboardSound.findMany({ where: { roomId: dbRoom.id }, orderBy: { createdAt: 'asc' } })
          .then((rows) => socket.emit(SocketEvents.SOUNDBOARD_LIST, {
            sounds: rows.map((r) => ({ id: r.id, name: r.name, url: r.url, durationMs: r.durationMs, createdByName: r.createdByName })),
          }))
          .catch((e) => console.error('[room] soundboard list on join error:', e));
      }
    });
  });

  socket.on(SocketEvents.ROOM_LOCK_SET, (data: { locked: boolean }) => {
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'room:lock')) {
      socket.emit('admin:error', { message: 'Only admins can lock the room' });
      return;
    }
    rs.locked = !!data?.locked;
    // Unlocking wipes the knock allowlist — a fresh lock shouldn't silently
    // still admit whoever was let in during a previous lock session.
    if (!rs.locked) rs.knockAllowlist?.clear();
    // Everyone in the room (including the toggler) gets the new state so the
    // 🔒 indicator and the owner's Lock/Unlock control stay in sync.
    io.to(room).emit(SocketEvents.ROOM_LOCK_UPDATED, { locked: rs.locked });
    // Also tell every Lobby socket so its 🔒 badge updates live, same channel
    // the playerCount/removed lobby events already use (see Lobby.tsx).
    io.emit('lobby:room_lock', { roomId: room, locked: rs.locked });
    console.log(`[room] ${room} ${rs.locked ? 'LOCKED' : 'unlocked'} by uid=${senderUid}`);
  });

  // Akses & Password Pintu audit item #9 — emergency door override. Same
  // shape as ROOM_LOCK_SET above: admin+ only, broadcasts the new state to
  // everyone in the room (including the toggler) so the banner + the
  // admin's own toggle control stay in sync.
  socket.on(SocketEvents.DOOR_OVERRIDE_SET, (data: { active: boolean }) => {
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'door:override')) {
      socket.emit('admin:error', { message: 'Only admins can override door locks' });
      return;
    }
    rs.doorOverride = !!data?.active;
    io.to(room).emit(SocketEvents.DOOR_OVERRIDE_UPDATED, { active: rs.doorOverride });
    console.log(`[room] ${room} door override ${rs.doorOverride ? 'ON' : 'off'} by uid=${senderUid}`);
  });

  // Fitur 15B — Password prompt verification. The attempt is compared
  // against the room's OWN stored layerData, fetched fresh from the DB right
  // here — never against anything the client sent or cached, and the real
  // password never reaches this or any other client (see
  // redactInteractiveSecrets, applied to every furniture list this socket
  // otherwise receives).
  socket.on(SocketEvents.INTERACTIVE_PASSWORD_CHECK, async (data: InteractivePasswordCheckPayload) => {
    if (!canCheckInteractive(socket.id)) return;
    // QA (Akses tamu checklist item 2, "Guest terbatas") — interactive
    // objects (password prompts, door locks, API-triggered pieces,
    // multi-choice) are internal-workspace tooling, not meeting features a
    // link-in visitor needs.
    const room = currentRoom; if (!room) return;
    if (isRestrictedSocket(socket, room)) return;
    const furnitureId = data?.furnitureId, attempt = data?.attempt;
    if (typeof furnitureId !== 'string' || typeof attempt !== 'string') return;
    try {
      const dbRoom = await getPrisma().room.findUnique({ where: { slug: room }, select: { layerData: true } });
      if (!dbRoom?.layerData) return;
      const ld = dbRoom.layerData as unknown as LayerData;
      const piece = [...(ld.objects ?? []), ...(ld.topObjects ?? [])].find((f) => f.id === furnitureId);
      if (!piece || piece.interactiveType !== 'password') return;
      const correct = (piece.interactiveConfig?.password ?? '') === attempt;
      socket.emit(SocketEvents.INTERACTIVE_PASSWORD_RESULT, {
        furnitureId,
        correct,
        correctText: correct ? piece.interactiveConfig?.correctText : undefined,
        failureMessage: correct ? undefined : (piece.interactiveConfig?.failureMessage || 'Password salah.'),
      });
    } catch (e) {
      console.warn('[room] password check error:', e);
    }
  });

  // ZEP-style door password — same verification approach as the furniture
  // password check above (re-read the room's own stored layerData fresh,
  // never trust a client-side compare), keyed by tile (x,y) instead of a
  // furnitureId since a door is a TileEffect, not a Furniture piece. A
  // correct attempt unlocks the door for the rest of THIS socket's session
  // (see doorLock.ts) — movementHandler.ts consults that on every move, so
  // the actual "can walk through now" enforcement lives there, not here.
  socket.on(SocketEvents.INTERACTIVE_DOOR_PASSWORD_CHECK, async (data: InteractiveDoorPasswordCheckPayload) => {
    if (!canCheckInteractive(socket.id)) return;
    // QA (Akses tamu checklist item 2) — same reasoning as the furniture
    // password check above.
    const room = currentRoom; if (!room) return;
    if (isRestrictedSocket(socket, room)) return;
    const x = data?.x, y = data?.y, attempt = data?.attempt;
    if (!Number.isInteger(x) || !Number.isInteger(y) || typeof attempt !== 'string') return;
    try {
      const dbRoom = await getPrisma().room.findUnique({ where: { slug: room }, select: { layerData: true } });
      if (!dbRoom?.layerData) return;
      const ld = dbRoom.layerData as unknown as LayerData;
      const eff = ld.tileEffects.find((e) => e.x === x && e.y === y && e.kind === 'door');
      if (!eff?.doorPasswordEnabled) return;
      const correct = (eff.doorPassword ?? '') === attempt;
      if (correct) {
        unlockDoor(socket.id, room, x, y);
        // Item #6 follow-up — let everyone else in the room know this door
        // just got opened (no visual door state to sync yet, so this is a
        // notice only; see DOOR_UNLOCKED_NOTICE's doc comment).
        socket.to(room).emit(SocketEvents.DOOR_UNLOCKED_NOTICE, { x, y, byName: getPlayerName(socket.id) });
      }
      socket.emit(SocketEvents.INTERACTIVE_DOOR_PASSWORD_RESULT, {
        x, y, correct,
        failureMessage: correct ? undefined : (eff.doorFailureMessage || 'Password salah.'),
      });
    } catch (e) {
      console.warn('[room] door password check error:', e);
    }
  });

  // Fitur 15B — Multiple choice pop-up verification. Same shape as the
  // password check above: re-read the room's own stored layerData fresh,
  // never trust the client's own copy of which option is correct (that's
  // exactly what redactInteractiveSecrets already stripped from it).
  socket.on(SocketEvents.INTERACTIVE_CHOICE_CHECK, async (data: InteractiveChoiceCheckPayload) => {
    if (!canCheckInteractive(socket.id)) return;
    // QA (Akses tamu checklist item 2) — same reasoning as the interactive
    // handlers above.
    const room = currentRoom; if (!room) return;
    if (isRestrictedSocket(socket, room)) return;
    const furnitureId = data?.furnitureId, selectedIndex = data?.selectedIndex;
    if (typeof furnitureId !== 'string' || !Number.isInteger(selectedIndex)) return;
    try {
      const dbRoom = await getPrisma().room.findUnique({ where: { slug: room }, select: { layerData: true } });
      if (!dbRoom?.layerData) return;
      const ld = dbRoom.layerData as unknown as LayerData;
      const piece = [...(ld.objects ?? []), ...(ld.topObjects ?? [])].find((f) => f.id === furnitureId);
      if (!piece || piece.interactiveType !== 'multiple_choice') return;
      const correct = !!piece.interactiveConfig?.options?.[selectedIndex]?.isCorrect;
      socket.emit(SocketEvents.INTERACTIVE_CHOICE_RESULT, {
        furnitureId,
        correct,
        correctText: correct ? piece.interactiveConfig?.correctText : undefined,
        incorrectMessage: correct ? undefined : (piece.interactiveConfig?.incorrectMessage || 'Jawaban salah.'),
      });
    } catch (e) {
      console.warn('[room] choice check error:', e);
    }
  });

  // Fitur 15B — API call (POST), the last of the 6 Interactive Object types.
  // The client only ever sends {furnitureId} — never a URL. The server
  // resolves the room's OWN stored apiUrl (already https://-only, see
  // rooms.ts's sanitizeObjs) and performs the POST itself: doing this from
  // the browser would mean either a CORS failure against most third-party
  // APIs, or — if it somehow worked — the browser making requests an admin
  // configured, to wherever they configured, on every visiting player's own
  // network egress (SSRF-by-proxy). Bounded with a timeout so one slow
  // third-party endpoint can't hang this handler indefinitely.
  socket.on(SocketEvents.INTERACTIVE_API_CALL, async (data: InteractiveApiCallPayload) => {
    if (!canApiCall(socket.id)) return;
    // QA (Akses tamu checklist item 2) — this one especially: an admin-
    // configured API call is internal workspace tooling by definition, and
    // the server making the request on a guest's behalf is exactly the
    // SSRF-by-proxy risk the comment above already flags for real members.
    const room = currentRoom; if (!room) return;
    if (isRestrictedSocket(socket, room)) return;
    const furnitureId = data?.furnitureId;
    if (typeof furnitureId !== 'string') return;
    const uid = findUserIdBySocket(socket.id);
    const name = playerNames.get(socket.id) || 'Someone';
    try {
      const dbRoom = await getPrisma().room.findUnique({ where: { slug: room }, select: { layerData: true, name: true } });
      if (!dbRoom?.layerData) return;
      const ld = dbRoom.layerData as unknown as LayerData;
      const piece = [...(ld.objects ?? []), ...(ld.topObjects ?? [])].find((f) => f.id === furnitureId);
      const apiUrl = piece?.interactiveType === 'api_call' ? piece.interactiveConfig?.apiUrl : undefined;
      if (!apiUrl) {
        socket.emit(SocketEvents.INTERACTIVE_API_CALL_RESULT, { furnitureId, success: false, error: 'API URL belum diatur.' });
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: uid, displayName: name, roomSlug: room, roomName: dbRoom.name, furnitureId, timestamp: Date.now() }),
          signal: controller.signal,
        });
        if (!res.ok) { socket.emit(SocketEvents.INTERACTIVE_API_CALL_RESULT, { furnitureId, success: false, error: `Server API membalas status ${res.status}.` }); return; }
        socket.emit(SocketEvents.INTERACTIVE_API_CALL_RESULT, { furnitureId, success: true });
      } catch {
        socket.emit(SocketEvents.INTERACTIVE_API_CALL_RESULT, { furnitureId, success: false, error: 'Gagal menghubungi API (timeout atau jaringan).' });
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      console.warn('[room] api call error:', e);
    }
  });

  // Fitur 15B — Change object. Unlike every other Interactive Object type,
  // this one MUTATES the room's actual saved layerData (not a per-socket
  // reply): any player who triggers it removes the piece for EVERYONE,
  // matching ZEP's own intent (a shared gameplay object, not a personal
  // popup). Re-reads the room fresh from the DB and re-derives/broadcasts
  // through the exact same path the Room Editor's own save already uses
  // (layerDataToLegacy + redactInteractiveSecrets + ROOM_UPDATED), so every
  // client's furniture list updates the same way it would from an editor
  // save — no separate client-side removal logic needed anywhere.
  socket.on(SocketEvents.INTERACTIVE_CHANGE_OBJECT, async (data: InteractiveChangeObjectPayload) => {
    if (!canChangeObject(socket.id)) return;
    // QA (Akses tamu checklist item 2) — same reasoning as the interactive
    // handlers above; this one mutates the room's actual saved layerData
    // for everyone, so it's especially not something a guest should trigger.
    const room = currentRoom; if (!room) return;
    if (isRestrictedSocket(socket, room)) return;
    const furnitureId = data?.furnitureId;
    if (typeof furnitureId !== 'string') return;
    try {
      const dbRoom = await getPrisma().room.findUnique({ where: { slug: room } });
      if (!dbRoom?.layerData) return;
      const ld = dbRoom.layerData as unknown as LayerData;
      const piece = [...(ld.objects ?? []), ...(ld.topObjects ?? [])].find((f) => f.id === furnitureId);
      if (!piece || piece.interactiveType !== 'change_object') return;
      if ((piece.interactiveConfig?.afterAction ?? 'disappear') === 'disappear') {
        ld.objects = (ld.objects ?? []).filter((f) => f.id !== furnitureId);
        ld.topObjects = (ld.topObjects ?? []).filter((f) => f.id !== furnitureId);
        await getPrisma().room.update({ where: { id: dbRoom.id }, data: { layerData: ld as unknown as object } });
        const derived = layerDataToLegacy(ld);
        setCachedTiles(room, derived.tiles);
        setCachedImpassableAreas(room, derived.impassableAreaRects);
        setCachedZones(room, derived.zones);
        io.to(room).emit(SocketEvents.ROOM_UPDATED, { tiles: redactDoorPasswords(derived.tiles), furniture: redactInteractiveSecrets(derived.furniture), zones: derived.zones, impassableAreaRects: derived.impassableAreaRects, wallAreaRects: derived.wallAreaRects });
      }
    } catch (e) {
      console.warn('[room] change object error:', e);
    }
  });

  socket.on(SocketEvents.ROOM_KNOCK, (data: { roomId: string }) => {
    if (!canKnock(socket.id)) return; // rate-limited: no knock-spamming the host
    const room = data?.roomId;
    if (!room || typeof room !== 'string') return;
    const rs = getRoomAdmin(room);
    if (!rs.locked) return; // nothing to knock on
    const uid = (socket.data as { userId?: string }).userId || socket.id;
    const name = playerNames.get(socket.id) || 'Someone';
    // Ring only the admins currently connected to that room (resolved via the
    // uid→socket map) — the knock UI is admin-only, so this avoids leaking the
    // knocker's identity to every member. Remembered (by the KNOCKER's own
    // socket id) so a later ROOM_KNOCK_CANCEL — or the knocker simply
    // disconnecting — can tell exactly these same admin sockets to drop it,
    // instead of leaving a stale "X is knocking" toast up after they changed
    // their mind or left.
    const notifiedAdminSocketIds: string[] = [];
    for (const adminUid of rs.adminUserIds) {
      const adminSocketId = userSocketMap.get(adminUid);
      if (adminSocketId && io.sockets.sockets.get(adminSocketId)) {
        io.to(adminSocketId).emit(SocketEvents.ROOM_KNOCK_REQUEST, { userId: uid, name });
        notifiedAdminSocketIds.push(adminSocketId);
      }
    }
    pendingKnocks.set(socket.id, { uid, name, notifiedAdminSocketIds });
    console.log(`[room] ${name} (uid=${uid}) knocked on ${room} — ${notifiedAdminSocketIds.length} admin(s) notified`);
  });

  // The knocker changed their mind before the host responded — tell every
  // admin socket that got the original ROOM_KNOCK_REQUEST to drop it, so the
  // host can't admit/reject a request that's already been withdrawn.
  socket.on(SocketEvents.ROOM_KNOCK_CANCEL, () => {
    cancelKnock(socket.id, io);
  });

  socket.on(SocketEvents.ROOM_KNOCK_ADMIT, (data: { userId: string }) => {
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'room:lock')) {
      socket.emit('admin:error', { message: 'Only admins can admit knockers' });
      return;
    }
    if (typeof data?.userId !== 'string') return;
    // Only honor this if there's still a matching PENDING knock — closes the
    // race where the knocker cancels the instant the host clicks Admit. A
    // cancelled request must never be approvable, not just visually hidden.
    let matchedSid: string | null = null;
    for (const [sid, pk] of pendingKnocks) { if (pk.uid === data.userId) { matchedSid = sid; break; } }
    if (!matchedSid) {
      socket.emit('admin:error', { message: 'Permintaan ini sudah dibatalkan' });
      return;
    }
    pendingKnocks.delete(matchedSid);
    if (!rs.knockAllowlist) rs.knockAllowlist = new Set();
    rs.knockAllowlist.add(data.userId);
    // Ping the knocker's socket so their client can auto-retry the join.
    const knockerSocketId = userSocketMap.get(data.userId);
    if (knockerSocketId) io.to(knockerSocketId).emit(SocketEvents.ROOM_KNOCK_ADMITTED, { roomId: room });
    console.log(`[room] uid=${data.userId} admitted to ${room} by uid=${senderUid}`);
  });

  // Guest Link & Ruang Tunggu — admin decides a pending guest request (see
  // JOIN_ROOM's guest branch above). admit adds the guestId to
  // guestAllowlist and pings the guest's own socket to retry JOIN_ROOM
  // (identical mechanic to ROOM_KNOCK_ADMIT/ADMITTED above); reject just
  // tells the guest's socket why, with no allowlist entry created.
  socket.on(SocketEvents.GUEST_JOIN_DECIDE, (data: { guestId: string; admit: boolean }) => {
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'guest:manage')) {
      socket.emit('admin:error', { message: 'Only admins can decide on guest requests' });
      return;
    }
    if (typeof data?.guestId !== 'string') return;
    const pending = rs.pendingGuests?.get(data.guestId);
    if (!pending) {
      socket.emit('admin:error', { message: 'Permintaan tamu ini sudah tidak berlaku' });
      return;
    }
    rs.pendingGuests!.delete(data.guestId);
    const guestSocket = io.sockets.sockets.get(pending.socketId);
    if (data.admit) {
      if (!rs.guestAllowlist) rs.guestAllowlist = new Set();
      rs.guestAllowlist.add(data.guestId);
      if (guestSocket) guestSocket.emit(SocketEvents.GUEST_JOIN_ADMITTED, { roomSlug: room });
      console.log(`[room] guest ${data.guestId} admitted to ${room} by uid=${senderUid}`);
    } else {
      if (guestSocket) guestSocket.emit(SocketEvents.GUEST_JOIN_REJECTED, { roomSlug: room });
      console.log(`[room] guest ${data.guestId} rejected from ${room} by uid=${senderUid}`);
    }
  });

  socket.on(SocketEvents.ADMIN_GRANT, (data: { targetUserId: string }) => {
    if (!canChangeAdmin(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'admin:grant')) {
      socket.emit('admin:error', { message: 'Only admins can grant admin' });
      return;
    }
    rs.adminUserIds.add(data.targetUserId);
    // Promoted straight to admin — no longer "just" staff.
    rs.staffUserIds.delete(data.targetUserId);
    broadcastAdmin(io, room, rs);
    persistRoleGrant(room, data.targetUserId, 'admin');
  });

  socket.on(SocketEvents.ADMIN_REVOKE, (data: { targetUserId: string }) => {
    if (!canChangeAdmin(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'admin:revoke')) {
      socket.emit('admin:error', { message: 'Only the master admin can revoke' });
      return;
    }
    if (data.targetUserId === rs.masterAdminUserId) {
      socket.emit('admin:error', { message: 'Cannot revoke the master admin' });
      return;
    }
    rs.adminUserIds.delete(data.targetUserId);
    broadcastAdmin(io, room, rs);
    persistRoleGrant(room, data.targetUserId, 'member');
  });

  // Staff sits between admin and member — see RoomAdminState's doc comment.
  socket.on(SocketEvents.STAFF_GRANT, (data: { targetUserId: string }) => {
    if (!canChangeAdmin(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'staff:grant')) {
      socket.emit('admin:error', { message: 'Only admins can grant staff' });
      return;
    }
    if (rs.adminUserIds.has(data.targetUserId)) return; // already admin-or-above, no-op
    rs.staffUserIds.add(data.targetUserId);
    broadcastAdmin(io, room, rs);
    persistRoleGrant(room, data.targetUserId, 'staff');
  });

  socket.on(SocketEvents.STAFF_REVOKE, (data: { targetUserId: string }) => {
    if (!canChangeAdmin(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'staff:revoke')) {
      socket.emit('admin:error', { message: 'Only admins can revoke staff' });
      return;
    }
    rs.staffUserIds.delete(data.targetUserId);
    broadcastAdmin(io, room, rs);
    persistRoleGrant(room, data.targetUserId, 'member');
  });

  // §4 — Teleport. Resolves the real x/y from the location's OWN stored
  // data (DB lookup by id, scoped to this room) rather than trusting
  // whatever coordinates a client might supply directly — same
  // server-authoritative principle as regular movement (§1). Skips
  // pathfinding entirely (spec's own instruction) but still runs the exact
  // same collision check regular movement does, so a teleport location can
  // never drop someone into a wall even if the room layout changed since
  // the location was saved.
  socket.on(SocketEvents.TELEPORT_REQUEST, async (data: TeleportRequest) => {
    if (!canTeleport(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const uid = findUserIdBySocket(socket.id);
    if (!uid || !data || (data.kind !== 'admin' && data.kind !== 'bookmark' && data.kind !== 'seat')) return;

    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
      if (!dbRoom) return;

      let target: { x: number; y: number } | null = null;
      // Only set for kind 'seat' — tells the client to sit down immediately
      // after landing, instead of just standing at the seat's tile (see
      // useSocket.ts's PLAYER_TELEPORTED handler).
      let seatFurnitureId: string | undefined;

      if (data.kind === 'seat') {
        // No locationId to look up — resolved straight from the requester's
        // own uid. Reads the room's furniture the same way the rest of this
        // file loads saved map data (dbRoom.furniture JSON), not through
        // furnitureHandler.ts's private state, matching this handler's own
        // existing "small deliberate duplication for decoupling" convention.
        const furnitureList = Array.isArray(dbRoom.furniture) ? (dbRoom.furniture as any[]) : [];
        const seat = furnitureList.find((f) => f?.assignedToUserId === uid);
        if (!seat) {
          socket.emit('admin:error', { message: "You don't have an assigned seat in this room" });
          return;
        }
        target = { x: seat.x, y: seat.y };
        seatFurnitureId = seat.id;
      } else if (data.kind === 'admin') {
        const rs = getRoomAdmin(room);
        // Bug 4 — USING a team location is open to every member; only
        // creating/deleting/reordering them (REST, see routes/teleport.ts)
        // stays 'teleport:admin'. The DB lookup is still scoped to this room,
        // so a member can only jump to a location that actually exists here.
        if (!canAccess(rs, uid, 'teleport:use')) {
          socket.emit('admin:error', { message: 'Room access required to use team locations' });
          return;
        }
        const loc = await prisma.teleportLocation.findFirst({ where: { id: data.locationId, roomId: dbRoom.id } });
        if (loc) target = { x: loc.x, y: loc.y };
      } else {
        // Bookmarks are owner-only, and only the owner's OWN bookmarks —
        // scoping the lookup by ownerId as well as id means a non-owner (or
        // a different owner in some other room) can never hit another
        // user's bookmark row even by guessing/brute-forcing ids.
        if (dbRoom.ownerId !== uid) {
          socket.emit('admin:error', { message: 'Bookmarks are owner-only' });
          return;
        }
        const bm = await prisma.ownerBookmark.findFirst({ where: { id: data.locationId, roomId: dbRoom.id, ownerId: uid } });
        if (bm) target = { x: bm.x, y: bm.y };
      }

      if (!target) {
        socket.emit('admin:error', { message: 'Teleport location not found' });
        return;
      }

      const pixelX = target.x * TILE_SIZE + TILE_SIZE / 2;
      const pixelY = target.y * TILE_SIZE + TILE_SIZE / 2;
      // Skipped for kind 'seat' — a chair tile is meant to be stood/sat on
      // by design (the ordinary sit flow already puts a player there with
      // no server-side tile-blocked check at all, see PLAYER_SIT's handler
      // below), unlike admin/bookmark locations which are arbitrary map
      // points that genuinely could have been placed inside a wall since.
      const tiles = getCachedTiles(room);
      if (data.kind !== 'seat' && tiles && isTileBlocked(tiles, target.x, target.y)) {
        // Spec's own rule: if the resolved tile is invalid, leave the
        // player where they were rather than forcing them into a wall.
        socket.emit('admin:error', { message: 'That location is blocked and can’t be teleported to right now' });
        return;
      }

      updatePlayerPosition(room, socket.id, pixelX, pixelY, 'down');
      io.to(room).emit(SocketEvents.PLAYER_TELEPORTED, { id: socket.id, x: pixelX, y: pixelY, direction: 'down', seatFurnitureId });
    } catch (e) {
      console.error('[room] teleport error:', e);
    }
  });

  // §5.1 — Summon (single user), request/consent step. Nothing moves yet —
  // this only starts a pending request the target has to accept, mirroring
  // Follow's consent flow below. Destination is captured as the actor's live
  // position NOW (not re-read at accept time) so the target ends up where
  // the actor was when they asked, not wherever the actor wandered to while
  // the request sat unanswered.
  socket.on(SocketEvents.SUMMON_USER, async (data: { nickname: string }) => {
    if (!canSummonUser(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const uid = findUserIdBySocket(socket.id);
    const nickname = data?.nickname?.trim();
    if (!uid || !nickname) return;
    // QA (Akses tamu checklist item 2, "Guest terbatas") — "open to ALL
    // roles" in the comment below has only ever meant every REAL member
    // tier (member/staff/admin/owner), not guests — a link-in visitor
    // pulling a real employee across the map isn't a case that comment's
    // "per product decision" was actually about.
    if (isRestrictedSocket(socket, room)) return;

    // Summon is open to ALL roles (per product decision) — no staff gate. The
    // safety rails that remain are enough: the target must ACCEPT (consent),
    // it's rate-limited (canSummonUser), and it still respects locked zones +
    // Focus mode below. uid is validated above only to identify the requester.
    const players = await getPlayers(room);
    const actor = players.find((p) => p.id === socket.id);
    if (!actor) return;

    // Spec §5.1: duplicate nicknames resolve to whoever joined THIS session
    // most recently — addPlayer() always appends, so the last array match
    // is exactly that, with no separate joinedAt field needed.
    const matches = players.filter((p) => p.id !== socket.id && p.name === nickname);
    if (matches.length === 0) {
      socket.emit('admin:error', { message: 'Player not found in this room' });
      return;
    }
    const target = matches[matches.length - 1];
    // A locked zone holds its people: they can't be summoned out of a meeting
    // any more than they could walk out of it. Staff rank doesn't override the
    // keyholder — that's the whole point of the lock.
    if (isUserInLockedZone(room, findUserIdBySocket(target.id) ?? undefined, zoneIdOfSocket(target.id))) {
      socket.emit('admin:error', { message: `${target.name} sedang di zona terkunci — tidak bisa dipanggil.` });
      return;
    }
    // A4 — respect A3's Focus/DND: someone in focus mode can't be summoned.
    if (target.workMode === 'focus') {
      socket.emit('admin:error', { message: `${target.name} sedang dalam mode Focus — tidak bisa dipanggil sekarang.` });
      return;
    }

    clearPendingSummon(target.id);
    const requestId = randomUUID();
    const actorName = getPlayerName(socket.id);
    const timeout = setTimeout(() => {
      pendingSummons.delete(target.id);
      io.to(socket.id).emit(SocketEvents.SUMMON_RESULT, { targetName: target.name, accepted: false, reason: 'timeout' });
    }, CONSENT_REQUEST_TIMEOUT_MS);
    pendingSummons.set(target.id, { requestId, fromSocketId: socket.id, fromName: actorName, x: actor.x, y: actor.y, direction: actor.direction, timeout });
    io.to(target.id).emit(SocketEvents.SUMMON_REQUEST, { requestId, actorName });
  });

  // Target's reply to a pending Summon request. Accept moves them to the
  // requester's captured position via the same PLAYER_TELEPORTED broadcast
  // Teleport uses; decline just clears it. Either way the requester gets
  // SUMMON_RESULT so their UI knows what happened instead of waiting
  // silently forever.
  socket.on(SocketEvents.SUMMON_RESPOND, async (data: SummonRespondPayload) => {
    const room = currentRoom; if (!room) return;
    const pending = pendingSummons.get(socket.id);
    if (!pending || pending.requestId !== data?.requestId) return;
    clearPendingSummon(socket.id);

    const targetName = getPlayerName(socket.id);
    if (!data.accept) {
      io.to(pending.fromSocketId).emit(SocketEvents.SUMMON_RESULT, { targetName, accepted: false, reason: 'declined' });
      return;
    }

    const players = await getPlayers(room);
    const stillRequester = players.find((p) => p.id === pending.fromSocketId);
    if (!stillRequester) {
      io.to(pending.fromSocketId).emit(SocketEvents.SUMMON_RESULT, { targetName, accepted: false, reason: 'offline' });
      return;
    }

    // Land BESIDE the requester, not on top of them. Teleporting to their
    // exact x/y stacked both avatars on one tile — the summoned player was
    // there, but hidden underneath, so someone had to walk a step before it
    // looked like anything had happened at all. Same helper (and the same
    // "no tiles cached → assume the tile below" fallback) the My Seat
    // landing already uses, so both land the same way.
    const tiles = getCachedTiles(room);
    const tileX = Math.floor(stillRequester.x / TILE_SIZE);
    const tileY = Math.floor(stillRequester.y / TILE_SIZE);
    const spot = tiles && tiles.length > 0
      ? findAdjacentFreeTile(tiles, tileX, tileY)
      : { x: tileX, y: tileY + 1 };
    const landX = spot.x * TILE_SIZE + TILE_SIZE / 2;
    const landY = spot.y * TILE_SIZE + TILE_SIZE / 2;

    // Potongan A1 — keyholder-summon bypasses the lock. Only when the summon
    // really did come from whoever currently holds the key on the zone the
    // requester is standing in (verified HERE, server-side, via
    // zoneKeyholderOf — never taken on the client's word: a modified client
    // claiming "I was summoned" can't forge this, since it depends on the
    // REQUESTER's own tracked zone and that zone's real lock record) — OR
    // from an admin+, same trust tier that can already lock/unlock any
    // room's zones outright ('room:lock'), so being able to override entry
    // via summon too is the same permission, not a new one. A non-keyholder,
    // non-admin summoner still can't bypass anything.
    // Admits the target into that zone's allowedUserIds — the exact
    // mechanism ZONE_KNOCK_DECIDE already uses for a granted knock — then
    // tells the target's own client BEFORE the teleport below, so its
    // zone-entry effect (App.tsx) already sees them as admitted and doesn't
    // bounce them back out the instant they land. Summons into an unlocked
    // zone, or from anyone without either of these, are unaffected —
    // mayEnterZone/the client bounce still apply exactly as before.
    const requesterUid = findUserIdBySocket(pending.fromSocketId);
    const targetUid = findUserIdBySocket(socket.id);
    const requesterZoneId = zoneIdOfSocket(pending.fromSocketId);
    if (requesterZoneId && requesterUid && targetUid) {
      const rs = getRoomAdmin(room);
      if (zoneKeyholderOf(room, requesterZoneId) === requesterUid || canAccess(rs, requesterUid, 'room:lock')) {
        admitUserToZone(room, requesterZoneId, targetUid);
        socket.emit(SocketEvents.ZONE_KNOCK_DECIDED, { zoneId: requesterZoneId, admitted: true, byName: stillRequester.name });
      }
    }

    updatePlayerPosition(room, socket.id, landX, landY, stillRequester.direction);
    io.to(room).emit(SocketEvents.PLAYER_TELEPORTED, { id: socket.id, x: landX, y: landY, direction: stillRequester.direction });
    io.to(pending.fromSocketId).emit(SocketEvents.SUMMON_RESULT, { targetName, accepted: true });
  });

  // "Tarik Paksa" (Force-pull) — admin+ only, NO consent step (that's the
  // whole difference from Summon above): targets by uid (like Kick), not
  // nickname, so there's no duplicate-name resolution to worry about.
  socket.on(SocketEvents.FORCE_PULL, async (data: { targetUserId: string }) => {
    if (!canForcePull(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'force_pull')) {
      socket.emit('admin:error', { message: 'Only admins can force-pull' });
      return;
    }
    const targetUserId = data?.targetUserId;
    if (typeof targetUserId !== 'string' || targetUserId === senderUid) return;

    const players = await getPlayers(room);
    const actor = players.find((p) => p.id === socket.id);
    if (!actor) return;
    const actorName = getPlayerName(socket.id);

    // Land BESIDE the admin, not on top of them — same reasoning as
    // Summon's accept path above.
    const tiles = getCachedTiles(room);
    const tileX = Math.floor(actor.x / TILE_SIZE);
    const tileY = Math.floor(actor.y / TILE_SIZE);
    const spot = tiles && tiles.length > 0
      ? findAdjacentFreeTile(tiles, tileX, tileY)
      : { x: tileX, y: tileY + 1 };
    const landX = spot.x * TILE_SIZE + TILE_SIZE / 2;
    const landY = spot.y * TILE_SIZE + TILE_SIZE / 2;

    const targetSocketId = userSocketMap.get(targetUserId);
    const targetSocket = targetSocketId ? io.sockets.sockets.get(targetSocketId) : undefined;

    if (!targetSocket) {
      // Offline right now — queue the landing spot for their next join to
      // THIS room (same slot a normal reconnect already resumes from, see
      // getLastKnownPosition in JOIN_ROOM above) and best-effort notify via
      // Lark since there's no live client to tell directly.
      saveLastKnownPosition(targetUserId, room, landX, landY, 'down');
      pendingForcePullNotices.set(targetUserId, actorName);
      notifyForcePullOffline(targetUserId, actorName, room).catch((e) => console.error('[room] force-pull notify error:', e));
      socket.emit(SocketEvents.FORCE_PULL_RESULT, { targetUserId, delivered: false });
      console.log(`[room] uid=${targetUserId} force-pulled (queued, offline) in ${room} by uid=${senderUid}`);
      return;
    }

    // Same locked-zone bypass Summon's accept path uses — an admin
    // force-pulling always qualifies (force_pull and room:lock are both
    // admin-tier, so canAccess(..., 'room:lock') is already true here),
    // which is exactly the intent: "force" means it isn't stopped by a lock
    // either. Admits the target into whatever zone the ADMIN is currently
    // standing in (that's where they're landing), same admit-then-teleport
    // ordering as Summon so the target's own client doesn't bounce them
    // back out the instant they arrive.
    const adminZoneId = zoneIdOfSocket(socket.id);
    if (adminZoneId && senderUid && canAccess(rs, senderUid, 'room:lock')) {
      admitUserToZone(room, adminZoneId, targetUserId);
      targetSocket.emit(SocketEvents.ZONE_KNOCK_DECIDED, { zoneId: adminZoneId, admitted: true, byName: actorName });
    }

    updatePlayerPosition(room, targetSocket.id, landX, landY, 'down');
    io.to(room).emit(SocketEvents.PLAYER_TELEPORTED, { id: targetSocket.id, x: landX, y: landY, direction: 'down' });
    targetSocket.emit(SocketEvents.FORCE_PULLED, { byName: actorName });
    socket.emit(SocketEvents.FORCE_PULL_RESULT, { targetUserId, delivered: true });
    console.log(`[room] uid=${targetUserId} force-pulled in ${room} by uid=${senderUid}`);
  });

  // A10 — Slap/Tap ("colek"): a one-way, ephemeral attention nudge. Reuses
  // Summon's target resolution (by nickname, most-recent match) and Focus/DND
  // respect, but with NO consent dance — just relay to the target after a
  // 30s-per-target cooldown. Nothing persisted (optional activity_log only).
  socket.on(SocketEvents.SLAP, async (data: { nickname: string }) => {
    if (!canSlap(socket.id)) return;
    // QA (Akses tamu checklist item 2) — no consent step at all (unlike
    // Summon above), so this is even less appropriate for a guest to reach
    // than Summon is.
    const room = currentRoom; if (!room) return;
    if (isRestrictedSocket(socket, room)) return;
    const nickname = data?.nickname?.trim();
    if (!nickname) return;

    const players = await getPlayers(room);
    const matches = players.filter((p) => p.id !== socket.id && p.name === nickname);
    if (matches.length === 0) {
      socket.emit('admin:error', { message: 'Orang itu tidak ada di room ini.' });
      return;
    }
    const target = matches[matches.length - 1];

    // Respect A3 Focus/DND — same rule as Summon.
    if (target.workMode === 'focus') {
      socket.emit('admin:error', { message: `${target.name} sedang fokus — tidak bisa dicolek sekarang.` });
      return;
    }

    // 30s-per-target cooldown (the 2nd rapid colek to the same person is dropped).
    const key = `${socket.id}:${target.id}`;
    const now = Date.now();
    const last = slapCooldown.get(key) ?? 0;
    if (now - last < SLAP_COOLDOWN_MS) {
      const wait = Math.ceil((SLAP_COOLDOWN_MS - (now - last)) / 1000);
      socket.emit('admin:error', { message: `Sabar ya, tunggu ${wait} detik sebelum colek ${target.name} lagi.` });
      return;
    }
    slapCooldown.set(key, now);

    // Scoped to exactly these 2 sockets — target gets SLAPPED, sender gets
    // SLAP_SENT as a local confirmation. Neither is broadcast to the room, so
    // bystanders never receive an event to play a sound from.
    io.to(target.id).emit(SocketEvents.SLAPPED, { fromName: getPlayerName(socket.id), fromId: socket.id });
    socket.emit(SocketEvents.SLAP_SENT, { targetName: target.name });

    // Optional, non-fatal: usage stats. logActivity is a guarded no-op unless
    // the Lark Base activity table is configured (see lib/larkBase).
    const uid = findUserIdBySocket(socket.id);
    if (uid) void logActivity({ eventType: 'slap', userId: uid, room, detail: { targetId: findUserIdBySocket(target.id) ?? target.id } });
  });

  socket.on(SocketEvents.AVATAR_UPDATE, (avatarConfig: AvatarConfig) => {
    const room = currentRoom; if (!room) return;
    socket.to(room).emit(SocketEvents.AVATAR_UPDATED, { id: socket.id, avatarConfig });
    updatePlayerAvatarConfig(room, socket.id, avatarConfig);
    // Bug 2 — playerNames only got set once, at JOIN_ROOM. Renaming mid-session
    // never touched it, so every system-generated message that reads a name
    // through getPlayerName() (nudge, follow/summon requests, slap, knock,
    // notice-pin "by X") kept saying the OLD name for the rest of that
    // session, even though the nametag/ParticipantPanel — which read
    // playerRecords directly, not this map — updated live and correctly.
    if (avatarConfig.name) playerNames.set(socket.id, avatarConfig.name);
  });

  socket.on(SocketEvents.PLAYER_HAND, async (raised: boolean) => {
    const room = currentRoom; if (!room) return;
    // QA (Akses tamu checklist item 2, "Guest terbatas") — hand raise is a
    // meeting-participation cue a guest attending a meeting has no real
    // need for; kept to move/chat/mic/camera/screen per the confirmed cut.
    if (isRestrictedSocket(socket, room)) return;
    const val = !!raised;
    // Visual ✋ badge: whole room, both raise and lower (unchanged).
    socket.to(room).emit(SocketEvents.PLAYER_HAND_UPDATED, { id: socket.id, handRaised: val });
    updatePlayerHand(room, socket.id, val);

    // Bug 14 — sound cue only on RAISE, throttled per sender, never blasted to
    // the whole map. Focus/DND is respected on the receiving client (a focused
    // user still gets the badge, not the sound). Audience computed by
    // getNearbyRecipients (proximityBroadcast.ts) — the SAME zone/proximity
    // rule the Soundboard feature reuses below, so the two never drift apart.
    if (!val) return;
    const now = Date.now();
    if (now - (handSoundCooldown.get(socket.id) ?? 0) < HAND_SOUND_COOLDOWN_MS) return;
    handSoundCooldown.set(socket.id, now);
    const fromName = getPlayerName(socket.id);
    const recipients = await getNearbyRecipients(room, socket.id);
    for (const sid of recipients) {
      io.to(sid).emit(SocketEvents.HAND_RAISED_ALERT, { fromId: socket.id, fromName });
    }
  });

  // Mic mute toggle — same relay+persist shape as raise-hand above, so a
  // muted badge shows for a peer even outside WebRTC proximity range.
  socket.on(SocketEvents.PLAYER_MIC, async (muted: boolean) => {
    const room = currentRoom; if (!room) return;
    const val = !!muted;
    socket.to(room).emit(SocketEvents.PLAYER_MIC_UPDATED, { id: socket.id, micMuted: val });
    updatePlayerMic(room, socket.id, val);
  });

  // Manual "hide myself" toggle — same relay+persist shape as mic above.
  // Purely a broadcast flag; enforcing WHO gets to see a hidden avatar
  // (skipping render for non-admin viewers) is entirely client-side (see
  // GameCanvas.tsx/Minimap.tsx/ParticipantPanel.tsx) — the server doesn't
  // gate visibility. It DOES gate who may use Ghost mode at all, below.
  socket.on(SocketEvents.PLAYER_HIDDEN, async (hidden: boolean) => {
    const room = currentRoom; if (!room) return;
    // Ghost mode is admin+ only (see shared/permissions.ts's 'player:hide')
    // — this single check already covers guests/restricted-tier too, since
    // isRestrictedSocket's whole point was clamping them below 'member',
    // well under 'admin'.
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'player:hide')) {
      socket.emit('admin:error', { message: 'Hanya admin yang bisa pakai mode ghost' });
      return;
    }
    const val = !!hidden;
    socket.to(room).emit(SocketEvents.PLAYER_HIDDEN_UPDATED, { id: socket.id, hidden: val });
    updatePlayerHidden(room, socket.id, val);
  });

  // Soundboard — cosmetic, fire-and-forget, same trust level as Jump/Nudge:
  // soundId is never resolved to a URL here (the client resolves it locally
  // from either the static default list or its own fetched custom-sounds
  // list — see shared/types' doc comment on SOUNDBOARD_PLAY), so a bogus id
  // just fails to match anything client-side and no-ops. Audience is the
  // SAME getNearbyRecipients used by the raise-hand chime above — one scope
  // rule for both, not two similar-but-separately-maintained copies.
  socket.on(SocketEvents.SOUNDBOARD_PLAY, async (data: SoundboardPlayPayload) => {
    const room = currentRoom; if (!room) return;
    // QA (Akses tamu checklist item 2) — cosmetic but still fits the "very
    // few features" cut — a visitor blasting sound effects isn't a case
    // worth keeping open.
    if (isRestrictedSocket(socket, room)) return;
    const soundId = data?.soundId;
    if (typeof soundId !== 'string' || !soundId) return;
    const now = Date.now();
    if (now - (soundboardCooldown.get(socket.id) ?? 0) < SOUNDBOARD_COOLDOWN_MS) return;
    soundboardCooldown.set(socket.id, now);
    const recipients = await getNearbyRecipients(room, socket.id);
    for (const sid of recipients) {
      io.to(sid).emit(SocketEvents.SOUNDBOARD_PLAYED, { fromId: socket.id, soundId });
    }
  });

  // A3 — Focus/Public work mode. Broadcast + persist like status/hand so other
  // clients update the badge and room:state carries it for late joiners.
  socket.on(SocketEvents.WORK_MODE_CHANGE, (data: { mode: WorkMode; zoneId?: string; reason?: string }) => {
    const room = currentRoom; if (!room) return;
    const VALID: WorkMode[] = ['available', 'in_meeting', 'focus', 'lunch', 'away', 'wfh', 'wfo', 'wfa', 'cuti', 'break'];
    const mode: WorkMode = VALID.includes(data?.mode) ? data.mode : 'available';
    // Fitur 3B — a reason only ever makes sense alongside 'away' (the popup
    // that produces it only ever fires for that transition); never trust the
    // client to keep it short/clean either.
    const reason = mode === 'away' && typeof data?.reason === 'string'
      ? data.reason.trim().slice(0, AWAY_REASON_MAX_LENGTH) || undefined
      : undefined;
    socket.to(room).emit(SocketEvents.WORK_MODE_CHANGED, { id: socket.id, workMode: mode, reason });
    updatePlayerWorkMode(room, socket.id, mode, reason);
    // A11 — log presence changes to Lark Base. Guarded no-op until the
    // table/scope are set up, so a logging failure never affects the live
    // change above.
    const uid = (socket.data as { userId?: string }).userId ?? socket.id;
    void logActivity({
      eventType: 'presence_change',
      userId: uid,
      room,
      detail: { to: mode, zoneId: data?.zoneId, reason },
    });
  });

  // ZEP-style Spotlight — admin-only, targets another player (unlike
  // WORK_MODE_CHANGE above, which is self-service), so this needs the same
  // permission-check + userId→socket resolution shape as PLAYER_KICK below,
  // not the self-service shape. Broadcasts with io.to() (not socket.to()) so
  // the TARGET's own client also learns about it — they never applied this
  // locally themselves the way a self-service toggle would.
  socket.on(SocketEvents.SPOTLIGHT_TOGGLE, async (data: { targetUserId: string; active: boolean }) => {
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'presence:spotlight')) {
      socket.emit('admin:error', { message: 'Only admins can toggle Spotlight' });
      return;
    }
    const targetUserId = data?.targetUserId;
    if (!targetUserId) return;
    const targetSocketId = userSocketMap.get(targetUserId);
    if (!targetSocketId) return;
    const active = !!data.active;

    await updatePlayerSpotlight(room, targetSocketId, active);
    io.to(room).emit(SocketEvents.SPOTLIGHT_CHANGED, { id: targetSocketId, active });
  });

  // QA #9/#10 — CEO/admin-only text broadcast, the text counterpart to
  // Spotlight above. 1/sec is deliberately tighter than any chat rate
  // limit — this is a room-wide PA push shown to everyone at once, not a
  // conversation. Fire-and-forget Lark relay (an outage there must never
  // block the in-app broadcast, same posture as relayChannelMessageToLark).
  socket.on(SocketEvents.BROADCAST_SEND, async (data: { text: string }) => {
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'broadcast:text')) {
      socket.emit('admin:error', { message: 'Only admins can broadcast' });
      return;
    }
    if (!canBroadcast(socket.id)) return;
    const text = sanitizeChat(data?.text || '').slice(0, 500);
    if (!text) return;

    const senderName = getPlayerName(socket.id);
    const sentAt = Date.now();
    io.to(room).emit(SocketEvents.BROADCAST_RECEIVED, { text, senderName, sentAt });

    try {
      const dbRoom = await getPrisma().room.findUnique({ where: { slug: room }, select: { id: true } });
      if (dbRoom) void relayBroadcastToLark(getPrisma(), dbRoom.id, senderName, text).catch((e) => console.error('[room] broadcast Lark relay failed:', e));
    } catch (e) {
      console.error('[room] broadcast Lark lookup failed:', e);
    }
  });

  socket.on(SocketEvents.PLAYER_SIT, (data: { sitting: boolean; x: number; y: number; direction: Avatar['direction']; seatFurnitureId?: string }) => {
    const room = currentRoom; if (!room) return;
    // QA (Akses tamu checklist item 2) — chairs (transient sit, distinct
    // from the persistent "assign as my seat" claim, which was already
    // guest-blocked before this — furnitureHandler.ts isn't registered for
    // guest sockets at all) aren't part of the kept-open guest feature set.
    if (isRestrictedSocket(socket, room)) return;
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number') return;
    // seatFurnitureId rides along so peers know WHICH chair this is — chairs
    // sharing a Furniture.tableId form a private audio group (see the client's
    // useProximity). Cleared (undefined) on stand-up.
    const seatFurnitureId = data.sitting && typeof data.seatFurnitureId === 'string' ? data.seatFurnitureId : undefined;
    const payload = { id: socket.id, isSitting: !!data.sitting, x: data.x, y: data.y, direction: data.direction, seatFurnitureId };
    socket.to(room).emit(SocketEvents.PLAYER_SAT, payload);
    updatePlayerSitting(room, socket.id, payload.isSitting, payload.x, payload.y, payload.direction, seatFurnitureId);
  });

  socket.on(SocketEvents.ROOM_UPDATE, (payload: RoomUpdatePayload) => {
    if (!canUpdateRoom(socket.id)) return;
    const room = currentRoom; if (!room) return;
    // This was previously the one handler in this file with NO server-side
    // permission check at all — only the Room Editor button being hidden
    // from non-admins in the UI kept a plain member from saving tilemap
    // changes. Any client could otherwise emit room:update directly and
    // overwrite the room regardless of role — exactly the gap §2 warns
    // about ("jangan hanya sembunyikan tombol di frontend").
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, findUserIdBySocket(socket.id), 'room:update')) {
      socket.emit('admin:error', { message: 'Only admins can edit this room' });
      return;
    }
    // Door passwords must never reach a normal player — same redaction as
    // the Room Editor's own save path (redactDoorPasswords), applied only
    // to what's BROADCAST; the cache below keeps the real payload so
    // movementHandler.ts's collision check still has the actual password.
    socket.to(room).emit(SocketEvents.ROOM_UPDATED, { ...payload, tiles: redactDoorPasswords(payload.tiles) });
    // Keep movementHandler.ts's collision cache in sync with whatever the
    // admin just saved — otherwise a wall added/removed in the Room Editor
    // wouldn't take effect for server-side movement validation until the
    // next full room rejoin.
    setCachedTiles(room, payload.tiles);
    setCachedZones(room, payload.zones ?? []);
    try {
      getPrisma().room.update({
        where: { slug: room },
        data: {
          tilemapData: payload.tiles as any,
          furniture: (payload.furniture ?? []) as any,
          zones: (payload.zones ?? []) as any,
        },
      })
        .then(() => console.log('[room] tilemap + furniture + zones saved to db'))
        .catch((e: any) => console.error('[room] tilemap save failed:', e));
    } catch (e) { /* ignore */ }
  });

  // Pin/unpin a chat message as the room's persistent Notice banner —
  // admin-only, and enforced here (not just by hiding the option in
  // ChatPanel.tsx) since any client could otherwise emit this event directly.
  socket.on(SocketEvents.NOTICE_PIN, (data: { messageId: string; text: string; senderName: string }) => {
    const room = currentRoom; if (!room) return;
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, findUserIdBySocket(socket.id), 'notice:pin')) {
      socket.emit('admin:error', { message: 'Only admins can pin a notice' });
      return;
    }
    if (!data?.text) return;
    const notice: Notice = {
      messageId: data.messageId,
      text: data.text.slice(0, 200),
      senderName: data.senderName || 'Someone',
      pinnedByName: playerNames.get(socket.id) || 'Admin',
      pinnedAt: Date.now(),
    };
    roomNoticeMap.set(room, notice);
    io.to(room).emit(SocketEvents.NOTICE_UPDATED, notice);
  });

  socket.on(SocketEvents.NOTICE_UNPIN, () => {
    const room = currentRoom; if (!room) return;
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, findUserIdBySocket(socket.id), 'notice:unpin')) {
      socket.emit('admin:error', { message: 'Only admins can unpin the notice' });
      return;
    }
    roomNoticeMap.delete(room);
    io.to(room).emit(SocketEvents.NOTICE_UPDATED, null);
  });

  // Room:delete — owner only
  socket.on(SocketEvents.ROOM_DELETE, async () => {
    const room = currentRoom; if (!room) return;
    const uid = findUserIdBySocket(socket.id);
    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
      // Resolved fresh from the DB's ownerId rather than the in-memory
      // roomAdminMap — deletion is rare/high-stakes enough to be worth
      // asking the source of truth directly instead of trusting
      // possibly-stale in-memory state, but still routed through the same
      // centralized 'room:delete' policy (owner-only) as everywhere else.
      const role: Role = dbRoom?.ownerId === uid ? 'owner' : 'member';
      if (!dbRoom || !hasFeatureAccess(role, 'room:delete')) {
        socket.emit('admin:error', { message: 'Only the room creator can delete this room' });
        return;
      }
      // Tell all players in room
      io.to(room).emit(SocketEvents.ROOM_DELETED, { roomId: room });
      // Kick everyone
      const roomSockets = await io.in(room).fetchSockets();
      for (const s of roomSockets) s.leave(room);
      // Delete from DB
      await prisma.room.delete({ where: { slug: room } });
      // Remove from memory
      roomAdminMap.delete(room);
      roomNoticeMap.delete(room);
      // Notify lobby
      io.emit('lobby:room_removed', { roomId: room });
      console.log(`[room] room deleted: ${room}`);
    } catch (e) {
      console.error('[room] delete error:', e);
      socket.emit('admin:error', { message: 'Failed to delete room' });
    }
  });

  // Temporary removal from the room (not a ban — see shared/permissions.ts's
  // 'room:kick', admin+). Reuses handleLeave's exact cleanup (remove from
  // room store, emit PLAYER_LEFT, leave the socket.io room, broadcastRoomCount)
  // since a kick should look identical to an ordinary leave to everyone else
  // in the room — the only difference is the target gets a dedicated
  // PLAYER_KICKED notice on their own socket first, so their client knows
  // why they suddenly left instead of just silently vanishing.
  socket.on(SocketEvents.PLAYER_KICK, async (data: { targetUserId: string }) => {
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'room:kick')) {
      socket.emit('admin:error', { message: 'Only admins can remove players' });
      return;
    }
    const targetUserId = data?.targetUserId;
    if (!targetUserId || targetUserId === senderUid) return;
    if (targetUserId === rs.masterAdminUserId) {
      socket.emit('admin:error', { message: 'Cannot remove the room owner' });
      return;
    }
    const targetSocketId = userSocketMap.get(targetUserId);
    if (!targetSocketId) return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;

    const byName = playerNames.get(socket.id) || 'An admin';
    targetSocket.emit(SocketEvents.PLAYER_KICKED, { byName });
    await handleLeave(io, targetSocket, room);
  });

  // QA (Moderasi checklist item 11, "Kick/mute admin") — same shape as
  // PLAYER_KICK just above, but the server can only ASK: the target's own
  // client (see useSocket.ts's PLAYER_FORCE_MUTED listener) is what
  // actually flips its local mic track off and re-emits PLAYER_MIC so the
  // existing badge machinery (PLAYER_MIC_UPDATED) picks it up with no
  // separate broadcast needed here.
  socket.on(SocketEvents.PLAYER_FORCE_MUTE, (data: { targetUserId: string }) => {
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!canAccess(rs, senderUid, 'room:force_mute')) {
      socket.emit('admin:error', { message: 'Only admins can mute other players' });
      return;
    }
    const targetUserId = data?.targetUserId;
    if (!targetUserId || targetUserId === senderUid) return;
    const targetSocketId = userSocketMap.get(targetUserId);
    if (!targetSocketId) return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;

    const byName = playerNames.get(socket.id) || 'An admin';
    targetSocket.emit(SocketEvents.PLAYER_FORCE_MUTED, { byName });
  });

  socket.on(SocketEvents.LEAVE_ROOM, () => {
    handleLeave(io, socket, currentRoom);
    currentRoom = null;
  });

  socket.on(SocketEvents.DISCONNECT, () => {
    // Guest Link & Ruang Tunggu — a guest still waiting on an admin decision
    // never got past JOIN_ROOM's early return (currentRoom stays null the
    // whole time they wait), so the `if (!room) return` below would
    // otherwise skip cleanup entirely and leave a stale pending entry +
    // notified-admins-that-never-get-told-it's-moot forever. Uses
    // socket.data.guestRoomSlug (set once at the handshake, independent of
    // currentRoom) rather than the closure var, specifically so this runs
    // even though the guest was never actually joined to anything.
    const pendingGuestId = (socket.data as { guestId?: string }).guestId;
    const pendingGuestRoom = (socket.data as { guestRoomSlug?: string }).guestRoomSlug;
    if (pendingGuestId && pendingGuestRoom) {
      const rs = getRoomAdmin(pendingGuestRoom);
      const pending = rs.pendingGuests?.get(pendingGuestId);
      if (pending) {
        rs.pendingGuests!.delete(pendingGuestId);
        for (const sid of pending.notifiedAdminSocketIds) {
          io.to(sid).emit(SocketEvents.GUEST_JOIN_CANCELLED, { guestId: pendingGuestId });
        }
      }
    }
    const room = currentRoom;
    if (!room) return;
    // No stable identity to reconnect AS (shouldn't happen — login is
    // mandatory — but fall back to the old immediate behavior if it ever is).
    const uid = findUserIdBySocket(socket.id);
    if (!uid) { handleLeave(io, socket, room); return; }

    // QA item #4 (Reconnect: posisi berubah) — save the position NOW, not
    // only if/when handleLeave eventually runs. It previously ONLY saved
    // inside handleLeave, which a reconnect landing inside the grace window
    // below skips entirely (JOIN_ROOM's stale-entry eviction cancels this
    // very timer before it ever fires) — so any reconnect that happened
    // WITHIN the grace period silently never got its position recorded,
    // and fell back to the spawn tile instead of where they actually were.
    // Only reconnects slower than the grace period (where handleLeave had
    // already run for real) were ever restored correctly — backwards from
    // what "auto-reconnect, posisi kembali" requires.
    savePositionForReconnect(room, socket).catch((e) => console.warn('[room] failed to save disconnect position:', e));

    // QA items #9/#10 (multi-tab duplicate) — this socket was just replaced
    // by a newer tab/connection for the same account (see JOIN_ROOM's
    // eviction below) and is never coming back as itself; skip the grace
    // period entirely, same as the explicit LEAVE_ROOM/PLAYER_KICKED paths.
    if ((socket.data as { supersededByNewerTab?: boolean }).supersededByNewerTab) {
      handleLeave(io, socket, room);
      return;
    }

    const timer = setTimeout(() => {
      pendingDisconnects.delete(uid);
      handleLeave(io, socket, room);
    }, RECONNECT_GRACE_MS);
    pendingDisconnects.set(uid, { socketId: socket.id, room, timer });
  });

  // QA (Presence checklist item #8, "Member list akurat") — one-time
  // snapshot for a member-list panel that just opened, answered ONLY to the
  // requester (not broadcast) — ongoing changes after this arrive via the
  // ROSTER_UPDATED deltas both JOIN_ROOM and handleLeave already broadcast
  // above. Deliberately not gated to any particular room — this is the
  // workspace-wide roster, callable from any connected (non-guest) socket.
  socket.on(SocketEvents.ROSTER_LIST_REQUEST, () => {
    // A guest has no business seeing which real accounts are online across
    // OTHER rooms they were never invited to — the UI already never offers
    // this (Sidebar hides the "Member" row for isGuest), this is the
    // server-side backstop in case a guest client fakes the request anyway.
    if ((socket.data as { guestId?: string }).guestId) return;
    const snapshot: RosterEntry[] = Array.from(userRoomMap, ([userId, v]) => ({ userId, roomSlug: v.roomSlug, roomName: v.roomName, zoneName: v.zoneName }));
    socket.emit(SocketEvents.ROSTER_SNAPSHOT, snapshot);
  });
}

// QA item #4 — extracted so both the immediate on-disconnect save (above)
// and handleLeave's own save (below, for the LEAVE_ROOM/PLAYER_KICKED paths
// that bypass the grace period and never go through DISCONNECT at all) share
// one implementation.
async function savePositionForReconnect(room: string, socket: Socket): Promise<void> {
  const uid = findUserIdBySocket(socket.id);
  if (!uid) return;
  const players = await getPlayers(room);
  const player = players.find((p) => p.id === socket.id);
  if (player) saveLastKnownPosition(uid, room, player.x, player.y, player.direction);
}

// "Ngobrol dengan CEO" queue — see handleLeave's own call site. Cheap for
// the overwhelming majority of leaves: bails on the very first query unless
// this room actually has queueing on, so ordinary rooms pay one extra
// findUnique and nothing more.
async function completeActiveQueueEntryOnLeave(userId: string, roomSlug: string): Promise<void> {
  const prisma = getPrisma();
  const room = await prisma.room.findUnique({ where: { slug: roomSlug }, select: { id: true, name: true, queueEnabled: true } });
  if (!room?.queueEnabled) return;
  const entry = await prisma.roomQueueEntry.findFirst({ where: { roomId: room.id, zoneId: null, userId, status: 'active' } });
  if (!entry) return;
  await prisma.roomQueueEntry.update({ where: { id: entry.id }, data: { status: 'done', completedAt: new Date() } });
  await advanceQueue(prisma, room.id, null);
}

async function handleLeave(io: Server, socket: Socket, room: string | null) {
  if (!room) return;
  console.log(`[room] ${playerNames.get(socket.id) || socket.id} left ${room}`);

  // Remember where they were, keyed by their real account id — see
  // roomStore.ts's lastKnownPosition doc comment and JOIN_ROOM's use of
  // getLastKnownPosition above. Must run before removePlayer() below,
  // which deletes this same player entry. Harmless redundancy on the
  // DISCONNECT→grace-timer-expiry path (savePositionForReconnect already
  // ran when the disconnect first fired, and the position can't have
  // changed since — the socket's been dead); the only path that actually
  // NEEDS this call is LEAVE_ROOM/PLAYER_KICKED, which never goes through
  // DISCONNECT at all.
  const leavingUid = findUserIdBySocket(socket.id);
  if (leavingUid) {
    await savePositionForReconnect(room, socket);

    // "Ngobrol dengan CEO" queue — per product decision, leaving/disconnecting
    // mid-slot (for ANY reason — LEAVE_ROOM, disconnect, or PLAYER_KICK all
    // funnel through here, same as the allowlist revoke just below) counts as
    // "done" and advances the queue immediately, rather than holding the next
    // person hostage until the original timer would have expired. Fire-and-
    // forget: this is bookkeeping for a queue that may not even be enabled on
    // this room, and must never slow down or block an ordinary leave.
    completeActiveQueueEntryOnLeave(leavingUid, room).catch((e) =>
      console.error('[room] queue leave-complete error:', e),
    );

    // A knock-admitted user's allowlist entry is a one-time entry pass, not
    // a standing grant — otherwise once let in, they (and anyone reading
    // their uid off the wire) could leave and walk straight back into a
    // still-locked room with no further host approval, defeating the whole
    // point of locking it. Revoke it the instant they leave (for ANY
    // reason — LEAVE_ROOM, disconnect, or PLAYER_KICK all funnel through
    // here); admins/owner never needed the allowlist to begin with (see the
    // JOIN_ROOM gate's own `!isAdmin` check), so this never affects them.
    const rs = getRoomAdmin(room);
    rs.knockAllowlist?.delete(leavingUid);
    // Same one-time-pass rule for a guest's admission — leaving revokes it,
    // so a returning guest (even the same guestId, if their JWT is still
    // valid) is re-vetted through the waiting room every visit rather than
    // silently walking back in.
    if (isGuestUid(leavingUid)) rs.guestAllowlist?.delete(leavingUid.slice(GUEST_UID_PREFIX.length));
  }
  // Same "revoke the instant they leave" rule as the knock allowlist above —
  // a password door isn't a permanent pass, it's good for this visit only.
  clearUnlockedDoorsForRoom(socket.id, room);

  removePlayer(room, socket.id);
  io.to(room).emit(SocketEvents.PLAYER_LEFT, socket.id);
  socket.leave(room);
  broadcastRoomCount(io, room);
  playerNames.delete(socket.id);
  playerColors.delete(socket.id);
  for (const [uid, sid] of userSocketMap) {
    if (sid === socket.id) {
      userSocketMap.delete(uid);
      // QA (Presence checklist item #8, "Member list akurat") — same
      // "only if THIS socket is still the authoritative one for uid" guard
      // as the userSocketMap delete just above (that's exactly what this
      // loop's `sid === socket.id` condition already establishes): a
      // superseded tab's OLD socket calling handleLeave after the NEW tab
      // already re-registered this uid must NOT wipe the new tab's roster
      // entry / broadcast a false "offline" for a user who's still online.
      if (userRoomMap.delete(uid)) broadcastRosterUpdate(io, { userId: uid, online: false });
      break;
    }
  }

  // A pending Summon request involving this socket (either side) can never
  // be answered/fulfilled correctly anymore — drop it rather than leaving a
  // stale entry that SUMMON_RESPOND would later act on against a gone player.
  clearPendingSummon(socket.id);
  for (const [targetId, pending] of pendingSummons) {
    if (pending.fromSocketId === socket.id) clearPendingSummon(targetId);
  }

  // Same reasoning for a pending knock: if the knocker left/disconnected
  // before the host responded, the admin's "X is knocking" toast is now
  // stale (there's no one left to admit) — same cleanup as an explicit
  // ROOM_KNOCK_CANCEL.
  cancelKnock(socket.id, io);
}
