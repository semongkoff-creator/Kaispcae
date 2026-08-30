import { Display, XLg } from 'react-bootstrap-icons';

interface RemoteHelpBannerProps {
  role: 'target' | 'helper';
  otherName: string;
  onEnd: () => void;
}

// Shown to BOTH sides of an active remote-help session (see App.tsx —
// rendered whenever gameStore's activeRemoteHelp is non-null). "Selesai"
// ends KaiSpace's own tracking/notification only — it cannot and does not
// claim to disconnect the underlying RustDesk session, which only
// RustDesk's own native client can do. That limit is stated in the copy
// itself so nobody mistakes this for a real kill-switch.
export function RemoteHelpBanner({ role, otherName, onEnd }: RemoteHelpBannerProps) {
  return (
    <div className="fixed top-16 right-4 z-50 w-72 bg-purple-600/95 text-white rounded-xl shadow-lg px-3.5 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <Display size={14} />
        {role === 'target' ? `Sedang dibantu remote oleh ${otherName}` : `Sedang membantu remote ${otherName}`}
      </div>
      <p className="text-[11px] text-purple-100 leading-snug">
        Tombol ini menghentikan pencatatan di KaiSpace saja — untuk memutus koneksi RustDesk, gunakan tombol disconnect di aplikasi RustDesk itu sendiri.
      </p>
      <button
        onClick={onEnd}
        className="self-end flex items-center gap-1 px-3 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-xs font-medium cursor-pointer transition-colors"
      >
        <XLg size={11} /> Selesai
      </button>
    </div>
  );
}
