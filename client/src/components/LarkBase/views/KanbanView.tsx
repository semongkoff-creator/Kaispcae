import { useMemo, useState } from 'react';
import { PlusLg, ChatDots } from 'react-bootstrap-icons';
import { ViewProps } from './shared';
import { BaseRecord, SELECT_COLORS, formatCurrency, formatNumber, formatDate } from '../types';
import { computeFormula, formulaDisplay } from '../formula';

export function KanbanView({ view, fields, visibleFields, rows, m, canEdit, commentCounts, openRecord, patchView }: ViewProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);

  const stackField = fields.find((f) => f.id === view.stackField && f.type === 'select');
  const selectFields = fields.filter((f) => f.type === 'select');

  const columns = useMemo(() => {
    if (!stackField) return [];
    const cols = (stackField.options ?? []).map((o) => ({ key: o.id, name: o.name, color: o.color, records: [] as BaseRecord[] }));
    const empty = { key: '__empty__', name: 'Belum diisi', color: 'gray', records: [] as BaseRecord[] };
    for (const r of rows) {
      const v = r.cells[stackField.id];
      const col = cols.find((c) => c.key === v);
      (col ?? empty).records.push(r);
    }
    return [...cols, empty];
  }, [stackField, rows]);

  if (!stackField) {
    return (
      <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
        <p className="mb-2">Kanban perlu satu kolom bertipe <b>Pilihan tunggal</b> untuk ditumpuk.</p>
        {selectFields.length > 0 ? (
          <select onChange={(e) => patchView({ stackField: e.target.value })} defaultValue="" className="bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 outline-none">
            <option value="" disabled>Pilih kolom…</option>
            {selectFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        ) : <p className="text-gray-400">Buat kolom Pilihan tunggal dulu di tampilan Grid.</p>}
      </div>
    );
  }

  const drop = (colKey: string) => {
    if (!dragId) return;
    const value = colKey === '__empty__' ? null : colKey;
    m.setCell(dragId, stackField.id, value);
    setDragId(null);
    setOverCol(null);
  };

  const previewFields = visibleFields.filter((f) => f.id !== stackField.id);

  return (
    <div className="flex gap-3 p-4 overflow-x-auto h-full items-start">
      {columns.map((col) => {
        const c = SELECT_COLORS[col.color] ?? SELECT_COLORS.gray;
        return (
          <div
            key={col.key}
            data-testid={`kanban-col-${col.key}`}
            onDragOver={(e) => { e.preventDefault(); setOverCol(col.key); }}
            onDrop={() => drop(col.key)}
            className={`w-64 shrink-0 rounded-xl p-2 ${overCol === col.key ? 'bg-purple-50 dark:bg-purple-900/20 ring-2 ring-purple-300' : 'bg-gray-50 dark:bg-gray-900/50'}`}
          >
            <div className="flex items-center gap-2 px-1 py-1.5 mb-1">
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${c.bg} ${c.text}`}>{col.name}</span>
              <span className="text-xs text-gray-400">{col.records.length}</span>
            </div>
            <div className="space-y-2">
              {col.records.map((rec) => (
                <div
                  key={rec.id}
                  draggable={canEdit}
                  onDragStart={() => canEdit && setDragId(rec.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null); }}
                  onClick={() => openRecord(rec.id)}
                  className={`bg-white dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700 shadow-sm p-2.5 hover:border-purple-300 ${canEdit ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${dragId === rec.id ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-start justify-between gap-1 mb-1">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{cardTitle(rec, previewFields[0]?.id) || 'Tanpa judul'}</p>
                    {!!commentCounts?.[rec.id] && <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-400 shrink-0"><ChatDots size={10} /> {commentCounts[rec.id]}</span>}
                  </div>
                  <div className="space-y-1">
                    {previewFields.slice(1, 5).map((f) => {
                      const disp = cellPreview(rec, f, fields);
                      if (!disp) return null;
                      return <div key={f.id} className="text-[11px] text-gray-500 dark:text-gray-400 truncate"><span className="text-gray-400">{f.name}:</span> {disp}</div>;
                    })}
                  </div>
                </div>
              ))}
              {canEdit && (
                <button onClick={() => m.addRecord({ [stackField.id]: col.key === '__empty__' ? null : col.key })} className="w-full flex items-center justify-center gap-1 py-1.5 text-xs text-gray-400 hover:text-purple-600 rounded-lg hover:bg-white/60 dark:hover:bg-gray-800/60 cursor-pointer">
                  <PlusLg size={11} /> Tambah
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function cardTitle(rec: BaseRecord, fieldId?: string): string {
  if (!fieldId) return '';
  const v = rec.cells[fieldId];
  return v == null ? '' : String(v);
}

function cellPreview(rec: BaseRecord, field: ViewProps['fields'][number], fields: ViewProps['fields']): string {
  const v = rec.cells[field.id];
  switch (field.type) {
    case 'formula': { const out = formulaDisplay(computeFormula(field, rec, fields)); return out; }
    case 'currency': return v == null || v === '' ? '' : formatCurrency(v);
    case 'number': return v == null || v === '' ? '' : formatNumber(v);
    case 'date': return v ? formatDate(v) : '';
    case 'checkbox': return v === true ? '✓' : '';
    case 'rating': return typeof v === 'number' && v > 0 ? '★'.repeat(v) : '';
    case 'select': return field.options?.find((o) => o.id === v)?.name ?? '';
    case 'multiSelect': return Array.isArray(v) ? v.map((id) => field.options?.find((o) => o.id === id)?.name ?? '').filter(Boolean).join(', ') : '';
    default: return v == null ? '' : String(v);
  }
}
