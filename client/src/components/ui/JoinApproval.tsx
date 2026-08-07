import { useState, useEffect, useCallback } from 'react';
import { PersonCheck, PersonX, HourglassSplit, ShieldLock, XLg } from 'react-bootstrap-icons';
import { api } from '@/services/api';

// Room join approval, client half (server: routes/roomMembers.ts).
//
// Two surfaces, deliberately in one file because they are two ends of one
// conversation: the person waiting, and the admin deciding.

type Reason = 'needs-request' | 'pending' | 'rejected' | 'restricted' | 'error' | string;

// What an employee sees instead of the room when it needs approval. This
// exists because the socket gate denies the join outright — without it they
// would sit on a blank room wondering what broke.
export function JoinGate({
  roomSlug,
  roomName,
  reason,
  onBack,
  onAdmitted,
}: {
  roomSlug: string;
  roomName?: string;
  reason: Reason;
  onBack: () => void;
  onAdmitted: () => void;
}) {
  const [state, setState] = useState<Reason>(reason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setState(reason), [reason]);

  // While pending, poll for the decision. The socket is NOT connected to this
  // room — the join was denied, that is the whole point — so there is no
  // event to listen for here; without this the screen's "kamu akan otomatis
  // masuk" would simply be untrue and the user would sit there forever.
  useEffect(() => {
    if (state !== 'pending') return;
    const iv = setInterval(async () => {
      try {
        const m = await api.getMembership(roomSlug);
        if (m.allowed) onAdmitted();
        else if (m.reason === 'rejected') setState('rejected');
      } catch {
        // Transient failure — keep waiting rather than bouncing them out.
      }
    }, 5000);
    return () => clearInterval(iv);
  }, [state, roomSlug, onAdmitted]);

  const request = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.requestJoin(roomSlug);
      // The server may just let them in (room stopped requiring approval, or
      // they were approved in the meantime) — take that as admission rather
      // than parking them on a waiting screen that will never move.
      if (res.status === 'active') onAdmitted();
      else setState(res.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal mengirim permintaan');
    } finally {
      setBusy(false);
    }
  }, [roomSlug, onAdmitted]);

  const title = roomName || roomSlug;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-6">
      <div className="w-full max-w-md text-center">
        <div className="w-14 h-14 rounded-2xl bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300 flex items-center justify-center mx-auto mb-4">
          {state === 'pending' ? <HourglassSplit size={24} /> : state === 'rejected' ? <PersonX size={24} /> : <ShieldLock size={24} />}
        </div>

        {state === 'pending' && (
          <>
            <h1 className="text-lg font-semibold mb-1.5">Menunggu persetujuan admin</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              Permintaanmu untuk bergabung ke <span className="font-medium text-gray-700 dark:text-gray-200">{title}</span> sudah
              dikirim. Kamu akan otomatis masuk begitu admin menyetujui — halaman ini tidak perlu dimuat ulang.
            </p>
          </>
        )}

        {state === 'rejected' && (
          <>
            <h1 className="text-lg font-semibold mb-1.5">Permintaan ditolak</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              Admin <span className="font-medium text-gray-700 dark:text-gray-200">{title}</span> menolak permintaan bergabungmu.
              Hubungi admin langsung kalau menurutmu ini keliru.
            </p>
          </>
        )}

        {/* QA (Akses ruang checklist item 1, "Ruang sensitif terkontrol") —
            deliberately NO request button here, unlike needs-request below:
            a restricted room has no self-service path at all — access can
            only be granted directly by an admin (Admin Console's room
            access manager), not requested and approved. */}
        {state === 'restricted' && (
          <>
            <h1 className="text-lg font-semibold mb-1.5">Room ini dibatasi</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              <span className="font-medium text-gray-700 dark:text-gray-200">{title}</span> hanya bisa dimasuki role tertentu.
              Hubungi admin kalau kamu seharusnya punya akses.
            </p>
          </>
        )}

        {(state === 'needs-request' || state === 'error') && (
          <>
            <h1 className="text-lg font-semibold mb-1.5">Room ini perlu persetujuan</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              <span className="font-medium text-gray-700 dark:text-gray-200">{title}</span> tidak bisa dimasuki langsung. Kirim
              permintaan dan tunggu admin menyetujui.
            </p>
            <button
              onClick={request}
              disabled={busy}
              className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-lg mb-2"
            >
              {busy ? 'Mengirim…' : 'Minta izin bergabung'}
            </button>
          </>
        )}

        {error && <p className="text-xs text-red-500 mb-2">{error}</p>}

        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
          Kembali ke daftar room
        </button>
      </div>
    </div>
  );
}

// The admin's queue. Rendered from the room, so an admin standing in the room
// can clear it without leaving — the request notification is useless if acting
// on it means navigating away.
export function JoinRequestPanel({ roomSlug, onClose }: { roomSlug: string; onClose: () => void }) {
  const [rows, setRows] = useState<{ userId: string; displayName: string; email: string; requestedAt: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setRows((await api.getJoinRequests(roomSlug)).requests);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat antrean');
    } finally {
      setLoading(false);
    }
  }, [roomSlug]);

  useEffect(() => { void load(); }, [load]);

  const decide = async (userId: string, decision: 'approve' | 'reject') => {
    setDeciding(userId);
    try {
      await api.decideJoinRequest(roomSlug, userId, decision);
      // Drop the row locally rather than refetching — the server has already
      // committed, and the socket broadcast will reconcile anything else.
      setRows((prev) => prev.filter((r) => r.userId !== userId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memproses');
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div className="absolute top-16 right-4 z-50 w-80 bg-white/95 dark:bg-gray-900/95 backdrop-blur-md rounded-xl border border-purple-100 dark:border-gray-700 shadow-2xl pointer-events-auto">
      <div className="px-3 py-2.5 border-b border-purple-100 dark:border-gray-700 flex items-center justify-between">
        <span className="text-sm font-medium">Permintaan bergabung</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <XLg size={13} />
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {loading && <p className="px-3 py-4 text-xs text-gray-400 text-center">Memuat…</p>}
        {!loading && rows.length === 0 && (
          <p className="px-3 py-6 text-xs text-gray-400 text-center">Tidak ada permintaan yang menunggu.</p>
        )}
        {rows.map((r) => (
          <div key={r.userId} className="px-3 py-2.5 border-b border-gray-50 dark:border-gray-800 last:border-0">
            <p className="text-sm font-medium truncate">{r.displayName}</p>
            <p className="text-[11px] text-gray-400 truncate mb-2">{r.email}</p>
            <div className="flex gap-1.5">
              <button
                onClick={() => decide(r.userId, 'approve')}
                disabled={deciding === r.userId}
                className="flex-1 inline-flex items-center justify-center gap-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs py-1.5 rounded-md"
              >
                <PersonCheck size={12} /> Setujui
              </button>
              <button
                onClick={() => decide(r.userId, 'reject')}
                disabled={deciding === r.userId}
                className="flex-1 inline-flex items-center justify-center gap-1 bg-gray-100 dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/40 hover:text-red-600 disabled:opacity-50 text-gray-600 dark:text-gray-300 text-xs py-1.5 rounded-md"
              >
                <PersonX size={12} /> Tolak
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && <p className="px-3 py-2 text-[11px] text-red-500">{error}</p>}
    </div>
  );
}
