import { Server, Socket } from 'socket.io';
import { SocketEvents, MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, isTileBlocked, isPointInImpassableArea, RoomTile, JumpEvent, NudgeEvent } from '@virtualmeet/shared';
import { updatePlayerPosition, setPlayerStopped, getCachedTiles, getCachedImpassableAreas } from '../store/roomStore';
import { isDoorUnlocked, clearUnlockedDoors } from './doorLock';
import { isDoorOverrideActive } from './roomHandler';
import { createStoppedPayload } from './movementPayload';
import { socketRateLimit } from '../middleware/rateLimit';

// Rate limiting: max 20 updates per second per player
const rateLimitMap = new Map<string, number>();
const MIN_UPDATE_INTERVAL = 1000 / 20; // 50ms

// QA #16 (Anti-spam) — Nudge had no cap at all: a spoofed/scripted client
// could fire PLAYER_NUDGE as fast as the socket allows. Same burst budget as
// Slap's canSlap (roomHandler.ts) minus its 30s per-target cooldown — Nudge
// stays purely cosmetic (no toast/sound intensity like Slap's), so a bare
// burst cap is enough to stop flooding without needing per-target tracking.
const canNudge = socketRateLimit(3);

interface MoveData {
  x: number;
  y: number;
  direction: string;
  isRunning?: boolean;
}

// ZEP-style door password — server-authoritative half of the gate (the
// client also predicts this locally for responsive collision, see
// GameCanvas.tsx's isBlocked). A password-protected door this socket hasn't
// solved yet is treated exactly like any other blocked tile: the move is
// silently dropped, same as walking into a wall. Not in BLOCKED_TILES itself
// since that's a static set keyed only on TileType — this needs per-socket,
// per-room session state isTileBlocked has no way to see.
//
// Item #9 (precise-collision follow-up) — pixelX/pixelY are the ACTUAL
// (clamped, un-floored) target position, needed alongside tileX/tileY
// because Impassable Area rectangles are checked at sub-tile precision, not
// against the tile grid (see mapLayers.ts's getImpassableAreaRects doc
// comment for why they're never rasterized into it).
function isBlockedForSocket(tiles: RoomTile[][], room: string, socketId: string, tileX: number, tileY: number, pixelX: number, pixelY: number): boolean {
  if (isTileBlocked(tiles, tileX, tileY)) return true;
  if (isPointInImpassableArea(getCachedImpassableAreas(room), pixelX, pixelY)) return true;
  const tile = tiles[tileY]?.[tileX];
  if (tile?.type === 'door' && tile.doorPasswordEnabled && tile.doorPassword) {
    // Item #9 — emergency override lets everyone through every door in this
    // room, bypassing the normal per-socket unlock entirely.
    if (isDoorOverrideActive(room)) return false;
    return !isDoorUnlocked(socketId, room, tileX, tileY);
  }
  return false;
}

// QA follow-up ("jalan ke selatan snap balik") — MAP_WIDTH/MAP_HEIGHT (50x36)
// are only the DEFAULT room grid; the Room Editor's Resize tool lets an
// admin grow a room up to 200x200 (see GameCanvas.tsx's matching client-side
// fix for the Overview-mode version of this exact bug). Every bounds clamp
// below used to clamp against the fixed constants regardless of the actual
// room size — so in a resized room, walking/teleporting past the OLD
// boundary got silently clamped back by the server, most visibly via
// PLAYER_STOP: it broadcasts (via io.to, which includes the sender) the
// server-clamped position back to the mover's OWN client the instant they
// stop, snapping them back to the old edge even though they'd walked
// further. Deriving real bounds from the room's cached tile grid — already
// fetched for the collision check right after — fixes every one of these
// the same way. Falls back to the fixed defaults when tiles aren't cached
// yet for this room (same fail-open posture the collision check already
// has below), which is exactly the existing behavior for a never-resized
// room anyway.
function getMapBounds(tiles: RoomTile[][] | undefined): { mapWidth: number; mapHeight: number } {
  return {
    mapWidth: tiles?.[0]?.length || MAP_WIDTH,
    mapHeight: tiles?.length || MAP_HEIGHT,
  };
}

export function registerMovementHandlers(io: Server, socket: Socket) {
  socket.on(SocketEvents.PLAYER_MOVE, (data: MoveData) => {
    // Rate limit: skip if too many updates
    const now = Date.now();
    const lastUpdate = rateLimitMap.get(socket.id) || 0;
    if (now - lastUpdate < MIN_UPDATE_INTERVAL) return;
    rateLimitMap.set(socket.id, now);

    // Broadcast to all others in the socket's game room only — a plain
    // socket.broadcast.emit would leak positions to every room on the server.
    const rooms = Array.from(socket.rooms);
    const gameRoom = rooms.find((r) => r !== socket.id);
    if (gameRoom) {
      // Server-authoritative collision check: previously this handler only
      // clamped to the map's outer rectangle and otherwise broadcast
      // whatever x/y the client reported — a modified client could walk
      // through walls/desks since nothing re-validated against the actual
      // room layout. getCachedTiles() is populated by roomHandler.ts on
      // join and on every editor save, so this is a synchronous lookup, no
      // DB round-trip per move. If the room's tiles haven't been cached yet
      // (e.g. a stray move racing the initial ROOM_STATE), fail open rather
      // than silently dropping legitimate early input.
      const tiles = getCachedTiles(gameRoom);
      const { mapWidth, mapHeight } = getMapBounds(tiles);
      const clampedX = Math.max(TILE_SIZE / 2, Math.min(mapWidth * TILE_SIZE - TILE_SIZE / 2, data.x));
      const clampedY = Math.max(TILE_SIZE / 2, Math.min(mapHeight * TILE_SIZE - TILE_SIZE / 2, data.y));
      if (tiles) {
        const tileX = Math.floor(clampedX / TILE_SIZE);
        const tileY = Math.floor(clampedY / TILE_SIZE);
        if (isBlockedForSocket(tiles, gameRoom, socket.id, tileX, tileY, clampedX, clampedY)) return;
      }

      socket.to(gameRoom).emit(SocketEvents.PLAYER_MOVED, {
        id: socket.id,
        x: clampedX,
        y: clampedY,
        direction: data.direction,
        isRunning: !!data.isRunning,
      });
      updatePlayerPosition(gameRoom, socket.id, clampedX, clampedY, data.direction, data.isRunning);
    }
  });

  // A4 — free double-click teleport. Same bounds + server-authoritative
  // collision guard as PLAYER_MOVE, but re-broadcast as PLAYER_TELEPORTED so
  // every client SNAPS instead of interpolating a slide across the map.
  socket.on(SocketEvents.PLAYER_TELEPORT_TO, (data: { x: number; y: number; direction?: string }) => {
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number') return;
    const rooms = Array.from(socket.rooms);
    const gameRoom = rooms.find((r) => r !== socket.id);
    if (!gameRoom) return;
    const tiles = getCachedTiles(gameRoom);
    const { mapWidth, mapHeight } = getMapBounds(tiles);
    const clampedX = Math.max(TILE_SIZE / 2, Math.min(mapWidth * TILE_SIZE - TILE_SIZE / 2, data.x));
    const clampedY = Math.max(TILE_SIZE / 2, Math.min(mapHeight * TILE_SIZE - TILE_SIZE / 2, data.y));
    if (tiles) {
      const tileX = Math.floor(clampedX / TILE_SIZE);
      const tileY = Math.floor(clampedY / TILE_SIZE);
      if (isBlockedForSocket(tiles, gameRoom, socket.id, tileX, tileY, clampedX, clampedY)) return; // refuse teleport into a wall/desk/locked door
    }
    const direction = (data.direction as MoveData['direction']) || 'down';
    socket.to(gameRoom).emit(SocketEvents.PLAYER_TELEPORTED, { id: socket.id, x: clampedX, y: clampedY, direction });
    updatePlayerPosition(gameRoom, socket.id, clampedX, clampedY, direction, false);
  });

  socket.on(SocketEvents.PLAYER_STOP, (data: { x?: number; y?: number; direction: string }) => {
    const rooms = Array.from(socket.rooms);
    const gameRoom = rooms.find((r) => r !== socket.id);
    if (gameRoom) {
      const tiles = getCachedTiles(gameRoom);
      const { mapWidth, mapHeight } = getMapBounds(tiles);
      const stopped = createStoppedPayload(socket.id, data, { mapWidth, mapHeight, tileSize: TILE_SIZE });
      if (!stopped) {
        socket.to(gameRoom).emit(SocketEvents.PLAYER_STOPPED, {
          id: socket.id,
          direction: data.direction,
        });
        setPlayerStopped(gameRoom, socket.id);
        return;
      }

      if (tiles) {
        const tileX = Math.floor(stopped.x / TILE_SIZE);
        const tileY = Math.floor(stopped.y / TILE_SIZE);
        if (isBlockedForSocket(tiles, gameRoom, socket.id, tileX, tileY, stopped.x, stopped.y)) {
          socket.to(gameRoom).emit(SocketEvents.PLAYER_STOPPED, {
            id: socket.id,
            direction: stopped.direction,
          });
          setPlayerStopped(gameRoom, socket.id);
          return;
        }
      }

      io.to(gameRoom).emit(SocketEvents.PLAYER_STOPPED, stopped);
      setPlayerStopped(gameRoom, socket.id, stopped.x, stopped.y, stopped.direction);
    }
  });

  // Jump — cosmetic, fire-and-forget (same shape/spirit as emoteHandler.ts's
  // EMOTE_PLAY relay), so no rate limit / position validation needed here.
  socket.on(SocketEvents.PLAYER_JUMP, () => {
    const rooms = Array.from(socket.rooms);
    const gameRoom = rooms.find((r) => r !== socket.id);
    if (!gameRoom) return;
    const event: JumpEvent = { playerId: socket.id, timestamp: Date.now() };
    socket.to(gameRoom).emit(SocketEvents.PLAYER_JUMP, event);
  });

  // Nudge ("senggol") — same trust level as Jump above: the client already
  // decided who's standing on the tile it's facing, this just relays it.
  // Worst case of a spoofed targetId is someone's avatar shaking with no
  // real trigger — purely cosmetic, nothing persisted.
  //
  // Potongan B — scoped to exactly the target + the sender (mirrors
  // roomHandler.ts's Slap/SLAPPED/SLAP_SENT, which already got this right):
  // a bystander must not receive this event at all, or useSocket.ts's
  // handler would play them an "ambient" sound and trigger the target's
  // shake animation on their screen too. Previously broadcast to the whole
  // room on purpose ("everyone hears an ambient blip") — that was the bug
  // being reported, not an oversight, so this is a deliberate behavior
  // change, not a targeting mistake. The client needs NO changes: it
  // already branches on `event.targetId === localPlayerId` to play the
  // target's stronger sound/toast vs. the sender's quieter one — with only
  // these two sockets ever receiving the event now, that existing branch
  // does exactly the right thing for both.
  socket.on(SocketEvents.PLAYER_NUDGE, (data: { targetId?: string }) => {
    if (!canNudge(socket.id)) return;
    const targetId = data?.targetId;
    if (!targetId || targetId === socket.id) return;
    const rooms = Array.from(socket.rooms);
    const gameRoom = rooms.find((r) => r !== socket.id);
    if (!gameRoom) return;
    const event: NudgeEvent = { fromId: socket.id, targetId, timestamp: Date.now() };
    io.to(targetId).emit(SocketEvents.PLAYER_NUDGE, event);
    socket.emit(SocketEvents.PLAYER_NUDGE, event);
  });

  // Clean up rate limit map on disconnect
  socket.on('disconnect', () => {
    rateLimitMap.delete(socket.id);
    clearUnlockedDoors(socket.id);
  });
}
