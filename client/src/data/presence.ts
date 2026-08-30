import type { WorkMode } from '@kaispace/shared';

// A11 — shared presence metadata so the HUD dropdown, avatar badge, and
// Participant panel all render the same label/emoji per status.
export const PRESENCE_LABEL: Record<WorkMode, string> = {
  available: 'Available',
  wfh: 'WFH',
  wfo: 'WFO',
  wfa: 'WFA',
  cuti: 'Cuti',
  in_meeting: 'In a meeting',
  focus: 'Focus',
  lunch: 'Lunch',
  break: 'Break',
  away: 'Away',
};

// Emoji badge per status. 'available' has none (no badge — a plain online dot).
export const PRESENCE_EMOJI: Record<Exclude<WorkMode, 'available'>, string> = {
  wfh: '🏠',
  wfo: '🏢',
  wfa: '🧳',
  cuti: '🌴',
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
// wfo/wfa/cuti (QA #1) added for the login-time status picker.
export const MANUAL_STATUSES = ['available', 'wfo', 'wfh', 'wfa', 'cuti', 'focus', 'in_meeting', 'lunch', 'break', 'away'] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

// QA #1 — exactly the 5 statuses the login-time gate offers (StatusPickModal),
// a deliberately narrower set than the full MANUAL_STATUSES dropdown above
// (which still has all 10, including this same 5, reachable any time via
// PresenceButton).
export const LOGIN_STATUSES = ['wfo', 'wfh', 'wfa', 'cuti', 'in_meeting'] as const;

// Participant-list grouping order — WFO/WFH/WFA surface first (the "where is
// everyone working from today" signal people actually scan the list for),
// then everything else in the same order PRESENCE_EMOJI/PRESENCE_LABEL
// already declare it, so a status never renders in one order in the badge
// and another in the list it groups.
export const PARTICIPANT_GROUP_ORDER: WorkMode[] = ['wfo', 'wfh', 'wfa', 'available', 'in_meeting', 'focus', 'lunch', 'break', 'away', 'cuti'];
