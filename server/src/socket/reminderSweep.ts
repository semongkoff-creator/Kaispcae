import { Server } from 'socket.io';
import { getPrisma } from '../lib/prisma';
import { expandOccurrences } from '@virtualmeet/shared';
import { DateTime } from 'luxon';

// Event reminders. A scheduled sweep, not a timer-per-event: timers would die
// with the process and can't survive a restart, while a sweep just re-reads
// the truth from the database every tick.
//
// How duplicates are avoided: EventReminder.lastFiredFor stores the OCCURRENCE
// this reminder last fired for. A weekly 09:00 standup with a 10-minute
// reminder must fire again every week, but only once per week — so the guard
// has to be per-occurrence, not a boolean.
//
// Delivery is IN-APP only. This repo has no mail infrastructure at all (no
// nodemailer/SMTP/provider), so `method: 'email'` reminders are recorded but
// NOT sent — see the honest skip below rather than a silent no-op.

const TICK_MS = 60 * 1000;
// How far ahead to expand series when looking for firing occurrences. Anything
// longer just wastes work; anything shorter would miss a reminder set further
// out than this (e.g. "1 day before" needs at least a day of lookahead).
const LOOKAHEAD_DAYS = 8;

export function startReminderSweep(io: Server, intervalMs = TICK_MS): void {
  setInterval(async () => {
    try {
      const prisma = getPrisma();
      const now = new Date();
      const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 86400000);

      const reminders = await prisma.eventReminder.findMany({
        include: {
          event: {
            select: {
              id: true, title: true, start: true, end: true, timezone: true, rrule: true,
              exdates: true, organizerId: true,
              attendees: { select: { userId: true, rsvp: true } },
            },
          },
        },
      });
      if (!reminders.length) return;

      let fired = 0;
      for (const rem of reminders) {
        const ev = rem.event;
        // Look at occurrences from now to the horizon and find the first one
        // whose reminder time has arrived but hasn't been sent yet.
        const occurrences = expandOccurrences(
          { start: ev.start, end: ev.end, timezone: ev.timezone, rrule: ev.rrule, exdates: ev.exdates },
          new Date(now.getTime() - 60 * 60 * 1000), // small back-window so a restart doesn't skip one
          horizon,
        );

        for (const occ of occurrences) {
          const fireAt = new Date(occ.start.getTime() - rem.minutesBefore * 60000);
          if (fireAt > now) continue;                 // not yet
          if (occ.start <= now) continue;             // already started; a reminder now is noise
          if (rem.lastFiredFor && rem.lastFiredFor.getTime() === occ.start.getTime()) continue; // done

          if (rem.method === 'email') {
            // Deliberately not pretending: there is no mailer in this repo.
            console.warn(`[reminder] email reminder for event ${ev.id} SKIPPED — no mail infrastructure configured`);
            await prisma.eventReminder.update({ where: { id: rem.id }, data: { lastFiredFor: occ.start } });
            continue;
          }

          // Notify the organiser and everyone who hasn't declined.
          const recipients = new Set<string>([ev.organizerId]);
          for (const a of ev.attendees) if (a.rsvp !== 'declined') recipients.add(a.userId);

          const local = DateTime.fromJSDate(occ.start, { zone: ev.timezone }).setLocale('id').toFormat('HH:mm');
          const body = rem.minutesBefore >= 60
            ? `"${ev.title}" mulai ${Math.round(rem.minutesBefore / 60)} jam lagi (${local}).`
            : `"${ev.title}" mulai ${rem.minutesBefore} menit lagi (${local}).`;

          for (const userId of recipients) {
            await prisma.notification.create({ data: { recipientId: userId, kind: 'workspace', body } });
            io.to(`user:${userId}`).emit('base:notif', {});
          }
          await prisma.eventReminder.update({ where: { id: rem.id }, data: { lastFiredFor: occ.start } });
          fired++;
          break; // one occurrence per reminder per tick
        }
      }
      if (fired) console.log(`[reminder] sweep fired ${fired} reminder(s)`);
    } catch (e) {
      console.error('[reminder] sweep error:', e);
    }
  }, intervalMs);
}
