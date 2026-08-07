import { useState } from 'react';
import { CloudDownload } from 'react-bootstrap-icons';

// Item 12, "Tak Terpikir" checklist ("Backup & recovery") — manual export,
// not a scheduled job (product decision): admin downloads a snapshot
// whenever they want one, straight to their own machine. Server side: see
// server/src/routes/admin.ts's GET /admin/backup/export.
//
// Fetched here (not a plain <a href>) because the download needs the
// Authorization header — a bare link can't carry that, and it's a file
// response, not JSON, so this doesn't go through admin/api.ts's req<T>
// helper (which always calls res.json()).
export function BackupPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const download = async () => {
    setBusy(true);
    setError('');
    try {
      const token = localStorage.getItem('vm_token');
      const res = await fetch('/api/admin/backup/export', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `Gagal: ${res.status}`);
      }
      const blob = await res.blob();
      // Filename comes from the server's Content-Disposition; a plain
      // hardcoded fallback name here is fine since it only matters if that
      // header is somehow missing.
      const cd = res.headers.get('Content-Disposition') || '';
      const match = /filename="([^"]+)"/.exec(cd);
      const filename = match?.[1] || `meetkai-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal membuat backup');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-lg">
      <h2 className="text-sm font-semibold mb-1">Backup & recovery</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
        Unduh snapshot berisi semua catatan ruang (notes), Minutes of Meeting (MoM), dan data absensi ke satu file JSON —
        untuk disimpan sendiri sebagai cadangan. Diunduh langsung, tidak disimpan di server.
      </p>
      <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-4">
        Pengumuman (notice) tidak termasuk — itu memang cuma banner yang aktif saat ini, bukan catatan riwayat, jadi tidak
        ada yang perlu dicadangkan di sana. Lokasi absensi (koordinat GPS) juga tidak disertakan — data itu sudah punya
        jadwal penghapusan otomatis tersendiri demi privasi.
      </p>
      {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
      <button
        onClick={download}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium cursor-pointer"
      >
        <CloudDownload size={14} /> {busy ? 'Membuat backup…' : 'Unduh backup'}
      </button>
    </div>
  );
}
