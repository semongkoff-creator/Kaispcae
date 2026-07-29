import { useEffect, useState, useCallback } from 'react';
import { XLg, PlusLg, ArrowClockwise } from 'react-bootstrap-icons';
import { api, ApiError, LeaveRecord, CreateLeaveBody } from '@/services/api';

// A9 — Cuti (leave) widget. Reads/creates leave requests via Lark Approval
// (source of truth = Lark). Status is refreshed by a light poll while the panel
// is open (the app is also subscribed to the approval's events server-side).
// MVP covers full-DAY leave (the common case); the leaveGroupV2 widget's
// half-day/hour units can be added later.

function todayInput(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmt(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'Menunggu', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' },
  APPROVED: { label: 'Disetujui', cls: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  REJECTED: { label: 'Ditolak', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  CANCELED: { label: 'Dibatalkan', cls: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300' },
};

export function LeavePanel({ onClose }: { onClose: () => void }) {
  const [leaves, setLeaves] = useState<LeaveRecord[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [noLark, setNoLark] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadMine = useCallback(async () => {
    try {
      const { leaves } = await api.getMyLeaves();
      setLeaves(leaves);
      setNoLark(false);
      setNotConfigured(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNoLark(true);
      else if (e instanceof ApiError && e.status === 503) setNotConfigured(true);
      else setError('Gagal memuat data cuti dari Lark.');
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [, opts] = await Promise.allSettled([loadMine(), api.getLeaveOptions()]);
    if (opts.status === 'fulfilled') setTypes(opts.value.leaveTypes);
    setLoading(false);
  }, [loadMine]);

  useEffect(() => {
    void load();
  }, [load]);

  // Near-real-time status: refetch while the panel is open.
  useEffect(() => {
    if (noLark || notConfigured) return;
    const id = setInterval(() => void loadMine(), 25000);
    return () => clearInterval(id);
  }, [noLark, notConfigured, loadMine]);

  return (
    <div className="absolute inset-0 z-40 bg-purple-50/95 dark:bg-gray-900/95 backdrop-blur-md pl-14 pointer-events-auto overflow-y-auto">
      <div className="max-w-2xl mx-auto px-5 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-gray-900 dark:text-gray-100 text-lg font-bold">Cuti</h2>
            <p className="text-gray-500 dark:text-gray-400 text-xs">Pengajuan cuti kamu — tersambung langsung ke Lark Approval.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void load()} title="Muat ulang" className="text-gray-500 hover:text-purple-600 dark:text-gray-400 cursor-pointer p-1.5"><ArrowClockwise size={16} /></button>
            <button onClick={onClose} title="Tutup" className="text-gray-500 hover:text-gray-800 dark:text-gray-400 cursor-pointer p-1.5"><XLg size={18} /></button>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm py-10 text-center">Memuat dari Lark…</p>
        ) : notConfigured ? (
          <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800 dark:text-amber-200">
            Fitur Cuti belum dikonfigurasi di server (approval_code kosong). Hubungi admin.
          </div>
        ) : noLark ? (
          <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800 dark:text-amber-200">
            Hubungkan akun Lark dulu (logout lalu <span className="font-medium">Login dengan Lark</span>) untuk mengajukan cuti.
          </div>
        ) : (
          <>
            {error && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs px-3 py-2 mb-3 flex items-center justify-between">
                <span>{error}</span>
                <button onClick={() => void load()} className="underline cursor-pointer">Coba lagi</button>
              </div>
            )}

            {!formOpen && (
              <button onClick={() => setFormOpen(true)} className="inline-flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-3 py-2 rounded-lg cursor-pointer mb-4">
                <PlusLg size={15} /> Ajukan Cuti
              </button>
            )}

            {formOpen && (
              <LeaveForm
                types={types}
                submitting={submitting}
                onCancel={() => setFormOpen(false)}
                onSubmit={async (body) => {
                  setSubmitting(true);
                  setError('');
                  try {
                    await api.createLeave(body);
                    setFormOpen(false);
                    await loadMine();
                  } catch {
                    setError('Gagal mengajukan cuti ke Lark.');
                  } finally {
                    setSubmitting(false);
                  }
                }}
              />
            )}

            {leaves.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-sm py-6 text-center">Belum ada pengajuan cuti.</p>
            ) : (
              <div className="space-y-2">
                {leaves.map((l) => {
                  const meta = STATUS_META[l.status] ?? { label: l.status, cls: 'bg-gray-100 text-gray-600' };
                  return (
                    <div key={l.instanceCode} className="rounded-lg bg-white dark:bg-gray-800 border border-purple-100 dark:border-gray-700 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{l.name || 'Cuti'}</span>
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${meta.cls}`}>{meta.label}</span>
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{fmt(l.start)} → {fmt(l.end)}</p>
                      {l.reason && <p className="text-xs text-gray-600 dark:text-gray-300 mt-1">{l.reason}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LeaveForm({
  types,
  submitting,
  onSubmit,
  onCancel,
}: {
  types: string[];
  submitting: boolean;
  onSubmit: (body: CreateLeaveBody) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(types[0] ?? '');
  const [startDate, setStartDate] = useState(todayInput());
  const [endDate, setEndDate] = useState(todayInput());
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');

  const inputCls = 'w-full bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm rounded px-2.5 py-1.5 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500';

  const submit = () => {
    setErr('');
    if (!name) return setErr('Pilih jenis cuti.');
    if (!reason.trim()) return setErr('Isi alasan cuti.');
    // Full-DAY leave: start = local midnight of startDate (as UTC), end = local
    // midnight of the day AFTER endDate (matches Lark's leaveGroupV2 shape:
    // end = start + interval days). interval = inclusive day count.
    const startMid = new Date(`${startDate}T00:00:00`);
    const endMid = new Date(`${endDate}T00:00:00`);
    if (endMid < startMid) return setErr('Tanggal selesai tidak boleh sebelum tanggal mulai.');
    const interval = Math.round((endMid.getTime() - startMid.getTime()) / 86400000) + 1;
    const start = startMid.toISOString();
    const end = new Date(endMid.getTime() + 86400000).toISOString();
    onSubmit({ name, start, end, unit: 'DAY', interval, reason: reason.trim(), timezoneOffset: new Date().getTimezoneOffset() });
  };

  return (
    <div className="rounded-xl border border-purple-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 mb-4 space-y-2.5">
      <label className="text-xs text-gray-500 dark:text-gray-400 block">
        Jenis cuti
        <select value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} mt-0.5 cursor-pointer`}>
          {types.length === 0 && <option value="">—</option>}
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-gray-500 dark:text-gray-400">
          Tanggal mulai
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={`${inputCls} mt-0.5`} />
        </label>
        <label className="text-xs text-gray-500 dark:text-gray-400">
          Tanggal selesai
          <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} className={`${inputCls} mt-0.5`} />
        </label>
      </div>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Alasan cuti…" rows={2} className={inputCls} />
      {err && <p className="text-red-500 text-[11px]">{err}</p>}
      <div className="flex items-center gap-2 pt-1">
        <button disabled={submitting} onClick={submit} className="bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-3 py-1.5 rounded-lg cursor-pointer disabled:opacity-50">
          {submitting ? 'Mengirim…' : 'Ajukan ke Lark'}
        </button>
        <button onClick={onCancel} disabled={submitting} className="text-gray-500 dark:text-gray-400 text-sm px-2 cursor-pointer">Batal</button>
      </div>
    </div>
  );
}
