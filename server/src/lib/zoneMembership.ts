import { PrismaClient } from '@prisma/client';
import { Role, roleAtLeast } from '@virtualmeet/shared';
import { resolveRoomRole } from './roles';
import { setCachedZoneRestrictions } from '../store/roomStore';

// (Re)loads the room's ZoneRestriction rows into roomStore.ts's in-memory
// cache — called at JOIN_ROOM (roomHandler.ts) and whenever an admin edits a
// restriction (routes/roomMembers.ts), so ZONE_ENTER's hot path never has
// to hit the DB for the common case of an unrestricted zone. Returns the
// rows too so a caller with a socket handy (JOIN_ROOM, the admin PATCH
// route) can also tell the client(s) without a second query.
export async function refreshZoneRestrictionCache(
  prisma: PrismaClient,
  roomSlug: string,
  roomId: string,
): Promise<{ zoneId: string; minRole: string; queueEnabled: boolean }[]> {
  const rows = await prisma.zoneRestriction.findMany({ where: { roomId } });
  const mapped = rows.map((r) => ({ zoneId: r.zoneId, minRole: r.minRole, queueEnabled: r.queueEnabled }));
  setCachedZoneRestrictions(roomSlug, mapped);
  return mapped;
}

// Zone entry — the same question roomMembership.ts's resolveEntry answers
// for a whole Room, one level down. Exists because "ruang CEO" turned out to
// be a ZONE inside the shared "Kaitech" office (Zone.id 'ceo-office'), not a
// separate Room — Room.restrictedAccess has no way to reach a sub-area of a
// room you're already standing in, so this is an independent, per-zone gate
// (see schema.prisma's ZoneRestriction doc comment).

export interface ZoneEntryDecision {
  allowed: boolean;
  // 'open'        — this zone has no restriction row at all (the common case)
  // 'privileged'  — the room's own owner
  // 'member'      — resolveRoomRole(...) already meets ZoneRestriction.minRole
  // 'restricted'  — below minRole, and queueEnabled is off: no self-service path
  // 'queue'       — below minRole, but may join the queue (queueEnabled is on)
  // 'queue-active'— holds a 'called' or unexpired 'active' ticket for THIS zone
  reason: 'open' | 'privileged' | 'member' | 'restricted' | 'queue' | 'queue-active';
}

export async function resolveZoneEntry(
  prisma: PrismaClient,
  room: { id: string; ownerId: string },
  zoneId: string,
  userId: string,
): Promise<ZoneEntryDecision> {
  const restriction = await prisma.zoneRestriction.findUnique({ where: { roomId_zoneId: { roomId: room.id, zoneId } } });
  if (!restriction) return { allowed: true, reason: 'open' };
  if (userId === room.ownerId) return { allowed: true, reason: 'privileged' };

  // resolveRoomRole already folds in global admin + room-level admin/staff
  // grants + the guest-tier clamp (see its own doc comment) — reusing it
  // here means a zone restriction automatically respects every one of those,
  // with no separate per-zone grant list to maintain.
  const role = await resolveRoomRole(prisma, userId, room.id, room.ownerId);
  if (roleAtLeast(role, (restriction.minRole as Role) ?? 'staff')) return { allowed: true, reason: 'member' };

  if (restriction.queueEnabled) {
    const ticket = await prisma.roomQueueEntry.findFirst({
      where: { roomId: room.id, zoneId, userId, status: { in: ['called', 'active'] } },
    });
    if (ticket?.status === 'called') return { allowed: true, reason: 'queue-active' };
    if (ticket?.status === 'active' && ticket.endsAt && ticket.endsAt > new Date()) {
      return { allowed: true, reason: 'queue-active' };
    }
    return { allowed: false, reason: 'queue' };
  }
  return { allowed: false, reason: 'restricted' };
}
