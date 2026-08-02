import { randomUUID } from 'crypto';
import { isUserInLockedZone } from './zoneLock';
import { zoneIdOfSocket, getSocketIdsInZone } from './zoneHandler';
import { Server, Socket } from 'socket.io';
import { SocketEvents, Avatar, AvatarConfig, RoomTile, RoomUpdatePayload, RoomTheme, RoomTemplateId, Notice, Role, FeatureKey, TeleportRequest, hasFeatureAccess, isTileBlocked, createDefaultOfficeLayout, findAdjacentFreeTile, TILE_SIZE, TRANSLUCENT_THRESHOLD, CONSENT_REQUEST_TIMEOUT_MS, SummonRespondPayload, WorkMode, LayerData, layerDataToLegacy, InteractivePasswordCheckPayload, InteractiveDoorPasswordCheckPayload, InteractiveChoiceCheckPayload, InteractiveApiCallPayload, InteractiveChangeObjectPayload, SoundboardPlayPayload, SOUNDBOARD_COOLDOWN_MS, AWAY_REASON_MAX_LENGTH } from '@virtualmeet/shared';
import {
  addPlayer, removePlayer, getPlayers, getRoomState, updatePlayerAvatarConfig, updatePlayerStatus, updatePlayerHand, updatePlayerWorkMode, updatePlayerSitting,
  setCachedTiles, getCachedTiles, saveLastKnownPosition, getLastKnownPosition, updatePlayerPosition,
} from '../store/roomStore';
import { getPrisma } from '../lib/prisma';
import { resolveEntry } from '../lib/roomMembership';
import { logActivity } from '../lib/larkBase';
import { socketRateLimit } from '../middleware/rateLimit';
import { redactInteractiveSecrets, redactDoorPasswords } from '../lib/redactFurniture';
import { unlockDoor, clearUnlockedDoorsForRoom } from './doorLock';
import { getNearbyRecipients } from './proximityBroadcast';

const canChangeAdmin = socketRateLimit(3); // max 3 admin grant/revoke calls/sec per socket
const canTeleport = socketRateLimit(2); // max 2 teleport requests/sec per socket
const canUpdateRoom = socketRateLimit(2); // max 2 room:update (DB write) calls/sec per socket
const canSummonUser = socketRateLimit(3); // max 3 single-target summon requests/sec per socket
const canKnock = socketRateLimit(1); // max 1 knock/sec per socket — no spamming the host
const canSlap = socketRateLimit(3); // A10 — burst guard; the real limit is the 30s/target cooldown below
const canCheckInteractive = socketRateLimit(3); // Fitur 15B — throttle brute-force guessing of a password/multiple-choice prompt
const canApiCall = socketRateLimit(1); // Fitur 15B — API call hits a THIRD-PARTY server; heavier than a DB compare, so a tighter cap
const canChangeObject = socketRateLimit(2); // Fitur 15B — mutates + saves the room's actual layerData

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

const DEFAULT_ROOM = 'main-office';
const DEFAULT_ROOM_NAME = 'Main Office';

const playerNames = new Map<string, string>();
const playerColors = new Map<string, string>();
let colorIndex = 0;

const userSocketMap = new Map<string, string>();

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
}

const roomAdminMap = new Map<string, RoomAdminState>();

// Resolves a user's current Role in a room from the in-memory admin state
// — the single place this app decides "what tier is this person" (see
// shared/permissions.ts's Role hierarchy doc comment). 'guest' is never
// returned here since login is mandatory before joining a room at all.
function getRole(rs: RoomAdminState, uid: string): Role {
  if (uid === rs.masterAdminUserId) return 'owner';
  if (rs.adminUserIds.has(uid)) return 'admin';
  if (rs.staffUserIds.has(uid)) return 'staff';
  return 'member';
}

// Every server-side permission check in this file should call this instead
// of re-deriving its own role comparison — see shared/permissions.ts's doc
// comment for why (this is the fix for the exact gap it describes).
function canAccess(rs: RoomAdminState, uid: string | undefined, feature: FeatureKey): boolean {
  if (!uid) return false;
  return hasFeatureAccess(getRole(rs, uid), feature);
}

// One pinned Notice per room (see shared/types/index.ts's Notice doc
// comment) — in-memory, same convention as roomAdminMap above.
const roomNoticeMap = new Map<string, Notice>();

function getRoomAdmin(room: string): RoomAdminState {
  if (!roomAdminMap.has(room)) {
    roomAdminMap.set(room, { masterAdminUserId: '', adminUserIds: new Set(), staffUserIds: new Set(), loadedFromDb: false });
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

function findUserIdBySocket(socketId: string): string | undefined {
  for (const [uid, sid] of userSocketMap) {
    if (sid === socketId) return uid;
  }
}

// Scans a saved tilemap for a tile of type 'spawn' and returns its pixel
// center. Falls back to null (caller uses the hardcoded default) if there's
// no saved map yet, or no spawn tile was placed in it.
function findSpawnPixel(tilemapData: unknown): { x: number; y: number } | null {
  if (!Array.isArray(tilemapData)) return null;
  for (const row of tilemapData as any[]) {
    if (!Array.isArray(row)) continue;
    for (const tile of row) {
      if (tile?.type === 'spawn' && typeof tile.x === 'number' && typeof tile.y === 'number') {
        return { x: tile.x * 32 + 16, y: tile.y * 32 + 16 };
      }
    }
  }
  return null;
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

export function registerRoomHandlers(io: Server, socket: Socket) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string, playerName?: string, avatarConfig?: AvatarConfig, userId?: string) => {
    const room = roomId || DEFAULT_ROOM;

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
    let approvalRoom: { id: string; ownerId: string; requiresApproval: boolean; slug: string } | null = null;
    try {
      approvalRoom = await prisma.room.findUnique({ where: { slug: room } });
    } catch (e) {
      // Can't tell whether this room is gated. Unknown slugs (DEFAULT_ROOM,
      // ad-hoc rooms) have always been walk-in, and this lookup is the only
      // thing that distinguishes them, so treat an unreadable answer the same
      // way — matching pre-existing behaviour rather than inventing a lockout.
      console.error('[room] could not read room for approval check:', e);
    }

    if (approvalRoom?.requiresApproval) {
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
    // and grant themselves master-admin.
    const uid = (socket.data as { userId?: string }).userId || userId || socket.id;
    userSocketMap.set(uid, socket.id);

    // Load master admin from database (ownerId), not first socket
    const rs = await initRoomAdminFromDb(room);
    if (!rs.masterAdminUserId) {
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
    try {
      const account = await getPrisma().user.findUnique({ where: { id: uid }, select: { accountRole: true } });
      if (account?.accountRole === 'admin') rs.adminUserIds.add(uid);
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
    let dbRoom: { id: string; tilemapData: unknown; furniture: unknown; zones: unknown; theme?: string | null; template?: string | null; layerData?: unknown } | null = null;
    try {
      dbRoom = await getPrisma().room.findUnique({ where: { slug: room } });
    } catch (e) { console.warn('[room] failed to load room from db:', e); }

    // Resolve the room's actual tile grid NOW (it used to happen later, only
    // for the room:state payload) — the spawn rescue below needs it. Hoisted,
    // not duplicated: the room:state emit further down reuses these.
    const theme: RoomTheme = dbRoom?.theme === 'scifi-office' ? 'scifi-office' : 'modern-interiors';
    const template = (dbRoom?.template as RoomTemplateId | null) ?? undefined;
    let savedTiles: RoomTile[][] | undefined;
    let savedFurniture: any[] | undefined;
    let savedZones: any[] | undefined;
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
    const remembered = getLastKnownPosition(uid, room);
    let spawn = remembered ?? findSpawnPixel(dbRoom?.tilemapData) ?? { x: 3 * 32 + 16, y: 3 * 32 + 16 };

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
      isAdmin, userId: uid,
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

      socket.emit(SocketEvents.ROOM_STATE, {
        ...state, tiles: redactDoorPasswords(tiles), furniture: redactInteractiveSecrets(savedFurniture || fallback!.furniture), zones: savedZones || fallback!.zones, players: playersWithMeta,
        adminUserIds: Array.from(rs.adminUserIds), masterAdminUserId: rs.masterAdminUserId, staffUserIds: Array.from(rs.staffUserIds), theme, template,
        notice: roomNoticeMap.get(room) ?? null,
        locked: !!rs.locked,
        role: getRole(rs, uid),
        // Fitur 15 — this room's custom Floor/Wall/Object uploads. Every
        // joining player needs these registered into PALETTE_BY_ID (see
        // useSocket.ts's ROOM_STATE handler) before `tiles`/`furniture` above
        // can resolve any custom paletteId they reference — not just the
        // admin who's in the (separate) Room Editor tab.
        customAssets: (dbRoom?.layerData as unknown as LayerData | undefined)?.customAssets ?? [],
      });

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

  // Fitur 15B — Password prompt verification. The attempt is compared
  // against the room's OWN stored layerData, fetched fresh from the DB right
  // here — never against anything the client sent or cached, and the real
  // password never reaches this or any other client (see
  // redactInteractiveSecrets, applied to every furniture list this socket
  // otherwise receives).
  socket.on(SocketEvents.INTERACTIVE_PASSWORD_CHECK, async (data: InteractivePasswordCheckPayload) => {
    if (!canCheckInteractive(socket.id)) return;
    const room = currentRoom; if (!room) return;
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
    const room = currentRoom; if (!room) return;
    const x = data?.x, y = data?.y, attempt = data?.attempt;
    if (!Number.isInteger(x) || !Number.isInteger(y) || typeof attempt !== 'string') return;
    try {
      const dbRoom = await getPrisma().room.findUnique({ where: { slug: room }, select: { layerData: true } });
      if (!dbRoom?.layerData) return;
      const ld = dbRoom.layerData as unknown as LayerData;
      const eff = ld.tileEffects.find((e) => e.x === x && e.y === y && e.kind === 'door');
      if (!eff?.doorPasswordEnabled) return;
      const correct = (eff.doorPassword ?? '') === attempt;
      if (correct) unlockDoor(socket.id, room, x, y);
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
    const room = currentRoom; if (!room) return;
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
    const room = currentRoom; if (!room) return;
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
    const room = currentRoom; if (!room) return;
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
        io.to(room).emit(SocketEvents.ROOM_UPDATED, { tiles: redactDoorPasswords(derived.tiles), furniture: redactInteractiveSecrets(derived.furniture), zones: derived.zones });
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

      const pixelX = target.x * 32 + 16;
      const pixelY = target.y * 32 + 16;
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

    updatePlayerPosition(room, socket.id, landX, landY, stillRequester.direction);
    io.to(room).emit(SocketEvents.PLAYER_TELEPORTED, { id: socket.id, x: landX, y: landY, direction: stillRequester.direction });
    io.to(pending.fromSocketId).emit(SocketEvents.SUMMON_RESULT, { targetName, accepted: true });
  });

  // A10 — Slap/Tap ("colek"): a one-way, ephemeral attention nudge. Reuses
  // Summon's target resolution (by nickname, most-recent match) and Focus/DND
  // respect, but with NO consent dance — just relay to the target after a
  // 30s-per-target cooldown. Nothing persisted (optional activity_log only).
  socket.on(SocketEvents.SLAP, async (data: { nickname: string }) => {
    if (!canSlap(socket.id)) return;
    const room = currentRoom; if (!room) return;
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

  socket.on(SocketEvents.PLAYER_STATUS_UPDATE, (status: string) => {
    const room = currentRoom; if (!room) return;
    const trimmed = (status || '').slice(0, 24);
    socket.to(room).emit(SocketEvents.PLAYER_STATUS_UPDATED, { id: socket.id, status: trimmed });
    updatePlayerStatus(room, socket.id, trimmed);
  });

  socket.on(SocketEvents.PLAYER_HAND, async (raised: boolean) => {
    const room = currentRoom; if (!room) return;
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

  // Soundboard — cosmetic, fire-and-forget, same trust level as Jump/Nudge:
  // soundId is never resolved to a URL here (the client resolves it locally
  // from either the static default list or its own fetched custom-sounds
  // list — see shared/types' doc comment on SOUNDBOARD_PLAY), so a bogus id
  // just fails to match anything client-side and no-ops. Audience is the
  // SAME getNearbyRecipients used by the raise-hand chime above — one scope
  // rule for both, not two similar-but-separately-maintained copies.
  socket.on(SocketEvents.SOUNDBOARD_PLAY, async (data: SoundboardPlayPayload) => {
    const room = currentRoom; if (!room) return;
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
    const VALID: WorkMode[] = ['available', 'in_meeting', 'focus', 'lunch', 'away'];
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

  socket.on(SocketEvents.PLAYER_SIT, (data: { sitting: boolean; x: number; y: number; direction: Avatar['direction']; seatFurnitureId?: string }) => {
    const room = currentRoom; if (!room) return;
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

  socket.on(SocketEvents.LEAVE_ROOM, () => {
    handleLeave(io, socket, currentRoom);
    currentRoom = null;
  });

  socket.on(SocketEvents.DISCONNECT, () => {
    handleLeave(io, socket, currentRoom);
  });
}

async function handleLeave(io: Server, socket: Socket, room: string | null) {
  if (!room) return;
  console.log(`[room] ${playerNames.get(socket.id) || socket.id} left ${room}`);

  // Remember where they were, keyed by their real account id — see
  // roomStore.ts's lastKnownPosition doc comment and JOIN_ROOM's use of
  // getLastKnownPosition above. Must run before removePlayer() below,
  // which deletes this same player entry.
  const leavingUid = findUserIdBySocket(socket.id);
  if (leavingUid) {
    const players = await getPlayers(room);
    const player = players.find((p) => p.id === socket.id);
    if (player) saveLastKnownPosition(leavingUid, room, player.x, player.y, player.direction);

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
  for (const [uid, sid] of userSocketMap) { if (sid === socket.id) { userSocketMap.delete(uid); break; } }

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
