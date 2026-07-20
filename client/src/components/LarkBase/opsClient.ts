// Client-side op builders + the LOCAL reducer that applies an op to the
// in-memory Table (optimistic). The SAME op objects are POSTed to the server
// and re-applied when they arrive back over WS — one vocabulary, one reducer.

import { BaseOp, BaseCellValue } from '@virtualmeet/shared';
import { Table, Field, View, CellValue, uid } from './types';

const now = () => Date.now();
// Client cells allow `undefined` (a cleared cell); the wire protocol uses
// `null`. Coerce at the op boundary so ops are always JSON-clean.
const cv = (v: CellValue): BaseCellValue => (v === undefined ? null : v);
const cvMap = (cells: Record<string, CellValue>): Record<string, BaseCellValue> => Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, cv(v)]));

// Builders — callers use these instead of hand-writing op literals.
export const op = {
  setCell: (tableId: string, recordId: string, fieldId: string, value: CellValue): BaseOp => ({ type: 'setCell', tableId, recordId, fieldId, value: cv(value), at: now() }),
  addRecord: (tableId: string, cells: Record<string, CellValue> = {}, orderIndex?: number): BaseOp & { recordId: string } => ({ type: 'addRecord', tableId, recordId: uid('rec'), cells: cvMap(cells), orderIndex, at: now() }),
  deleteRecord: (tableId: string, recordId: string): BaseOp => ({ type: 'deleteRecord', tableId, recordId, at: now() }),
  addField: (tableId: string, field: Field, index?: number): BaseOp => ({ type: 'addField', tableId, field, index, at: now() }),
  updateField: (tableId: string, fieldId: string, patch: Partial<Field>): BaseOp => ({ type: 'updateField', tableId, fieldId, patch: patch as Record<string, unknown>, at: now() }),
  deleteField: (tableId: string, fieldId: string): BaseOp => ({ type: 'deleteField', tableId, fieldId, at: now() }),
  addView: (tableId: string, view: View): BaseOp => ({ type: 'addView', tableId, view, at: now() }),
  updateView: (tableId: string, viewId: string, patch: Partial<View>): BaseOp => ({ type: 'updateView', tableId, viewId, patch: patch as Record<string, unknown>, at: now() }),
  deleteView: (tableId: string, viewId: string): BaseOp => ({ type: 'deleteView', tableId, viewId, at: now() }),
  addTable: (table: Table): BaseOp => ({ type: 'addTable', table, at: now() }),
  deleteTable: (tableId: string): BaseOp => ({ type: 'deleteTable', tableId, at: now() }),
};

// Apply one op to the tables array immutably. Base-level ops (addTable/
// deleteTable) reshape the array; the rest target one table by id.
export function applyOpToTables(tables: Table[], o: BaseOp): Table[] {
  if (o.type === 'addTable') {
    const t = o.table as Table;
    return tables.some((x) => x.id === t.id) ? tables : [...tables, t];
  }
  if (o.type === 'deleteTable') {
    return tables.length <= 1 ? tables : tables.filter((t) => t.id !== o.tableId);
  }
  return tables.map((t) => (t.id === o.tableId ? applyOpToTable(t, o) : t));
}

function applyOpToTable(table: Table, o: BaseOp): Table {
  switch (o.type) {
    case 'setCell':
      return { ...table, records: table.records.map((r) => (r.id === o.recordId ? { ...r, cells: { ...r.cells, [o.fieldId]: o.value } } : r)) };
    case 'addRecord':
      return table.records.some((r) => r.id === o.recordId) ? table : { ...table, records: [...table.records, { id: o.recordId, cells: { ...(o.cells ?? {}) } }] };
    case 'deleteRecord':
      return { ...table, records: table.records.filter((r) => r.id !== o.recordId) };
    case 'addField': {
      const fields = table.fields.slice();
      if (fields.some((f) => f.id === (o.field as Field).id)) return table;
      fields.splice(o.index ?? fields.length, 0, o.field as Field);
      return { ...table, fields };
    }
    case 'updateField':
      return { ...table, fields: table.fields.map((f) => (f.id === o.fieldId ? { ...f, ...(o.patch as Partial<Field>) } : f)) };
    case 'deleteField':
      return deleteFieldLocal(table, o.fieldId);
    case 'addView':
      return table.views.some((v) => v.id === (o.view as View).id) ? table : { ...table, views: [...table.views, o.view as View] };
    case 'updateView':
      return { ...table, views: table.views.map((v) => (v.id === o.viewId ? { ...v, ...(o.patch as Partial<View>) } : v)) };
    case 'deleteView':
      return table.views.length <= 1 ? table : { ...table, views: table.views.filter((v) => v.id !== o.viewId) };
    default:
      return table;
  }
}

function deleteFieldLocal(table: Table, fieldId: string): Table {
  if (table.fields.length <= 1) return table;
  return {
    ...table,
    fields: table.fields.filter((f) => f.id !== fieldId),
    records: table.records.map((r) => { const cells = { ...r.cells }; delete cells[fieldId]; return { ...r, cells }; }),
    views: table.views.map((v) => ({
      ...v,
      filters: v.filters.filter((f) => f.fieldId !== fieldId),
      sorts: v.sorts.filter((s) => s.fieldId !== fieldId),
      groupBy: v.groupBy === fieldId ? undefined : v.groupBy,
      hidden: v.hidden.filter((h) => h !== fieldId),
      stackField: v.stackField === fieldId ? undefined : v.stackField,
      dateField: v.dateField === fieldId ? undefined : v.dateField,
    })),
  };
}
