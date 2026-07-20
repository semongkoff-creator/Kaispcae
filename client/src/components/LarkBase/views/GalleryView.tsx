import { PlusLg } from 'react-bootstrap-icons';
import { ViewProps } from './shared';
import { BaseRecord, Field, SELECT_COLORS, formatCurrency, formatNumber, formatDate } from '../types';
import { computeFormula, formulaDisplay } from '../formula';

export function GalleryView({ fields, visibleFields, rows, m, canEdit, openRecord }: ViewProps) {
  const titleField = visibleFields[0];
  const detailFields = visibleFields.slice(1);

  return (
    <div className="p-4 overflow-y-auto h-full">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {rows.map((rec) => (
          <button
            key={rec.id}
            onClick={() => openRecord(rec.id)}
            className="text-left bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm p-3 hover:border-purple-300 hover:shadow-md transition-all cursor-pointer focus:ring-2 focus:ring-purple-500 outline-none"
          >
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate mb-2">
              {titleField ? String(rec.cells[titleField.id] ?? '') || 'Tanpa judul' : 'Tanpa judul'}
            </p>
            <div className="space-y-1.5">
              {detailFields.slice(0, 6).map((f) => (
                <div key={f.id} className="flex items-start gap-1.5 text-[11px]">
                  <span className="text-gray-400 shrink-0 w-20 truncate">{f.name}</span>
                  <span className="text-gray-600 dark:text-gray-300 min-w-0"><CellPreview rec={rec} field={f} fields={fields} /></span>
                </div>
              ))}
            </div>
          </button>
        ))}
      </div>
      {canEdit && (
        <button onClick={() => m.addRecord()} className="mt-3 inline-flex items-center gap-1.5 text-xs text-purple-600 hover:text-purple-800 cursor-pointer">
          <PlusLg size={12} /> Tambah kartu
        </button>
      )}
    </div>
  );
}

function CellPreview({ rec, field, fields }: { rec: BaseRecord; field: Field; fields: Field[] }) {
  const v = rec.cells[field.id];
  if (field.type === 'select') { const o = field.options?.find((op) => op.id === v); if (!o) return <span className="text-gray-300">—</span>; const c = SELECT_COLORS[o.color] ?? SELECT_COLORS.gray; return <span className={`inline-flex rounded-full px-1.5 py-0.5 ${c.bg} ${c.text}`}>{o.name}</span>; }
  if (field.type === 'multiSelect') { const ids = Array.isArray(v) ? v : []; if (!ids.length) return <span className="text-gray-300">—</span>; return <span className="flex flex-wrap gap-1">{ids.map((id) => { const o = field.options?.find((op) => op.id === id); if (!o) return null; const c = SELECT_COLORS[o.color] ?? SELECT_COLORS.gray; return <span key={id} className={`inline-flex rounded-full px-1.5 py-0.5 ${c.bg} ${c.text}`}>{o.name}</span>; })}</span>; }
  if (field.type === 'checkbox') return <span>{v === true ? '✓ Ya' : '—'}</span>;
  if (field.type === 'rating') return <span className="text-amber-400">{typeof v === 'number' && v > 0 ? '★'.repeat(v) : '—'}</span>;
  if (field.type === 'currency') return <span>{v == null || v === '' ? '—' : formatCurrency(v)}</span>;
  if (field.type === 'number') return <span>{v == null || v === '' ? '—' : formatNumber(v)}</span>;
  if (field.type === 'date') return <span>{v ? formatDate(v) : '—'}</span>;
  if (field.type === 'url') return v ? <a href={String(v)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-purple-600 dark:text-purple-400 hover:underline truncate inline-block max-w-full">{String(v)}</a> : <span className="text-gray-300">—</span>;
  if (field.type === 'formula') { const out = formulaDisplay(computeFormula(field, rec, fields)); return <span className={out === '#ERR' ? 'text-red-500' : ''}>{out || '—'}</span>; }
  return <span className="truncate inline-block max-w-full">{v == null || v === '' ? '—' : String(v)}</span>;
}
