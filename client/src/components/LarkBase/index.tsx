import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { XLg, PlusLg, Trash, People, PencilFill, Check2, UiChecksGrid, CloudCheck, CloudArrowUp, ExclamationTriangle, WifiOff, Table as TableIcon, Kanban, Grid3x3GapFill, CalendarWeek, LockFill, PersonFill, ThreeDots } from 'react-bootstrap-icons';
import { useClickOutside } from './components/useClickOutside';
import { View, ViewType, uid } from './types';
import { can } from '@virtualmeet/shared';
import { useServerBase, CurrentUser } from './serverStore';
import { makeViewMutations } from './viewMutations';
import { applyPipeline } from './filters';
import { Toolbar } from './components/Toolbar';
import { RecordPanel } from './components/RecordPanel';
import { GridView } from './views/GridView';
import { KanbanView } from './views/KanbanView';
import { GalleryView } from './views/GalleryView';
import { CalendarView } from './views/CalendarView';
import { FormView } from './views/FormView';
import { PresenceBar } from './collab/PresenceBar';
import { SharePanel } from './collab/SharePanel';
import { NotificationsBell } from './collab/NotificationsBell';
import { exportCsv } from './csv';
import { parseImportedRecordCells } from './csv';
import { op } from './opsClient';
import { ViewProps } from './views/shared';

const VIEW_META: Record<ViewType, { label: string; icon: JSX.Element }> = {
  grid: { label: 'Grid', icon: <TableIcon size={13} /> },
  kanban: { label: 'Kanban', icon: <Kanban size={13} /> },
  gallery: { label: 'Galeri', icon: <Grid3x3GapFill size={13} /> },
  calendar: { label: 'Kalender', icon: <CalendarWeek size={13} /> },
  form: { label: 'Formulir', icon: <UiChecksGrid size={13} /> },
};

export default function LarkBaseApp({ baseId, currentUser, onClose }: { baseId: string; currentUser: CurrentUser; onClose: () => void }) {
  const s = useServerBase();
  useEffect(() => { s.loadBase(baseId, currentUser); return () => s.teardown(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [baseId]);

  const [openRecordId, setOpenRecordId] = useState<string | null>(null);
  const [showViewAdd, setShowViewAdd] = useState(false);
  const [search, setSearch] = useState('');
  const [showShare, setShowShare] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const table = s.tables.find((t) => t.id === s.activeTableId) ?? s.tables[0];
  const view = table?.views.find((v) => v.id === s.activeViewId) ?? table?.views[0];
  const visibleFields = useMemo(() => (table && view ? table.fields.filter((f) => !view.hidden.includes(f.id)) : []), [table, view]);
  const rows = useMemo(
    () => (table && view ? applyPipeline(table.records, table.fields, view.filters, view.sorts, search, visibleFields, currentUser.id) : []),
    [table, view, search, visibleFields, currentUser.id],
  );

  const canEdit = can('record:update', { role: s.myRole ?? undefined });
  const canEditView = can('view:editConfig', { role: s.myRole ?? undefined });

  const m = useMemo(
    () => (table ? makeViewMutations(table.id, s.dispatch, () => useServerBase.getState().tables.find((t) => t.id === table.id)?.fields ?? []) : null),
    [table?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (s.loading) return <Shell onClose={onClose}><Centered>Memuat base…</Centered></Shell>;
  if (s.error) return <Shell onClose={onClose}><Centered>{s.error}</Centered></Shell>;
  if (!table || !view || !m) return <Shell onClose={onClose}><Centered>Base kosong.</Centered></Shell>;

  const patchView = (patch: Partial<View>) => { if (canEditView) s.dispatch(op.updateView(table.id, view.id, patch)); };

  const commitRename = (raw: string) => {
    const name = raw.trim();
    setRenaming(false);
    if (name && name !== s.baseName) s.renameBase(name);
  };

  const addNewView = (type: ViewType) => {
    const viewId = uid('viw');
    const firstDate = table.fields.find((f) => f.type === 'date')?.id;
    const firstSelect = table.fields.find((f) => f.type === 'select')?.id;
    const nv: View = { id: viewId, name: VIEW_META[type].label, type, filters: [], sorts: [], hidden: [], rowHeight: 'short', stackField: type === 'kanban' ? firstSelect : undefined, dateField: type === 'calendar' ? firstDate : undefined };
    s.dispatch(op.addView(table.id, nv));
    s.setActiveView(viewId);
    setShowViewAdd(false);
  };

  const onExportCsv = () => exportCsv(table, visibleFields, rows, table.fields);
  const onImportCsv = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const cellsList = parseImportedRecordCells(table, String(reader.result ?? ''));
      s.dispatch(cellsList.map((cells) => op.addRecord(table.id, cells)));
    };
    reader.readAsText(file);
  };

  const viewProps: ViewProps = {
    table, view, fields: table.fields, visibleFields, rows, m, canEdit,
    myRole: s.myRole ?? undefined,
    members: s.members,
    commentCounts: s.commentCounts,
    openRecord: setOpenRecordId, patchView,
    onCursor: (recordId, fieldId) => s.sendCursor(view.id, recordId, fieldId),
  };

  return (
    // pl-14 clears the room's Sidebar rail (w-14, z-50) which sits ABOVE this
    // panel — without it the tables sidebar and its back button get covered.
    <div className="absolute inset-0 z-40 flex bg-white dark:bg-gray-900 overflow-hidden pl-14">
      {/* Tables sidebar */}
      <aside className="w-44 sm:w-52 shrink-0 border-r border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 flex flex-col">
        <div className="px-3 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2">
          <button onClick={onClose} aria-label="Kembali" className="p-1 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 cursor-pointer shrink-0"><XLg size={14} /></button>
          {renaming ? (
            <input
              autoFocus
              defaultValue={s.baseName}
              onBlur={(e) => commitRename(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(false); }}
              aria-label="Nama base"
              className="flex-1 min-w-0 text-sm font-semibold bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 rounded px-1.5 py-0.5 outline-none ring-1 ring-purple-500"
            />
          ) : (
            <div className="flex items-center gap-1 min-w-0 group/name">
              <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{s.baseName}</p>
              {canEditView && (
                <button onClick={() => setRenaming(true)} aria-label="Ganti nama base" title="Ganti nama base" className="opacity-0 group-hover/name:opacity-100 text-gray-400 hover:text-purple-600 cursor-pointer shrink-0"><PencilFill size={10} /></button>
              )}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {s.tables.map((t) => (
            <div key={t.id} className={`group flex items-center rounded-lg ${t.id === s.activeTableId ? 'bg-purple-100 dark:bg-gray-700' : 'hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
              <button onClick={() => s.setActiveTable(t.id)} className="flex-1 flex items-center gap-2 px-2 py-1.5 text-left cursor-pointer min-w-0">
                <span className="text-sm shrink-0">{t.icon ?? '📄'}</span>
                <span className={`text-sm truncate ${t.id === s.activeTableId ? 'text-purple-700 dark:text-purple-200 font-medium' : 'text-gray-600 dark:text-gray-300'}`}>{t.name}</span>
              </button>
              {canEdit && s.tables.length > 1 && (
                <button onClick={() => { if (window.confirm(`Hapus tabel "${t.name}"?`)) s.dispatch(op.deleteTable(t.id)); }} aria-label="Hapus tabel" className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 px-1.5 cursor-pointer"><Trash size={12} /></button>
              )}
            </div>
          ))}
        </div>
        {canEdit && (
          <button onClick={() => { const id = uid('tbl'); const fid = uid('fld'); const vid = uid('viw'); s.dispatch(op.addTable({ id, name: `Tabel ${s.tables.length + 1}`, icon: '📋', fields: [{ id: fid, name: 'Judul', type: 'text', width: 240 }], records: [{ id: uid('rec'), cells: { [fid]: '' } }], views: [{ id: vid, name: 'Grid', type: 'grid', filters: [], sorts: [], hidden: [], rowHeight: 'short' }] })); }} className="m-2 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-xs text-gray-500 hover:text-purple-600 hover:border-purple-400 cursor-pointer">
            <PlusLg size={12} /> Tabel baru
          </button>
        )}
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <span className="text-lg">{table.icon ?? '📄'}</span>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{table.name}</h2>
          <span className="text-xs text-gray-400 shrink-0">{rows.length} baris</span>
          <SaveIndicator state={s.saveState} />
          <div className="flex-1" />
          <PresenceBar users={s.presence} meId={currentUser.id} />
          <NotificationsBell onOpenRecord={setOpenRecordId} />
          <button onClick={() => setShowShare(true)} className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white cursor-pointer">
            <People size={13} /> Bagikan
          </button>
        </div>

        {/* View tabs — the row itself must NOT clip (popovers below live in
            it); only the inner strip scrolls horizontally. */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <div className="flex items-center gap-1 overflow-x-auto min-w-0 flex-1">
          {table.views.map((v) => (
            <div key={v.id} className={`group flex items-center rounded-lg shrink-0 ${v.id === s.activeViewId ? 'bg-purple-100 dark:bg-gray-700' : 'hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
              <button onClick={() => s.setActiveView(v.id)} className={`flex items-center gap-1.5 px-2.5 py-1 text-xs cursor-pointer ${v.id === s.activeViewId ? 'text-purple-700 dark:text-purple-200 font-medium' : 'text-gray-500 dark:text-gray-400'}`}>
                {VIEW_META[v.type].icon} {v.name}
                {v.mode === 'locked' && <LockFill size={9} className="text-amber-500" aria-label="Terkunci" />}
                {v.mode === 'personal' && <PersonFill size={9} className="text-purple-500" aria-label="Personal" />}
              </button>
              {canEditView && table.views.length > 1 && (
                <button onClick={() => s.dispatch(op.deleteView(table.id, v.id))} aria-label="Hapus tampilan" className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 px-1 cursor-pointer"><XLg size={9} /></button>
              )}
            </div>
          ))}
          </div>

          {/* Popovers live OUTSIDE the scrolling strip above: `overflow-x-auto`
              also clips the Y axis, which buried these dropdowns inside the
              tab row (and grew a stray scrollbar) instead of overlaying. */}
          <ViewModeMenu view={view} meId={currentUser.id} meName={currentUser.name} onSet={(patch) => s.dispatch(op.updateView(table.id, view.id, patch))} />
          {canEditView && (
            <div className="relative shrink-0">
              <button onClick={() => setShowViewAdd((v) => !v)} aria-label="Tambah tampilan" className="p-1 rounded-lg text-gray-400 hover:text-purple-600 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"><PlusLg size={13} /></button>
              {/* right-0 on the popover: this button sits at the row's right
                  edge, so it must open leftwards or it runs off-screen. */}
              {showViewAdd && (
                <div className="absolute z-40 top-full right-0 mt-1 w-40 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-purple-100 dark:border-gray-700 p-1">
                  {(Object.keys(VIEW_META) as ViewType[]).map((vt) => (
                    <button key={vt} onClick={() => addNewView(vt)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">
                      {VIEW_META[vt].icon} {VIEW_META[vt].label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <Toolbar table={table} view={view} fields={table.fields} visibleFields={visibleFields} patchView={patchView} search={search} setSearch={setSearch} onImportCsv={onImportCsv} onExportCsv={onExportCsv} canEditView={canEditView} canImport={canEdit} />

        <div className="flex-1 min-h-0">
          {view.type === 'grid' && <GridView {...viewProps} />}
          {view.type === 'kanban' && <KanbanView {...viewProps} />}
          {view.type === 'gallery' && <GalleryView {...viewProps} />}
          {view.type === 'calendar' && <CalendarView {...viewProps} />}
          {view.type === 'form' && <FormView {...viewProps} canEditView={canEditView} />}
        </div>
      </div>

      {openRecordId && <RecordPanel table={table} recordId={openRecordId} m={m} canEdit={canEdit} onClose={() => setOpenRecordId(null)} />}
      {showShare && <SharePanel onClose={() => setShowShare(false)} />}
    </div>
  );
}

// Per-view mode switcher: collaborative ↔ locked ↔ personal (Lark semantics).
function ViewModeMenu({ view, meId, meName, onSet }: { view: View; meId: string; meName: string; onSet: (patch: Partial<View>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  const mode = view.mode ?? 'collaborative';
  const pick = (m: 'collaborative' | 'locked' | 'personal') => {
    if (m === 'personal') onSet({ mode: 'personal', ownerId: meId, lockedById: undefined, lockedByName: undefined });
    else if (m === 'locked') onSet({ mode: 'locked', lockedById: meId, lockedByName: meName, ownerId: undefined });
    else onSet({ mode: 'collaborative', ownerId: undefined, lockedById: undefined, lockedByName: undefined });
    setOpen(false);
  };
  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={() => setOpen((v) => !v)} aria-label="Mode tampilan" title={mode === 'locked' ? `Dikunci oleh ${view.lockedByName ?? 'seseorang'}` : mode === 'personal' ? 'Tampilan personal — hanya kamu' : 'Tampilan kolaboratif'} className="px-1 text-gray-400 hover:text-purple-600 cursor-pointer"><ThreeDots size={11} /></button>
      {open && (
        <div className="absolute z-50 top-full right-0 mt-1 w-48 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-purple-100 dark:border-gray-700 p-1 text-xs">
          <p className="text-[10px] text-gray-400 px-2 py-1">Mode tampilan</p>
          {([['collaborative', 'Kolaboratif — semua'], ['locked', 'Kunci view (hanya pengunci/pemilik)'], ['personal', 'Jadikan personal (hanya aku)']] as const).map(([m, label]) => (
            <button key={m} onClick={() => pick(m)} className={`w-full text-left px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer ${mode === m ? 'bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-200 font-medium' : 'text-gray-700 dark:text-gray-200'}`}>{label}</button>
          ))}
          {mode === 'locked' && view.lockedByName && <p className="text-[10px] text-gray-400 px-2 py-1 border-t border-gray-100 dark:border-gray-700 mt-1">Dikunci oleh {view.lockedByName}</p>}
        </div>
      )}
    </div>
  );
}

function Shell({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-white dark:bg-gray-900">
      <div className="flex items-center px-4 py-2.5 border-b border-gray-100 dark:border-gray-700">
        <button onClick={onClose} aria-label="Tutup" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 cursor-pointer"><XLg size={16} /></button>
        <span className="ml-2 text-sm font-semibold text-gray-700 dark:text-gray-200">Basis Data</span>
      </div>
      {children}
    </div>
  );
}
function Centered({ children }: { children: ReactNode }) {
  return <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">{children}</div>;
}

function SaveIndicator({ state }: { state: 'saved' | 'saving' | 'error' | 'offline' }) {
  const map = {
    saved: { icon: <CloudCheck size={13} />, text: 'Tersimpan', cls: 'text-green-600 dark:text-green-400' },
    saving: { icon: <CloudArrowUp size={13} />, text: 'Menyimpan…', cls: 'text-gray-400' },
    error: { icon: <ExclamationTriangle size={13} />, text: 'Gagal tersimpan', cls: 'text-red-500' },
    offline: { icon: <WifiOff size={13} />, text: 'Offline — antre', cls: 'text-amber-500' },
  }[state];
  return <span className={`inline-flex items-center gap-1 text-[11px] ${map.cls}`} title={map.text}>{map.icon} <span className="hidden sm:inline">{map.text}</span></span>;
}
