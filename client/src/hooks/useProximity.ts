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
} from '@virtualmeet/shared';

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
export function findZoneAt(pos: { x: number; y: number }, zones: Zone[]): Zone | undefined {
  const tileX = pos.x / TILE_SIZE;
  const tileY = pos.y / TILE_SIZE;
  return zones.find((z) => tileX >= z.x && tileX < z.x + z.width && tileY >= z.y && tileY < z.y + z.height);
}

export function useProximity(
  localPlayer: Pick<Avatar, 'x' | 'y' | 'id' | 'isSitting' | 'seatFurnitureId' | 'workMode'>,
  remotePlayers: Record<string, Avatar>,
  zones: Zone[] = [],
  spotlightedUserIds: string[] = [],
  furniture: Furniture[] = [],
): ProximityPlayer[] {
  return useMemo(() => {
    const localZone = findZoneAt(localPlayer, zones);
    const spotlightSet = new Set(spotlightedUserIds);
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
      const distanceTiles = calcDistanceTiles(localPlayer, p);

      // §6 — spotlight bypasses distance/zone entirely (spec's own
      // computeVisibility rule: "if target.isSpotlighted: return FULL_VISIBLE").
      // viaZone: true here too — it's what useWebRTC.ts reads to decide
      // "skip the distance falloff, use full volume" (viaZone ? 1 :
      // calcGain(distanceTiles)); without it a spotlighted-but-far player
      // would render at full opacity but stay silent, since distanceTiles
      // still reflects their real (possibly huge) distance.
      if (p.userId && spotlightSet.has(p.userId)) {
        return { id: p.id, distanceTiles, visibility: 'full_visible' as VisibilityStatus, viaZone: true };
      }

      // A3 Focus/DND — checked before table/zone/distance so it overrides every
      // auto-connect path (including a shared 'focus' zone: focus is meant to be
      // solo). If either side is in focus mode, they don't auto-connect. Spotlight
      // above still wins as a deliberate admin override.
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

      const remoteZone = findZoneAt(p, zones);

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
  }, [localPlayer.x, localPlayer.y, localPlayer.isSitting, localPlayer.seatFurnitureId, localPlayer.workMode, remotePlayers, zones, spotlightedUserIds, furniture]);
}
