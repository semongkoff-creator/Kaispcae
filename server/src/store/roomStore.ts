import { Avatar, RoomState, AvatarConfig } from '@virtualmeet/shared';
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
  const client = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 2000,
    retryStrategy: () => null, // never retry — fail fast
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
): Promise<Avatar | null> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    player.x = x;
    player.y = y;
    player.direction = direction as Avatar['direction'];
    player.isMoving = true;
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
