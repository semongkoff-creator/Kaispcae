import type { WorkMode } from '@virtualmeet/shared';

// A11 — shared presence metadata so the HUD dropdown, avatar badge, and
// Participant panel all render the same label/emoji per status.
export const PRESENCE_LABEL: Record<WorkMode, string> = {
  available: 'Available',
  in_meeting: 'In Meeting',
  focus: 'Focus',
  lunch: 'Lunch',
  away: 'Away',
};

// Emoji badge per status. 'available' has none (no badge — a plain online dot).
export const PRESENCE_EMOJI: Record<Exclude<WorkMode, 'available'>, string> = {
  in_meeting: '🎥',
  focus: '🎧',
  lunch: '🍽️',
  away: '🌙',
};

// The statuses a user may pick MANUALLY. In Meeting/Focus are auto-only (driven
// by the zone), so they're deliberately not selectable.
export const MANUAL_STATUSES = ['available', 'lunch', 'away'] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];
