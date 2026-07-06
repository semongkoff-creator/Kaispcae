import { Server, Socket } from 'socket.io';
import { SocketEvents, Avatar, AvatarConfig, RoomTile, RoomUpdatePayload, createDefaultOfficeLayout } from '@virtualmeet/shared';
import { addPlayer, removePlayer, getRoomState, updatePlayerAvatarConfig, updatePlayerStatus, updatePlayerSitting } from '../store/roomStore';
import { PrismaClient } from '@prisma/client';
import { socketRateLimit } from '../middleware/rateLimit';

const canChangeAdmin = socketRateLimit(3); // max 3 admin grant/revoke calls/sec per socket
const canUpdateRoom = socketRateLimit(2); // max 2 room:update (DB write) calls/sec per socket

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
  loadedFromDb: boolean;
}

const roomAdminMap = new Map<string, RoomAdminState>();

function getRoomAdmin(room: string): RoomAdminState {
  if (!roomAdminMap.has(room)) {
    roomAdminMap.set(room, { masterAdminUserId: '', adminUserIds: new Set(), loadedFromDb: false });
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
  } catch (e) {
    console.warn('[room] failed to load room owner from db:', e);
  }
  rs.loadedFromDb = true;
  return rs;
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

    const isAdmin = rs.adminUserIds.has(uid);
    const isMasterAdmin = uid === rs.masterAdminUserId;

    // Fetch the saved room once — reused for spawn point lookup below and
    // for the tiles/furniture/zones sent in room:state once player data is ready.
    let dbRoom: { tilemapData: unknown; furniture: unknown; zones: unknown } | null = null;
    try {
      dbRoom = await getPrisma().room.findUnique({ where: { slug: room } });
    } catch (e) { console.warn('[room] failed to load room from db:', e); }

    const spawn = findSpawnPixel(dbRoom?.tilemapData) ?? { x: 3 * 32 + 16, y: 3 * 32 + 16 };

    // `name` is already the resolved display name (real account name takes
    // priority client-side in useSocket.ts). avatarConfig.name defaults to
    // the placeholder 'You' used for the Avatar Editor's own live preview —
    // it must not win over the real name just because a player never opened
    // that editor, so it's only a fallback for the (unreachable in practice,
    // since login is mandatory) case where `name` itself is empty.
    const newPlayer: Avatar = {
      id: socket.id, name: name || avatarConfig?.name || 'Player',
      x: spawn.x, y: spawn.y, direction: 'down',
      color, isMoving: false, avatarConfig: avatarConfig || undefined,
      isAdmin, userId: uid,
    };

    console.log(`[room] ${newPlayer.name} (${socket.id}) uid=${uid} ${isAdmin ? isMasterAdmin ? '⭐' : '👑' : ''} joined ${room}`);

    socket.to(room).emit(SocketEvents.PLAYER_JOINED, newPlayer);
    broadcastRoomCount(io, room);

    addPlayer(room, newPlayer).then(async () => {
      const state = await getRoomState(room, DEFAULT_ROOM_NAME);

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
      // saved data and don't need it.
      const fallback = (!savedTiles || !savedFurniture || !savedZones) ? createDefaultOfficeLayout() : null;

      socket.emit(SocketEvents.ROOM_STATE, {
        ...state, tiles: savedTiles || fallback!.tiles, furniture: savedFurniture || fallback!.furniture, zones: savedZones || fallback!.zones, players: playersWithMeta,
        adminUserIds: Array.from(rs.adminUserIds), masterAdminUserId: rs.masterAdminUserId,
      });
    });
  });

  socket.on(SocketEvents.ADMIN_GRANT, (data: { targetUserId: string }) => {
    if (!canChangeAdmin(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (!senderUid || !rs.adminUserIds.has(senderUid)) {
      socket.emit('admin:error', { message: 'Only admins can grant admin' });
      return;
    }
    rs.adminUserIds.add(data.targetUserId);
    broadcastAdmin(io, room, rs);
  });

  socket.on(SocketEvents.ADMIN_REVOKE, (data: { targetUserId: string }) => {
    if (!canChangeAdmin(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const senderUid = findUserIdBySocket(socket.id);
    const rs = getRoomAdmin(room);
    if (senderUid !== rs.masterAdminUserId) {
      socket.emit('admin:error', { message: 'Only the master admin can revoke' });
      return;
    }
    if (data.targetUserId === rs.masterAdminUserId) {
      socket.emit('admin:error', { message: 'Cannot revoke the master admin' });
      return;
    }
    rs.adminUserIds.delete(data.targetUserId);
    broadcastAdmin(io, room, rs);
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
    socket.to(room).emit(SocketEvents.ROOM_UPDATED, payload);
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

  // Room:delete — owner only
  socket.on(SocketEvents.ROOM_DELETE, async () => {
    const room = currentRoom; if (!room) return;
    const uid = findUserIdBySocket(socket.id);
    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
      if (!dbRoom || dbRoom.ownerId !== uid) {
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
      // Notify lobby
      io.emit('lobby:room_removed', { roomId: room });
      console.log(`[room] room deleted: ${room}`);
    } catch (e) {
      console.error('[room] delete error:', e);
      socket.emit('admin:error', { message: 'Failed to delete room' });
    }
  });

  socket.on(SocketEvents.LEAVE_ROOM, () => {
    handleLeave(io, socket, currentRoom);
    currentRoom = null;
  });

  socket.on(SocketEvents.DISCONNECT, () => {
    handleLeave(io, socket, currentRoom);
  });
}

function handleLeave(io: Server, socket: Socket, room: string | null) {
  if (!room) return;
  console.log(`[room] ${playerNames.get(socket.id) || socket.id} left ${room}`);
  removePlayer(room, socket.id);
  io.to(room).emit(SocketEvents.PLAYER_LEFT, socket.id);
  socket.leave(room);
  broadcastRoomCount(io, room);
  playerNames.delete(socket.id);
  playerColors.delete(socket.id);
  for (const [uid, sid] of userSocketMap) { if (sid === socket.id) { userSocketMap.delete(uid); break; } }
}
