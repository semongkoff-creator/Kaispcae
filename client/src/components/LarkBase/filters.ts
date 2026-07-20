// Filter → search → sort → group pipeline. Pure functions; the view layer
// wraps these in useMemo so the whole pipeline only recomputes when its
// inputs change (not on every cell render).

import { Field, BaseRecord, FilterCondition, FilterOperator, SortRule, CellValue } from './types';
import { fieldFormulaValue, FormulaValue } from './formula';

interface OpDef { op: FilterOperator; label: string }

// Operators offered per field type (drives the Filter UI). Order = menu order.
export function operatorsForField(type: Field['type']): OpDef[] {
  switch (type) {
    case 'text': case 'longText': case 'url':
      return [
        { op: 'contains', label: 'berisi' }, { op: 'notContains', label: 'tidak berisi' },
        { op: 'is', label: 'sama dengan' }, { op: 'isNot', label: 'tidak sama dengan' },
        { op: 'isEmpty', label: 'kosong' }, { op: 'isNotEmpty', label: 'tidak kosong' },
      ];
    case 'person':
      // 'adalah saya' is what makes one shared "Tugasku" view work per-person.
      return [
        { op: 'isCurrentUser', label: 'adalah saya' },
        { op: 'is', label: 'adalah' }, { op: 'isNot', label: 'bukan' },
        { op: 'isEmpty', label: 'kosong' }, { op: 'isNotEmpty', label: 'tidak kosong' },
      ];
    case 'number': case 'currency': case 'rating':
      return [
        { op: 'is', label: '=' }, { op: 'isNot', label: '≠' },
        { op: 'gt', label: '>' }, { op: 'gte', label: '≥' }, { op: 'lt', label: '<' }, { op: 'lte', label: '≤' },
        { op: 'isEmpty', label: 'kosong' }, { op: 'isNotEmpty', label: 'tidak kosong' },
      ];
    case 'select':
      return [
        { op: 'is', label: 'adalah' }, { op: 'isNot', label: 'bukan' },
        { op: 'isEmpty', label: 'kosong' }, { op: 'isNotEmpty', label: 'tidak kosong' },
      ];
    case 'multiSelect':
      return [
        { op: 'hasAny', label: 'punya salah satu' }, { op: 'hasAll', label: 'punya semua' },
        { op: 'isEmpty', label: 'kosong' }, { op: 'isNotEmpty', label: 'tidak kosong' },
      ];
    case 'date':
      return [
        { op: 'is', label: 'pada' }, { op: 'isBefore', label: 'sebelum' }, { op: 'isAfter', label: 'sesudah' },
        { op: 'isEmpty', label: 'kosong' }, { op: 'isNotEmpty', label: 'tidak kosong' },
      ];
    case 'checkbox':
      return [{ op: 'isChecked', label: 'dicentang' }, { op: 'isUnchecked', label: 'tidak dicentang' }];
    case 'formula':
      return [
        { op: 'contains', label: 'berisi' }, { op: 'is', label: '=' },
        { op: 'gt', label: '>' }, { op: 'lt', label: '<' },
        { op: 'isEmpty', label: 'kosong' }, { op: 'isNotEmpty', label: 'tidak kosong' },
      ];
    default:
      return [{ op: 'isEmpty', label: 'kosong' }, { op: 'isNotEmpty', label: 'tidak kosong' }];
  }
}

// Operators that take NO value input.
export function opNeedsValue(op: FilterOperator): boolean {
  return !['isEmpty', 'isNotEmpty', 'isChecked', 'isUnchecked', 'isCurrentUser'].includes(op);
}

function isBlank(v: CellValue): boolean {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

const num = (v: FormulaValue | CellValue): number => {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const str = (v: FormulaValue | CellValue): string => (v == null ? '' : String(v)).toLowerCase();

// Evaluate one filter condition against one record. Formula fields compare on
// their computed value.
export function evalCondition(cond: FilterCondition, field: Field, fields: Field[], record: BaseRecord, currentUserId?: string): boolean {
  const rawCell = record.cells[field.id];
  const computed: FormulaValue | CellValue = field.type === 'formula' ? fieldFormulaValue(field, record, fields) : rawCell;

  switch (cond.operator) {
    case 'isCurrentUser': return !!currentUserId && rawCell === currentUserId;
    case 'isEmpty': return field.type === 'formula' ? isBlank(computed as CellValue) : isBlank(rawCell);
    case 'isNotEmpty': return field.type === 'formula' ? !isBlank(computed as CellValue) : !isBlank(rawCell);
    case 'isChecked': return rawCell === true;
    case 'isUnchecked': return rawCell !== true;
    case 'contains': return str(computed).includes(str(cond.value));
    case 'notContains': return !str(computed).includes(str(cond.value));
    case 'is':
      if (field.type === 'number' || field.type === 'currency' || field.type === 'rating') return num(computed) === num(cond.value);
      if (field.type === 'date') return sameDay(num(rawCell), num(cond.value));
      return String(rawCell ?? '') === String(cond.value ?? '');
    case 'isNot':
      if (field.type === 'number' || field.type === 'currency' || field.type === 'rating') return num(computed) !== num(cond.value);
      return String(rawCell ?? '') !== String(cond.value ?? '');
    case 'gt': return num(computed) > num(cond.value);
    case 'gte': return num(computed) >= num(cond.value);
    case 'lt': return num(computed) < num(cond.value);
    case 'lte': return num(computed) <= num(cond.value);
    case 'hasAny': {
      const have = Array.isArray(rawCell) ? rawCell : [];
      const want = Array.isArray(cond.value) ? cond.value : cond.value != null ? [cond.value] : [];
      return want.length === 0 ? true : want.some((w) => have.includes(w as string));
    }
    case 'hasAll': {
      const have = Array.isArray(rawCell) ? rawCell : [];
      const want = Array.isArray(cond.value) ? cond.value : cond.value != null ? [cond.value] : [];
      return want.every((w) => have.includes(w as string));
    }
    case 'isBefore': return num(rawCell) < num(cond.value);
    case 'isAfter': return num(rawCell) > num(cond.value);
    default: return true;
  }
}

function sameDay(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const da = new Date(a); const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

// Comparable value for sorting/grouping.
export function sortValue(field: Field, record: BaseRecord, fields: Field[]): number | string {
  const raw = record.cells[field.id];
  switch (field.type) {
    case 'number': case 'currency': case 'rating': { const n = num(raw); return Number.isFinite(n) ? n : -Infinity; }
    case 'date': { const n = num(raw); return Number.isFinite(n) && !isBlank(raw) ? n : -Infinity; }
    case 'checkbox': return raw === true ? 1 : 0;
    case 'select': { const i = field.options?.findIndex((o) => o.id === raw) ?? -1; return i < 0 ? Infinity : i; }
    case 'multiSelect': { const first = Array.isArray(raw) ? raw[0] : undefined; const i = field.options?.findIndex((o) => o.id === first) ?? -1; return i < 0 ? Infinity : i; }
    case 'formula': { const v = fieldFormulaValue(field, record, fields); return typeof v === 'number' ? v : String(v).toLowerCase(); }
    default: return String(raw ?? '').toLowerCase();
  }
}

export function applyPipeline(
  records: BaseRecord[],
  fields: Field[],
  filters: FilterCondition[],
  sorts: SortRule[],
  search: string,
  searchFields: Field[] = fields,
  currentUserId?: string,
): BaseRecord[] {
  const byId = new Map(fields.map((f) => [f.id, f]));

  // 1) filters (all conditions must pass; a condition on a since-deleted field is skipped)
  let out = records.filter((rec) =>
    filters.every((c) => {
      const f = byId.get(c.fieldId);
      return f ? evalCondition(c, f, fields, rec, currentUserId) : true;
    }),
  );

  // 2) global search across visible fields (caller passes only visible fields)
  const q = search.trim().toLowerCase();
  if (q) {
    out = out.filter((rec) =>
      searchFields.some((f) => {
        const v = f.type === 'formula' ? fieldFormulaValue(f, rec, fields) : rec.cells[f.id];
        if (v == null) return false;
        if (Array.isArray(v)) {
          return v.some((id) => (f.options?.find((o) => o.id === id)?.name ?? '').toLowerCase().includes(q));
        }
        if (f.type === 'select') return (f.options?.find((o) => o.id === v)?.name ?? '').toLowerCase().includes(q);
        return String(v).toLowerCase().includes(q);
      }),
    );
  }

  // 3) sort (multi-level, stable)
  if (sorts.length) {
    const activeSorts = sorts.filter((s) => byId.has(s.fieldId));
    out = out
      .map((rec, i) => ({ rec, i }))
      .sort((a, b) => {
        for (const s of activeSorts) {
          const f = byId.get(s.fieldId)!;
          const va = sortValue(f, a.rec, fields);
          const vb = sortValue(f, b.rec, fields);
          let cmp = 0;
          if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
          else cmp = String(va).localeCompare(String(vb), 'id');
          if (cmp !== 0) return s.direction === 'asc' ? cmp : -cmp;
        }
        return a.i - b.i; // stable
      })
      .map((x) => x.rec);
  }

  return out;
}

export interface Group { key: string; label: string; color?: string; records: BaseRecord[] }

// Group already-filtered/sorted records by a field. Preserves select-option
// order; everything without a value falls into a trailing "Belum diisi".
export function groupRecords(records: BaseRecord[], field: Field): Group[] {
  const groups = new Map<string, Group>();
  const emptyKey = '__empty__';

  const ensure = (key: string, label: string, color?: string) => {
    if (!groups.has(key)) groups.set(key, { key, label, color, records: [] });
    return groups.get(key)!;
  };

  // Pre-seed select groups in option order so empty groups still show a header.
  if (field.type === 'select' && field.options) {
    for (const o of field.options) ensure(o.id, o.name, o.color);
  }

  for (const rec of records) {
    const raw = rec.cells[field.id];
    if (field.type === 'select') {
      const o = field.options?.find((op) => op.id === raw);
      if (o) ensure(o.id, o.name, o.color).records.push(rec);
      else ensure(emptyKey, 'Belum diisi').records.push(rec);
    } else if (field.type === 'multiSelect') {
      const ids = Array.isArray(raw) ? raw : [];
      if (ids.length === 0) ensure(emptyKey, 'Belum diisi').records.push(rec);
      else for (const id of ids) { const o = field.options?.find((op) => op.id === id); ensure(o?.id ?? emptyKey, o?.name ?? 'Belum diisi', o?.color).records.push(rec); }
    } else if (field.type === 'checkbox') {
      const on = raw === true;
      ensure(on ? '1' : '0', on ? 'Dicentang' : 'Tidak dicentang').records.push(rec);
    } else {
      const label = raw == null || raw === '' ? 'Belum diisi' : String(raw);
      ensure(label === 'Belum diisi' ? emptyKey : label, label).records.push(rec);
    }
  }

  // Move the empty group to the end, drop pre-seeded empties.
  const arr = Array.from(groups.values()).filter((g) => g.records.length > 0 || (field.type === 'select' && g.key !== emptyKey));
  arr.sort((a, b) => (a.key === emptyKey ? 1 : b.key === emptyKey ? -1 : 0));
  return arr;
}
