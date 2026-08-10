import { useState } from 'react';
import { CalendarEventFill, XLg } from 'react-bootstrap-icons';

// "Ngobrol dengan CEO" v2 — the G-key modal. Deliberately time-only (not a
// full date+time picker): the spec's own example ("14:00-15:00") is same-day
// scheduling, so this keeps the form to what people actually asked for.
// Picking a time already earlier than now is interpreted as tomorrow (see
// toTodayOrTomorrow below) rather than rejected outright — simpler than a
// separate date field for the one edge case ("it's 9pm, I want an 8am slot").
function toTodayOrTomorrow(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(h, m);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

interface BookingFormProps {
  zoneName: string;
  busy: boolean;
  error: string;
  onSubmit: (bookingStart: number, bookingEnd: number, topic?: string) => void;
  onClose: () => void;
}

export function BookingForm({ zoneName, busy, error, onSubmit, onClose }: BookingFormProps) {
  const [startTime, setStartTime] = useState('14:00');
  const [endTime, setEndTime] = useState('15:00');
  const [topic, setTopic] = useState('');
  const [localError, setLocalError] = useState('');

  const handleSubmit = () => {
    setLocalError('');
    const bookingStart = toTodayOrTomorrow(startTime);
    let bookingEnd = toTodayOrTomorrow(endTime);
    // toTodayOrTomorrow rolls each time independently against "now" — an
    // end time that's earlier in the clock than the start time (23:30-00:30)
    // would otherwise resolve to a day BEFORE the start. Push it a day later
    // than whatever day the start landed on instead.
    if (bookingEnd <= bookingStart) bookingEnd += 24 * 60 * 60 * 1000;
    if (bookingEnd - bookingStart < 5 * 60 * 1000) {
      setLocalError('Jam selesai harus setelah jam mulai');
      return;
    }
    onSubmit(bookingStart, bookingEnd, topic.trim() || undefined);
  };

  return (
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="w-80 bg-white/95 dark:bg-gray-800/95 backdrop-blur-xl border border-purple-200/60 dark:border-white/10 shadow-2xl shadow-purple-500/10 rounded-2xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 inline-flex items-center gap-1.5">
            <CalendarEventFill size={13} className="text-purple-600" /> Booking {zoneName}
          </p>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer">
            <XLg size={14} />
          </button>
        </div>
        <p className="text-[11px] text-gray-400 mb-3">Pilih jam mulai &amp; selesai — menunggu persetujuan CEO.</p>

        <div className="grid grid-cols-2 gap-2 mb-2">
          <label className="text-[11px] text-gray-500 dark:text-gray-400">
            Mulai
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-purple-400"
            />
          </label>
          <label className="text-[11px] text-gray-500 dark:text-gray-400">
            Selesai
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-purple-400"
            />
          </label>
        </div>
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={300}
          placeholder="Keperluan (opsional)"
          className="w-full text-xs px-2.5 py-1.5 mb-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-400"
        />
        {(localError || error) && <p className="text-[10px] text-red-500 mb-1.5">{localError || error}</p>}
        <button
          onClick={handleSubmit}
          disabled={busy}
          className="w-full py-1.5 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700 disabled:opacity-50"
        >
          {busy ? 'Mengirim…' : 'Ajukan booking'}
        </button>
      </div>
    </div>
  );
}
