import { useState, useEffect, useCallback } from 'react';
import { PersonCheck, PersonX, ShieldLock, XLg } from 'react-bootstrap-icons';
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
  const [rooms, setRooms] = useState<{ slug: string; name: string; requiresApproval: boolean; isPublic: boolean; restrictedAccess: boolean; restrictedMinRole: string; queueEnabled: boolean }[]>([]);
  const [toggling, setToggling] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  // QA (Akses ruang checklist item 1, "Ruang sensitif terkontrol") — which
  // room's access-manager flyout is open, if any. One at a time, like every
  // other single-active-panel convention elsewhere in this app.
  const [managingSlug, setManagingSlug] = useState<string | null>(null);

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
            <div key={r.slug} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
              <div className="px-4 py-2.5 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-gray-800/50">
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
                  title="Perlu persetujuan admin untuk masuk"
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
                  className="w-4 h-4 accent-purple-600 shrink-0 cursor-pointer"
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* QA (Akses ruang checklist item 1, "Ruang sensitif terkontrol") —
          separate from the ordinary approval list above: this is the
          STRICTER gate (no self-service request path at all — see
          resolveEntry's own doc comment), for rooms like a CEO room or
          client room where only specifically-granted staff+ may enter. */}
      <div className="mt-8">
        <h2 className="text-sm font-semibold mb-1 flex items-center gap-1.5"><ShieldLock size={14} /> Room dibatasi (akses khusus)</h2>
        <p className="text-xs text-gray-400 mb-3">
          Kalau dinyalakan, HANYA orang yang kamu beri akses langsung di bawah ini yang bisa masuk — tidak ada jalur "minta izin".
          Cocok untuk ruang CEO/klien atau ruangan sensitif lainnya.
        </p>
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden max-h-96 overflow-y-auto">
          {rooms.length === 0 && <p className="px-4 py-6 text-sm text-gray-400 text-center">Belum ada room.</p>}
          {rooms.map((r) => (
            <div key={r.slug} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
              <div className="px-4 py-2.5 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{r.name}</p>
                  <p className="text-[11px] text-gray-400 truncate">{r.slug}</p>
                </div>
                {/* Always available — a room's own restrictedAccess only
                    gates the ROOM-level flyout content below; zone-level
                    restriction (see ZoneRestrictionManager) can apply to
                    a perfectly ordinary, non-restricted room's map (e.g.
                    "CEO Office" is a zone inside the shared Kaitech office,
                    which itself has restrictedAccess off). */}
                <button
                  onClick={() => setManagingSlug(managingSlug === r.slug ? null : r.slug)}
                  className="text-xs text-purple-600 hover:text-purple-800 dark:text-purple-300 shrink-0 cursor-pointer"
                >
                  {managingSlug === r.slug ? 'Tutup' : 'Kelola'}
                </button>
                <input
                  type="checkbox"
                  checked={r.restrictedAccess}
                  disabled={toggling === `restrict:${r.slug}`}
                  title="Batasi room ini hanya untuk role tertentu"
                  onChange={async (e) => {
                    const next = e.target.checked;
                    setToggling(`restrict:${r.slug}`);
                    setRooms((prev) => prev.map((x) => (x.slug === r.slug ? { ...x, restrictedAccess: next } : x)));
                    if (next) setManagingSlug(r.slug);
                    try {
                      await adminApi.setRoomRestricted(r.slug, next);
                    } catch (err) {
                      setRooms((prev) => prev.map((x) => (x.slug === r.slug ? { ...x, restrictedAccess: !next } : x)));
                      setError(err instanceof Error ? err.message : 'Gagal menyimpan');
                    } finally {
                      setToggling(null);
                    }
                  }}
                  className="w-4 h-4 accent-purple-600 shrink-0 cursor-pointer"
                />
              </div>
              {managingSlug === r.slug && (
                <>
                  {r.restrictedAccess && <RoomAccessManager slug={r.slug} />}
                  <ZoneRestrictionManager slug={r.slug} />
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// QA (Akses ruang checklist item 1) — who currently holds staff/admin role
// in this specific room (i.e. who a restricted room actually admits), plus
// a small picker to grant/revoke it. Grants work even for someone not
// currently online/in the room — see roomMembers.ts's access-grant route
// doc comment for why the socket-based ADMIN_GRANT/STAFF_GRANT couldn't be
// reused here (circular: you'd need to already be let into the restricted
// room to grant someone else access to it).
type QueueEntryRow = {
  id: string; userId: string; name: string; topic: string | null; durationMin: number;
  status: 'waiting' | 'called' | 'active'; requestedAt: number; calledAt: number | null; endsAt: number | null;
};

const QUEUE_STATUS_LABEL: Record<QueueEntryRow['status'], string> = {
  waiting: 'menunggu', called: 'dipanggil', active: 'sedang di dalam',
};

function RoomAccessManager({ slug }: { slug: string }) {
  const [members, setMembers] = useState<{ userId: string; displayName: string; email: string; role: string }[] | null>(null);
  const [people, setPeople] = useState<{ id: string; displayName: string }[] | null>(null);
  const [query, setQuery] = useState('');
  const [pickedUserId, setPickedUserId] = useState('');
  const [pickedRole, setPickedRole] = useState<'staff' | 'admin'>('staff');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // "Ngobrol dengan CEO" queue — its own toggle + live list, nested under
  // this same access-manager flyout since it only ever makes sense for a
  // room that's already restricted. Polled every 5s while this panel is
  // open, same convention as JoinGate's own queue-status poll — an admin
  // watching the line should see it move without manually refreshing.
  const [queueEnabled, setQueueEnabled] = useState(false);
  const [queueEntries, setQueueEntries] = useState<QueueEntryRow[] | null>(null);
  const [queueToggling, setQueueToggling] = useState(false);
  const [queueBusy, setQueueBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMembers(await adminApi.getRoomAccessList(slug));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar akses');
    }
  }, [slug]);

  const loadQueue = useCallback(async () => {
    try {
      const res = await adminApi.getRoomQueue(slug);
      setQueueEnabled(res.queueEnabled);
      setQueueEntries(res.entries);
    } catch {
      // Silent — this is a background refresh; the panel just keeps showing
      // the last-known list rather than flashing an error on a blip.
    }
  }, [slug]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void loadQueue();
    const iv = setInterval(loadQueue, 5000);
    return () => clearInterval(iv);
  }, [loadQueue]);
  useEffect(() => {
    api.getWorkspacePeople().then((res) => setPeople(res.people)).catch(() => setPeople([]));
  }, []);

  const toggleQueue = async () => {
    const next = !queueEnabled;
    setQueueToggling(true);
    setQueueEnabled(next);
    try {
      await adminApi.setRoomQueueEnabled(slug, true, next);
    } catch (e) {
      setQueueEnabled(!next);
      setError(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setQueueToggling(false);
    }
  };

  const skipQueueEntry = async (entryId: string) => {
    setQueueBusy(entryId);
    try {
      await adminApi.skipQueueEntry(slug, entryId);
      await loadQueue();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal mengubah antrean');
    } finally {
      setQueueBusy(null);
    }
  };

  const grant = async () => {
    if (!pickedUserId) return;
    setBusy(true);
    setError('');
    try {
      await adminApi.grantRoomAccess(slug, pickedUserId, pickedRole);
      setPickedUserId('');
      setQuery('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memberi akses');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (userId: string) => {
    setBusy(true);
    setError('');
    try {
      await adminApi.revokeRoomAccess(slug, userId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal mencabut akses');
    } finally {
      setBusy(false);
    }
  };

  const filteredPeople = (people ?? []).filter(
    (p) => query.length > 0 && p.displayName.toLowerCase().includes(query.toLowerCase()) && !members?.some((m) => m.userId === p.id),
  );

  return (
    <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-800">
      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}

      {members === null ? (
        <p className="text-xs text-gray-400">Memuat…</p>
      ) : members.length === 0 ? (
        <p className="text-xs text-gray-400 mb-2">Belum ada yang diberi akses — hanya pemilik room yang bisa masuk.</p>
      ) : (
        <div className="mb-3 space-y-1.5">
          {members.map((m) => (
            <div key={m.userId} className="flex items-center gap-2 text-xs">
              <span className="flex-1 min-w-0 truncate">{m.displayName} <span className="text-gray-400">({m.role})</span></span>
              <button
                onClick={() => revoke(m.userId)}
                disabled={busy}
                title="Cabut akses"
                className="text-gray-400 hover:text-red-500 disabled:opacity-50 cursor-pointer"
              >
                <XLg size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative flex items-center gap-1.5">
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPickedUserId(''); }}
          placeholder="Cari orang…"
          className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-xs focus:outline-none focus:ring-1 focus:ring-purple-400"
        />
        <select
          value={pickedRole}
          onChange={(e) => setPickedRole(e.target.value as 'staff' | 'admin')}
          className="px-1.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-xs"
        >
          <option value="staff">staff</option>
          <option value="admin">admin</option>
        </select>
        <button
          onClick={grant}
          disabled={busy || !pickedUserId}
          className="px-2.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white text-xs shrink-0 cursor-pointer"
        >
          Beri akses
        </button>

        {query && filteredPeople.length > 0 && !pickedUserId && (
          <div className="absolute top-full left-0 mt-1 w-full max-h-40 overflow-y-auto bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg z-10">
            {filteredPeople.slice(0, 20).map((p) => (
              <button
                key={p.id}
                onClick={() => { setPickedUserId(p.id); setQuery(p.displayName); }}
                className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-purple-50 dark:hover:bg-gray-800 cursor-pointer"
              >
                {p.displayName}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* "Ngobrol dengan CEO" queue — self-service alternative for everyone
          NOT on the access list above: they fill their own form (name,
          keperluan, durasi) instead of waiting on an admin to grant access. */}
      <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800">
        <label className="flex items-center gap-2 text-xs mb-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={queueEnabled}
            disabled={queueToggling}
            onChange={toggleQueue}
            className="w-3.5 h-3.5 accent-purple-600 cursor-pointer"
          />
          <span className="font-medium">Aktifkan antrean &quot;Ngobrol dengan CEO&quot;</span>
        </label>
        <p className="text-[11px] text-gray-400 mb-2">
          Orang yang ditolak masuk bisa isi form untuk dapat nomor antrean dan pilih durasi sendiri — otomatis masuk saat gilirannya,
          otomatis keluar saat waktunya habis, lalu giliran berikutnya otomatis masuk.
        </p>
        {queueEnabled && (
          queueEntries === null ? (
            <p className="text-xs text-gray-400">Memuat antrean…</p>
          ) : queueEntries.length === 0 ? (
            <p className="text-xs text-gray-400">Antrean kosong.</p>
          ) : (
            <div className="space-y-1.5">
              {queueEntries.map((q) => (
                <div key={q.id} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 min-w-0 truncate">
                    {q.name}
                    {q.topic ? ` — ${q.topic}` : ''}{' '}
                    <span className="text-gray-400">({QUEUE_STATUS_LABEL[q.status]}, {q.durationMin} menit)</span>
                  </span>
                  <button
                    onClick={() => skipQueueEntry(q.id)}
                    disabled={queueBusy === q.id}
                    title="Lewati / keluarkan dari antrean"
                    className="text-gray-400 hover:text-red-500 disabled:opacity-50 cursor-pointer"
                  >
                    <XLg size={11} />
                  </button>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

// "Ngobrol dengan CEO" queue, zone-level (see server/src/lib/zoneMembership.ts)
// — "ruang CEO" turned out to be a ZONE inside the shared office map, not a
// separate Room, so restricting it is configured per-zone here rather than
// via the room-level restrictedAccess toggle above. Independent of that
// toggle: an otherwise completely ordinary room can still have one zone
// gated this way.
function ZoneRestrictionManager({ slug }: { slug: string }) {
  const [zones, setZones] = useState<{ id: string; name: string }[] | null>(null);
  const [restrictions, setRestrictions] = useState<{ zoneId: string; minRole: string; queueEnabled: boolean }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await adminApi.getZoneRestrictions(slug);
      setZones(res.zones);
      setRestrictions(res.restrictions);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar zona');
    }
  }, [slug]);

  useEffect(() => { void load(); }, [load]);

  const restrictionOf = (zoneId: string) => restrictions.find((r) => r.zoneId === zoneId);

  const save = async (zoneId: string, patch: { enabled: boolean; minRole?: string; queueEnabled?: boolean }) => {
    setBusy(zoneId);
    try {
      await adminApi.setZoneRestriction(slug, zoneId, patch);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-800">
      <h3 className="text-xs font-semibold mb-1 flex items-center gap-1.5"><ShieldLock size={12} /> Zona dibatasi</h3>
      <p className="text-[11px] text-gray-400 mb-2">
        Batasi satu AREA tertentu di dalam map ini (mis. &quot;CEO Office&quot;) tanpa membatasi seluruh room — orang yang tidak
        memenuhi role bisa isi form antrean untuk dapat giliran masuk sendiri.
      </p>
      {error && <p className="text-[11px] text-red-500 mb-2">{error}</p>}
      {zones === null ? (
        <p className="text-xs text-gray-400">Memuat zona…</p>
      ) : zones.length === 0 ? (
        <p className="text-xs text-gray-400">Room ini belum punya zona.</p>
      ) : (
        <div className="space-y-1">
          {zones.map((z) => {
            const r = restrictionOf(z.id);
            const enabled = !!r;
            return (
              <div key={z.id} className="text-xs">
                <label className="flex items-center gap-2 cursor-pointer py-1">
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={busy === z.id}
                    onChange={() => save(z.id, { enabled: !enabled })}
                    className="w-3.5 h-3.5 accent-purple-600 cursor-pointer shrink-0"
                  />
                  <span className="flex-1 truncate">{z.name}</span>
                  {enabled && <span className="text-[10px] text-purple-600 shrink-0">dibatasi</span>}
                </label>
                {enabled && r && (
                  <div className="ml-5 mb-1.5 flex items-center gap-2 flex-wrap">
                    <select
                      value={r.minRole}
                      disabled={busy === z.id}
                      onChange={(e) => save(z.id, { enabled: true, minRole: e.target.value })}
                      className="px-1.5 py-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-[11px]"
                    >
                      <option value="staff">staff+</option>
                      <option value="admin">admin+</option>
                      <option value="owner">owner saja</option>
                    </select>
                    <label className="flex items-center gap-1 text-[11px] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={r.queueEnabled}
                        disabled={busy === z.id}
                        onChange={() => save(z.id, { enabled: true, queueEnabled: !r.queueEnabled })}
                        className="w-3 h-3 accent-purple-600 cursor-pointer"
                      />
                      Antrean
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
