import { Avatar, RoomState, AvatarConfig, RoomTile } from '@virtualmeet/shared';
import { Redis } from 'ioredis';

// In-memory fallback storage — always works, zero dependencies
const memoryStore: Record<string, Avatar[]> = {};

// Redis client — may be null if unavailable
let redis: Redis | null = null;
let redisFailed = false;

function memoryKey(roomId: string): string {
  return `room:${roomId}`;
}

function createRedisClient(): Redis {
  // REDIS_URL is the documented/configured var (see .env.example and
  // docker-compose.yml, which points it at the `redis` service hostname).
  // Falling back to REDIS_HOST/REDIS_PORT only for setups that prefer discrete vars.
  const url = process.env.REDIS_URL;
  const options = {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 2000,
    retryStrategy: () => null, // never retry — fail fast
  };
  const client = url
    ? new Redis(url, options)
    : new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
        ...options,
      });

  // CRITICAL: must attach error listener before connect, otherwise Node.js
  // will crash on unhandled 'error' events from the connection attempt.
  client.on('error', () => {
    // silently swallow — we handle connection failure in getRedis()
  });

  return client;
}

/**
 * Attempts to connect to Redis. Returns the client on success, null on failure.
 * Once a connection fails, redisFailed is set to true and all future calls
 * short-circuit to the in-memory store.
 */
export async function getRedis(): Promise<Redis | null> {
  if (redisFailed) return null;

  if (redis) {
    if (redis.status === 'ready') return redis;
    // Status is not ready — try connecting
  } else {
    try {
      redis = createRedisClient();
    } catch {
      redis = null;
      redisFailed = true;
      return null;
    }
  }

  try {
    if (redis && redis.status !== 'ready') {
      await redis.connect();
    }
    if (redis?.status === 'ready') {
      return redis;
    }
  } catch {
    // Connection refused or timeout — give up on Redis entirely
  }

  // Mark failed so we never retry
  redisFailed = true;

  // Clean up the dead client
  try {
    redis?.disconnect();
  } catch {
    // ignore
  }
  redis = null;

  return null;
}

// ─── Player CRUD (Redis or in-memory) ─────────────────────────────

export async function getPlayers(roomId: string): Promise<Avatar[]> {
  const r = await getRedis();
  if (r) {
    try {
      const raw = await r.get(`room:${roomId}:players`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      // Redis get failed — continue to in-memory
    }
  }

  const key = memoryKey(roomId);
  return memoryStore[key] || [];
}

export async function setPlayers(roomId: string, players: Avatar[]): Promise<void> {
  const r = await getRedis();
  if (r) {
    try {
      await r.set(`room:${roomId}:players`, JSON.stringify(players));
    } catch {
      // ignore, memory store handles it below
    }
  }

  memoryStore[memoryKey(roomId)] = players;
}

export async function addPlayer(roomId: string, player: Avatar): Promise<void> {
  const players = await getPlayers(roomId);
  const filtered = players.filter((p) => p.id !== player.id);
  filtered.push(player);
  await setPlayers(roomId, filtered);
}

export async function removePlayer(roomId: string, playerId: string): Promise<void> {
  const players = await getPlayers(roomId);
  const filtered = players.filter((p) => p.id !== playerId);
  await setPlayers(roomId, filtered);
}

export async function updatePlayerPosition(
  roomId: string,
  playerId: string,
  x: number,
  y: number,
  direction: string,
  isRunning?: boolean,
): Promise<Avatar | null> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    player.x = x;
    player.y = y;
    player.direction = direction as Avatar['direction'];
    player.isMoving = true;
    player.isRunning = isRunning ?? false;
    await setPlayers(roomId, players);
    return player;
  }
  return null;
}

export async function setPlayerStopped(roomId: string, playerId: string): Promise<void> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    player.isMoving = false;
    player.isRunning = false;
    await setPlayers(roomId, players);
  }
}

export async function updatePlayerAvatarConfig(
  roomId: string,
  playerId: string,
  config: AvatarConfig,
): Promise<void> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    player.avatarConfig = config;
    player.name = config.name;
    player.color = config.color;
    await setPlayers(roomId, players);
  }
}

export async function updatePlayerStatus(
  roomId: string,
  playerId: string,
  status: string,
): Promise<void> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    player.status = status || undefined;
    await setPlayers(roomId, players);
  }
}

export async function updatePlayerHand(
  roomId: string,
  playerId: string,
  raised: boolean,
): Promise<void> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    player.handRaised = raised || undefined;
    await setPlayers(roomId, players);
  }
}

export async function updatePlayerSitting(
  roomId: string,
  playerId: string,
  isSitting: boolean,
  x: number,
  y: number,
  direction: Avatar['direction'],
): Promise<void> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    player.isSitting = isSitting || undefined;
    player.x = x;
    player.y = y;
    player.direction = direction;
    await setPlayers(roomId, players);
  }
}

// ─── Room state ────────────────────────────────────────────────────

export async function getRoomState(roomId: string, roomName: string): Promise<RoomState> {
  const players = await getPlayers(roomId);
  return {
    id: roomId,
    name: roomName,
    tiles: [],
    players,
  };
}

// ─── Tile cache (in-memory only — see caveat below) ─────────────────
//
// movementHandler.ts needs to validate every PLAYER_MOVE against the
// room's actual wall/desk/chair layout (server-authoritative collision —
// previously the server only clamped to the map's outer bounds and
// otherwise trusted whatever x/y the client reported, so a modified
// client could walk through walls). Hitting Postgres on every move tick
// would be far too slow, so the currently-active tile grid for each room
// is cached here instead, populated on join (roomHandler.ts's JOIN_ROOM)
// and refreshed on every editor save (ROOM_UPDATE).
//
// In-memory only, like the rest of this file's non-Redis-backed maps
// (playerNames/roomAdminMap in roomHandler.ts) — fine for a single server
// process; a multi-instance deployment would need this in Redis too,
// same as the player list already is.
const tileCache = new Map<string, RoomTile[][]>();

export function setCachedTiles(roomId: string, tiles: RoomTile[][]): void {
  tileCache.set(roomId, tiles);
}

export function getCachedTiles(roomId: string): RoomTile[][] | undefined {
  return tileCache.get(roomId);
}

// ─── Last known position (reconnect persistence) ─────────────────────
//
// Keyed by the player's real account id (uid), not socket.id — socket.id
// is different on every reconnect, so keying by it would never actually
// find a previous entry. Populated on disconnect/leave (roomHandler.ts's
// handleLeave) and consulted on JOIN_ROOM so refreshing/reconnecting
// resumes where the player left off instead of always resetting to the
// room's spawn tile (see the "Move" spec's explicit reconnect-persist rule).
interface LastKnownPosition {
  roomId: string;
  x: number;
  y: number;
  direction: string;
}

const lastKnownPosition = new Map<string, LastKnownPosition>();

export function saveLastKnownPosition(userId: string, roomId: string, x: number, y: number, direction: string): void {
  lastKnownPosition.set(userId, { roomId, x, y, direction });
}

// Only returns a position if it's for THIS room — a player who last left
// from a different room should still spawn fresh, not appear at their old
// coordinates in an unrelated map.
export function getLastKnownPosition(userId: string, roomId: string): LastKnownPosition | undefined {
  const entry = lastKnownPosition.get(userId);
  return entry && entry.roomId === roomId ? entry : undefined;
}
