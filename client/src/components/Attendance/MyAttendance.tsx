import { useEffect, useState, useCallback } from 'react';
import { DateTime, Interval } from 'luxon';
import { ChevronLeft, ChevronRight, PencilSquare } from 'react-bootstrap-icons';
import { AttendanceStatus, STATUS_LABELS } from '@virtualmeet/shared';
import { attendanceApi, AttendanceRecordDto, CorrectionDto } from './api';

const STATUS_COLOR: Record<AttendanceStatus, string> = {
  ontime: 'bg-green-500',
  late: 'bg-red-500',
  early_leave: 'bg-amber-500',
  absent: 'bg-gray-300 dark:bg-gray-600',
  leave: 'bg-blue-500',
  holiday: 'bg-purple-400',
  auto_closed: 'bg-orange-500',
};

export function MyAttendance({ refreshKey }: { refreshKey: number }) {
  const [cursor, setCursor] = useState(() => DateTime.now());
  const [records, setRecords] = useState<AttendanceRecordDto[]>([]);
  const [corrections, setCorrections] = useState<CorrectionDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<AttendanceRecordDto | null>(null);

  const load = useCallback(async () => {
    try {
      const from = cursor.startOf('month').toJSDate();
      const to = cursor.endOf('month').toJSDate();
      const [r, c] = await Promise.all([attendanceApi.records(from, to), attendanceApi.myCorrections()]);
      setRecords(r.records);
      setCorrections(c.corrections);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat'); }
  }, [cursor]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const byDate = new Map(records.map((r) => [r.date.slice(0, 10), r]));
  const days = Interval.fromDateTimes(cursor.startOf('month').startOf('week'), cursor.endOf('month').endOf('week'))
    .splitBy({ days: 1 }).map((d) => d.start!);

  const sum = records.reduce(
    (acc, r) => ({
      hadir: acc.hadir + (r.clockIn ? 1 : 0),
      telat: acc.telat + (r.status === 'late' ? 1 : 0),
      lembur: acc.lembur + r.overtimeMinutes,
      menit: acc.menit + r.workMinutes,
    }),
    { hadir: 0, telat: 0, lembur: 0, menit: 0 },
  );

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-3">
        <button onClick={() => setCursor((c) => c.minus({ months: 1 }))} aria-label="Bulan sebelumnya" className="p-1 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"><ChevronLeft size={12} /></button>
        <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{cursor.setLocale('id').toFormat('LLLL yyyy')}</p>
        <button onClick={() => setCursor((c) => c.plus({ months: 1 }))} aria-label="Bulan berikutnya" className="p-1 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"><ChevronRight size={12} /></button>
      </div>

      {error && <p className="mb-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}

      <div className="grid grid-cols-4 gap-2 mb-3">
        {[['Hadir', `${sum.hadir} hari`], ['Telat', `${sum.telat} hari`], ['Jam kerja', `${Math.floor(sum.menit / 60)}j`], ['Lembur', `${Math.floor(sum.lembur / 60)}j ${sum.lembur % 60}m`]].map(([l, v]) => (
          <div key={l} className="rounded-lg bg-gray-50 dark:bg-gray-800 p-2">
            <p className="text-[10px] text-gray-400">{l}</p>
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{v}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-px bg-gray-100 dark:bg-gray-700 rounded-lg overflow-hidden">
        {['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].map((d) => (
          <div key={d} className="bg-gray-50 dark:bg-gray-800 py-1 text-center text-[10px] text-gray-500">{d}</div>
        ))}
        {days.map((d) => {
          const rec = byDate.get(d.toISODate()!);
          const outside = d.month !== cursor.month;
          return (
            <div key={d.toISODate()} className={`bg-white dark:bg-gray-900 min-h-[52px] p-1 ${outside ? 'opacity-30' : ''}`}>
              <span className="text-[10px] text-gray-500">{d.day}</span>
              {rec && (
                <button
                  onClick={() => setCorrecting(rec)}
                  title={`${STATUS_LABELS[rec.status]} — klik untuk ajukan koreksi`}
                  className="mt-0.5 w-full flex items-center gap-1 cursor-pointer group"
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLOR[rec.status]}`} />
                  <span className="text-[9px] text-gray-600 dark:text-gray-300 truncate">
                    {rec.clockIn ? DateTime.fromISO(rec.clockIn).toFormat('HH:mm') : '—'}
                  </span>
                  <PencilSquare size={7} className="opacity-0 group-hover:opacity-100 text-gray-400 shrink-0" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2 mt-2">
        {(Object.keys(STATUS_COLOR) as AttendanceStatus[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1 text-[10px] text-gray-500">
            <span className={`w-1.5 h-1.5 rounded-full ${STATUS_COLOR[s]}`} /> {STATUS_LABELS[s]}
          </span>
        ))}
      </div>

      {corrections.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-1">Koreksi yang kamu ajukan</p>
          <div className="space-y-1">
            {corrections.map((c) => (
              <div key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-gray-100 dark:border-gray-700">
                <span className="text-[11px] text-gray-600 dark:text-gray-300 flex-1 truncate">{c.reason}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  c.status === 'approved' ? 'bg-green-100 text-green-700' : c.status === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                }`}>
                  {c.status === 'approved' ? 'Disetujui' : c.status === 'rejected' ? 'Ditolak' : 'Menunggu'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {correcting && <CorrectionForm record={correcting} onClose={() => setCorrecting(null)} onDone={load} />}
    </div>
  );
}

function CorrectionForm({ record, onClose, onDone }: { record: AttendanceRecordDto; onClose: () => void; onDone: () => void }) {
  const [clockIn, setClockIn] = useState(record.clockIn ? DateTime.fromISO(record.clockIn).toFormat("yyyy-MM-dd'T'HH:mm") : '');
  const [clockOut, setClockOut] = useState(record.clockOut ? DateTime.fromISO(record.clockOut).toFormat("yyyy-MM-dd'T'HH:mm") : '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const field = 'w-full bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-800 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500';

  const submit = async () => {
    if (!reason.trim()) { setError('Alasan wajib diisi.'); return; }
    try {
      await attendanceApi.requestCorrection({
        recordId: record.id,
        requestedClockIn: clockIn ? DateTime.fromISO(clockIn).toUTC().toISO()! : undefined,
        requestedClockOut: clockOut ? DateTime.fromISO(clockOut).toUTC().toISO()! : undefined,
        reason: reason.trim(),
      });
      onDone(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-4">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1">Ajukan koreksi</h3>
        <p className="text-[11px] text-gray-400 mb-3">
          {DateTime.fromISO(record.date).setLocale('id').toFormat('cccc, d LLLL yyyy')} · kamu tidak mengubah recordnya langsung — atasan/admin yang memutuskan.
        </p>
        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
        <div className="space-y-2">
          <div>
            <label className="block text-[11px] text-gray-400 mb-0.5" htmlFor="cor-in">Jam masuk seharusnya</label>
            <input id="cor-in" type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} className={field} />
          </div>
          <div>
            <label className="block text-[11px] text-gray-400 mb-0.5" htmlFor="cor-out">Jam keluar seharusnya</label>
            <input id="cor-out" type="datetime-local" value={clockOut} onChange={(e) => setClockOut(e.target.value)} className={field} />
          </div>
          <div>
            <label className="block text-[11px] text-gray-400 mb-0.5" htmlFor="cor-reason">Alasan</label>
            <textarea id="cor-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Lupa clock out karena…" className={`${field} resize-none`} />
          </div>
        </div>
        <button onClick={submit} className="mt-3 w-full py-2 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700">Kirim pengajuan</button>
      </div>
    </div>
  );
}
