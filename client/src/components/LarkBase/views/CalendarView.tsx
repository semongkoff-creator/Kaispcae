import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'react-bootstrap-icons';
import { ViewProps } from './shared';
import { BaseRecord } from '../types';

const WEEKDAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const monthFmt = new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' });

function startOfDay(ts: number): number { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function sameYMD(a: Date, b: Date): boolean { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

export function CalendarView({ fields, visibleFields, rows, m, canEdit, openRecord, patchView, view }: ViewProps) {
  const now = new Date();
  const [cursor, setCursor] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));

  const dateField = fields.find((f) => f.id === view.dateField && f.type === 'date');
  const dateFields = fields.filter((f) => f.type === 'date');
  const titleFieldId = visibleFields[0]?.id;

  // 6-week (42-cell) grid, Monday-start.
  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7; // Mon=0
    const startDate = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    const byDay = new Map<number, BaseRecord[]>();
    if (dateField) {
      for (const r of rows) {
        const v = r.cells[dateField.id];
        if (v == null || v === '') continue;
        const key = startOfDay(Number(v));
        if (!Number.isFinite(key)) continue;
        (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(r);
      }
    }
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
      return { date: d, inMonth: d.getMonth() === cursor.getMonth(), records: byDay.get(startOfDay(d.getTime())) ?? [] };
    });
  }, [cursor, rows, dateField]);

  if (!dateField) {
    return (
      <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
        <p className="mb-2">Kalender perlu satu kolom bertipe <b>Tanggal</b>.</p>
        {dateFields.length > 0 ? (
          <select onChange={(e) => patchView({ dateField: e.target.value })} defaultValue="" className="bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 outline-none">
            <option value="" disabled>Pilih kolom…</option>
            {dateFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        ) : <p className="text-gray-400">Buat kolom Tanggal dulu di tampilan Grid.</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 shrink-0">
        <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} aria-label="Bulan sebelumnya" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 cursor-pointer"><ChevronLeft size={16} /></button>
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 min-w-[9rem] text-center capitalize">{monthFmt.format(cursor)}</span>
        <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} aria-label="Bulan berikutnya" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 cursor-pointer"><ChevronRight size={16} /></button>
        <button onClick={() => setCursor(new Date(now.getFullYear(), now.getMonth(), 1))} className="text-xs px-2 py-1 rounded-lg border border-purple-200 dark:border-gray-600 text-purple-600 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer">Hari ini</button>
      </div>

      <div className="grid grid-cols-7 border-t border-l border-gray-100 dark:border-gray-700 shrink-0">
        {WEEKDAYS.map((w) => <div key={w} className="text-[11px] font-medium text-gray-400 text-center py-1 border-r border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">{w}</div>)}
      </div>

      <div className="flex-1 grid grid-cols-7 grid-rows-6 border-l border-gray-100 dark:border-gray-700 overflow-y-auto">
        {cells.map((cell, i) => {
          const isToday = sameYMD(cell.date, now);
          const shown = cell.records.slice(0, 3);
          const extra = cell.records.length - shown.length;
          return (
            <div key={i} className={`border-r border-b border-gray-100 dark:border-gray-700 p-1 min-h-[84px] flex flex-col gap-1 ${cell.inMonth ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/60 dark:bg-gray-900/40'}`}>
              <div className="flex items-center justify-between">
                <span className={`text-[11px] w-5 h-5 flex items-center justify-center rounded-full ${isToday ? 'bg-purple-600 text-white font-bold' : cell.inMonth ? 'text-gray-500 dark:text-gray-400' : 'text-gray-300 dark:text-gray-600'}`}>{cell.date.getDate()}</span>
                {canEdit && <button onClick={() => m.addRecord({ [dateField.id]: new Date(cell.date.getFullYear(), cell.date.getMonth(), cell.date.getDate(), 10).getTime() })} aria-label="Tambah pada tanggal ini" className="text-gray-300 hover:text-purple-600 text-xs opacity-0 hover:opacity-100 cursor-pointer">+</button>}
              </div>
              {shown.map((rec) => (
                <button key={rec.id} onClick={() => openRecord(rec.id)} className="text-left text-[11px] bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-200 rounded px-1.5 py-0.5 truncate hover:bg-purple-200 dark:hover:bg-purple-900/60 cursor-pointer">
                  {titleFieldId ? String(rec.cells[titleFieldId] ?? '') || 'Tanpa judul' : 'Tanpa judul'}
                </button>
              ))}
              {extra > 0 && <span className="text-[10px] text-gray-400 px-1">+{extra} lagi</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
