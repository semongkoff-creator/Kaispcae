import { Avatar, RoomState, AvatarConfig, RoomTile, WorkMode, ImpassableAreaRect, DoorAreaRect, Zone } from '@kaispace/shared';
import { Redis } from 'ioredis';
import { clearLivePlayerMovement, mergeLivePlayerMovement, setLivePlayerMovement } from './playerLiveState';
import { getPrisma } from '../lib/prisma';

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
      const players = raw ? JSON.parse(raw) : [];
      memoryStore[memoryKey(roomId)] = players;
      return mergeLivePlayerMovement(roomId, players);
    } catch {
      // Redis get failed — continue to in-memory
    }
  }

  const key = memoryKey(roomId);
  return mergeLivePlayerMovement(roomId, memoryStore[key] || []);
}

// Synchronous "who's here right now" snapshot for server-authoritative
// per-move checks (e.g. movementHandler.ts's private-area anti-stacking
// guard) that can't afford an async Redis round trip on every PLAYER_MOVE.
// Mirrors getPlayers' own merge (memoryStore + the live in-flight-movement
// overlay from playerLiveState.ts) but skips the Redis fetch — memoryStore
// is kept in sync with Redis on every read/write already (getPlayers writes
// it back at line ~98, setPlayers at ~119), so it's only stale in the
// multi-instance case right after another instance's write, same caveat
// already documented for tileCache/impassableAreaCache/zoneCache below.
export function getCachedPlayers(roomId: string): Avatar[] {
  return mergeLivePlayerMovement(roomId, memoryStore[memoryKey(roomId)] || []);
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
  clearLivePlayerMovement(roomId, player.id);
  const players = await getPlayers(roomId);
  const filtered = players.filter((p) => p.id !== player.id);
  filtered.push(player);
  await setPlayers(roomId, filtered);
}

export async function removePlayer(roomId: string, playerId: string): Promise<void> {
  clearLivePlayerMovement(roomId, playerId);
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
  const key = memoryKey(roomId);
  const players = memoryStore[key] || (await getPlayers(roomId));
  const player = players.find((p) => p.id === playerId);
  if (player) {
    const movement = {
      x,
      y,
      direction: direction as Avatar['direction'],
      isMoving: true,
      isRunning: isRunning ?? false,
    };
    setLivePlayerMovement(roomId, playerId, movement);
    return { ...player, ...movement };
  }
  return null;
}

export async function setPlayerStopped(roomId: string, playerId: string, x?: number, y?: number, direction?: string): Promise<void> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    if (typeof x === 'number' && Number.isFinite(x)) player.x = x;
    if (typeof y === 'number' && Number.isFinite(y)) player.y = y;
    if (typeof direction === 'string') player.direction = direction as Avatar['direction'];
    player.isMoving = false;
    player.isRunning = false;
    await setPlayers(roomId, players);
    clearLivePlayerMovement(roomId, playerId);
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

// A3 — persist Focus/Public so it survives in room:state for late joiners.
// Fitur 3B — awayReason travels alongside workMode (only meaningful when
// workMode === 'away'); always cleared otherwise so a stale reason never
// survives into a later, unrelated 'away'.
export async function updatePlayerWorkMode(
  roomId: string,
  playerId: string,
  workMode: WorkMode,
  awayReason?: string,
): Promise<void> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    // 'available' is the default → store undefined (no badge); keep any other.
    player.workMode = workMode === 'available' ? undefined : workMode;
    player.awayReason = workMode === 'away' ? awayReason : undefined;
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

export async function updatePlayerMic(
  roomId: string,
  playerId: string,
  muted: boolean,
): Promise<void> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    player.micMuted = muted || undefined;
    await setPlayers(roomId, players);
  }
}

export async function updatePlayerHidden(
  roomId: string,
  playerId: string,
  hidden: boolean,
): Promise<void> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    player.hidden = hidden || undefined;
    await setPlayers(roomId, players);
  }
}

export async function updatePlayerSpotlight(
  roomId: string,
  playerId: string,
  active: boolean,
): Promise<void> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    player.spotlightActive = active || undefined;
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
  seatFurnitureId?: string,
): Promise<void> {
  const players = await getPlayers(roomId);
  const player = players.find((p) => p.id === playerId);
  if (player) {
    player.isSitting = isSitting || undefined;
    // Which chair they're in, so a late-joiner's room:state carries table
    // membership too — cleared when they stand.
    player.seatFurnitureId = isSitting ? seatFurnitureId : undefined;
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

// Item #9 (precise-collision follow-up) — impassable Area rectangles, pixel
// space, cached alongside the tile grid (same populate-on-join/refresh-on-
// save lifecycle, same in-memory-only caveat). Kept as a SEPARATE cache
// rather than folded into RoomTile: these need sub-tile precision, which a
// per-tile grid can't represent at all.
const impassableAreaCache = new Map<string, ImpassableAreaRect[]>();

export function setCachedImpassableAreas(roomId: string, rects: ImpassableAreaRect[]): void {
  impassableAreaCache.set(roomId, rects);
}

export function getCachedImpassableAreas(roomId: string): ImpassableAreaRect[] {
  return impassableAreaCache.get(roomId) ?? [];
}

// "Door Area" — same cache shape as impassableAreaCache above, but kept
// separate: unlike an impassable rect, whether one of these blocks a given
// mover is conditional (see doorLock.ts's isDoorAreaUnlocked), so
// movementHandler.ts needs to filter this list itself rather than the
// unconditional impassableAreaCache already covering it.
const doorAreaCache = new Map<string, DoorAreaRect[]>();

export function setCachedDoorAreaRects(roomId: string, rects: DoorAreaRect[]): void {
  doorAreaCache.set(roomId, rects);
}

export function getCachedDoorAreaRects(roomId: string): DoorAreaRect[] {
  return doorAreaCache.get(roomId) ?? [];
}

// Zones — same populate-on-join/refresh-on-save lifecycle, in-memory-only
// caveat as the caches above. zoneHandler.ts's ZONE_ENTER needs this to
// enforce a zone's optional capacity limit (Zone.capacity) server-side —
// it only ever tracked socket↔zoneId membership before, never the zones'
// own data, so there was nowhere to look up a capacity to check against.
const zoneCache = new Map<string, Zone[]>();

export function setCachedZones(roomId: string, zones: Zone[]): void {
  zoneCache.set(roomId, zones);
}

export function getCachedZones(roomId: string): Zone[] {
  return zoneCache.get(roomId) ?? [];
}

// Productivity Analytics — furniture placement has no discrete server event
// (ROOM_UPDATE overwrites the whole array every save, see roomHandler.ts),
// so "who placed what" is inferred by diffing each save's furniture id set
// against the previous one. `undefined` (never cached — a fresh server
// process, or this room's first-ever save) deliberately means "unknown
// baseline, don't diff" rather than "empty" — otherwise every pre-existing
// piece in the room would look newly placed the moment the server restarts.
const furnitureIdCache = new Map<string, Set<string>>();

export function getCachedFurnitureIds(roomId: string): Set<string> | undefined {
  return furnitureIdCache.get(roomId);
}

export function setCachedFurnitureIds(roomId: string, ids: Set<string>): void {
  furnitureIdCache.set(roomId, ids);
}

// "Ngobrol dengan CEO" queue, zone-level (see schema.prisma's
// ZoneRestriction) — ZONE_ENTER fires on essentially every zone crossing
// for every player, all day, so it cannot afford a DB round trip for the
// overwhelming majority of zones that have no restriction at all.
// zoneHandler.ts loads this ONCE per room at JOIN_ROOM (and refreshes it
// whenever an admin edits a restriction) so the hot path is a synchronous
// Map lookup; the DB is only actually hit for the rare zone that IS
// restricted, where correctness matters more than raw speed anyway.
const zoneRestrictionCache = new Map<string, Map<string, { minRole: string; queueEnabled: boolean; bookingMode: boolean }>>();

export function setCachedZoneRestrictions(roomSlug: string, restrictions: { zoneId: string; minRole: string; queueEnabled: boolean; bookingMode: boolean }[]): void {
  zoneRestrictionCache.set(roomSlug, new Map(restrictions.map((r) => [r.zoneId, { minRole: r.minRole, queueEnabled: r.queueEnabled, bookingMode: r.bookingMode }])));
}

export function getCachedZoneRestriction(roomSlug: string, zoneId: string): { minRole: string; queueEnabled: boolean; bookingMode: boolean } | undefined {
  return zoneRestrictionCache.get(roomSlug)?.get(zoneId);
}

// ─── Last known position (reconnect persistence) ─────────────────────
//
// Keyed by the player's real account id (uid), not socket.id — socket.id
// is different on every reconnect, so keying by it would never actually
// find a previous entry. Populated on disconnect/leave (roomHandler.ts's
// handleLeave) and consulted on JOIN_ROOM so refreshing/reconnecting
// resumes where the player left off instead of always resetting to the
// room's spawn tile (see the "Move" spec's explicit reconnect-persist rule).
//
// NOTE: despite the field name, every caller in this codebase actually
// passes the room's SLUG here, not its Room.id — this map has always used
// the slug as an opaque string key, which works fine for an in-memory
// lookup. The DB fallback below resolves slug -> real Room.id internally
// so every existing call site (save AND read) keeps passing the slug
// completely unchanged.
interface LastKnownPosition {
  roomId: string;
  x: number;
  y: number;
  direction: string;
}

const lastKnownPosition = new Map<string, LastKnownPosition>();

// Bug fix — this used to be the ONLY copy of this data, so a server restart
// (every deploy) silently reset every player back to the room's spawn tile
// on their next join, even though nothing about a normal mid-session
// reconnect changed. Now write-through: the in-memory Map updates
// synchronously (nothing here needs to wait on it), and the DB upsert runs
// alongside, fire-and-forget — a transient DB hiccup must never affect the
// disconnect/leave path it's called from.
export function saveLastKnownPosition(userId: string, roomSlug: string, x: number, y: number, direction: string): void {
  lastKnownPosition.set(userId, { roomId: roomSlug, x, y, direction });
  getPrisma().room.findUnique({ where: { slug: roomSlug }, select: { id: true } })
    .then((room) => {
      if (!room) return undefined;
      return getPrisma().roomLastPosition.upsert({
        where: { roomId_userId: { roomId: room.id, userId } },
        create: { roomId: room.id, userId, x, y, direction },
        update: { x, y, direction },
      });
    })
    .catch((e) => console.error('[roomStore] failed to persist last known position:', e));
}

// Only returns a position if it's for THIS room — a player who last left
// from a different room should still spawn fresh, not appear at their old
// coordinates in an unrelated map.
//
// Async now: the in-memory Map answers instantly whenever it has the entry
// (the common case — anything saved since this server last started), and
// only falls back to a DB query when it doesn't, i.e. right after a
// restart before this user's next disconnect/leave re-warms the cache.
export async function getLastKnownPosition(userId: string, roomSlug: string): Promise<LastKnownPosition | undefined> {
  const entry = lastKnownPosition.get(userId);
  if (entry && entry.roomId === roomSlug) return entry;
  try {
    const room = await getPrisma().room.findUnique({ where: { slug: roomSlug }, select: { id: true } });
    if (!room) return undefined;
    const row = await getPrisma().roomLastPosition.findUnique({ where: { roomId_userId: { roomId: room.id, userId } } });
    if (!row) return undefined;
    const restored: LastKnownPosition = { roomId: roomSlug, x: row.x, y: row.y, direction: row.direction };
    lastKnownPosition.set(userId, restored);
    return restored;
  } catch (e) {
    console.error('[roomStore] getLastKnownPosition DB fallback failed:', e);
    return undefined;
  }
}
