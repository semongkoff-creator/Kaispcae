// One-off backfill: gives every already-drawn Map Location / Private Area /
// Focus Area (and, defensively, any Meeting/Restricted Area that predates
// its own explicit color) its correct color in Room.layerData.areas —
// matching the mapping editorStore.ts's addArea() now writes for NEWLY
// drawn areas (see that file's own comment for why these 5 colors
// specifically). Rooms drawn before that client fix landed still have
// color: undefined in their stored JSON, so their banners render the wrong
// (fallback purple) color in-game — this script is what makes
// already-drawn areas pick up the fix too, not just new ones going forward.
//
// Dry-run by default (reports what WOULD change, writes nothing). This is a
// multi-room data mutation — unlike this folder's other script
// (seedKaitechRoom.ts, a single fixed-slug room, idempotent-safe by
// construction) — so a preview pass before any real write is the safer
// default here, not an existing convention this repo already has elsewhere.
//
// Run with: npx tsx server/scripts/backfillAreaColors.ts          (dry run, writes nothing)
//           npx tsx server/scripts/backfillAreaColors.ts --apply  (writes)

import 'dotenv/config';
import { getPrisma } from '../src/lib/prisma';

// Mirrors client/src/stores/editorStore.ts's addArea() color mapping exactly.
const COLOR_BY_EFFECT: Record<string, string> = {
  meetingArea: '#14b8a6',
  restrictedArea: '#dc2626',
  mapLocation: '#c084fc',
  privateArea: '#60a5fa',
  focusArea: '#f59e0b',
  recordArea: '#db2777',
};

const BATCH_SIZE = 200;
const apply = process.argv.includes('--apply');

async function main() {
  const prisma = getPrisma();
  let cursor: string | undefined;
  let roomsScanned = 0;
  let roomsChanged = 0;
  let areasBackfilled = 0;

  for (;;) {
    // No `layerData`-not-null filter at the DB level — Prisma's JSON null
    // semantics (Prisma.JsonNull vs Prisma.DbNull) are an easy footgun to
    // get subtly wrong, and this repo has no existing query to copy the
    // right form from. Paginating unfiltered and checking in JS below is
    // simple and, at low-hundreds of rooms, cheap enough either way.
    const rooms: { id: string; slug: string; name: string; layerData: unknown }[] = await prisma.room.findMany({
      select: { id: true, slug: true, name: true, layerData: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rooms.length === 0) break;

    for (const room of rooms) {
      roomsScanned++;
      const layerData = room.layerData as { areas?: { effect?: string; color?: string }[] } | null;
      if (!layerData || !Array.isArray(layerData.areas)) continue;

      let changedHere = 0;
      for (const area of layerData.areas) {
        if (area.color) continue; // already colored (explicit, or an earlier run of this script)
        const color = area.effect ? COLOR_BY_EFFECT[area.effect] : undefined;
        if (!color) continue; // not one of the 5 affected types
        area.color = color;
        changedHere++;
      }

      if (changedHere > 0) {
        roomsChanged++;
        areasBackfilled += changedHere;
        console.log(`${apply ? '[APPLY]' : '[DRY RUN]'} ${room.slug} (${room.name}): ${changedHere} area(s) colored`);
        if (apply) {
          await prisma.room.update({ where: { id: room.id }, data: { layerData: layerData as unknown as object } });
        }
      }
    }

    cursor = rooms[rooms.length - 1].id;
    if (rooms.length < BATCH_SIZE) break;
  }

  console.log(`\n[backfillAreaColors] Scanned ${roomsScanned} room(s) with layerData, ${roomsChanged} needed a backfill, ${areasBackfilled} area(s) colored.`);
  if (!apply) console.log('[backfillAreaColors] Dry run only, nothing written — re-run with --apply to write these changes.');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[backfillAreaColors] FAILED:', err);
  process.exit(1);
});
