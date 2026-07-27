import { useState, useEffect, useCallback } from 'react';
import { ClockHistory, BoxArrowRight, CheckCircleFill, XLg } from 'react-bootstrap-icons';
import { api, AttendanceStatus, ApiError } from '@/services/api';

// A12 — the new, minimal attendance panel backed by Lark. Check-in is automatic
// (on login, see server); this panel shows today's status and lets the user
// check out. Status is fetched live from Lark on open, so a checkout done in
// the Lark app itself is reflected here too (button shows "Sudah Checkout").

function fmtTime(sec: number | null): string {
  if (!sec) return '—';
  return new Date(sec * 1000).toLocaleTimeString('id-ID', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta',
  });
}

export function LarkAttendancePanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<AttendanceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setStatus(await api.getAttendanceStatus());
    } catch {
      setError('Gagal memuat status absen.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCheckout = async () => {
    setBusy(true);
    setError('');
    try {
      setStatus(await api.checkOutAttendance());
    } catch (e) {
      // e.g. 409 already-checked-out (perhaps done in the Lark app) — re-sync
      // so the button reflects the real state rather than staying "Checkout".
      setError(e instanceof ApiError ? e.message : 'Gagal checkout.');
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl p-6 w-full max-w-sm shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <span className="flex items-center gap-2 text-gray-900 dark:text-gray-100 font-semibold">
            <ClockHistory size={16} /> Absensi
          </span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer">
            <XLg size={16} />
          </button>
        </div>

        {loading ? (
          <p className="text-gray-400 dark:text-gray-500 text-sm text-center py-6">Memuat…</p>
        ) : !status?.isLarkUser ? (
          <p className="text-gray-500 dark:text-gray-400 text-sm py-4">
            Absensi otomatis hanya untuk akun yang login lewat Lark.
          </p>
        ) : (
          <>
            <div className="space-y-2 mb-4 text-sm">
              <Row label="Check-in" value={fmtTime(status.checkInTime)} ok={status.checkedIn} />
              <Row label="Check-out" value={fmtTime(status.checkOutTime)} ok={status.checkedOut} />
              <Row label="Total jam" value={status.totalHours != null ? `${status.totalHours} jam` : '—'} />
            </div>

            {!status.checkedIn ? (
              <p className="text-amber-600 dark:text-amber-400 text-xs bg-amber-50 dark:bg-amber-900/30 rounded-lg px-3 py-2">
                Belum check-in hari ini. Check-in otomatis saat kamu membuka MeetKai.
              </p>
            ) : status.checkedOut ? (
              <div className="flex items-center justify-center gap-2 text-green-600 dark:text-green-400 font-medium text-sm bg-green-50 dark:bg-green-900/30 rounded-lg py-2.5">
                <CheckCircleFill size={15} /> Sudah Checkout
              </div>
            ) : (
              <button
                onClick={handleCheckout}
                disabled={busy}
                className="w-full flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white font-semibold rounded-lg py-2.5 text-sm cursor-pointer"
              >
                <BoxArrowRight size={15} /> {busy ? 'Memproses…' : 'Checkout'}
              </button>
            )}

            {error && <p className="text-red-500 text-xs mt-2 text-center">{error}</p>}
            <p className="text-gray-400 dark:text-gray-500 text-[10px] mt-3 text-center">
              Data resmi ada di aplikasi Lark → Attendance.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className={`font-medium tabular-nums ${ok ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'}`}>
        {value}
      </span>
    </div>
  );
}
