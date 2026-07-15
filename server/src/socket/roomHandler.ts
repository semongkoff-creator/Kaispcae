import { randomUUID } from 'crypto';
import { Server, Socket } from 'socket.io';
import { SocketEvents, Avatar, AvatarConfig, RoomTile, RoomUpdatePayload, RoomTheme, RoomTemplateId, Notice, Role, FeatureKey, TeleportRequest, hasFeatureAccess, isTileBlocked, createDefaultOfficeLayout, CONSENT_REQUEST_TIMEOUT_MS, SummonRespondPayload } from '@virtualmeet/shared';
import {
  addPlayer, removePlayer, getPlayers, getRoomState, updatePlayerAvatarConfig, updatePlayerStatus, updatePlayerSitting,
  setCachedTiles, getCachedTiles, saveLastKnownPosition, getLastKnownPosition, updatePlayerPosition,
} from '../store/roomStore';
import { PrismaClient } from '@prisma/client';
import { socketRateLimit } from '../middleware/rateLimit';

const canChangeAdmin = socketRateLimit(3); // max 3 admin grant/revoke calls/sec per socket
const canTeleport = socketRateLimit(2); // max 2 teleport requests/sec per socket
const canUpdateRoom = socketRateLimit(2); // max 2 room:update (DB write) calls/sec per socket
const canSummonUser = socketRateLimit(3); // max 3 single-target summon requests/sec per socket

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

function getPrisma(): PrismaClient {
  return new PrismaClient();
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

export function registerRoomHandlers(io: Server, socket: Socket) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string, playerName?: string, avatarConfig?: AvatarConfig, userId?: string) => {
    const room = roomId || DEFAULT_ROOM;
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

    // Fetch the saved room once — reused for spawn point lookup below and
    // for the tiles/furniture/zones sent in room:state once player data is ready.
    let dbRoom: { tilemapData: unknown; furniture: unknown; zones: unknown; theme?: string | null; template?: string | null } | null = null;
    try {
      dbRoom = await getPrisma().room.findUnique({ where: { slug: room } });
    } catch (e) { console.warn('[room] failed to load room from db:', e); }

    // Resume where this account last left THIS room, if known (see
    // roomStore.ts's lastKnownPosition doc comment) — otherwise fall back
    // to the room's spawn tile. Keyed by the real account id (uid), not
    // socket.id, since socket.id is different on every reconnect and would
    // never match a previous entry — without this, refreshing/reconnecting
    // always reset the player back to spawn regardless of where they'd
    // walked to, which the "Move" spec explicitly calls out as wrong.
    const remembered = getLastKnownPosition(uid, room);
    const spawn = remembered ?? findSpawnPixel(dbRoom?.tilemapData) ?? { x: 3 * 32 + 16, y: 3 * 32 + 16 };

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
      const theme: RoomTheme = dbRoom?.theme === 'scifi-office' ? 'scifi-office' : 'modern-interiors';
      const template = (dbRoom?.template as RoomTemplateId | null) ?? undefined;

      let savedTiles: RoomTile[][] | undefined;
      let savedFurniture: any[] | undefined;
      let savedZones: any[] | undefined;
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

      const playersWithMeta = state.players.map((p) => {
        const puid = findUserIdBySocket(p.id) ?? p.id;
        return { ...p, userId: puid, isAdmin: rs.adminUserIds.has(puid), isMasterAdmin: puid === rs.masterAdminUserId };
      });

      // Rooms created before the default-office-layout seed (or the legacy
      // DEFAULT_ROOM slug, which has no DB row at all) still have empty or
      // missing map data — fall back to the same layout newly-created rooms
      // are seeded with (see shared/defaultRoomLayout.ts) instead of an
      // empty floor. Computed lazily since most joins already have real
      // saved data and don't need it. Uses the room's own theme so a
      // scifi-office room missing its saved layout still falls back to a
      // scifi-office-themed default, not modern-interiors.
      const fallback = (!savedTiles || !savedFurniture || !savedZones) ? createDefaultOfficeLayout(theme) : null;
      const tiles = savedTiles || fallback!.tiles;

      // Populate movementHandler.ts's collision cache with this room's
      // actual layout — without this, server-side movement validation has
      // nothing to check against and fails open (see getCachedTiles's doc
      // comment there).
      setCachedTiles(room, tiles);

      socket.emit(SocketEvents.ROOM_STATE, {
        ...state, tiles, furniture: savedFurniture || fallback!.furniture, zones: savedZones || fallback!.zones, players: playersWithMeta,
        adminUserIds: Array.from(rs.adminUserIds), masterAdminUserId: rs.masterAdminUserId, staffUserIds: Array.from(rs.staffUserIds), theme, template,
        notice: roomNoticeMap.get(room) ?? null,
        role: getRole(rs, uid),
      });
    });
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
        if (!canAccess(rs, uid, 'teleport:admin')) {
          socket.emit('admin:error', { message: 'Staff role or higher required to use team locations' });
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

    const rs = getRoomAdmin(room);
    if (!canAccess(rs, uid, 'summon')) {
      socket.emit('admin:error', { message: 'Staff role or higher required to summon players' });
      return;
    }

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

    updatePlayerPosition(room, socket.id, stillRequester.x, stillRequester.y, stillRequester.direction);
    io.to(room).emit(SocketEvents.PLAYER_TELEPORTED, { id: socket.id, x: stillRequester.x, y: stillRequester.y, direction: stillRequester.direction });
    io.to(pending.fromSocketId).emit(SocketEvents.SUMMON_RESULT, { targetName, accepted: true });
  });

  socket.on(SocketEvents.AVATAR_UPDATE, (avatarConfig: AvatarConfig) => {
    const room = currentRoom; if (!room) return;
    socket.to(room).emit(SocketEvents.AVATAR_UPDATED, { id: socket.id, avatarConfig });
    updatePlayerAvatarConfig(room, socket.id, avatarConfig);
  });

  socket.on(SocketEvents.PLAYER_STATUS_UPDATE, (status: string) => {
    const room = currentRoom; if (!room) return;
    const trimmed = (status || '').slice(0, 24);
    socket.to(room).emit(SocketEvents.PLAYER_STATUS_UPDATED, { id: socket.id, status: trimmed });
    updatePlayerStatus(room, socket.id, trimmed);
  });

  socket.on(SocketEvents.PLAYER_SIT, (data: { sitting: boolean; x: number; y: number; direction: Avatar['direction'] }) => {
    const room = currentRoom; if (!room) return;
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number') return;
    const payload = { id: socket.id, isSitting: !!data.sitting, x: data.x, y: data.y, direction: data.direction };
    socket.to(room).emit(SocketEvents.PLAYER_SAT, payload);
    updatePlayerSitting(room, socket.id, payload.isSitting, payload.x, payload.y, payload.direction);
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
    socket.to(room).emit(SocketEvents.ROOM_UPDATED, payload);
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
  }

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
}
