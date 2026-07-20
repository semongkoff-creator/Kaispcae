import type { BaseRole } from '@virtualmeet/shared';

// Data model for the Lark Base (Bitable) clone.
//
//   Base → Table[] → { fields: Field[], records: BaseRecord[], views: View[] }
//
// Everything is plain serialisable data (no class instances) so the whole
// Base can be JSON-round-tripped straight to/from a future API — see the
// single `update()` mutation point in store.ts (the PERSISTENCE HOOK).

export type FieldType =
  | 'text'
  | 'longText'
  | 'number'
  | 'currency'
  | 'select'
  | 'multiSelect'
  | 'date'
  | 'checkbox'
  | 'rating'
  | 'person'
  | 'url'
  | 'formula';

// A coloured choice for select / multiSelect fields.
export interface SelectOption {
  id: string;
  name: string;
  color: string; // one of SELECT_COLORS below
}

export interface Field {
  id: string;
  name: string;
  type: FieldType;
  width: number; // px, for the grid
  // select / multiSelect only
  options?: SelectOption[];
  // formula only — raw source, e.g. "{Durasi (menit)} / 60 * {Rate / jam}"
  formula?: string;
  // Per-field permission (see shared/basePermissions.ts's FieldAccess).
  // `hiddenBelowRole` fields are stripped from the API response entirely for
  // roles below it — not merely hidden in CSS.
  access?: { hiddenBelowRole?: BaseRole; readOnlyBelowRole?: BaseRole };
}

// Cell values are loosely typed by field type:
//   text/longText/url/person → string
//   number/currency/rating    → number
//   checkbox                  → boolean
//   date                      → number (epoch ms) | null
//   select                    → optionId (string) | null
//   multiSelect               → optionId[] (string[])
//   formula                   → derived (never stored)
export type CellValue = string | number | boolean | string[] | null | undefined;

export interface BaseRecord {
  id: string;
  cells: Record<string, CellValue>; // keyed by Field.id
  // System fields (read-only) — surfaced in the record panel + usable later
  // for created/modified filtering. Optional: not every code path carries them.
  createdById?: string;
  updatedById?: string;
  createdAt?: number;
  updatedAt?: number;
}

// 'form' is a submit-only view: shared via a link, anyone with it fills the
// listed fields and each submission appends a record (like Lark's Form view).
export type ViewType = 'grid' | 'kanban' | 'gallery' | 'calendar' | 'form';

export type FilterOperator =
  | 'contains'
  | 'notContains'
  | 'is'
  | 'isNot'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'hasAny'
  | 'hasAll'
  | 'isBefore'
  | 'isAfter'
  | 'isChecked'
  | 'isUnchecked'
  // person fields: matches whoever is VIEWING, so one shared view works
  // per-person ("Tugasku") without a separate view per member.
  | 'isCurrentUser';

export interface FilterCondition {
  id: string;
  fieldId: string;
  operator: FilterOperator;
  value?: CellValue;
}

export interface SortRule {
  id: string;
  fieldId: string;
  direction: 'asc' | 'desc';
}

export type RowHeight = 'short' | 'medium' | 'tall';

// Collaborative = anyone with edit rights changes it for everyone.
// Locked      = only the owner or whoever locked it may change its config.
// Personal    = only its creator can see it at all (server filters it out
//               for everyone else); its config is private to them.
export type ViewMode = 'collaborative' | 'locked' | 'personal';

export interface View {
  id: string;
  name: string;
  type: ViewType;
  mode?: ViewMode; // default: collaborative
  ownerId?: string; // personal views: the only user who sees it
  lockedById?: string;
  lockedByName?: string;
  filters: FilterCondition[];
  sorts: SortRule[];
  groupBy?: string; // fieldId (grid grouping)
  hidden: string[]; // hidden fieldIds
  rowHeight?: RowHeight; // grid
  stackField?: string; // kanban: the select fieldId to stack by
  dateField?: string; // calendar: the date fieldId to map to days
  coverField?: string; // gallery: reserved (title is always field[0])
  // form view: heading shown to whoever opens the shared link. Which fields
  // the form asks for is `hidden` (same as every other view).
  formTitle?: string;
  formDescription?: string;
}

export interface Table {
  id: string;
  name: string;
  icon?: string;
  fields: Field[];
  records: BaseRecord[];
  views: View[];
}

export interface Base {
  id: string;
  name: string;
  tables: Table[];
}

// ─── Field-type metadata ────────────────────────────────────────────

export interface FieldTypeMeta {
  type: FieldType;
  label: string; // Indonesian label
  icon: string; // emoji, kept simple (no icon-font dependency in the header menu)
  isNumeric: boolean; // eligible for SUM footer / numeric operators
  readOnly: boolean; // formula
}

export const FIELD_TYPES: FieldTypeMeta[] = [
  { type: 'text', label: 'Teks', icon: 'A', isNumeric: false, readOnly: false },
  { type: 'longText', label: 'Teks panjang', icon: '¶', isNumeric: false, readOnly: false },
  { type: 'number', label: 'Angka', icon: '#', isNumeric: true, readOnly: false },
  { type: 'currency', label: 'Mata uang (IDR)', icon: 'Rp', isNumeric: true, readOnly: false },
  { type: 'select', label: 'Pilihan tunggal', icon: '◉', isNumeric: false, readOnly: false },
  { type: 'multiSelect', label: 'Pilihan ganda', icon: '☰', isNumeric: false, readOnly: false },
  { type: 'date', label: 'Tanggal', icon: '📅', isNumeric: false, readOnly: false },
  { type: 'checkbox', label: 'Kotak centang', icon: '✓', isNumeric: false, readOnly: false },
  { type: 'rating', label: 'Rating', icon: '★', isNumeric: true, readOnly: false },
  { type: 'person', label: 'Orang', icon: '@', isNumeric: false, readOnly: false },
  { type: 'url', label: 'Tautan', icon: '🔗', isNumeric: false, readOnly: false },
  { type: 'formula', label: 'Formula', icon: 'ƒ', isNumeric: true, readOnly: true },
];

export function fieldMeta(type: FieldType): FieldTypeMeta {
  return FIELD_TYPES.find((f) => f.type === type) ?? FIELD_TYPES[0];
}

// Palette for select options — Tailwind-ish pairs (bg + text) so the chips
// read well in light AND dark. Referenced by SelectOption.color (the key).
export const SELECT_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  gray: { bg: 'bg-gray-100 dark:bg-gray-700', text: 'text-gray-700 dark:text-gray-200', dot: 'bg-gray-400' },
  red: { bg: 'bg-red-100 dark:bg-red-900/40', text: 'text-red-700 dark:text-red-300', dot: 'bg-red-500' },
  orange: { bg: 'bg-orange-100 dark:bg-orange-900/40', text: 'text-orange-700 dark:text-orange-300', dot: 'bg-orange-500' },
  amber: { bg: 'bg-amber-100 dark:bg-amber-900/40', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
  green: { bg: 'bg-green-100 dark:bg-green-900/40', text: 'text-green-700 dark:text-green-300', dot: 'bg-green-500' },
  teal: { bg: 'bg-teal-100 dark:bg-teal-900/40', text: 'text-teal-700 dark:text-teal-300', dot: 'bg-teal-500' },
  blue: { bg: 'bg-blue-100 dark:bg-blue-900/40', text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500' },
  purple: { bg: 'bg-purple-100 dark:bg-purple-900/40', text: 'text-purple-700 dark:text-purple-300', dot: 'bg-purple-500' },
  pink: { bg: 'bg-pink-100 dark:bg-pink-900/40', text: 'text-pink-700 dark:text-pink-300', dot: 'bg-pink-500' },
};

export const SELECT_COLOR_KEYS = Object.keys(SELECT_COLORS);

// ─── id-ID formatting helpers ───────────────────────────────────────

const idr = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('id-ID');
const dateFmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });

export function formatCurrency(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? idr.format(n) : '';
}
export function formatNumber(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? num.format(n) : '';
}
export function formatDate(v: unknown): string {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '';
  return dateFmt.format(new Date(n));
}

// Short, dependency-free unique ids (crypto.randomUUID is available in all
// target browsers; the fallback keeps SSR/older engines from throwing).
export function uid(prefix = ''): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.abs(Math.floor((performance.now() * 1000) % 1e8)).toString(36) + (idCounter++).toString(36);
  return prefix + rand;
}
let idCounter = 0;
