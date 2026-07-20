import { useState, useEffect, useCallback } from 'react';
import { PersonCheck, PersonX } from 'react-bootstrap-icons';
import { adminApi } from './api';
import { api } from '@/services/api';

interface PendingRequest {
  userId: string;
  displayName: string;
  email: string;
  roomSlug: string;
  roomName: string;
  requestedAt: number;
}

const fmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Workspace-wide join approvals. The room sidebar has a per-room copy of this
// queue, which only helps an admin already standing in that room — this is the
// one place that shows every pending request across every room.
export function ApprovalPanel() {
  const [rows, setRows] = useState<PendingRequest[]>([]);
  const [rooms, setRooms] = useState<{ slug: string; name: string; requiresApproval: boolean; isPublic: boolean }[]>([]);
  const [toggling, setToggling] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [reqs, rms] = await Promise.all([adminApi.listJoinRequests(), adminApi.listRoomsApproval()]);
      setRows(reqs);
      setRooms(rms);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat antrean');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const decide = async (r: PendingRequest, decision: 'approve' | 'reject') => {
    // Keyed by room+user, not user alone — the same person can be waiting on
    // more than one room, and those rows must stay independently actionable.
    const key = `${r.roomSlug}:${r.userId}`;
    setBusy(key);
    try {
      await api.decideJoinRequest(r.roomSlug, r.userId, decision);
      setRows((prev) => prev.filter((x) => `${x.roomSlug}:${x.userId}` !== key));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memproses');
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <p className="text-sm text-gray-400">Memuat…</p>;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold">Permintaan bergabung</h2>
        <span className="text-xs text-gray-400">{rows.length} menunggu</span>
      </div>

      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}

      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 py-8 text-center">
          Tidak ada permintaan yang menunggu persetujuan.
        </p>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          {rows.map((r) => {
            const key = `${r.roomSlug}:${r.userId}`;
            return (
              <div
                key={key}
                className="px-4 py-3 flex items-center gap-3 border-b border-gray-100 dark:border-gray-800 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{r.displayName}</p>
                  <p className="text-xs text-gray-400 truncate">{r.email}</p>
                </div>
                <div className="min-w-0 hidden sm:block">
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{r.roomName}</p>
                  <p className="text-[11px] text-gray-400">{fmt.format(new Date(r.requestedAt))}</p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    onClick={() => decide(r, 'approve')}
                    disabled={busy === key}
                    className="inline-flex items-center gap-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
                  >
                    <PersonCheck size={12} /> Setujui
                  </button>
                  <button
                    onClick={() => decide(r, 'reject')}
                    disabled={busy === key}
                    className="inline-flex items-center gap-1 bg-gray-100 dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/40 hover:text-red-600 disabled:opacity-50 text-gray-600 dark:text-gray-300 text-xs px-3 py-1.5 rounded-lg"
                  >
                    <PersonX size={12} /> Tolak
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Which rooms are gated at all. Without this the approval feature is
          invisible: new rooms are gated by default and every pre-existing room
          is not, with no way to tell which is which — let alone change it. */}
      <div className="mt-8">
        <h2 className="text-sm font-semibold mb-1">Room yang perlu persetujuan</h2>
        <p className="text-xs text-gray-400 mb-3">
          Kalau dinyalakan, orang yang membuka tautan undangan masuk ke antrean di atas dulu.
          Anggota yang sudah disetujui tidak terpengaruh.
        </p>
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden max-h-80 overflow-y-auto">
          {rooms.length === 0 && <p className="px-4 py-6 text-sm text-gray-400 text-center">Belum ada room.</p>}
          {rooms.map((r) => (
            <label
              key={r.slug}
              className="px-4 py-2.5 flex items-center gap-3 border-b border-gray-100 dark:border-gray-800 last:border-0 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{r.name}</p>
                <p className="text-[11px] text-gray-400 truncate">{r.slug}</p>
              </div>
              <span className="text-xs text-gray-400 shrink-0">
                {r.requiresApproval ? 'Perlu persetujuan' : 'Bebas masuk'}
              </span>
              <input
                type="checkbox"
                checked={r.requiresApproval}
                disabled={toggling === r.slug}
                onChange={async (e) => {
                  const next = e.target.checked;
                  setToggling(r.slug);
                  // Optimistic: the row flips immediately and is rolled back if
                  // the server refuses, so a slow request doesn't feel stuck.
                  setRooms((prev) => prev.map((x) => (x.slug === r.slug ? { ...x, requiresApproval: next } : x)));
                  try {
                    await adminApi.setRoomApproval(r.slug, next);
                  } catch (err) {
                    setRooms((prev) => prev.map((x) => (x.slug === r.slug ? { ...x, requiresApproval: !next } : x)));
                    setError(err instanceof Error ? err.message : 'Gagal menyimpan');
                  } finally {
                    setToggling(null);
                  }
                }}
                className="w-4 h-4 accent-purple-600 shrink-0"
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
