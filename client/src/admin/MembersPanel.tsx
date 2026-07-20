import { useEffect, useState, useCallback } from 'react';
import { WORKSPACE_ROLE_LABELS, WorkspaceRole } from '@virtualmeet/shared';
import { CurrentUser } from '@/hooks/useCurrentUser';
import { adminApi, AdminMember, AdminDepartment } from './api';

const dateFmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });

export function MembersPanel({ currentUser }: { currentUser: CurrentUser }) {
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [departments, setDepartments] = useState<AdminDepartment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, d] = await Promise.all([adminApi.getMembers(), adminApi.getDepartments()]);
      setMembers(m.members);
      setDepartments(d.departments);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const patch = async (userId: string, body: Parameters<typeof adminApi.updateMember>[1]) => {
    setBusyId(userId);
    setError(null);
    try {
      await adminApi.updateMember(userId, body);
      await load();
    } catch (e) {
      // The server is the authority: if it refuses (last admin, etc.) we show
      // its message rather than pretending the change stuck.
      setError(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <p className="text-xs text-gray-400">Memuat anggota…</p>;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Anggota workspace</h2>
        <span className="text-xs text-gray-400">{members.length} orang</span>
      </div>
      {error && <p className="mb-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-700">
              <th className="py-2 pr-3 font-medium">Nama</th>
              <th className="py-2 pr-3 font-medium">Peran</th>
              <th className="py-2 pr-3 font-medium">Departemen</th>
              <th className="py-2 pr-3 font-medium">Manajer</th>
              <th className="py-2 pr-3 font-medium">Bergabung</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isMe = m.id === currentUser.id;
              return (
                <tr key={m.id} className={`border-b border-gray-50 dark:border-gray-800 ${!m.active ? 'opacity-50' : ''}`}>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-6 h-6 rounded-full bg-purple-200 dark:bg-purple-800 text-purple-700 dark:text-purple-200 text-[10px] font-bold flex items-center justify-center shrink-0">
                        {m.displayName.charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-gray-800 dark:text-gray-100 font-medium truncate">
                          {m.displayName}{isMe && <span className="text-gray-400 font-normal"> (kamu)</span>}
                        </span>
                        <span className="block text-gray-400 truncate">{m.email}</span>
                      </span>
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      value={m.workspaceRole}
                      disabled={busyId === m.id}
                      onChange={(e) => patch(m.id, { workspaceRole: e.target.value as WorkspaceRole })}
                      aria-label={`Peran ${m.displayName}`}
                      className="bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none cursor-pointer text-gray-800 dark:text-gray-100"
                    >
                      {(['admin', 'member'] as WorkspaceRole[]).map((r) => (
                        <option key={r} value={r}>{WORKSPACE_ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      value={m.department?.id ?? ''}
                      disabled={busyId === m.id}
                      onChange={(e) => patch(m.id, { departmentId: e.target.value || null })}
                      aria-label={`Departemen ${m.displayName}`}
                      className="bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none cursor-pointer text-gray-800 dark:text-gray-100"
                    >
                      <option value="">—</option>
                      {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      value={m.manager?.id ?? ''}
                      disabled={busyId === m.id}
                      onChange={(e) => patch(m.id, { managerId: e.target.value || null })}
                      aria-label={`Manajer ${m.displayName}`}
                      className="bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none cursor-pointer text-gray-800 dark:text-gray-100"
                    >
                      <option value="">—</option>
                      {members.filter((o) => o.id !== m.id && o.active).map((o) => (
                        <option key={o.id} value={o.id}>{o.displayName}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {dateFmt.format(new Date(m.createdAt))}
                  </td>
                  <td className="py-2">
                    <button
                      onClick={() => patch(m.id, { active: !m.active })}
                      disabled={busyId === m.id}
                      className={`px-2 py-1 rounded-lg font-medium cursor-pointer disabled:cursor-wait ${
                        m.active
                          ? 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                          : 'text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20'
                      }`}
                    >
                      {m.active ? 'Nonaktifkan' : 'Aktifkan'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-gray-400">
        Menonaktifkan akun akan mengakhiri sesinya dan mencabut semua izinnya, tapi riwayat auditnya tetap tersimpan.
      </p>
    </div>
  );
}
