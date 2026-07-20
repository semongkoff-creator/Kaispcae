// CSV import/export. RFC-4180-ish quoting, UTF-8 BOM on export so Excel
// opens Indonesian text correctly. Formula fields export their COMPUTED value
// but are skipped on import (they're read-only / derived).

import { Table, Field, BaseRecord, CellValue, uid } from './types';
import { computeFormula, formulaDisplay } from './formula';

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
  return value;
}

// One field's value as a flat CSV string. Options export by NAME so a
// re-import can match them back; multiSelect joins names with "; ".
function cellToCsv(field: Field, record: BaseRecord, fields: Field[]): string {
  const v = record.cells[field.id];
  switch (field.type) {
    case 'formula': { const out = formulaDisplay(computeFormula(field, record, fields)); return out === '#ERR' ? '' : out; }
    case 'checkbox': return v === true ? 'true' : 'false';
    case 'date': return v == null || v === '' ? '' : new Date(Number(v)).toISOString();
    case 'select': return field.options?.find((o) => o.id === v)?.name ?? '';
    case 'multiSelect': return Array.isArray(v) ? v.map((id) => field.options?.find((o) => o.id === id)?.name ?? '').filter(Boolean).join('; ') : '';
    default: return v == null ? '' : String(v);
  }
}

// Export the rows AS CURRENTLY SHOWN (already filtered/searched/sorted) and
// only the visible fields — honouring the active view.
export function exportCsv(table: Table, visibleFields: Field[], rows: BaseRecord[], allFields: Field[]): void {
  const header = visibleFields.map((f) => escapeCsv(f.name)).join(',');
  const lines = rows.map((r) => visibleFields.map((f) => escapeCsv(cellToCsv(f, r, allFields))).join(','));
  const csv = '﻿' + [header, ...lines].join('\r\n'); // BOM + CRLF
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${table.name}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Minimal RFC-4180 parser: handles quoted fields, escaped quotes, CRLF/LF.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // strip BOM
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cur += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(cur); cur = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ''));
}

// Parse one CSV string value into the field's cell value on import.
function csvToCell(field: Field, raw: string): CellValue {
  const s = raw.trim();
  switch (field.type) {
    case 'number': case 'currency': case 'rating': { if (s === '') return null; const num = parseFloat(s.replace(/[^\d.-]/g, '')); return Number.isFinite(num) ? num : null; }
    case 'checkbox': return /^(true|ya|1|✓)$/i.test(s);
    case 'date': { if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
    case 'select': { const o = field.options?.find((op) => op.name.toLowerCase() === s.toLowerCase()); return o ? o.id : null; }
    case 'multiSelect': { const names = s.split(/[;,]/).map((x) => x.trim()).filter(Boolean); const ids = names.map((nm) => field.options?.find((op) => op.name.toLowerCase() === nm.toLowerCase())?.id).filter((x): x is string => !!x); return ids; }
    default: return s;
  }
}

// Server-backed import: parse a CSV into an array of cell-maps (one per data
// row), mapping headers→fields by name and skipping formula fields. The
// caller turns each into an addRecord op. Returns [] for an empty/invalid CSV.
export function parseImportedRecordCells(table: Table, text: string): Record<string, CellValue>[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0];
  const byName = new Map(table.fields.map((f) => [f.name.toLowerCase(), f] as const));
  const cols = headers.map((h) => { const f = byName.get(h.trim().toLowerCase()); return f && f.type !== 'formula' ? f : null; });
  return rows.slice(1).map((cells) => {
    const out: Record<string, CellValue> = {};
    cols.forEach((f, ci) => { if (f) out[f.id] = csvToCell(f, cells[ci] ?? ''); });
    return out;
  });
}

// Import: map CSV headers to existing fields by name (case-insensitive).
// Unmatched headers are ignored; formula fields are skipped. Returns a NEW
// table with the imported records APPENDED.
export function importCsv(table: Table, text: string): Table {
  const rows = parseCsv(text);
  if (rows.length < 2) return table;
  const headers = rows[0];
  const byName = new Map(table.fields.map((f) => [f.name.toLowerCase(), f] as const));
  // header index -> field (skip formula + unmatched)
  const cols = headers.map((h) => {
    const f = byName.get(h.trim().toLowerCase());
    return f && f.type !== 'formula' ? f : null;
  });

  const newRecords: BaseRecord[] = rows.slice(1).map((cells) => {
    const rec: BaseRecord = { id: uid('rec'), cells: {} };
    cols.forEach((f, ci) => { if (f) rec.cells[f.id] = csvToCell(f, cells[ci] ?? ''); });
    return rec;
  });

  return { ...table, records: [...table.records, ...newRecords] };
}
