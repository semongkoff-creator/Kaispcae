import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { XLg, PlusLg, ArrowClockwise, BoxArrowUpRight } from 'react-bootstrap-icons';
import { api, ApiError, DailyTask, TaskOptions, CreateTaskBody } from '@/services/api';

// A7 — Daily Task widget. Reads/writes a Lark Base table directly (no local
// copy), so every open queries Lark and every change posts to Lark. The form
// mirrors the real table columns (confirmed via API): Task, Workstream,
// Priority, Due Date, Status, Notes, Related Project — Owner is auto (the
// logged-in user). Select/Project options are fetched LIVE from Lark, never
// hardcoded. Loading + error states are explicit because these are external
// API calls, not instant local reads.

function todayInputValue(): string {
  // Local YYYY-MM-DD for the date input's default.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDue(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}

const DONE_STATUS = 'Done';
const UNDONE_STATUS = 'In Progress';

export function DailyTaskPanel({ onClose }: { onClose: () => void }) {
  const [tasks, setTasks] = useState<DailyTask[]>([]);
  const [options, setOptions] = useState<TaskOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [noLark, setNoLark] = useState(false);
  const [busyRecord, setBusyRecord] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setNoLark(false);
    try {
      // Options can fail independently of the list; the list is the critical one.
      const [tasksRes, optsRes] = await Promise.allSettled([api.getTodayTasks(), api.getTaskOptions()]);
      if (tasksRes.status === 'rejected') throw tasksRes.reason;
      setTasks(tasksRes.value.tasks);
      if (optsRes.status === 'fulfilled') setOptions(optsRes.value);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNoLark(true);
      else setError(e instanceof Error && e.message !== 'lark' ? 'Gagal memuat task dari Lark. Coba lagi.' : 'Gagal terhubung ke Lark. Coba lagi sebentar.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleDone = async (t: DailyTask) => {
    setBusyRecord(t.recordId);
    const next = t.status === DONE_STATUS ? UNDONE_STATUS : DONE_STATUS;
    try {
      await api.updateTaskStatus(t.recordId, next);
      setTasks((prev) => prev.map((x) => (x.recordId === t.recordId ? { ...x, status: next } : x)));
    } catch {
      setError('Gagal mengubah status di Lark.');
    } finally {
      setBusyRecord(null);
    }
  };

  return (
    <div className="absolute inset-0 z-40 bg-purple-50/95 dark:bg-gray-900/95 backdrop-blur-md pl-14 pointer-events-auto overflow-y-auto">
      <div className="max-w-2xl mx-auto px-5 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-gray-900 dark:text-gray-100 text-lg font-bold">Daily Task</h2>
            <p className="text-gray-500 dark:text-gray-400 text-xs">Tugas kamu hari ini — tersambung langsung ke Lark Base.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void load()} title="Muat ulang" className="text-gray-500 hover:text-purple-600 dark:text-gray-400 dark:hover:text-purple-300 cursor-pointer p-1.5">
              <ArrowClockwise size={16} />
            </button>
            <button onClick={onClose} title="Tutup" className="text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100 cursor-pointer p-1.5">
              <XLg size={18} />
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm py-10 text-center">Memuat dari Lark…</p>
        ) : noLark ? (
          <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800 dark:text-amber-200">
            Hubungkan akun Lark dulu (logout lalu <span className="font-medium">Login dengan Lark</span>) untuk memakai Daily Task — task disimpan atas nama akun Lark kamu.
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
              <button
                onClick={() => setFormOpen(true)}
                className="inline-flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-3 py-2 rounded-lg cursor-pointer mb-4"
              >
                <PlusLg size={15} /> Tambah Task
              </button>
            )}

            {formOpen && options && (
              <TaskForm
                options={options}
                submitting={submitting}
                onCancel={() => setFormOpen(false)}
                onSubmit={async (body) => {
                  setSubmitting(true);
                  setError('');
                  try {
                    const { task } = await api.createTask(body);
                    // Only prepend if it belongs to today's owned view (it does:
                    // owner=me; due date may differ, so reload to stay truthful).
                    setTasks((prev) => [task, ...prev]);
                    setFormOpen(false);
                    void load();
                  } catch {
                    setError('Gagal menyimpan task ke Lark.');
                  } finally {
                    setSubmitting(false);
                  }
                }}
              />
            )}

            {tasks.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-sm py-6 text-center">Belum ada task untuk hari ini.</p>
            ) : (
              <div className="space-y-2">
                {tasks.map((t) => {
                  const done = t.status === DONE_STATUS;
                  return (
                    <div key={t.recordId} className="flex items-start gap-3 rounded-lg bg-white dark:bg-gray-800 border border-purple-100 dark:border-gray-700 px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={done}
                        disabled={busyRecord === t.recordId}
                        onChange={() => void toggleDone(t)}
                        className="mt-1 h-4 w-4 accent-purple-600 cursor-pointer disabled:opacity-50"
                      />
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm ${done ? 'line-through text-gray-400 dark:text-gray-500' : 'text-gray-800 dark:text-gray-100'}`}>{t.task}</p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[10px]">
                          {t.status && <Badge>{t.status}</Badge>}
                          {t.priority && <Badge>{t.priority}</Badge>}
                          {t.workstream && <Badge>{t.workstream}</Badge>}
                          {t.project && <Badge>{t.project.name}</Badge>}
                          {t.dueDate && <span className="text-gray-400 dark:text-gray-500">{fmtDue(t.dueDate)}</span>}
                        </div>
                        {t.notes && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t.notes}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <a
              href="https://osgfmmt9uzgh.sg.larksuite.com/base/UXozb1N5TapUC4s7fu2lpmDigwc?table=tbl4HKtwKhDS99pJ"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-purple-600 dark:text-purple-300 hover:underline mt-5"
            >
              <BoxArrowUpRight size={11} /> Buka di Lark Base
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="px-1.5 py-0.5 rounded bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-200">{children}</span>;
}

function TaskForm({
  options,
  submitting,
  onSubmit,
  onCancel,
}: {
  options: TaskOptions;
  submitting: boolean;
  onSubmit: (body: CreateTaskBody) => void;
  onCancel: () => void;
}) {
  const [task, setTask] = useState('');
  const [workstream, setWorkstream] = useState('');
  const [priority, setPriority] = useState('');
  const [status, setStatus] = useState(options.status[0] ?? '');
  const [projectRecordId, setProjectRecordId] = useState('');
  const [due, setDue] = useState(todayInputValue());
  const [notes, setNotes] = useState('');

  const inputCls =
    'w-full bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm rounded px-2.5 py-1.5 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500';

  return (
    <div className="rounded-xl border border-purple-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 mb-4 space-y-2.5">
      <input autoFocus value={task} onChange={(e) => setTask(e.target.value)} placeholder="Judul tugas…" className={inputCls} />
      <div className="grid grid-cols-2 gap-2">
        <Select label="Workstream" value={workstream} onChange={setWorkstream} options={options.workstream} cls={inputCls} />
        <Select label="Priority" value={priority} onChange={setPriority} options={options.priority} cls={inputCls} />
        <Select label="Status" value={status} onChange={setStatus} options={options.status} cls={inputCls} />
        <label className="text-xs text-gray-500 dark:text-gray-400">
          Due Date
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${inputCls} mt-0.5`} />
        </label>
      </div>
      <label className="text-xs text-gray-500 dark:text-gray-400 block">
        Related Project
        <select value={projectRecordId} onChange={(e) => setProjectRecordId(e.target.value)} className={`${inputCls} mt-0.5 cursor-pointer`}>
          <option value="">— Tidak ada —</option>
          {options.projects.map((p) => (
            <option key={p.recordId} value={p.recordId}>{p.name}</option>
          ))}
        </select>
      </label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Catatan (opsional)…" rows={2} className={inputCls} />
      <div className="flex items-center gap-2 pt-1">
        <button
          disabled={submitting || !task.trim()}
          onClick={() =>
            onSubmit({
              task: task.trim(),
              workstream: workstream || undefined,
              priority: priority || undefined,
              status: status || undefined,
              notes: notes.trim() || undefined,
              dueDate: due ? new Date(`${due}T00:00:00`).getTime() : undefined,
              projectRecordId: projectRecordId || undefined,
            })
          }
          className="bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-3 py-1.5 rounded-lg cursor-pointer disabled:opacity-50"
        >
          {submitting ? 'Menyimpan…' : 'Simpan ke Lark'}
        </button>
        <button onClick={onCancel} disabled={submitting} className="text-gray-500 dark:text-gray-400 text-sm px-2 cursor-pointer">Batal</button>
      </div>
    </div>
  );
}

function Select({ label, value, onChange, options, cls }: { label: string; value: string; onChange: (v: string) => void; options: string[]; cls: string }) {
  return (
    <label className="text-xs text-gray-500 dark:text-gray-400">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${cls} mt-0.5 cursor-pointer`}>
        <option value="">— Pilih —</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}
