import { useEffect, useState, useCallback } from 'react';
import { PlusLg, Trash } from 'react-bootstrap-icons';
import { adminApi, AdminDepartment } from './api';

export function DepartmentsPanel() {
  const [departments, setDepartments] = useState<AdminDepartment[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { departments: d } = await adminApi.getDepartments();
      setDepartments(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      await adminApi.createDepartment(n);
      setName('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal membuat departemen');
    }
  };

  const remove = async (d: AdminDepartment) => {
    try {
      await adminApi.deleteDepartment(d.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menghapus');
    }
  };

  if (loading) return <p className="text-xs text-gray-400">Memuat departemen…</p>;

  return (
    <div className="max-w-lg">
      <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-3">Departemen</h2>
      {error && <p className="mb-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}

      <div className="flex items-center gap-2 mb-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
          placeholder="Nama departemen baru…"
          aria-label="Nama departemen baru"
          className="flex-1 bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-800 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500"
        />
        <button onClick={add} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700">
          <PlusLg size={12} /> Tambah
        </button>
      </div>

      {departments.length === 0 ? (
        <p className="text-xs text-gray-400">Belum ada departemen.</p>
      ) : (
        <ul className="space-y-1">
          {departments.map((d) => (
            <li key={d.id} className="group flex items-center justify-between px-2.5 py-2 rounded-lg bg-gray-50 dark:bg-gray-800">
              <span className="text-xs text-gray-800 dark:text-gray-100 font-medium">{d.name}</span>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-gray-400">{d.memberCount} anggota</span>
                <button
                  onClick={() => remove(d)}
                  aria-label={`Hapus ${d.name}`}
                  className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 cursor-pointer"
                >
                  <Trash size={12} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-gray-400">
        Menghapus departemen tidak menghapus anggotanya — mereka hanya jadi tanpa departemen.
      </p>
    </div>
  );
}
