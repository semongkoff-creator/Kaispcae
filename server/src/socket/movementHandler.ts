import { Server, Socket } from 'socket.io';
import { getPrisma } from '../lib/prisma';
import { SocketEvents, MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, isTileBlocked, isPointInImpassableArea, RoomTile, JumpEvent, NudgeEvent, PlayerMovePayload, PlayerMovedPayload, PlayerStoppedPayload } from '@kaispace/shared';
import { updatePlayerPosition, setPlayerStopped, getCachedTiles, getCachedImpassableAreas, getCachedDoorAreaRects, getCachedZones, getCachedPlayers } from '../store/roomStore';
import { isDoorUnlocked, isDoorAreaUnlocked, clearUnlockedDoors } from './doorLock';
import { isDoorOverrideActive } from './roomHandler';
import { createStoppedPayload } from './movementPayload';
import { socketRateLimit } from '../middleware/rateLimit';
import { clearMovementSequence, shouldAcceptMoveSequence } from './movementSequence';
import { collectStaleMovers, MoverEntry, STALE_MOVE_SWEEP_INTERVAL_MS } from './staleMovers';
import { recordPokeReceived } from '../lib/pokeResponse';
import { getPlayerName } from './roomHandler';
import { broadcastAnalyticsActivity } from './analyticsFeed';

// Rate limiting, per player.
//
// This has to sit BELOW the client's own send interval, not level with it.
// The client throttles emitMove to one packet per 50ms (useSocket.ts), so a
// 50ms floor here left exactly zero tolerance: a packet delayed even a
// millisecond less than its predecessor arrives 49ms after it and gets
// dropped as "too fast", even though the sender was perfectly well behaved.
// Ordinary network jitter therefore ate a steady fraction of legitimate
// movement updates, and the gaps showed up as stutter on every other
// client's screen. 30ms keeps the abuse ceiling meaningful (~33/sec against
// a client that sends 20/sec) while giving normal jitter room to land.
const rateLimitMap = new Map<string, number>();
const MIN_UPDATE_INTERVAL = 30;

// Sockets currently believed to be walking, and when they last said so.
//
// A client only ever stops being "moving" by SENDING a stop, and that emit
// lives inside the browser's requestAnimationFrame loop — which browsers
// suspend entirely for a backgrounded tab. Switch tabs mid-stride and the
// frame that would have sent it never runs: the server keeps the player
// flagged as moving, and every other client keeps cycling their walk (or
// run) animation over a position that never changes again. An avatar
// jogging on the spot forever, and nothing in the system ever cleaned it
// up — the flag only cleared on an explicit stop or on disconnect.
//
// So the server stops waiting to be told. If nothing has arrived from a
// mover for STALE_MOVE_TIMEOUT_MS, it calls the stop itself. Deliberately
// server-side rather than a client-side visibilitychange handler alone:
// this also covers a frozen tab, a dropped packet, and a client that lies.
const activeMovers = new Map<string, MoverEntry>();

let staleMoveSweep: ReturnType<typeof setInterval> | null = null;

function startStaleMoveSweep(io: Server): void {
  if (staleMoveSweep) return;
  staleMoveSweep = setInterval(() => {
    const now = Date.now();
    for (const { socketId, room } of collectStaleMovers(activeMovers, now)) {
      activeMovers.delete(socketId);

      // Gone already — the disconnect path has its own cleanup and has
      // told the room; nothing to announce on behalf of a socket that
      // isn't there.
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;

      const player = getCachedPlayers(room).find((p) => p.id === socketId);
      if (!player || !player.isMoving) continue;

      const stopped: PlayerStoppedPayload = {
        id: socketId,
        x: player.x,
        y: player.y,
        direction: player.direction,
        serverTime: now,
      };
      // socket.to(), NOT io.to() — everyone else needs correcting, but the
      // stale client does not. Sending it to them too would snap their own
      // avatar back to this position, and if the silence turned out to be a
      // network hiccup rather than a backgrounded tab, that reads as a
      // rubber-band on a player who never actually stopped.
      socket.to(room).emit(SocketEvents.PLAYER_STOPPED, stopped);
      void setPlayerStopped(room, socketId, player.x, player.y, player.direction);
    }
  }, STALE_MOVE_SWEEP_INTERVAL_MS);
  // Never a reason to hold the process open for this.
  staleMoveSweep.unref?.();
}

// QA #16 (Anti-spam) — Nudge had no cap at all: a spoofed/scripted client
// could fire PLAYER_NUDGE as fast as the socket allows. Same burst budget as
// Slap's canSlap (roomHandler.ts) minus its 30s per-target cooldown — Nudge
// stays purely cosmetic (no toast/sound intensity like Slap's), so a bare
// burst cap is enough to stop flooding without needing per-target tracking.
const canNudge = socketRateLimit(3);

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
  // Follow-up — "Door Area" tool, the resizable-area sibling of the
  // per-tile check just above. Reuses isPointInImpassableArea AS-IS (same
  // pixel-space rect shape, see mapLayers.ts's DoorAreaRect) against only
  // the subset of door areas that are actually still locked for THIS
  // socket — an unlocked or override-bypassed one is simply left out of
  // the list handed in, rather than teaching isPointInImpassableArea a new
  // per-socket concept it has no business knowing about.
  if (!isDoorOverrideActive(room)) {
    const lockedDoorAreas = getCachedDoorAreaRects(room).filter(
      (r) => r.doorPasswordEnabled && r.doorPassword && !isDoorAreaUnlocked(socketId, room, r.id),
    );
    if (lockedDoorAreas.length > 0 && isPointInImpassableArea(lockedDoorAreas, pixelX, pixelY)) return true;
  }
  if (isTileOccupiedInPrivateArea(room, tileX, tileY, socketId)) return true;
  return false;
}

// QA #2's own note — "karakter gabisa numpuk jika dalam private area"
// (characters can't stack while inside a private area) — confirmed to apply
// to EVERY private area, not just ones with a numeric capacity set (a
// left-unlimited private area is still a "real room" someone shouldn't be
// able to walk through another person inside). The Zone model has no
// explicit "this is a Private Area, not a Map Location" flag (both are
// zoneType 'desk' — see mapLayers.ts's layerDataToLegacy, which drops
// AreaEffect.effect entirely once converted), so `audioIsolated !== false`
// is the best available proxy: Private Area's whole point is isolating
// audio (defaults to isolate=true), Map Location's is a plain name pin
// (defaults to isolate=false) — matching the exact same inference
// RoomEditorPage.tsx's own preview already uses to tell them apart.
// Meeting/Focus areas (zoneType 'meeting'/'focus') are naturally excluded by
// the zoneType==='desk' check — this was never asked to extend to those. A
// player is never blocked by their OWN current tile — this only stops
// walking ONTO someone else, not standing still.
function isTileOccupiedInPrivateArea(room: string, tileX: number, tileY: number, selfId: string): boolean {
  const zone = getCachedZones(room).find(
    (z) => z.type === 'desk' && z.audioIsolated !== false && tileX >= z.x && tileX < z.x + z.width && tileY >= z.y && tileY < z.y + z.height,
  );
  if (!zone) return false;
  return getCachedPlayers(room).some((p) => {
    if (p.id === selfId) return false;
    return Math.floor(p.x / TILE_SIZE) === tileX && Math.floor(p.y / TILE_SIZE) === tileY;
  });
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
  startStaleMoveSweep(io);

  // Root cause of "jalan ke selatan snap balik" (walking south/diagonal
  // snapping back straight) — every handler below used to derive the game
  // room by picking the first entry in socket.rooms that wasn't the
  // socket's own id room. That's unsafe the moment a socket is ALSO a
  // member of any other room — which channel/DM chat (CHANNEL_JOIN/DM_JOIN,
  // see channelChatHandler.ts) makes routine, and which a reconnect makes
  // into an outright RACE: JOIN_ROOM's handler does real DB work before it
  // ever calls socket.join(gameRoomSlug), while CHANNEL_JOIN's handler can
  // finish faster and call socket.join('channel:<id>') first — landing the
  // CHANNEL room ahead of the actual game room in socket.rooms' insertion
  // order. `gameRoom` then silently resolved to a chat channel id instead
  // of the room slug: getCachedTiles(gameRoom) found nothing for it, so
  // every bounds/collision check below fell back to the OLD default 50x36
  // map size regardless of the room's real (possibly much larger) size,
  // clamping/rejecting moves that were actually fine — confirmed via
  // diagnostic logging showing exactly this (room: 'channel:...', hadTiles:
  // false) in production.
  //
  // Fix: track the game room explicitly from JOIN_ROOM itself, the same
  // pattern zoneHandler.ts/roomHandler.ts already use for the exact same
  // reason, instead of ever guessing from socket.rooms again.
  let currentRoom: string | null = null;
  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string) => {
    const slug = roomId || null;
    if (!slug) { currentRoom = null; return; }
    // Multi-tenant Fase 3 — this module (like ~10 others) registers its own
    // independent JOIN_ROOM listener; Socket.IO fires every one of them, so
    // roomHandler.ts rejecting a cross-org join does NOT stop this one from
    // also running. Without this check, `currentRoom` would still be set to
    // a room this socket never actually joined (socket.join never ran), and
    // PLAYER_MOVE broadcasts via io.to(gameRoom) reach a room regardless of
    // whether the SENDING socket is a member of it — letting a rejected
    // cross-org socket inject fake movement into another company's room.
    try {
      const room = await getPrisma().room.findUnique({ where: { slug }, select: { organizationId: true } });
      if (!room || room.organizationId !== (socket.data as { organizationId?: string }).organizationId) { currentRoom = null; return; }
    } catch (e) {
      console.error('[movement] org check failed:', e);
      currentRoom = null;
      return;
    }
    currentRoom = slug;
  });

  socket.on(SocketEvents.PLAYER_MOVE, (data: PlayerMovePayload) => {
    if (!shouldAcceptMoveSequence(socket.id, data?.seq)) return;
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number') return;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return;

    // Rate limit: skip if too many updates
    const now = Date.now();
    const lastUpdate = rateLimitMap.get(socket.id) || 0;
    if (now - lastUpdate < MIN_UPDATE_INTERVAL) return;
    rateLimitMap.set(socket.id, now);

    const gameRoom = currentRoom;
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

      const moved: PlayerMovedPayload = {
        id: socket.id,
        x: clampedX,
        y: clampedY,
        direction: data.direction || 'down',
        isRunning: !!data.isRunning,
        seq: data.seq,
        serverTime: now,
      };
      socket.to(gameRoom).emit(SocketEvents.PLAYER_MOVED, moved);
      updatePlayerPosition(gameRoom, socket.id, clampedX, clampedY, moved.direction, data.isRunning);
      // Refreshed on every accepted move; the sweep above calls the stop
      // itself if these ever run dry.
      activeMovers.set(socket.id, { room: gameRoom, lastMoveAt: now });
    }
  });

  // A4 — free double-click teleport. Same bounds + server-authoritative
  // collision guard as PLAYER_MOVE, but re-broadcast as PLAYER_TELEPORTED so
  // every client SNAPS instead of interpolating a slide across the map.
  socket.on(SocketEvents.PLAYER_TELEPORT_TO, (data: { x: number; y: number; direction?: string }) => {
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number') return;
    const gameRoom = currentRoom;
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
    const direction = data.direction || 'down';
    socket.to(gameRoom).emit(SocketEvents.PLAYER_TELEPORTED, { id: socket.id, x: clampedX, y: clampedY, direction });
    updatePlayerPosition(gameRoom, socket.id, clampedX, clampedY, direction, false);
    activeMovers.delete(socket.id);
  });

  socket.on(SocketEvents.PLAYER_STOP, (data: { x?: number; y?: number; direction: string }) => {
    const gameRoom = currentRoom;
    // Told properly — the sweep has nothing left to clean up here. Cleared
    // before the branch below so an early return can't leave a stale entry
    // behind to fire a redundant stop a second later.
    activeMovers.delete(socket.id);
    if (gameRoom) {
      const serverTime = Date.now();
      const tiles = getCachedTiles(gameRoom);
      const { mapWidth, mapHeight } = getMapBounds(tiles);
      const stopped = createStoppedPayload(socket.id, data, { mapWidth, mapHeight, tileSize: TILE_SIZE });
      if (!stopped) {
        const stoppedWithoutPosition: PlayerStoppedPayload = {
          id: socket.id,
          direction: (data.direction || 'down') as PlayerStoppedPayload['direction'],
          serverTime,
        };
        socket.to(gameRoom).emit(SocketEvents.PLAYER_STOPPED, stoppedWithoutPosition);
        setPlayerStopped(gameRoom, socket.id);
        return;
      }

      if (tiles) {
        const tileX = Math.floor(stopped.x / TILE_SIZE);
        const tileY = Math.floor(stopped.y / TILE_SIZE);
        if (isBlockedForSocket(tiles, gameRoom, socket.id, tileX, tileY, stopped.x, stopped.y)) {
          const blockedStop: PlayerStoppedPayload = {
            id: socket.id,
            direction: stopped.direction as PlayerStoppedPayload['direction'],
            serverTime,
          };
          socket.to(gameRoom).emit(SocketEvents.PLAYER_STOPPED, blockedStop);
          setPlayerStopped(gameRoom, socket.id);
          return;
        }
      }

      io.to(gameRoom).emit(SocketEvents.PLAYER_STOPPED, { ...stopped, serverTime });
      setPlayerStopped(gameRoom, socket.id, stopped.x, stopped.y, stopped.direction);
    }
  });

  // Jump — cosmetic, fire-and-forget (same shape/spirit as emoteHandler.ts's
  // EMOTE_PLAY relay), so no rate limit / position validation needed here.
  socket.on(SocketEvents.PLAYER_JUMP, () => {
    const gameRoom = currentRoom;
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
    if (!currentRoom) return;
    const event: NudgeEvent = { fromId: socket.id, targetId, timestamp: Date.now() };
    io.to(targetId).emit(SocketEvents.PLAYER_NUDGE, event);
    socket.emit(SocketEvents.PLAYER_NUDGE, event);

    // v2 Bagian B.4 — Vibe's "response time to poke" component starts
    // here. No findUserIdBySocket export needed: `io` already has direct
    // access to the target's own socket.data.
    const targetUserId = io.sockets.sockets.get(targetId)?.data?.userId as string | undefined;
    if (targetUserId) recordPokeReceived(targetUserId);

    // v2 Bagian B.2 #5 — Office Activity Feed, attributed to the SENDER
    // (the one taking the action), with the target as `other` for context.
    const senderUserId = (socket.data as { userId?: string }).userId;
    if (senderUserId) {
      broadcastAnalyticsActivity(io, senderUserId, getPlayerName(socket.id), 'poke', undefined, {
        userId: targetUserId ?? targetId,
        userName: getPlayerName(targetId),
      });
    }
  });

  // Clean up rate limit map on disconnect
  socket.on('disconnect', () => {
    rateLimitMap.delete(socket.id);
    activeMovers.delete(socket.id);
    clearMovementSequence(socket.id);
    clearUnlockedDoors(socket.id);
  });
}
