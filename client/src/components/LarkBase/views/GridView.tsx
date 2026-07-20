import { useMemo, useRef, useState } from 'react';
import { ThreeDotsVertical, PlusLg, Trash, ChevronDown, ChevronRight, ArrowsExpand, ChatDots } from 'react-bootstrap-icons';
import { canEditField } from '@virtualmeet/shared';
import { ViewProps } from './shared';
import { BaseRecord, RowHeight, fieldMeta, formatNumber, formatCurrency } from '../types';
import { Cell } from '../components/Cell';
import { FieldMenu } from '../components/FieldMenu';
import { groupRecords } from '../filters';

const ROW_MIN_H: Record<RowHeight, number> = { short: 34, medium: 56, tall: 96 };

export function GridView({ table, view, fields, visibleFields, rows, m, canEdit, myRole, members, commentCounts, openRecord, onCursor }: ViewProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuFieldId, setMenuFieldId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rowHeight = view.rowHeight ?? 'short';
  const minH = ROW_MIN_H[rowHeight];

  const groupField = view.groupBy ? fields.find((f) => f.id === view.groupBy) : undefined;
  const groups = useMemo(() => (groupField ? groupRecords(rows, groupField) : null), [rows, groupField]);

  const rowIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const selectedHere = useMemo(() => new Set([...selected].filter((id) => rowIds.has(id))), [selected, rowIds]);

  const toggleRow = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allChecked = rows.length > 0 && rows.every((r) => selectedHere.has(r.id));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)));
  const bulkDelete = () => { m.deleteRecords(selectedHere); setSelected(new Set()); };

  const totalWidth = 44 + visibleFields.reduce((s, f) => s + f.width, 0) + 44;

  const sums = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of visibleFields) {
      if (!fieldMeta(f.type).isNumeric || f.type === 'formula') continue;
      out[f.id] = rows.reduce((s, r) => { const v = r.cells[f.id]; const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return s + (Number.isFinite(n) ? n : 0); }, 0);
    }
    return out;
  }, [visibleFields, rows]);

  const renderRow = (rec: BaseRecord, index: number) => (
    <div key={rec.id} className="flex border-b border-gray-100 dark:border-gray-700/60 group hover:bg-purple-50/30 dark:hover:bg-gray-700/20" style={{ minHeight: minH }}>
      <div className="sticky left-0 z-10 w-11 shrink-0 flex items-center justify-center bg-white dark:bg-gray-800 group-hover:bg-purple-50/30 dark:group-hover:bg-gray-700/20 border-r border-gray-100 dark:border-gray-700/60">
        <span className={`text-xs text-gray-400 ${canEdit && selectedHere.has(rec.id) ? 'hidden' : canEdit ? 'group-hover:hidden' : ''}`}>{index + 1}</span>
        {canEdit && <input type="checkbox" checked={selectedHere.has(rec.id)} onChange={() => toggleRow(rec.id)} aria-label={`Pilih baris ${index + 1}`} className={`w-3.5 h-3.5 accent-purple-600 cursor-pointer ${selectedHere.has(rec.id) ? '' : 'hidden group-hover:block'}`} />}
      </div>
      {visibleFields.map((f, ci) => (
        <div key={f.id} className="shrink-0 border-r border-gray-100 dark:border-gray-700/60 relative" style={{ width: f.width }} onFocus={() => onCursor?.(rec.id, f.id)}>
          <Cell field={f} fields={fields} value={rec.cells[f.id]} record={rec} rowHeight={rowHeight} readOnly={!canEdit || !canEditField(f.access, myRole)} members={members} onChange={(v) => m.setCell(rec.id, f.id, v)} onAddOption={(name) => m.addOption(f.id, name)} />
          {ci === 0 && (
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {!!commentCounts?.[rec.id] && (
                <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-400" title={`${commentCounts[rec.id]} komentar`}><ChatDots size={10} /> {commentCounts[rec.id]}</span>
              )}
              <button onClick={() => openRecord(rec.id)} title="Buka detail" aria-label="Buka detail baris" className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-purple-600 cursor-pointer bg-white dark:bg-gray-800 rounded p-0.5">
                <ArrowsExpand size={12} />
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="w-11 shrink-0" />
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {canEdit && selectedHere.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-1.5 bg-purple-600 text-white text-xs shrink-0">
          <span>{selectedHere.size} baris dipilih</span>
          <button onClick={bulkDelete} className="inline-flex items-center gap-1 bg-white/20 hover:bg-white/30 px-2 py-1 rounded cursor-pointer"><Trash size={12} /> Hapus</button>
          <button onClick={() => setSelected(new Set())} className="hover:underline cursor-pointer">Batal</button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <div style={{ width: totalWidth, minWidth: '100%' }}>
          {/* Header */}
          <div className="flex sticky top-0 z-20 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
            <div className="sticky left-0 z-30 w-11 shrink-0 flex items-center justify-center bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700">
              {canEdit && <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Pilih semua" className="w-3.5 h-3.5 accent-purple-600 cursor-pointer" />}
            </div>
            {visibleFields.map((f) => (
              <div key={f.id} className="shrink-0 relative border-r border-gray-200 dark:border-gray-700 group/h" style={{ width: f.width }}>
                <button onClick={() => canEdit && setMenuFieldId(menuFieldId === f.id ? null : f.id)} className={`w-full flex items-center gap-1 px-2 py-1.5 text-left ${canEdit ? 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'cursor-default'}`}>
                  <span className="w-4 text-gray-400 text-[10px] shrink-0">{fieldMeta(f.type).icon}</span>
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-300 truncate flex-1">{f.name}</span>
                  {canEdit && <ThreeDotsVertical size={12} className="text-gray-400 opacity-0 group-hover/h:opacity-100" />}
                </button>
                {canEdit && menuFieldId === f.id && (
                  <FieldMenu
                    field={f}
                    onApply={(patch) => m.changeFieldType(f, patch)}
                    onInsertLeft={() => m.insertField(table.fields.findIndex((x) => x.id === f.id), 'text')}
                    onInsertRight={() => m.insertField(table.fields.findIndex((x) => x.id === f.id) + 1, 'text')}
                    onDelete={() => m.deleteField(f.id)}
                    onClose={() => setMenuFieldId(null)}
                  />
                )}
                {canEdit && <ResizeHandle width={f.width} onResize={(w) => m.setFieldWidth(f.id, w)} />}
              </div>
            ))}
            <div className="w-11 shrink-0 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              {canEdit && <button onClick={() => m.insertField(table.fields.length, 'text')} title="Tambah kolom" aria-label="Tambah kolom" className="text-gray-400 hover:text-purple-600 cursor-pointer"><PlusLg size={14} /></button>}
            </div>
          </div>

          {/* Body */}
          {groups
            ? groups.map((g) => (
                <div key={g.key}>
                  <button onClick={() => setCollapsed((s) => { const n = new Set(s); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })} className="sticky left-0 flex items-center gap-2 px-3 py-1.5 bg-gray-100/80 dark:bg-gray-900/80 border-b border-gray-200 dark:border-gray-700 text-xs font-medium text-gray-600 dark:text-gray-300 w-full cursor-pointer">
                    {collapsed.has(g.key) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <span>{g.label}</span>
                    <span className="text-gray-400">({g.records.length})</span>
                  </button>
                  {!collapsed.has(g.key) && g.records.map((rec, i) => renderRow(rec, i))}
                </div>
              ))
            : rows.map((rec, i) => renderRow(rec, i))}

          {canEdit && (
            <button onClick={() => m.addRecord()} className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400 hover:text-purple-600 hover:bg-purple-50/30 dark:hover:bg-gray-700/20 w-full sticky left-0 cursor-pointer border-b border-gray-100 dark:border-gray-700/60">
              <PlusLg size={12} /> Tambah baris
            </button>
          )}

          {Object.keys(sums).length > 0 && (
            <div className="flex sticky bottom-0 z-10 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700">
              <div className="sticky left-0 z-10 w-11 shrink-0 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700" />
              {visibleFields.map((f) => (
                <div key={f.id} className="shrink-0 border-r border-gray-100 dark:border-gray-700/60 px-2 py-1 text-right text-xs text-gray-500 dark:text-gray-400" style={{ width: f.width }}>
                  {sums[f.id] != null ? (<><span className="text-gray-400 mr-1">Σ</span>{f.type === 'currency' ? formatCurrency(sums[f.id]) : formatNumber(sums[f.id])}</>) : ''}
                </div>
              ))}
              <div className="w-11 shrink-0 bg-gray-50 dark:bg-gray-900" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResizeHandle({ width, onResize }: { width: number; onResize: (w: number) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      role="separator"
      aria-label="Ubah lebar kolom"
      onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); start.current = { x: e.clientX, w: width }; }}
      onPointerMove={(e) => { if (start.current) onResize(start.current.w + (e.clientX - start.current.x)); }}
      onPointerUp={() => { start.current = null; }}
      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-purple-400/50 z-10"
    />
  );
}
