import { useEffect, useState } from 'react';
import { adminApi, WorkspacePolicy } from './api';

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2.5 px-2.5 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 w-3.5 h-3.5 accent-purple-600 shrink-0" />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-gray-800 dark:text-gray-100">{label}</span>
        <span className="block text-[11px] text-gray-400">{hint}</span>
      </span>
    </label>
  );
}

export function PolicyPanel() {
  const [policy, setPolicy] = useState<WorkspacePolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    adminApi.getPolicy()
      .then((r) => setPolicy(r.policy))
      .catch((e) => setError(e instanceof Error ? e.message : 'Gagal memuat'));
  }, []);

  const patch = async (p: Partial<WorkspacePolicy>) => {
    if (!policy) return;
    const prev = policy;
    setPolicy({ ...policy, ...p }); // optimistic
    setError(null);
    try {
      const r = await adminApi.updatePolicy(p);
      setPolicy(r.policy);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setPolicy(prev); // server said no — put it back
      setError(e instanceof Error ? e.message : 'Gagal menyimpan');
    }
  };

  if (!policy) return <p className="text-xs text-gray-400">{error ?? 'Memuat kebijakan…'}</p>;

  return (
    <div className="max-w-lg">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Kebijakan workspace</h2>
        {saved && <span className="text-[11px] text-green-600">Tersimpan</span>}
      </div>
      {error && <p className="mb-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}

      <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1 px-2.5">Base</p>
      <Toggle
        label="Izinkan link berbagi publik"
        hint="Kalau dimatikan, server menolak pembuatan link berbagi baru di semua base."
        checked={policy.basePublicLinksAllowed}
        onChange={(v) => patch({ basePublicLinksAllowed: v })}
      />
      <Toggle
        label="Izinkan ekspor"
        hint="Mengatur ketersediaan ekspor CSV di modul Base."
        checked={policy.baseExportAllowed}
        onChange={(v) => patch({ baseExportAllowed: v })}
      />

      <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1 mt-3 px-2.5">Docs</p>
      <Toggle
        label="Izinkan link berbagi publik"
        hint="Berlaku untuk dokumen. Modul Docs belum dibangun — nilai ini tersimpan dan akan dipakai saat modulnya ada."
        checked={policy.docsPublicLinksAllowed}
        onChange={(v) => patch({ docsPublicLinksAllowed: v })}
      />
      <Toggle
        label="Wajibkan password di link dokumen"
        hint="Belum ditegakkan — menunggu modul Docs."
        checked={policy.docsLinkPasswordRequired}
        onChange={(v) => patch({ docsLinkPasswordRequired: v })}
      />

      <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1 mt-3 px-2.5">Umum</p>
      <div className="px-2.5 py-2">
        <label htmlFor="maxdays" className="block text-xs font-medium text-gray-800 dark:text-gray-100 mb-1">Batas usia link berbagi (hari)</label>
        <input
          id="maxdays"
          type="number"
          min={1}
          max={3650}
          value={policy.maxShareLinkDays ?? ''}
          placeholder="Tanpa batas"
          onChange={(e) => setPolicy({ ...policy, maxShareLinkDays: e.target.value === '' ? null : Number(e.target.value) })}
          onBlur={(e) => patch({ maxShareLinkDays: e.target.value === '' ? null : Number(e.target.value) })}
          className="w-40 bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-800 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500"
        />
        <p className="text-[11px] text-gray-400 mt-1">
          Link yang dibuat melebihi batas ini otomatis dipangkas ke batas oleh server, bukan ditolak. Kosongkan untuk tanpa batas.
        </p>
      </div>
    </div>
  );
}
