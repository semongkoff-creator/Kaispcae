import { DateTime } from 'luxon';
import { CalendarEventDto } from './api';

// Minimal RFC 5545 writer for "export what I'm looking at" (.ics).
//
// Times are emitted as UTC (the trailing Z form) rather than with VTIMEZONE
// blocks: every importer understands UTC instants, and writing VTIMEZONE by
// hand is a well-known way to produce subtly wrong files. The consequence is
// honest and worth knowing: a recurring event exported this way recurs on the
// UTC instant, so an importer in a DST-observing zone can shift it by an hour
// after a transition. Series masters therefore carry their RRULE as authored.

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

const utc = (iso: string) => DateTime.fromISO(iso).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");

// Lines longer than 75 octets must be folded (RFC 5545 §3.1) or strict
// parsers reject the file.
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) { parts.push(' ' + rest.slice(0, 74)); rest = rest.slice(74); }
  if (rest) parts.push(' ' + rest);
  return parts.join('\r\n');
}

export function toIcs(events: CalendarEventDto[], zone: string): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KaiSpace//Kalender//ID',
    'CALSCALE:GREGORIAN',
  ];
  const stamp = DateTime.utc().toFormat("yyyyMMdd'T'HHmmss'Z'");

  // One VEVENT per SERIES (not per occurrence): exporting every expanded
  // instance separately would turn a weekly meeting into dozens of unrelated
  // events in the importing calendar.
  const seen = new Set<string>();
  for (const e of events) {
    if (e.isRecurring && e.rrule) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
    }
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.id}-${e.recurrenceId}@meetkai`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${utc(e.start)}`);
    lines.push(`DTEND:${utc(e.end)}`);
    lines.push(fold(`SUMMARY:${esc(e.title)}`));
    if (e.description) lines.push(fold(`DESCRIPTION:${esc(e.description)}`));
    const where = e.location || e.roomName;
    if (where) lines.push(fold(`LOCATION:${esc(where)}`));
    if (e.rrule) lines.push(`RRULE:${e.rrule}`);
    if (e.visibility === 'private') lines.push('CLASS:PRIVATE');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  void zone;
  return lines.join('\r\n');
}
