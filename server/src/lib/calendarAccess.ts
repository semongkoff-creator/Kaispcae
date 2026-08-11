import { PrismaClient } from '@prisma/client';
import { CalendarRole } from '@virtualmeet/shared';

// Resolve a user's role on a calendar FROM THE DATABASE, on every request.
//
// As with Docs, there is deliberately no workspace-admin shortcut: an admin
// who isn't the owner and holds no CalendarMember row gets null. Admin power
// over calendars is org configuration (create/delete TEAM calendars, manage
// rooms) — it is not a key to everyone's personal schedule.
export async function resolveCalendarRole(prisma: PrismaClient, calendarId: string, userId: string, organizationId: string | undefined): Promise<CalendarRole | null> {
  const cal = await prisma.calendar.findUnique({
    where: { id: calendarId },
    select: { ownerId: true, type: true, owner: { select: { organizationId: true } } },
  });
  if (!cal) return null;
  // Multi-tenant Fase 2 — every branch below (owner, explicit member, or the
  // "any authenticated user" team-calendar default) previously assumed one
  // shared workspace. A calendar whose owner is in a different org must be
  // invisible regardless of which of those three paths would otherwise grant
  // access — most notably the team-calendar branch, which the comment below
  // already documents as "readable by the whole workspace by default".
  if (!organizationId || cal.owner.organizationId !== organizationId) return null;
  if (cal.ownerId === userId) return 'owner';
  const m = await prisma.calendarMember.findUnique({
    where: { calendarId_userId: { calendarId, userId } },
    select: { role: true },
  });
  if (m) return m.role === 'editor' ? 'editor' : 'viewer';
  // A team calendar is readable by the whole workspace by default — that's
  // what makes it a team calendar. Writing still needs an explicit grant.
  if (cal.type === 'team') return 'viewer';
  return null;
}
