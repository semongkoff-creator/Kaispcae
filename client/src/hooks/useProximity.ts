import { useMemo } from 'react';
import {
  PROXIMITY_THRESHOLD,
  TRANSLUCENT_THRESHOLD,
  ProximityPlayer,
  VisibilityStatus,
  Avatar,
  Zone,
  Furniture,
  TILE_SIZE,
} from '@kaispace/shared';
// Relative, not the '@/' alias: this module is loaded directly by the
// test runner from the repo root, which doesn't resolve the client's
// tsconfig paths.
import { remotePos } from '../stores/remotePositions';

// §6 (RTC upgrade) — Chebyshev distance (max(|dx|,|dy|)), not Euclidean:
// movement here is grid-based with 8 directions (see useMovement.ts), so
// "how many steps away" is what should gate visibility, not straight-line
// distance — the spec's own stated reasoning for this choice.
export function calcDistanceTiles(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = Math.abs(a.x - b.x) / TILE_SIZE;
  const dy = Math.abs(a.y - b.y) / TILE_SIZE;
  return Math.max(dx, dy);
}

// Fades across the whole full+translucent range (not just to the edge of
// "full") so audio doesn't hit silence right at the full/translucent
// boundary while the peer is still rendered on screen.
export function calcGain(distanceTiles: number): number {
  return Math.max(0, Math.min(1, 1 - distanceTiles / TRANSLUCENT_THRESHOLD));
}

// Finds the zone (if any) that contains a pixel position. Zone x/y/width/height
// are in TILE units (see Zone in shared/types and the overlay draw in
// GameCanvas.tsx), so the position is converted to tile coordinates first.
//
// Bug fix — when more than one zone covers the same point (e.g. a small,
// specifically-drawn Private Area sitting inside a much larger Map Location
// that was ALSO marked "kedap suara: YA"), this used to just return whichever
// one happened to come first in the zones array — in practice always the
// bigger, coarser one, since it's usually drawn first. That silently shadowed
// every smaller area nested inside it (never selected for chat/audio/dim,
// no matter how deliberately it was drawn) with no way to tell from the UI.
// Smallest-area-wins matches what an admin actually means by drawing a
// tighter rectangle on top of a looser one — same intuition as "the more
// specific CSS selector wins" — and needs no data migration: it's purely a
// tie-break over rects that were always there.
export function findZoneAt(pos: { x: number; y: number }, zones: Zone[]): Zone | undefined {
  const tileX = pos.x / TILE_SIZE;
  const tileY = pos.y / TILE_SIZE;
  let best: Zone | undefined;
  let bestArea = Infinity;
  for (const z of zones) {
    if (tileX < z.x || tileX >= z.x + z.width || tileY < z.y || tileY >= z.y + z.height) continue;
    const area = z.width * z.height;
    if (area < bestArea) { best = z; bestArea = area; }
  }
  return best;
}

// Pure form of the calculation. Split out of the hook because proximity is
// no longer derived from React state on every render: remote positions live
// outside the store now (see remotePositions.ts), so App drives this on a
// fixed tick instead. The hook below is kept for any caller that still wants
// the memoised, props-driven shape.
export function computeProximity(
  localPlayer: Pick<Avatar, 'x' | 'y' | 'id' | 'isSitting' | 'seatFurnitureId' | 'workMode'>,
  remotePlayers: Record<string, Avatar>,
  zones: Zone[] = [],
  furniture: Furniture[] = [],
): ProximityPlayer[] {
  {
    // A zone only overrides distance-based hearing when it isolates audio
    // (Zone.audioIsolated !== false) — a 'Map location' area (see the Room
    // Editor's Map Location tool) is just a name pin, so standing near its
    // boundary should hear people the normal distance-based way instead of
    // going dead silent the instant someone's one step outside the pin.
    const audioZoneAt = (pos: { x: number; y: number }): Zone | undefined => {
      const z = findZoneAt(pos, zones);
      return z && z.audioIsolated !== false ? z : undefined;
    };
    const localZone = audioZoneAt(localPlayer);
    // A3 — Do-Not-Disturb: a focus-mode avatar neither triggers nor receives
    // auto-connect. If WE are in focus, nobody connects to us at all.
    const localFocus = localPlayer.workMode === 'focus';

    // chair Furniture.id → its tableId, so a seated player's table can be
    // resolved from the seatFurnitureId they broadcast. Only chairs that were
    // actually grouped carry a tableId.
    const tableOfChair = new Map<string, string>();
    for (const f of furniture) {
      if (f.tableId) tableOfChair.set(f.id, f.tableId);
    }
    const seatedTable = (a: Pick<Avatar, 'isSitting' | 'seatFurnitureId'>): string | undefined =>
      a.isSitting && a.seatFurnitureId ? tableOfChair.get(a.seatFurnitureId) : undefined;
    const localTable = seatedTable(localPlayer);

    return Object.values(remotePlayers).map((p) => {
      // remotePos, not p.x/p.y — a moving player's record no longer carries
      // their current position; the interpolated overlay does (see
      // remotePositions.ts). Reading the record here would freeze everyone
      // at wherever they last came to a stop.
      const pos = remotePos(p);
      const distanceTiles = calcDistanceTiles(localPlayer, pos);

      // ZEP-style Spotlight — an admin-toggled PA broadcast (see
      // shared/permissions.ts's 'presence:spotlight'). Checked BEFORE the
      // Focus/DND check below so it overrides DND in both directions: a
      // spotlighted player reaches someone who's in Focus mode, same as a
      // real announcement breaking through noise-cancelling headphones.
      // viaZone:true forces full volume (calcGain would otherwise fade it
      // with distance) — an announcement should be uniformly audible, not
      // quieter the farther away you are.
      if (p.spotlightActive) {
        return { id: p.id, distanceTiles, visibility: 'full_visible' as VisibilityStatus, viaZone: true };
      }

      // A3 Focus/DND — checked before table/zone/distance so it overrides every
      // auto-connect path (including a shared 'focus' zone: focus is meant to be
      // solo). If either side is in focus mode, they don't auto-connect.
      if (localFocus || p.workMode === 'focus') {
        return { id: p.id, distanceTiles, visibility: 'not_visible' as VisibilityStatus };
      }

      // Table membership: two people seated at chairs sharing a tableId are one
      // private group — the SAME effect as a shared zone (full connect, full
      // volume via viaZone), checked FIRST so it holds even if one of them is
      // also standing inside some zone. A table in the open (no zone) works
      // identically. Standing clears seatFurnitureId, so this lapses on its own
      // and they fall back to plain distance below.
      if (localTable && seatedTable(p) === localTable) {
        return { id: p.id, distanceTiles, visibility: 'full_visible' as VisibilityStatus, viaZone: true };
      }

      const remoteZone = audioZoneAt(pos);

      // Zone membership overrides the global distance radius: players who
      // share a private zone always connect (regardless of distance), and
      // players split across a zone boundary never connect even if close.
      if (localZone || remoteZone) {
        const sameZone = !!localZone && !!remoteZone && localZone.id === remoteZone.id;
        const visibility: VisibilityStatus = sameZone ? 'full_visible' : 'not_visible';
        return { id: p.id, distanceTiles, visibility, viaZone: sameZone };
      }

      const visibility: VisibilityStatus =
        distanceTiles <= PROXIMITY_THRESHOLD ? 'full_visible' : distanceTiles <= TRANSLUCENT_THRESHOLD ? 'translucent' : 'not_visible';
      return { id: p.id, distanceTiles, visibility };
    });
  }
}

export function useProximity(
  localPlayer: Pick<Avatar, 'x' | 'y' | 'id' | 'isSitting' | 'seatFurnitureId' | 'workMode'>,
  remotePlayers: Record<string, Avatar>,
  zones: Zone[] = [],
  furniture: Furniture[] = [],
): ProximityPlayer[] {
  return useMemo(
    () => computeProximity(localPlayer, remotePlayers, zones, furniture),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [localPlayer.x, localPlayer.y, localPlayer.isSitting, localPlayer.seatFurnitureId, localPlayer.workMode, remotePlayers, zones, furniture],
  );
}

// Two proximity results are interchangeable when nothing downstream would
// behave differently: same peers, same visibility, and a distance close
// enough that the gain it produces is indistinguishable. Used to skip the
// state update on a tick where nobody meaningfully moved, so standing still
// costs zero renders rather than one per tick.
export function proximityUnchanged(a: ProximityPlayer[], b: ProximityPlayer[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id) return false;
    if (x.visibility !== y.visibility) return false;
    if (!!x.viaZone !== !!y.viaZone) return false;
    // 0.01 tile is well below the resolution of anything reading this —
    // gain, the video-slot ranking, or the distance shown in the UI.
    if (Math.abs(x.distanceTiles - y.distanceTiles) > 0.01) return false;
  }
  return true;
}
