import { useEffect, useState, useRef } from 'react';
import { DateTime } from 'luxon';
import { GeoAlt, ExclamationTriangle } from 'react-bootstrap-icons';
import { STATUS_LABELS, lateMinutes, ShiftDef } from '@kaispace/shared';
import { attendanceApi, TodayDto, getCoords } from './api';

// Clock in/out. The ticking display uses the browser clock (it's just a
// display), but every DECISION — late or not, what gets stored — is the
// server's. `serverOffsetMs` keeps the shown time honest even if the user's
// machine is wrong, so what they see matches what will be recorded.
export function ClockWidget({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<TodayDto | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offsetRef = useRef(0);

  const load = async () => {
    try {
      const d = await attendanceApi.today();
      offsetRef.current = new Date(d.serverNow).getTime() - Date.now();
      setData(d);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat'); }
  };
  useEffect(() => { void load(); }, []);

  useEffect(() => {
    // Store a number, not a DateTime: luxon's DateTime<true>/<false> union
    // doesn't fit a single useState type, and the offset is what matters here.
    const t = setInterval(() => setNowMs(Date.now() + offsetRef.current), 1000);
    return () => clearInterval(t);
  }, []);

  const zone = data?.shift?.timezone ?? 'Asia/Jakarta';
  const rec = data?.record;
  const clockedIn = !!rec?.clockIn && !rec?.clockOut;
  const done = !!rec?.clockIn && !!rec?.clockOut;

  const act = async (kind: 'in' | 'out') => {
    setBusy(true); setError(null); setMsg(null);
    try {
      const coords = data?.shift?.hasGeofence ? await getCoords() : {};
      const r = kind === 'in' ? await attendanceApi.clockIn(coords) : await attendanceApi.clockOut(coords);
      setMsg(r.message);
      await load();
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
    finally { setBusy(false); }
  };

  // Running duration, computed from the SERVER-recorded clock-in.
  const now = DateTime.fromMillis(nowMs);
  const running = rec?.clockIn && !rec.clockOut
    ? Math.floor((nowMs - new Date(rec.clockIn).getTime()) / 60000)
    : null;

  const lateNow = data?.shift && !rec?.clockIn
    ? lateMinutes(data.shift as unknown as ShiftDef, new Date(nowMs))
    : 0;

  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-700 p-4">
      <p className="text-3xl font-bold text-gray-800 dark:text-gray-100 tabular-nums">
        {now.setZone(zone).setLocale('id').toFormat('HH:mm:ss')}
      </p>
      <p className="text-[11px] text-gray-400 mb-3">
        {now.setZone(zone).setLocale('id').toFormat('cccc, d LLLL yyyy')} · {zone}
      </p>

      {!data?.shift ? (
        <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2 py-1.5">
          Kamu belum punya shift. Hubungi admin dulu sebelum bisa absen.
        </p>
      ) : (
        <>
          <p className="text-xs text-gray-600 dark:text-gray-300">
            <span className="font-medium">{data.shift.name}</span> · {data.shift.startTime}–{data.shift.endTime}
            <span className="text-gray-400"> (toleransi {data.shift.graceMinutes} menit)</span>
          </p>
          {!data.isWorkday && <p className="text-[11px] text-gray-400 mt-0.5">Hari ini bukan hari kerja shift kamu.</p>}

          <div className="mt-3 flex items-center gap-2">
            {!clockedIn && !done && (
              <button onClick={() => act('in')} disabled={busy} className="flex-1 py-3 rounded-xl bg-green-600 text-white text-sm font-semibold cursor-pointer hover:bg-green-700 disabled:opacity-50">
                {busy ? 'Memproses…' : 'Clock in'}
              </button>
            )}
            {clockedIn && (
              <button onClick={() => act('out')} disabled={busy} className="flex-1 py-3 rounded-xl bg-purple-600 text-white text-sm font-semibold cursor-pointer hover:bg-purple-700 disabled:opacity-50">
                {busy ? 'Memproses…' : 'Clock out'}
              </button>
            )}
            {done && (
              <p className="flex-1 py-3 text-center text-xs text-gray-500 bg-gray-50 dark:bg-gray-800 rounded-xl">
                Absensi hari ini selesai.
              </p>
            )}
          </div>

          {/* C4: the person must be told their location is recorded, plainly,
              at the moment it happens — not buried in a footer. */}
          {data.shift.hasGeofence && !done && (
            <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2 py-1.5 flex items-start gap-1.5">
              <GeoAlt size={11} className="mt-0.5 shrink-0" />
              <span>
                Shift ini pakai geofence: <strong>lokasimu direkam saat clock in dan clock out</strong> untuk memastikan kamu di area kantor.
                Lokasi hanya diambil pada dua momen itu — tidak ada pelacakan berkelanjutan — dan dihapus otomatis setelah 90 hari.
              </span>
            </p>
          )}

          <div className="mt-3 space-y-1 text-xs">
            {rec?.clockIn && (
              <p className="text-gray-600 dark:text-gray-300">
                Masuk: <span className="font-medium">{DateTime.fromISO(rec.clockIn, { zone }).toFormat('HH:mm')}</span>
                <span className={`ml-1.5 px-1.5 py-0.5 rounded text-[10px] ${rec.status === 'late' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'}`}>
                  {STATUS_LABELS[rec.status] ?? rec.status}
                </span>
              </p>
            )}
            {rec?.clockOut && (
              <p className="text-gray-600 dark:text-gray-300">
                Keluar: <span className="font-medium">{DateTime.fromISO(rec.clockOut, { zone }).toFormat('HH:mm')}</span>
                <span className="text-gray-400"> · {Math.floor(rec.workMinutes / 60)}j {rec.workMinutes % 60}m kerja</span>
                {rec.overtimeMinutes > 0 && <span className="text-purple-600"> · lembur {rec.overtimeMinutes}m</span>}
              </p>
            )}
            {running !== null && (
              <p className="text-gray-600 dark:text-gray-300">Berjalan: <span className="font-medium tabular-nums">{Math.floor(running / 60)}j {running % 60}m</span></p>
            )}
            {!rec?.clockIn && lateNow > 0 && data.isWorkday && (
              <p className="text-amber-600 inline-flex items-center gap-1"><ExclamationTriangle size={10} /> Kalau clock in sekarang, tercatat terlambat {lateNow} menit.</p>
            )}
          </div>
        </>
      )}

      {msg && <p className="mt-2 text-xs text-green-700 bg-green-50 dark:bg-green-900/20 rounded-lg px-2 py-1.5">{msg}</p>}
      {error && <p className="mt-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}
    </div>
  );
}
