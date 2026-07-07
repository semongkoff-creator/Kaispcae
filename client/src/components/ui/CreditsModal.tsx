import { X, BoxArrowUpRight } from 'react-bootstrap-icons';

// Mandatory CC-BY-SA 3.0 attribution for the Sci-Fi Office theme's assets
// (client/public/assets/tilesets/scifi-office/, taken from Space Station 14)
// — see that folder's ATTRIBUTION.md. The license only requires a credits
// page/section somewhere in the app, not per-image inline credit, so this
// summary + a link to the full 208-entry list (served as a static file by
// Vite straight from client/public/, same as every other tileset asset) is
// enough; it doesn't need to be reproduced inline here.
const ATTRIBUTION_URL = '/assets/tilesets/scifi-office/ATTRIBUTION.md';

export function CreditsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white rounded-xl p-6 shadow-xl shadow-purple-100/50 border border-purple-100 max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-gray-900 text-sm font-bold">Credits / About</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 cursor-pointer"><X size={16} /></button>
        </div>
        <p className="text-gray-600 text-sm leading-relaxed mb-3">
          Sebagian aset visual room bertema Sci-Fi Office berasal dari{' '}
          <span className="font-medium">Space Station 14</span> (
          <a href="https://github.com/space-wizards/space-station-14" target="_blank" rel="noreferrer" className="text-purple-600 hover:underline">
            space-wizards/space-station-14
          </a>
          ), dilisensikan CC-BY-SA 3.0.
        </p>
        <p className="text-gray-400 text-xs leading-relaxed mb-4">
          Sebagian besar item dilisensikan CC-BY-SA 3.0 (gratis, boleh komersial, wajib kredit — dipenuhi oleh
          halaman ini); beberapa item individual memakai lisensi lain (misalnya CC0-1.0) — lihat daftar lengkap
          untuk rincian per-item.
        </p>
        <a
          href={ATTRIBUTION_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-purple-600 hover:text-purple-800 text-xs font-medium underline"
        >
          <BoxArrowUpRight size={11} /> Daftar kredit lengkap (ATTRIBUTION.md)
        </a>
      </div>
    </div>
  );
}
