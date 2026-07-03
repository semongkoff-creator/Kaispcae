import { useMemo } from 'react';
import {
  PROXIMITY_THRESHOLD,
  ProximityPlayer,
  Avatar,
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

export function useProximity(
  localPlayer: Pick<Avatar, 'x' | 'y' | 'id'>,
  remotePlayers: Record<string, Avatar>,
): ProximityPlayer[] {
  return useMemo(() => {
    return Object.values(remotePlayers).map((p) => {
      const distanceTiles = calcDistanceTiles(localPlayer, p);
      return {
        id: p.id,
        distanceTiles,
        inProximity: distanceTiles <= PROXIMITY_THRESHOLD,
      };
    });
  }, [localPlayer.x, localPlayer.y, remotePlayers]);
}
