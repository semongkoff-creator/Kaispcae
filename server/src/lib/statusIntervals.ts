import { PrismaClient } from '@prisma/client';
import { WorkMode } from '@kaispace/shared';

// Productivity Analytics — Bagian A.3's status-time distribution + Bagian
// B.3.1's Focus/Meeting-time cards, backed by StatusInterval rows (see
// schema.prisma). Two simplifications, both deliberate and documented at the
// call sites: 'quick_chat' (proximity chat) has no clean start/end signal
// today, so its COUNT comes from ConnectionEvent instead of a duration here;
// 'offline' is never written explicitly — any time NOT covered by a row for
// a user is offline by definition, computed at query time as a gap.
export type AnalyticsStatus = 'available' | 'focus' | 'in_meeting' | 'busy' | 'away';

// wfh/wfo/wfa are work-LOCATION flags layered on top of "available" (see
// AvatarSprite.ts's presence-pill list — none of the three render a distinct
// badge, same as plain 'available'). lunch/break/cuti collapse to 'busy' —
// not interruptible, not a formal meeting, and there's no direct WorkMode
// equivalent of the brief's generic manual Busy/DND.
export function resolveEffectiveStatus(mode: WorkMode): AnalyticsStatus {
  switch (mode) {
    case 'in_meeting': return 'in_meeting';
    case 'focus': return 'focus';
    case 'away': return 'away';
    case 'lunch':
    case 'break':
    case 'cuti': return 'busy';
    default: return 'available'; // available | wfh | wfo | wfa
  }
}

// Closes whatever interval is currently open for this user (there is never
// more than one — every open() call closes-before-opening) then opens a new
// one. Fire-and-forget from call sites — analytics bookkeeping must never
// block or fail the live feature it's hooked into.
export async function openStatusInterval(
  prisma: PrismaClient,
  userId: string,
  roomSlug: string,
  status: AnalyticsStatus,
  at: Date = new Date(),
  zoneId?: string,
): Promise<void> {
  await closeOpenStatusInterval(prisma, userId, at);
  await prisma.statusInterval.create({ data: { userId, roomSlug, status, startedAt: at, zoneId: zoneId ?? null } });
}

export async function closeOpenStatusInterval(
  prisma: PrismaClient,
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  await prisma.statusInterval.updateMany({
    where: { userId, endedAt: null },
    data: { endedAt: at },
  });
}
