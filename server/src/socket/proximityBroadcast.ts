import { TILE_SIZE, TRANSLUCENT_THRESHOLD } from '@virtualmeet/shared';
import { getPlayers } from '../store/roomStore';
import { zoneIdOfSocket, getSocketIdsInZone } from './zoneHandler';

// Shared "who's near me" audience computation for cosmetic, real-time cues
// that should reach nearby people ONLY — never the whole room. Originally
// written inline for Bug 14's raise-hand chime; extracted here so the
// Soundboard feature (and any future one like it) reuses the EXACT same
// rule instead of a second copy that could drift out of sync:
//  • if the sender is inside a zone → everyone else in that same zone;
//  • otherwise (open floor) → other open-floor players within earshot
//    (TRANSLUCENT_THRESHOLD tiles), so it still works outside a meeting zone
//    without reaching people across the map or those busy in a zone.
//
// Deliberately NOT used for Slap (A10) — that feature pokes ONE named
// target by design (io.to(target.id)), not "everyone nearby"; running it
// through this function would broadcast a private poke to bystanders,
// exactly the opposite of what Slap is for.
export async function getNearbyRecipients(room: string, senderSocketId: string): Promise<string[]> {
  const zoneId = zoneIdOfSocket(senderSocketId);
  if (zoneId) {
    return getSocketIdsInZone(room, zoneId).filter((sid) => sid !== senderSocketId);
  }
  const players = await getPlayers(room);
  const me = players.find((p) => p.id === senderSocketId);
  if (!me) return [];
  return players
    .filter((p) =>
      p.id !== senderSocketId &&
      zoneIdOfSocket(p.id) == null && // don't reach people busy inside a zone
      Math.max(Math.abs(p.x - me.x), Math.abs(p.y - me.y)) / TILE_SIZE <= TRANSLUCENT_THRESHOLD,
    )
    .map((p) => p.id);
}
