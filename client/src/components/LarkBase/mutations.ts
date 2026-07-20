// Pure immutable table transforms, shared by every view + the record panel.
// Components call these inside useBaseStore().update(tableId, t => ...), so
// they take a Table and return a NEW Table (never mutate in place).

import { Table, Field, BaseRecord, CellValue, FieldType, View, SelectOption, uid, SELECT_COLOR_KEYS } from './types';

export function setCell(table: Table, recordId: string, fieldId: string, value: CellValue): Table {
  return {
    ...table,
    records: table.records.map((r) => (r.id === recordId ? { ...r, cells: { ...r.cells, [fieldId]: value } } : r)),
  };
}

export function addRecord(table: Table, seed: Record<string, CellValue> = {}): Table {
  return { ...table, records: [...table.records, { id: uid('rec'), cells: { ...seed } }] };
}

export function deleteRecords(table: Table, ids: Set<string>): Table {
  return { ...table, records: table.records.filter((r) => !ids.has(r.id)) };
}

export function addOption(table: Table, fieldId: string, name: string): { table: Table; optionId: string } {
  const optionId = uid('opt');
  const nextFields = table.fields.map((f) => {
    if (f.id !== fieldId) return f;
    const opts = f.options ?? [];
    const option: SelectOption = { id: optionId, name, color: SELECT_COLOR_KEYS[opts.length % SELECT_COLOR_KEYS.length] };
    return { ...f, options: [...opts, option] };
  });
  return { table: { ...table, fields: nextFields }, optionId };
}

export function applyFieldPatch(table: Table, fieldId: string, patch: Partial<Field>): Table {
  return { ...table, fields: table.fields.map((f) => (f.id === fieldId ? coerceOnTypeChange({ ...f, ...patch }, f, patch) : f)) };
}

// When a field's TYPE changes, existing cell values may no longer make sense.
// Rather than corrupt data, we clear cells for the changed field on a type
// switch (Lark does the same). Filters/sorts/groups that referenced it stay
// valid structurally — evalCondition just coerces — but see cleanupReferences
// which the store calls to drop now-nonsensical filter values if desired.
function coerceOnTypeChange(next: Field, prev: Field, patch: Partial<Field>): Field {
  if (patch.type && patch.type !== prev.type) {
    // keep options only if staying within select-family
    const choiceFamily = (t: FieldType) => t === 'select' || t === 'multiSelect';
    if (!(choiceFamily(prev.type) && choiceFamily(next.type))) {
      return { ...next, options: choiceFamily(next.type) ? next.options ?? [] : undefined };
    }
  }
  return next;
}

// Clears cells of a field when its type changed (called alongside the patch).
export function clearFieldCellsIfTypeChanged(table: Table, fieldId: string, prevType: FieldType, nextType: FieldType): Table {
  if (prevType === nextType) return table;
  const choiceFamily = (t: FieldType) => t === 'select' || t === 'multiSelect';
  // select<->multiSelect can partly carry over; everything else resets.
  return {
    ...table,
    records: table.records.map((r) => {
      const v = r.cells[fieldId];
      let nv: CellValue = null;
      if (choiceFamily(prevType) && choiceFamily(nextType)) {
        // single -> multi: wrap; multi -> single: take first
        if (prevType === 'select' && nextType === 'multiSelect') nv = v ? [v as string] : [];
        else if (prevType === 'multiSelect' && nextType === 'select') nv = Array.isArray(v) ? (v[0] ?? null) : null;
        else nv = v;
      }
      return { ...r, cells: { ...r.cells, [fieldId]: nv } };
    }),
  };
}

export function insertField(table: Table, atIndex: number, type: FieldType = 'text'): Table {
  const field: Field = { id: uid('fld'), name: 'Kolom baru', type, width: 160, options: type === 'select' || type === 'multiSelect' ? [] : undefined, formula: type === 'formula' ? '' : undefined };
  const fields = table.fields.slice();
  fields.splice(atIndex, 0, field);
  return { ...table, fields };
}

// Deleting a field ALSO scrubs every view's references to it (filters, sorts,
// groupBy, hidden, stackField, dateField) so nothing dangles — finish
// criteria #6.
export function deleteField(table: Table, fieldId: string): Table {
  if (table.fields.length <= 1) return table; // keep at least one column
  const views: View[] = table.views.map((v) => ({
    ...v,
    filters: v.filters.filter((f) => f.fieldId !== fieldId),
    sorts: v.sorts.filter((s) => s.fieldId !== fieldId),
    groupBy: v.groupBy === fieldId ? undefined : v.groupBy,
    hidden: v.hidden.filter((h) => h !== fieldId),
    stackField: v.stackField === fieldId ? undefined : v.stackField,
    dateField: v.dateField === fieldId ? undefined : v.dateField,
  }));
  return {
    ...table,
    fields: table.fields.filter((f) => f.id !== fieldId),
    records: table.records.map((r) => { const cells = { ...r.cells }; delete cells[fieldId]; return { ...r, cells }; }),
    views,
  };
}

export function setFieldWidth(table: Table, fieldId: string, width: number): Table {
  return { ...table, fields: table.fields.map((f) => (f.id === fieldId ? { ...f, width: Math.max(80, Math.round(width)) } : f)) };
}
