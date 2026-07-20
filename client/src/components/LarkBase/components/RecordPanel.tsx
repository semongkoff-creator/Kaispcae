import { X, Trash } from 'react-bootstrap-icons';
import { canEditField } from '@virtualmeet/shared';
import { Table, CellValue, fieldMeta } from '../types';
import { Cell } from './Cell';
import { ViewMutations } from '../views/shared';
import { Comments } from '../collab/Comments';
import { RecordHistory } from '../collab/RecordHistory';
import { useServerBase } from '../serverStore';

interface RecordPanelProps {
  table: Table;
  recordId: string;
  m: ViewMutations;
  canEdit: boolean;
  onClose: () => void;
}

export function RecordPanel({ table, recordId, m, canEdit, onClose }: RecordPanelProps) {
  const members = useServerBase((s) => s.members);
  const myRole = useServerBase((s) => s.myRole);
  const record = table.records.find((r) => r.id === recordId);
  const titleField = table.fields[0];
  const nameOf = (id?: string) => (id ? members.find((mm) => mm.userId === id)?.name ?? 'seseorang' : '—');
  const fmtDate = (ms?: number) => (ms ? new Date(ms).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

  return (
    <div className="fixed inset-0 z-[70] flex justify-end" role="dialog" aria-modal="true" aria-label="Detail baris">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white dark:bg-gray-900 h-full shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
            {record && titleField ? String(record.cells[titleField.id] ?? '') || 'Detail baris' : 'Detail baris'}
          </h3>
          <button onClick={onClose} aria-label="Tutup" className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 cursor-pointer"><X size={18} /></button>
        </div>

        {!record ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Baris tidak ditemukan.</div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {table.fields.map((f) => (
                <div key={f.id}>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-gray-400 mb-1">
                    <span className="w-4 text-center">{fieldMeta(f.type).icon}</span>{f.name}
                    {fieldMeta(f.type).readOnly && <span className="text-[10px] text-gray-300">(otomatis)</span>}
                  </label>
                  <div className="rounded-lg">
                    <Cell
                      field={f}
                      fields={table.fields}
                      value={record.cells[f.id]}
                      record={record}
                      mode="panel"
                      readOnly={!canEdit || !canEditField(f.access, myRole ?? undefined)}
                      members={members}
                      onChange={(v: CellValue) => m.setCell(record.id, f.id, v)}
                      onAddOption={(name) => m.addOption(f.id, name)}
                    />
                  </div>
                </div>
              ))}

              {/* System fields (read-only) */}
              <div className="border-t border-gray-100 dark:border-gray-700 pt-2 text-[11px] text-gray-400 space-y-0.5">
                <p>Dibuat oleh <span className="text-gray-500 dark:text-gray-300">{nameOf(record.createdById)}</span> · {fmtDate(record.createdAt)}</p>
                <p>Diubah terakhir oleh <span className="text-gray-500 dark:text-gray-300">{nameOf(record.updatedById)}</span> · {fmtDate(record.updatedAt)}</p>
              </div>

              <RecordHistory recordId={record.id} fields={table.fields} cellsVersion={JSON.stringify(record.cells)} canEdit={canEdit} onRevert={(fieldId, value) => m.setCell(record.id, fieldId, value)} />
              <Comments recordId={record.id} />
            </div>
            {canEdit && (
              <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-700 shrink-0">
                <button
                  onClick={() => { if (window.confirm('Hapus baris ini?')) { m.deleteRecords(new Set([record.id])); onClose(); } }}
                  className="inline-flex items-center gap-1.5 text-sm text-red-600 hover:text-red-700 cursor-pointer"
                >
                  <Trash size={14} /> Hapus baris
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
