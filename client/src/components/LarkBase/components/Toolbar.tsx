import { useRef, useState, type ReactNode } from 'react';
import { Funnel, SortDown, Grid3x3Gap, EyeSlash, Search, Upload, Download, PlusLg, X } from 'react-bootstrap-icons';
import { Table, View, Field, FilterCondition, SortRule, CellValue, RowHeight, uid, SELECT_COLORS } from '../types';
import { operatorsForField, opNeedsValue } from '../filters';
import { useServerBase } from '../serverStore';
import { useClickOutside } from './useClickOutside';

interface ToolbarProps {
  table: Table;
  view: View;
  fields: Field[];
  visibleFields: Field[];
  patchView: (patch: Partial<View>) => void;
  search: string;
  setSearch: (s: string) => void;
  onImportCsv: (file: File) => void;
  onExportCsv: () => void;
  canEditView: boolean; // gate filter/sort/group/hide/row-height (shared view config)
  canImport: boolean;   // gate CSV import (creates records → editor+)
}

function Btn({ active, count, icon, label, onClick }: { active?: boolean; count?: number; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors ${active ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
      {icon} {label}{count ? <span className="bg-purple-600 text-white rounded-full px-1.5 text-[10px]">{count}</span> : null}
    </button>
  );
}

function Pop({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, onClose, true);
  return <div ref={ref} className="absolute z-40 top-full left-0 mt-1 w-80 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-purple-100 dark:border-gray-700 p-3">{children}</div>;
}

export function Toolbar({ view, fields, patchView, search, setSearch, onImportCsv, onExportCsv, canEditView, canImport }: ToolbarProps) {
  const [open, setOpen] = useState<null | 'filter' | 'sort' | 'group' | 'hide'>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isGrid = view.type === 'grid';

  const setFilters = (filters: FilterCondition[]) => patchView({ filters });
  const setSorts = (sorts: SortRule[]) => patchView({ sorts });

  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 shrink-0 flex-wrap">
      {canEditView && (<>
      {/* Filter */}
      <div className="relative">
        <Btn active={open === 'filter' || view.filters.length > 0} count={view.filters.length} icon={<Funnel size={13} />} label="Filter" onClick={() => setOpen(open === 'filter' ? null : 'filter')} />
        {open === 'filter' && (
          <Pop onClose={() => setOpen(null)}>
            <FilterEditor fields={fields} filters={view.filters} onChange={setFilters} />
          </Pop>
        )}
      </div>

      {/* Sort */}
      <div className="relative">
        <Btn active={open === 'sort' || view.sorts.length > 0} count={view.sorts.length} icon={<SortDown size={13} />} label="Urutkan" onClick={() => setOpen(open === 'sort' ? null : 'sort')} />
        {open === 'sort' && (
          <Pop onClose={() => setOpen(null)}>
            <SortEditor fields={fields} sorts={view.sorts} onChange={setSorts} />
          </Pop>
        )}
      </div>

      {/* Group (grid only) */}
      {isGrid && (
        <div className="relative">
          <Btn active={open === 'group' || !!view.groupBy} icon={<Grid3x3Gap size={13} />} label="Grup" onClick={() => setOpen(open === 'group' ? null : 'group')} />
          {open === 'group' && (
            <Pop onClose={() => setOpen(null)}>
              <p className="text-xs text-gray-400 mb-1">Kelompokkan berdasarkan</p>
              <select value={view.groupBy ?? ''} onChange={(e) => patchView({ groupBy: e.target.value || undefined })} className="w-full text-sm bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 outline-none">
                <option value="">Tidak ada</option>
                {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </Pop>
          )}
        </div>
      )}

      {/* Hide fields */}
      <div className="relative">
        <Btn active={open === 'hide' || view.hidden.length > 0} count={view.hidden.length} icon={<EyeSlash size={13} />} label="Sembunyikan" onClick={() => setOpen(open === 'hide' ? null : 'hide')} />
        {open === 'hide' && (
          <Pop onClose={() => setOpen(null)}>
            <div className="max-h-60 overflow-y-auto space-y-0.5">
              {fields.map((f) => (
                <label key={f.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer text-sm text-gray-700 dark:text-gray-200">
                  <input type="checkbox" checked={!view.hidden.includes(f.id)} onChange={(e) => patchView({ hidden: e.target.checked ? view.hidden.filter((h) => h !== f.id) : [...view.hidden, f.id] })} className="w-3.5 h-3.5 accent-purple-600" />
                  {f.name}
                </label>
              ))}
            </div>
          </Pop>
        )}
      </div>

      {/* Row height (grid only) */}
      {isGrid && (
        <select value={view.rowHeight ?? 'short'} onChange={(e) => patchView({ rowHeight: e.target.value as RowHeight })} aria-label="Tinggi baris" className="text-xs bg-transparent text-gray-600 dark:text-gray-300 rounded-lg px-2 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 outline-none cursor-pointer">
          <option value="short">Baris pendek</option>
          <option value="medium">Baris sedang</option>
          <option value="tall">Baris tinggi</option>
        </select>
      )}
      </>)}

      <div className="flex-1" />

      {/* Search */}
      <div className="relative">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cari..." aria-label="Pencarian global" className="w-24 sm:w-40 bg-gray-50 dark:bg-gray-700 rounded-lg pl-7 pr-2 py-1.5 text-xs text-gray-800 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500" />
      </div>

      {/* CSV */}
      <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onImportCsv(f); e.target.value = ''; }} />
      {canImport && <Btn icon={<Upload size={13} />} label="Impor" onClick={() => fileRef.current?.click()} />}
      <Btn icon={<Download size={13} />} label="Ekspor" onClick={onExportCsv} />
    </div>
  );
}

function FilterEditor({ fields, filters, onChange }: { fields: Field[]; filters: FilterCondition[]; onChange: (f: FilterCondition[]) => void }) {
  const add = () => {
    const f = fields[0];
    const op = operatorsForField(f.type)[0].op;
    onChange([...filters, { id: uid('flt'), fieldId: f.id, operator: op }]);
  };
  const patch = (id: string, p: Partial<FilterCondition>) => onChange(filters.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const remove = (id: string) => onChange(filters.filter((c) => c.id !== id));

  return (
    <div>
      {filters.length === 0 && <p className="text-xs text-gray-400 mb-2">Belum ada filter.</p>}
      <div className="space-y-1.5">
        {filters.map((c) => {
          const field = fields.find((f) => f.id === c.fieldId) ?? fields[0];
          const ops = operatorsForField(field.type);
          const op = ops.find((o) => o.op === c.operator) ? c.operator : ops[0].op;
          return (
            <div key={c.id} className="flex items-center gap-1">
              <select value={c.fieldId} onChange={(e) => { const nf = fields.find((f) => f.id === e.target.value)!; patch(c.id, { fieldId: e.target.value, operator: operatorsForField(nf.type)[0].op, value: undefined }); }} className="text-xs bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none max-w-[7rem]">
                {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <select value={op} onChange={(e) => patch(c.id, { operator: e.target.value as FilterCondition['operator'], value: undefined })} className="text-xs bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none">
                {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
              </select>
              {opNeedsValue(op) && <FilterValueInput field={field} value={c.value} onChange={(v) => patch(c.id, { value: v })} />}
              <button onClick={() => remove(c.id)} aria-label="Hapus filter" className="text-gray-300 hover:text-red-500 cursor-pointer"><X size={14} /></button>
            </div>
          );
        })}
      </div>
      <button onClick={add} className="mt-2 inline-flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800 cursor-pointer"><PlusLg size={11} /> Tambah kondisi</button>
    </div>
  );
}

function FilterValueInput({ field, value, onChange }: { field: Field; value: CellValue; onChange: (v: CellValue) => void }) {
  const cls = 'flex-1 min-w-0 text-xs bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none';
  const members = useServerBase((s) => s.members);
  if (field.type === 'person') {
    // person cells store a member's userId — pick, don't type.
    return (
      <select value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)} className={cls}>
        <option value="">—</option>
        {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
      </select>
    );
  }
  if (field.type === 'select') {
    return <select value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)} className={cls}><option value="">—</option>{field.options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
  }
  if (field.type === 'multiSelect') {
    const arr = Array.isArray(value) ? value : [];
    return (
      <div className="flex-1 flex flex-wrap gap-1">
        {field.options?.map((o) => {
          const on = arr.includes(o.id);
          const c = SELECT_COLORS[o.color] ?? SELECT_COLORS.gray;
          return <button key={o.id} onClick={() => onChange(on ? arr.filter((x) => x !== o.id) : [...arr, o.id])} className={`text-[10px] px-1.5 py-0.5 rounded-full cursor-pointer ${on ? `${c.bg} ${c.text}` : 'bg-gray-100 dark:bg-gray-700 text-gray-400'}`}>{o.name}</button>;
        })}
      </div>
    );
  }
  if (field.type === 'date') {
    const s = value ? new Date(Number(value)).toISOString().slice(0, 10) : '';
    return <input type="date" value={s} onChange={(e) => { const [y, m, d] = e.target.value.split('-').map(Number); onChange(e.target.value ? new Date(y, m - 1, d, 10).getTime() : null); }} className={cls} />;
  }
  if (field.type === 'number' || field.type === 'currency' || field.type === 'rating') {
    return <input type="number" value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} className={cls} />;
  }
  return <input type="text" value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value)} className={cls} />;
}

function SortEditor({ fields, sorts, onChange }: { fields: Field[]; sorts: SortRule[]; onChange: (s: SortRule[]) => void }) {
  const add = () => onChange([...sorts, { id: uid('srt'), fieldId: fields[0].id, direction: 'asc' }]);
  const patch = (id: string, p: Partial<SortRule>) => onChange(sorts.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const remove = (id: string) => onChange(sorts.filter((s) => s.id !== id));
  return (
    <div>
      {sorts.length === 0 && <p className="text-xs text-gray-400 mb-2">Belum ada urutan.</p>}
      <div className="space-y-1.5">
        {sorts.map((s) => (
          <div key={s.id} className="flex items-center gap-1">
            <select value={s.fieldId} onChange={(e) => patch(s.id, { fieldId: e.target.value })} className="flex-1 text-xs bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none">
              {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <select value={s.direction} onChange={(e) => patch(s.id, { direction: e.target.value as 'asc' | 'desc' })} className="text-xs bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none">
              <option value="asc">A→Z / naik</option>
              <option value="desc">Z→A / turun</option>
            </select>
            <button onClick={() => remove(s.id)} aria-label="Hapus urutan" className="text-gray-300 hover:text-red-500 cursor-pointer"><X size={14} /></button>
          </div>
        ))}
      </div>
      <button onClick={add} className="mt-2 inline-flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800 cursor-pointer"><PlusLg size={11} /> Tambah urutan</button>
    </div>
  );
}
