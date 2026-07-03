import { useMemo } from 'react';
import {
  PROXIMITY_THRESHOLD,
  ProximityPlayer,
  Avatar,
  Zone,
  TILE_SIZE,
} from '@virtualmeet/shared';

export function calcDistanceTiles(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = (a.x - b.x) / TILE_SIZE;
  const dy = (a.y - b.y) / TILE_SIZE;
  return Math.sqrt(dx * dx + dy * dy);
}

export function calcGain(distanceTiles: number): number {
  return Math.max(0, Math.min(1, 1 - distanceTiles / PROXIMITY_THRESHOLD));
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
  localPlayer: Pick<Avatar, 'x' | 'y' | 'id'>,
  remotePlayers: Record<string, Avatar>,
  zones: Zone[] = [],
): ProximityPlayer[] {
  return useMemo(() => {
    const localZone = findZoneAt(localPlayer, zones);

    return Object.values(remotePlayers).map((p) => {
      const distanceTiles = calcDistanceTiles(localPlayer, p);
      const remoteZone = findZoneAt(p, zones);

      // Zone membership overrides the global distance radius: players who
      // share a private zone always connect (regardless of distance), and
      // players split across a zone boundary never connect even if close.
      if (localZone || remoteZone) {
        const sameZone = !!localZone && !!remoteZone && localZone.id === remoteZone.id;
        return { id: p.id, distanceTiles, inProximity: sameZone, viaZone: sameZone };
      }

      return {
        id: p.id,
        distanceTiles,
        inProximity: distanceTiles <= PROXIMITY_THRESHOLD,
      };
    });
  }, [localPlayer.x, localPlayer.y, remotePlayers, zones]);
}
