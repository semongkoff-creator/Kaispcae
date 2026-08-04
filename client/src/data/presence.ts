import type { WorkMode } from '@virtualmeet/shared';

// A11 — shared presence metadata so the HUD dropdown, avatar badge, and
// Participant panel all render the same label/emoji per status.
export const PRESENCE_LABEL: Record<WorkMode, string> = {
  available: 'Available',
  wfh: 'WFH',
  in_meeting: 'In a meeting',
  focus: 'Focus',
  lunch: 'Lunch',
  break: 'Break',
  away: 'Away',
};

// Emoji badge per status. 'available' has none (no badge — a plain online dot).
export const PRESENCE_EMOJI: Record<Exclude<WorkMode, 'available'>, string> = {
  wfh: '🏠',
  in_meeting: '🎥',
  focus: '🎧',
  lunch: '🍽️',
  break: '☕',
  away: '🌙',
};

// The statuses a user may pick MANUALLY, in display order. In Meeting/Focus
// used to be auto-only (driven by the zone) but are now also directly
// pickable here — same WorkMode value either way, so picking one manually
// gets the exact same DND behaviour a zone-triggered one does. wfh/break
// replace the old free-text Custom Status feature's quick-pick chips.
export const MANUAL_STATUSES = ['available', 'wfh', 'focus', 'in_meeting', 'lunch', 'break', 'away'] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];
