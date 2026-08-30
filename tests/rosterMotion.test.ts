import assert from 'node:assert/strict';
import { getPlayers, setPlayers, updatePlayerPosition, setPlayerStopped } from '../server/src/store/roomStore';
import { getLivePlayerMovement } from '../server/src/store/playerLiveState';
import type { Avatar } from '@kaispace/shared';

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { console.error(`  FAIL  ${name}`); console.error(err instanceof Error ? err.message : err); process.exitCode = 1; }
}

function avatar(id: string): Avatar {
  return { id, name: id, x: 1, y: 1, direction: 'down', isMoving: false, color: '#fff' } as Avatar;
}

const ROOM = 'roster-motion-test';

async function main() {
  await test('the merge reports motion while it is happening, and stops when it stops', async () => {
    await setPlayers(ROOM, [avatar('anna'), avatar('budi')]);
    await updatePlayerPosition(ROOM, 'anna', 5, 5, 'right', false);
    const moving = await getPlayers(ROOM);
    assert.equal(moving.find((p) => p.id === 'anna')!.isMoving, true);

    await setPlayerStopped(ROOM, 'anna', 5, 5, 'right');
    const stopped = await getPlayers(ROOM);
    assert.equal(stopped.find((p) => p.id === 'anna')!.isMoving, false);
    assert.equal(getLivePlayerMovement(ROOM, 'anna'), undefined);
  });

  await test('a stale write landing after a stop cannot freeze a walker mid-stride', async () => {
    // THE bug, and the interleaving is the whole point of it.
    //
    // getPlayers() merges live movement over the roster, and nearly every
    // writer does read-modify-write on that result. Handlers are async, so one
    // that read the roster while Anna was walking can finish AFTER she stops —
    // writing her mid-stride isMoving back over the corrected row.
    //
    // Nothing recovers from that. clearLivePlayerMovement empties the live map,
    // so the merge has nothing left to correct, while the stored row itself now
    // claims motion. Anna stands still and every client that joins or
    // refreshes from then on draws her running on the spot.
    //
    // Written out as an explicit stale array rather than by racing two real
    // handlers, because a sequential test cannot reproduce the ordering that
    // causes it — which is exactly why the earlier version of this file passed
    // with the bug still in place.
    await setPlayers(ROOM, [avatar('anna'), avatar('budi')]);
    await updatePlayerPosition(ROOM, 'anna', 7, 7, 'left', true);

    // A handler reads the roster now, while Anna is walking.
    const staleRead = await getPlayers(ROOM);
    assert.equal(staleRead.find((p) => p.id === 'anna')!.isMoving, true, 'the read really is mid-stride');

    // Anna stops before that handler gets to its write.
    await setPlayerStopped(ROOM, 'anna', 7, 7, 'left');

    // The handler now finishes, changing something unrelated to Anna.
    const budi = staleRead.find((p) => p.id === 'budi')!;
    budi.name = 'Budi Santoso';
    await setPlayers(ROOM, staleRead);

    const after = await getPlayers(ROOM);
    const anna = after.find((p) => p.id === 'anna')!;
    assert.equal(anna.isMoving, false, 'Anna is standing still and must read as still');
    assert.equal(anna.isRunning, false);
    // And the unrelated change still has to survive — the fix strips motion,
    // not everything else.
    assert.equal(after.find((p) => p.id === 'budi')!.name, 'Budi Santoso');
  });

  await test('the durable roster never records motion at all', async () => {
    // The invariant the case above rests on: the roster is the at-rest truth,
    // the live map is the moving truth, and no write may mix them.
    await setPlayers(ROOM, [{ ...avatar('anna'), isMoving: true, isRunning: true } as Avatar]);
    const roster = await getPlayers(ROOM);   // anna has no live entry here
    assert.equal(roster[0].isMoving, false, 'a write may not smuggle motion into storage');
    assert.equal(roster[0].isRunning, false);
  });

  console.log(`\n${passed} roster motion test(s) passed`);
  // Explicit, because roomStore's Redis client keeps a socket handle open even
  // after failing to connect, and node will not exit while it is there.
  process.exit(process.exitCode ? Number(process.exitCode) : 0);
}

void main();
