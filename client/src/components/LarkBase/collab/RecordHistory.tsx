import { useEffect, useState } from 'react';
import { ClockHistory, ArrowCounterclockwise, ChevronDown, ChevronRight } from 'react-bootstrap-icons';
import { Field, CellValue, formatCurrency, formatNumber, formatDate } from '../types';
import { baseApi, HistoryDto } from '../api';

// Per-record change log: who changed which field, old → new, when — with a
// per-entry "Kembalikan" (revert) that just dispatches a normal setCell to the
// old value (so it's permission-checked AND itself recorded). `cellsVersion`
// (a hash of the record's cells) refetches history whenever the record changes,
// local or remote.
export function RecordHistory({ recordId, fields, cellsVersion, canEdit, onRevert }: {
  recordId: string;
  fields: Field[];
  cellsVersion: string;
  canEdit: boolean;
  onRevert: (fieldId: string, value: CellValue) => void;
}) {
  const [history, setHistory] = useState<HistoryDto[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    baseApi.getHistory(recordId).then((r) => { if (!cancelled) setHistory(r.history); }).catch(() => {});
    return () => { cancelled = true; };
  }, [recordId, cellsVersion]);

  const fieldName = (id: string) => fields.find((f) => f.id === id)?.name ?? '(kolom dihapus)';

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 pt-3 mt-1">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 cursor-pointer">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <ClockHistory size={12} /> Riwayat {history.length ? `(${history.length})` : ''}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {history.length === 0 && <p className="text-xs text-gray-400">Belum ada perubahan.</p>}
          {history.map((h) => {
            const field = fields.find((f) => f.id === h.fieldId);
            return (
              <div key={h.id} className="text-[11px] group/h">
                <div className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
                  <span className="font-medium text-gray-700 dark:text-gray-200">{h.actorName}</span>
                  <span>mengubah</span>
                  <span className="font-medium">{fieldName(h.fieldId)}</span>
                  <span className="text-gray-400">· {new Date(h.createdAt).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 ml-1">
                  <span className="line-through text-gray-400">{display(field, h.oldValue)}</span>
                  <span className="text-gray-400">→</span>
                  <span className="text-gray-700 dark:text-gray-200">{display(field, h.newValue)}</span>
                  {canEdit && field && (
                    <button onClick={() => onRevert(h.fieldId, h.oldValue as CellValue)} title="Kembalikan nilai lama" className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-gray-400 hover:text-purple-600 opacity-0 group-hover/h:opacity-100 cursor-pointer">
                      <ArrowCounterclockwise size={11} /> Kembalikan
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Human-readable rendering of a stored history value for a given field.
function display(field: Field | undefined, value: unknown): string {
  if (value == null || value === '') return '(kosong)';
  if (!field) return String(value);
  switch (field.type) {
    case 'select': return field.options?.find((o) => o.id === value)?.name ?? String(value);
    case 'multiSelect': return Array.isArray(value) ? value.map((id) => field.options?.find((o) => o.id === id)?.name ?? '').filter(Boolean).join(', ') || '(kosong)' : String(value);
    case 'currency': return formatCurrency(value);
    case 'number': return formatNumber(value);
    case 'date': return formatDate(value);
    case 'checkbox': return value === true ? '✓' : '✗';
    case 'rating': return typeof value === 'number' ? '★'.repeat(value) : String(value);
    default: return String(value);
  }
}
