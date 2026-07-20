import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link45deg, LockFill, Download } from 'react-bootstrap-icons';
import { openShare, SharePayload } from './api';
import { Table, View } from './types';
import { applyPipeline } from './filters';
import { exportCsv } from './csv';
import { FormRunner } from './FormRunner';
import { GridView } from './views/GridView';
import { KanbanView } from './views/KanbanView';
import { GalleryView } from './views/GalleryView';
import { CalendarView } from './views/CalendarView';
import { ViewProps, ViewMutations } from './views/shared';

// Public read-only viewer for a share link (?share=<token>). No auth. Renders
// exactly ONE view; all mutations are no-ops (server would reject anyway).
const NOOP_M: ViewMutations = {
  setCell: () => {}, addRecord: () => {}, deleteRecords: () => {}, changeFieldType: () => {},
  insertField: () => {}, deleteField: () => {}, setFieldWidth: () => {}, addOption: () => '',
  addView: () => {}, updateView: () => {}, deleteView: () => {},
};

export function SharePage({ token }: { token: string }) {
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [okPassword, setOkPassword] = useState<string | undefined>(undefined);

  const tryOpen = (password?: string) => {
    setLoading(true); setError(null);
    openShare(token, password)
      .then((p) => { setPayload(p); setNeedPassword(false); setOkPassword(password); })
      .catch((e: Error & { status?: number; code?: string }) => {
        if (e.code === 'password_required') { setNeedPassword(true); }
        else if (e.code === 'password_wrong') { setNeedPassword(true); setError('Password salah.'); }
        else if (e.status === 410) setError('Link ini sudah kedaluwarsa.');
        else if (e.status === 404) setError('Link tidak ditemukan atau sudah dicabut.');
        else setError(e.message || 'Gagal membuka link.');
      })
      .finally(() => setLoading(false));
  };
  useEffect(() => { tryOpen(); /* eslint-disable-line */ }, [token]);

  const table: Table | null = useMemo(() => (payload ? { ...payload.table, records: payload.records.map((r) => ({ id: r.id, cells: r.cells })) } : null), [payload]);
  const view: View | undefined = table?.views[0];
  const visibleFields = useMemo(() => (table && view ? table.fields.filter((f) => !view.hidden.includes(f.id)) : []), [table, view]);
  const rows = useMemo(() => (table && view ? applyPipeline(table.records, table.fields, view.filters, view.sorts, search, visibleFields) : []), [table, view, search, visibleFields]);

  return (
    <div className="fixed inset-0 z-0 flex flex-col bg-white dark:bg-gray-900">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shrink-0">
        <Link45deg size={18} className="text-purple-600" />
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{payload ? payload.baseName : 'Basis Data'}</span>
        <span className="text-[11px] bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full px-2 py-0.5">{payload?.table.views[0]?.type === 'form' ? 'formulir · isi & kirim' : 'hanya-baca · dibagikan'}</span>
        <div className="flex-1" />
        {payload && payload.table.views[0]?.type !== 'form' && (
          <>
            <div className="relative">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cari…" aria-label="Cari" className="w-32 sm:w-48 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-purple-500" />
            </div>
            {payload.allowCopy && table && view && (
              <button onClick={() => exportCsv(table, visibleFields, rows, table.fields)} className="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"><Download size={12} /> Ekspor</button>
            )}
          </>
        )}
      </div>

      {loading ? (
        <Center>Memuat…</Center>
      ) : needPassword ? (
        <Center>
          <div className="text-center max-w-xs">
            <LockFill size={28} className="text-amber-500 mx-auto mb-2" />
            <p className="text-sm text-gray-700 dark:text-gray-200 mb-3">Link ini dilindungi password.</p>
            <div className="flex gap-2">
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') tryOpen(pw); }} autoFocus placeholder="Password" className="flex-1 bg-gray-50 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-purple-500" />
              <button onClick={() => tryOpen(pw)} className="bg-purple-600 hover:bg-purple-700 text-white text-sm px-3 rounded-lg cursor-pointer">Buka</button>
            </div>
            {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
          </div>
        </Center>
      ) : error ? (
        <Center><span className="text-red-500">{error}</span></Center>
      ) : table && view && view.type === 'form' ? (
        // A form link is submit-only: show the form, not the data.
        <FormRunner token={token} view={view} fields={table.fields} password={okPassword} />
      ) : table && view ? (
        <div className="flex-1 min-h-0">
          {view.type === 'grid' && <ReadonlyView Comp={GridView} table={table} view={view} fields={table.fields} visibleFields={visibleFields} rows={rows} />}
          {view.type === 'kanban' && <ReadonlyView Comp={KanbanView} table={table} view={view} fields={table.fields} visibleFields={visibleFields} rows={rows} />}
          {view.type === 'gallery' && <ReadonlyView Comp={GalleryView} table={table} view={view} fields={table.fields} visibleFields={visibleFields} rows={rows} />}
          {view.type === 'calendar' && <ReadonlyView Comp={CalendarView} table={table} view={view} fields={table.fields} visibleFields={visibleFields} rows={rows} />}
        </div>
      ) : null}
    </div>
  );
}

function ReadonlyView({ Comp, table, view, fields, visibleFields, rows }: { Comp: (p: ViewProps) => JSX.Element } & Pick<ViewProps, 'table' | 'view' | 'fields' | 'visibleFields' | 'rows'>) {
  return <Comp table={table} view={view} fields={fields} visibleFields={visibleFields} rows={rows} m={NOOP_M} canEdit={false} commentCounts={{}} openRecord={() => {}} patchView={() => {}} />;
}

function Center({ children }: { children: ReactNode }) {
  return <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 p-6">{children}</div>;
}
