import { CalendarRole, Rsvp, EditScope } from '@kaispace/shared';

const API_BASE = '/api';

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('vm_token');
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...((options.headers as Record<string, string>) || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Gagal: ${res.status}`);
  }
  return res.json();
}

export interface CalendarSummary { id: string; name: string; color: string; type: string; role: CalendarRole }
export interface EventAttendeeDto { userId: string; name: string; rsvp: Rsvp; optional: boolean }

export interface CalendarEventDto {
  id: string;
  calendarId: string;
  start: string;
  end: string;
  recurrenceId: string;
  allDay: boolean;
  timezone: string;
  isRecurring: boolean;
  rrule: string | null;
  organizerId: string;
  title: string;
  // True when the server withheld the details — this viewer only gets "busy".
  busyOnly: boolean;
  description?: string | null;
  location?: string | null;
  roomId?: string | null;
  roomName?: string | null;
  visibility?: 'default' | 'private';
  meetkaiRoomSlug?: string | null;
  meetkaiZoneId?: string | null;
  meetkaiPassword?: string | null;
  attendees?: EventAttendeeDto[];
}

export interface MeetingRoomDto { id: string; name: string; capacity: number; location: string | null; equipment: string[]; bookableBy: string }
export interface BusyBlock { start: string; end: string }
export interface MeetingZoneDto { id: string; name: string }

export interface EventInput {
  title: string;
  description?: string | null;
  start: string;
  end: string;
  allDay?: boolean;
  timezone?: string;
  location?: string | null;
  roomId?: string | null;
  rrule?: string | null;
  visibility?: 'default' | 'private';
  attendeeIds?: string[];
  reminders?: number[];
  meetkaiRoomSlug?: string | null;
  meetkaiZoneId?: string | null;
  meetkaiPassword?: string | null;
}

export const calendarApi = {
  listCalendars: () => req<{ calendars: CalendarSummary[] }>('/calendars'),
  createCalendar: (name: string, type: 'personal' | 'team' = 'personal', color?: string) =>
    req<CalendarSummary>('/calendars', { method: 'POST', body: JSON.stringify({ name, type, color }) }),
  deleteCalendar: (id: string) => req<{ success: boolean }>(`/calendars/${id}`, { method: 'DELETE' }),

  getEvents: (calendarIds: string[], from: Date, to: Date) =>
    req<{ events: CalendarEventDto[] }>(
      `/calendars/events?calendarIds=${calendarIds.join(',')}&from=${from.toISOString()}&to=${to.toISOString()}`,
    ),
  createEvent: (calendarId: string, input: EventInput) =>
    req<{ id: string }>(`/calendars/${calendarId}/events`, { method: 'POST', body: JSON.stringify(input) }),
  patchEvent: (eventId: string, patch: Partial<EventInput> & { scope: EditScope; recurrenceId?: string }) =>
    req<{ id: string; scope: EditScope }>(`/calendars/events/${eventId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteEvent: (eventId: string, scope: EditScope, recurrenceId?: string) => {
    const qs = new URLSearchParams({ scope });
    if (recurrenceId) qs.set('recurrenceId', recurrenceId);
    return req<{ success: boolean }>(`/calendars/events/${eventId}?${qs}`, { method: 'DELETE' });
  },
  rsvp: (eventId: string, rsvp: Rsvp) =>
    req<{ rsvp: Rsvp }>(`/calendars/events/${eventId}/rsvp`, { method: 'POST', body: JSON.stringify({ rsvp }) }),

  freeBusy: (userIds: string[], from: Date, to: Date) =>
    req<{ freebusy: Record<string, BusyBlock[]> }>(
      `/calendars/freebusy?userIds=${userIds.join(',')}&from=${from.toISOString()}&to=${to.toISOString()}`,
    ),

  listRooms: () => req<{ rooms: MeetingRoomDto[] }>('/meeting-rooms'),
  roomBusy: (roomId: string, from: Date, to: Date) =>
    req<{ busy: BusyBlock[] }>(`/meeting-rooms/${roomId}/busy?from=${from.toISOString()}&to=${to.toISOString()}`),
  listMeetingZones: (roomSlug: string) => req<{ zones: MeetingZoneDto[] }>(`/rooms/${roomSlug}/zones`),
};
