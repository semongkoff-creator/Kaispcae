import { useEffect, useState, useCallback } from 'react';
import { DateTime } from 'luxon';
import { attendanceApi, LeaveDto, LeaveTypeDto, QuotaDto, CorrectionDto } from './api';

const field = 'w-full bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-800 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500';
const badge = (s: string) =>
  s === 'approved' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
    : s === 'rejected' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
const label = (s: string) => (s === 'approved' ? 'Disetujui' : s === 'rejected' ? 'Ditolak' : 'Menunggu');
const fmt = (iso: string) => DateTime.fromISO(iso).setLocale('id').toFormat('d LLL yyyy');

export function LeavePanel({ onChanged }: { onChanged: () => void }) {
  const [types, setTypes] = useState<LeaveTypeDto[]>([]);
  const [leaves, setLeaves] = useState<LeaveDto[]>([]);
  const [quota, setQuota] = useState<QuotaDto[]>([]);
  const [typeId, setTypeId] = useState('');
  const [startDate, setStartDate] = useState(DateTime.now().toISODate()!);
  const [endDate, setEndDate] = useState(DateTime.now().toISODate()!);
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, m] = await Promise.all([attendanceApi.leaveTypes(), attendanceApi.myLeaves()]);
      setTypes(t.types);
      if (!typeId && t.types[0]) setTypeId(t.types[0].id);
      setLeaves(m.leaves);
      setQuota(m.quota);
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat'); }
  }, [typeId]);
  useEffect(() => { void load(); }, []);

  const submit = async () => {
    setError(null); setOk(null);
    if (!reason.trim()) { setError('Alasan wajib diisi.'); return; }
    try {
      await attendanceApi.requestLeave({ typeId, startDate, endDate, halfDay, reason: reason.trim() });
      setReason('');
      setOk('Pengajuan terkirim.');
      await load(); onChanged();
    } catch (e) {
      // Quota is enforced by the server — show its refusal verbatim rather
      // than pretending the request went through.
      setError(e instanceof Error ? e.message : 'Gagal mengajukan');
    }
  };

  if (!types.length) {
    return <p className="text-xs text-gray-400">Belum ada jenis cuti. Admin harus membuatnya dulu di Konsol Admin.</p>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-2">Ajukan cuti / izin</p>
        {error && <p className="mb-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}
        {ok && <p className="mb-2 text-xs text-green-700 bg-green-50 dark:bg-green-900/20 rounded-lg px-2 py-1.5">{ok}</p>}
        <div className="space-y-2">
          <div>
            <label className="block text-[11px] text-gray-400 mb-0.5" htmlFor="lv-type">Jenis</label>
            <select id="lv-type" value={typeId} onChange={(e) => setTypeId(e.target.value)} className={field}>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}{t.paid ? '' : ' (tidak dibayar)'}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-gray-400 mb-0.5" htmlFor="lv-start">Dari</label>
              <input id="lv-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={field} />
            </div>
            <div>
              <label className="block text-[11px] text-gray-400 mb-0.5" htmlFor="lv-end">Sampai</label>
              <input id="lv-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={field} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-gray-700 dark:text-gray-200 cursor-pointer">
            <input type="checkbox" checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)} className="w-3 h-3 accent-purple-600" /> Setengah hari
          </label>
          <div>
            <label className="block text-[11px] text-gray-400 mb-0.5" htmlFor="lv-reason">Alasan</label>
            <textarea id="lv-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={`${field} resize-none`} />
          </div>
          <button onClick={submit} className="w-full py-2 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700">Ajukan</button>
        </div>

        <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mt-4 mb-1">Sisa kuota tahun ini</p>
        <div className="space-y-1">
          {quota.map((q) => (
            <div key={q.typeId} className="flex items-center gap-2 text-[11px]">
              <span className="flex-1 text-gray-600 dark:text-gray-300 truncate">{q.name}</span>
              <span className="text-gray-400">{q.used} / {q.quotaPerYear}</span>
              <span className={`font-medium ${q.remaining === 0 ? 'text-red-600' : 'text-green-700'}`}>sisa {q.remaining}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-2">Pengajuanmu</p>
        {!leaves.length && <p className="text-[11px] text-gray-400">Belum ada pengajuan.</p>}
        <div className="space-y-1">
          {leaves.map((l) => (
            <div key={l.id} className="px-2 py-1.5 rounded-lg border border-gray-100 dark:border-gray-700">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-gray-800 dark:text-gray-100 flex-1 truncate">{l.type.name}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge(l.status)}`}>{label(l.status)}</span>
              </div>
              <p className="text-[10px] text-gray-400">{fmt(l.startDate)} – {fmt(l.endDate)}{l.halfDay ? ' · setengah hari' : ''}</p>
              <p className="text-[10px] text-gray-500 dark:text-gray-400 truncate">{l.reason}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Approver inbox — visible to managers (their reports) and admins (everyone).
// The server refuses this endpoint for anyone with no reports, so an ordinary
// member never sees the tab at all.
export function ApprovalsPanel({ onChanged }: { onChanged: () => void }) {
  const [leaves, setLeaves] = useState<LeaveDto[]>([]);
  const [corrections, setCorrections] = useState<CorrectionDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, c] = await Promise.all([
        attendanceApi.pendingLeaves().catch(() => ({ leaves: [] })),
        attendanceApi.pendingCorrections().catch(() => ({ corrections: [] })),
      ]);
      setLeaves(l.leaves.filter((x) => x.status === 'pending'));
      setCorrections(c.corrections.filter((x) => x.status === 'pending'));
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const decideLeave = async (id: string, status: 'approved' | 'rejected') => {
    try { await attendanceApi.decideLeave(id, status); await load(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };
  const decideCorrection = async (id: string, status: 'approved' | 'rejected') => {
    try { await attendanceApi.decideCorrection(id, status); await load(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };

  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div>
        <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-1">Cuti menunggu persetujuan ({leaves.length})</p>
        {!leaves.length && <p className="text-[11px] text-gray-400">Tidak ada.</p>}
        {leaves.map((l) => (
          <div key={l.id} className="flex items-center gap-2 px-2 py-2 rounded-lg border border-gray-100 dark:border-gray-700 mb-1">
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-medium text-gray-800 dark:text-gray-100 truncate">{l.user?.displayName} · {l.type.name}</span>
              <span className="block text-[10px] text-gray-400">{fmt(l.startDate)} – {fmt(l.endDate)} · {l.reason}</span>
            </span>
            <button onClick={() => decideLeave(l.id, 'approved')} className="px-2 py-1 rounded-lg bg-green-600 text-white text-[10px] cursor-pointer hover:bg-green-700">Setujui</button>
            <button onClick={() => decideLeave(l.id, 'rejected')} className="px-2 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-[10px] cursor-pointer">Tolak</button>
          </div>
        ))}
      </div>
      <div>
        <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-1">Koreksi menunggu persetujuan ({corrections.length})</p>
        {!corrections.length && <p className="text-[11px] text-gray-400">Tidak ada.</p>}
        {corrections.map((c) => (
          <div key={c.id} className="flex items-center gap-2 px-2 py-2 rounded-lg border border-gray-100 dark:border-gray-700 mb-1">
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-medium text-gray-800 dark:text-gray-100 truncate">{c.user?.displayName}</span>
              <span className="block text-[10px] text-gray-400 truncate">
                {c.record ? fmt(c.record.date) : ''} · minta: {c.requestedClockIn ? DateTime.fromISO(c.requestedClockIn).toFormat('HH:mm') : '—'} → {c.requestedClockOut ? DateTime.fromISO(c.requestedClockOut).toFormat('HH:mm') : '—'} · {c.reason}
              </span>
            </span>
            <button onClick={() => decideCorrection(c.id, 'approved')} className="px-2 py-1 rounded-lg bg-green-600 text-white text-[10px] cursor-pointer hover:bg-green-700">Setujui</button>
            <button onClick={() => decideCorrection(c.id, 'rejected')} className="px-2 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-[10px] cursor-pointer">Tolak</button>
          </div>
        ))}
      </div>
    </div>
  );
}
