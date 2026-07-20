import { create } from 'zustand';
import { Base, Table, View, uid } from './types';
import { buildSeedBase } from './seed';

interface BaseStore {
  base: Base;
  activeTableId: string;
  activeViewId: string;

  setActiveTable: (tableId: string) => void;
  setActiveView: (viewId: string) => void;

  // ── THE single mutation entry point ──────────────────────────────
  // Every field/record/view change in every component goes through here.
  // It replaces one table immutably and writes the new Base. To move this
  // module onto a real backend later, this is the ONLY place to touch:
  // fire a debounced PATCH with the returned table and keep the optimistic
  // local write — no component changes needed.
  update: (tableId: string, updater: (table: Table) => Table) => void;

  addTable: () => void;
  deleteTable: (tableId: string) => void;
}

// One shared in-memory Base. Kept out of gameStore deliberately — this module
// is self-contained and its persistence story (see `update` below) is
// separate from the realtime room state.
export const useBaseStore = create<BaseStore>((set, get) => ({
  base: buildSeedBase(),
  activeTableId: '',
  activeViewId: '',

  setActiveTable: (tableId) =>
    set((state) => {
      const table = state.base.tables.find((t) => t.id === tableId);
      return { activeTableId: tableId, activeViewId: table?.views[0]?.id ?? '' };
    }),

  setActiveView: (viewId) => set({ activeViewId: viewId }),

  update: (tableId, updater) =>
    set((state) => {
      const idx = state.base.tables.findIndex((t) => t.id === tableId);
      if (idx === -1) return {};
      const nextTable = updater(state.base.tables[idx]);
      if (nextTable === state.base.tables[idx]) return {}; // no-op guard
      const tables = state.base.tables.slice();
      tables[idx] = nextTable;
      const base = { ...state.base, tables };

      // PERSISTENCE HOOK — swap this line for a debounced
      // `api.patchTable(tableId, nextTable)` (optimistic: keep the local
      // set() and reconcile on the response). Everything upstream already
      // funnels through here, so no component ever calls the network directly.

      return { base };
    }),

  addTable: () =>
    set((state) => {
      const n = state.base.tables.length + 1;
      const fieldId = uid('fld');
      const viewId = uid('viw');
      const table: Table = {
        id: uid('tbl'),
        name: `Tabel ${n}`,
        icon: '📋',
        fields: [{ id: fieldId, name: 'Judul', type: 'text', width: 240 }],
        records: [
          { id: uid('rec'), cells: { [fieldId]: '' } },
          { id: uid('rec'), cells: { [fieldId]: '' } },
          { id: uid('rec'), cells: { [fieldId]: '' } },
        ],
        views: [{ id: viewId, name: 'Grid', type: 'grid', filters: [], sorts: [], hidden: [], rowHeight: 'short' }],
      };
      // PERSISTENCE HOOK (table create) — same story as `update` above.
      return {
        base: { ...state.base, tables: [...state.base.tables, table] },
        activeTableId: table.id,
        activeViewId: viewId,
      };
    }),

  deleteTable: (tableId) =>
    set((state) => {
      if (state.base.tables.length <= 1) return {}; // never leave the Base empty
      const tables = state.base.tables.filter((t) => t.id !== tableId);
      const nextActive = state.activeTableId === tableId ? tables[0] : state.base.tables.find((t) => t.id === state.activeTableId)!;
      // PERSISTENCE HOOK (table delete).
      return {
        base: { ...state.base, tables },
        activeTableId: nextActive.id,
        activeViewId: nextActive.views[0]?.id ?? '',
      };
    }),
}));

// Initialise the active table/view once, after the store exists.
(() => {
  const s = useBaseStore.getState();
  const t0 = s.base.tables[0];
  useBaseStore.setState({ activeTableId: t0.id, activeViewId: t0.views[0].id });
})();

// ── small view helpers used across the module ──────────────────────

export function replaceView(table: Table, viewId: string, patch: Partial<View>): Table {
  return { ...table, views: table.views.map((v) => (v.id === viewId ? { ...v, ...patch } : v)) };
}

export function addView(table: Table, type: View['type'], name: string): { table: Table; viewId: string } {
  const viewId = uid('viw');
  const firstDate = table.fields.find((f) => f.type === 'date')?.id;
  const firstSelect = table.fields.find((f) => f.type === 'select')?.id;
  const view: View = {
    id: viewId,
    name,
    type,
    filters: [],
    sorts: [],
    hidden: [],
    rowHeight: 'short',
    stackField: type === 'kanban' ? firstSelect : undefined,
    dateField: type === 'calendar' ? firstDate : undefined,
  };
  return { table: { ...table, views: [...table.views, view] }, viewId };
}
