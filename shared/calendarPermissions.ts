// Permission matrix for the Calendar module. Shared by the client (cosmetic
// gating) AND the server (authoritative re-check on every request).
//
// Two things here are load-bearing and easy to get wrong:
//
// 1. FREE/BUSY IS NOT READ ACCESS. Seeing that someone is busy at 10:00 must
//    never leak WHAT they are doing. `calendar:readFreeBusy` is granted to
//    every workspace member; `event:readDetails` is not. The server strips
//    title/description/location for anyone who only holds the former — see
//    routes/calendar.ts (finish criterion #25).
//
// 2. A PRIVATE EVENT hides its details even from attendees' colleagues. The
//    `visibility: 'private'` flag is checked in addition to the role.
//
// Team-calendar creation and room administration live in the WORKSPACE layer
// (shared/workspacePermissions.ts: calendar:manageTeamCalendars,
// calendar:manageRooms, ...), not here — those are org configuration, not
// per-calendar rights.

export type CalendarRole = 'owner' | 'editor' | 'viewer';

const ROLE_ORDER: CalendarRole[] = ['viewer', 'editor', 'owner'];

export function calendarRoleAtLeast(role: CalendarRole | undefined, min: CalendarRole): boolean {
  if (!role) return false;
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
}

export type CalendarAction =
  | 'calendar:read'
  | 'calendar:readFreeBusy'  // "busy at 10:00" — never the title. See note above.
  | 'event:create'
  | 'event:update'
  | 'event:delete'
  | 'event:readDetails'      // title/description/location/attendees
  | 'calendar:manageMembers'
  | 'calendar:delete';

const OWNER_ONLY: CalendarAction[] = ['calendar:manageMembers', 'calendar:delete'];

const ACTION_MIN_ROLE: Record<Exclude<CalendarAction, 'calendar:manageMembers' | 'calendar:delete'>, CalendarRole> = {
  'calendar:read': 'viewer',
  'calendar:readFreeBusy': 'viewer',
  'event:create': 'editor',
  'event:update': 'editor',
  'event:delete': 'editor',
  'event:readDetails': 'viewer',
};

export interface CalendarCtx {
  role: CalendarRole | undefined;
}

export function canCalendar(action: CalendarAction, ctx: CalendarCtx): boolean {
  if (OWNER_ONLY.includes(action)) return ctx.role === 'owner';
  return calendarRoleAtLeast(ctx.role, ACTION_MIN_ROLE[action as keyof typeof ACTION_MIN_ROLE]);
}

// Whether `viewerId` may see an event's DETAILS (title etc.) as opposed to
// just its busy block. Organiser and invited attendees always may; everyone
// else may only when the event is not private and they can read the calendar.
export function canSeeEventDetails(
  event: { organizerId: string; visibility: 'default' | 'private'; attendeeIds: string[] },
  viewerId: string,
  calendarRole: CalendarRole | undefined,
): boolean {
  if (event.organizerId === viewerId) return true;
  if (event.attendeeIds.includes(viewerId)) return true;
  if (event.visibility === 'private') return false;
  return canCalendar('event:readDetails', { role: calendarRole });
}

export type Rsvp = 'needsAction' | 'accepted' | 'declined' | 'tentative';

export const RSVP_LABELS: Record<Rsvp, string> = {
  needsAction: 'Belum menjawab',
  accepted: 'Hadir',
  declined: 'Tidak hadir',
  tentative: 'Mungkin',
};

export const CALENDAR_ROLE_LABELS: Record<CalendarRole, string> = {
  owner: 'Pemilik',
  editor: 'Editor',
  viewer: 'Pengamat',
};
