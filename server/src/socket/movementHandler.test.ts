import assert from 'node:assert/strict';
import { createStoppedPayload } from './movementPayload';
import { collectStaleMovers, MoverEntry } from './staleMovers';
import { clearMovementSequence, shouldAcceptMoveSequence } from './movementSequence';
import { clearLivePlayerMovement, mergeLivePlayerMovement, setLivePlayerMovement } from '../store/playerLiveState';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Movement tests. This repo has no test runner, so this file is a plain
// self-checking script:
//
//     npx tsx server/src/socket/movementHandler.test.ts
//
// It exits non-zero on the first failed assertion.

const TILE_SIZE = 48;

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

test('player stop payload includes authoritative final position', () => {
  const payload = createStoppedPayload(
    'socket-a',
    { x: TILE_SIZE * 2, y: TILE_SIZE * 3, direction: 'right' },
    { mapWidth: 50, mapHeight: 36, tileSize: TILE_SIZE },
  );

  assert.deepEqual(payload, { id: 'socket-a', x: TILE_SIZE * 2, y: TILE_SIZE * 3, direction: 'right' });
});

test('player stop payload clamps impossible positions to map bounds', () => {
  const payload = createStoppedPayload(
    'socket-a',
    { x: -999, y: 99999, direction: 'left' },
    { mapWidth: 50, mapHeight: 36, tileSize: TILE_SIZE },
  );

  assert.deepEqual(payload, {
    id: 'socket-a',
    x: TILE_SIZE / 2,
    y: 36 * TILE_SIZE - TILE_SIZE / 2,
    direction: 'left',
  });
});

test('movement sequence rejects stale or duplicate move packets', () => {
  const socketId = 'socket-seq';
  clearMovementSequence(socketId);

  assert.equal(shouldAcceptMoveSequence(socketId, 10), true);
  assert.equal(shouldAcceptMoveSequence(socketId, 10), false);
  assert.equal(shouldAcceptMoveSequence(socketId, 9), false);
  assert.equal(shouldAcceptMoveSequence(socketId, 11), true);

  clearMovementSequence(socketId);
});

test('movement sequence keeps legacy unsequenced move packets accepted', () => {
  const socketId = 'socket-legacy';
  clearMovementSequence(socketId);

  assert.equal(shouldAcceptMoveSequence(socketId, undefined), true);
  assert.equal(shouldAcceptMoveSequence(socketId, 1), true);

  clearMovementSequence(socketId);
});

test('live player movement overlays active positions without mutating the source list', () => {
  const roomId = 'room-live-state';
  clearLivePlayerMovement(roomId, 'socket-live');
  const players = [{
    id: 'socket-live',
    name: 'Live',
    x: 48,
    y: 48,
    direction: 'down' as const,
    color: '#fff',
    isMoving: false,
  }];

  setLivePlayerMovement(roomId, 'socket-live', {
    x: 96,
    y: 120,
    direction: 'right',
    isMoving: true,
    isRunning: true,
  });

  const merged = mergeLivePlayerMovement(roomId, players);

  assert.equal(players[0].x, 48);
  assert.equal(merged[0].x, 96);
  assert.equal(merged[0].y, 120);
  assert.equal(merged[0].direction, 'right');
  assert.equal(merged[0].isMoving, true);
  assert.equal(merged[0].isRunning, true);

  clearLivePlayerMovement(roomId, 'socket-live');
});

// ── stale movers: a client that never sent its stop ───────────────────────

const movers = (entries: Record<string, number>): Map<string, MoverEntry> =>
  new Map(Object.entries(entries).map(([id, lastMoveAt]) => [id, { room: 'office', lastMoveAt }]));

test('a mover that went quiet past the timeout is swept', () => {
  const now = 100_000;
  const stale = collectStaleMovers(movers({ 'gone-quiet': now - 900 }), now, 800);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].socketId, 'gone-quiet');
  assert.equal(stale[0].room, 'office', 'the room has to survive — the stop is broadcast into it');
});

test('a mover still sending is left alone', () => {
  const now = 100_000;
  // 50ms is the client's own send interval; anything near it must not trip.
  assert.equal(collectStaleMovers(movers({ walking: now - 50 }), now, 800).length, 0);
  assert.equal(collectStaleMovers(movers({ jittery: now - 400 }), now, 800).length, 0);
});

test('the timeout boundary is inclusive, not off by one', () => {
  const now = 100_000;
  assert.equal(collectStaleMovers(movers({ a: now - 799 }), now, 800).length, 0, 'just inside stays');
  assert.equal(collectStaleMovers(movers({ a: now - 800 }), now, 800).length, 1, 'exactly at the limit goes');
});

test('only the quiet movers are swept, not the whole room', () => {
  const now = 100_000;
  const stale = collectStaleMovers(
    movers({ backgrounded: now - 5000, walking: now - 60, alsoStuck: now - 2000 }),
    now,
    800,
  );
  assert.deepEqual(stale.map((m) => m.socketId).sort(), ['alsoStuck', 'backgrounded']);
});

test('an empty roster sweeps nothing', () => {
  assert.deepEqual(collectStaleMovers(new Map(), Date.now(), 800), []);
});


// ── the stale-move sweep reads the right source ──────────────────────────

test('a roster row never reports movement, so nothing may ask it', () => {
  // setPlayerMoved writes movement into the live map and returns a merged
  // COPY, leaving the stored roster untouched. A roster row's isMoving is
  // therefore false for a player's whole session. The sweep used to gate on
  // exactly that field, so it skipped every player and cleaned up nothing —
  // and anyone who refreshed saw a quiet player walking on the spot.
  const src = readFileSync(resolve('server/src/socket/movementHandler.ts'), 'utf8');
  assert.equal(
    /if \(!player \|\| !player\.isMoving\) continue/.test(src), false,
    'the sweep must not gate on the roster row',
  );
  assert.ok(/getLivePlayerMovement\(room, socketId\)/.test(src), 'it must ask the live state');
  assert.ok(/if \(!live\?\.isMoving\) continue/.test(src));
});

test('a vanished socket still gets its live flag cleared', () => {
  // The roster cleanup belongs to the disconnect path, but a player held
  // through the disconnect debounce would otherwise be handed to the next
  // person who refreshes, still moving.
  const src = readFileSync(resolve('server/src/socket/movementHandler.ts'), 'utf8');
  const at = src.indexOf('if (!socket) {');
  assert.ok(at > 0, 'the vanished-socket branch should be explicit');
  assert.ok(src.slice(at, at + 160).includes('clearLivePlayerMovement'));
});

test('the stop is announced at the position the mover actually reached', () => {
  // The roster row's x/y is only written when a stop arrives — the very
  // event that never came. Using it would snap the avatar back to wherever
  // they last stopped, which can be the other side of the room.
  const src = readFileSync(resolve('server/src/socket/movementHandler.ts'), 'utf8');
  assert.ok(/x: live\.x/.test(src));
  assert.ok(/setPlayerStopped\(room, socketId, live\.x, live\.y, live\.direction\)/.test(src));
});

test('the live state can be read back, not only written', () => {
  const live = readFileSync(resolve('server/src/store/playerLiveState.ts'), 'utf8');
  assert.ok(/export function getLivePlayerMovement/.test(live));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} movement test(s) passed`);
