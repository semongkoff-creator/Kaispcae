import { useRef, useState, type ReactNode } from 'react';
import { StarFill, Star } from 'react-bootstrap-icons';
import { Field, CellValue, RowHeight, SELECT_COLORS, SELECT_COLOR_KEYS, formatCurrency, formatNumber, formatDate } from '../types';
import { computeFormula, formulaDisplay } from '../formula';
import { useClickOutside } from './useClickOutside';

interface CellProps {
  field: Field;
  fields: Field[];
  value: CellValue;
  record: { id: string; cells: Record<string, CellValue> };
  onChange: (value: CellValue) => void;
  // Create a new select option on this field, returns its id (used by the
  // select/multiSelect inline "+ tambah opsi").
  onAddOption?: (name: string) => string;
  rowHeight?: RowHeight;
  mode?: 'grid' | 'panel';
  // Viewer/commenter: render values but block all editing (server enforces
  // too — this is the cosmetic half).
  readOnly?: boolean;
  // Base members — a `person` cell stores a member's userId and is picked
  // from this list (never free text).
  members?: { userId: string; name: string }[];
}

const HEIGHT_LINES: Record<RowHeight, number> = { short: 1, medium: 2, tall: 4 };

function epochToInput(v: CellValue): string {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function inputToEpoch(s: string): number | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 10, 0, 0).getTime();
}

export function Cell({ field, fields, value, record, onChange, onAddOption, rowHeight = 'short', mode = 'grid', readOnly = false, members = [] }: CellProps) {
  const [editing, setEditing] = useState(mode === 'panel' && !readOnly);
  const panel = mode === 'panel';
  const addOption = readOnly ? undefined : onAddOption;

  // ── formula (read-only) ──
  if (field.type === 'formula') {
    const out = formulaDisplay(computeFormula(field, record, fields));
    const err = out === '#ERR';
    return (
      <div className={`px-2 py-1 text-sm truncate ${err ? 'text-red-500 font-medium' : 'text-gray-500 dark:text-gray-400'}`} title={out}>
        {out || <span className="text-gray-300 dark:text-gray-600">ƒ</span>}
      </div>
    );
  }

  // ── checkbox (direct toggle) ──
  if (field.type === 'checkbox') {
    return (
      <div className={`flex items-center px-2 py-1 ${panel ? '' : 'justify-center'}`}>
        <input
          type="checkbox"
          checked={value === true}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={field.name}
          className="w-4 h-4 accent-purple-600 cursor-pointer disabled:cursor-default"
        />
      </div>
    );
  }

  // ── rating (stars) ──
  if (field.type === 'rating') {
    const cur = typeof value === 'number' ? value : 0;
    return (
      <div className="flex items-center gap-0.5 px-2 py-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <button
            key={i}
            onClick={() => !readOnly && onChange(cur === i ? i - 1 : i)}
            disabled={readOnly}
            aria-label={`Beri rating ${i}`}
            className="text-amber-400 hover:scale-110 transition-transform cursor-pointer disabled:cursor-default disabled:hover:scale-100"
          >
            {i <= cur ? <StarFill size={14} /> : <Star size={14} className="text-gray-300 dark:text-gray-600" />}
          </button>
        ))}
      </div>
    );
  }

  // ── select ──
  if (field.type === 'select') {
    return <SelectCell field={field} value={value} onChange={onChange} onAddOption={addOption} panel={panel} readOnly={readOnly} />;
  }
  // ── multiSelect ──
  if (field.type === 'multiSelect') {
    return <MultiSelectCell field={field} value={Array.isArray(value) ? value : []} onChange={onChange} onAddOption={addOption} panel={panel} readOnly={readOnly} />;
  }

  // ── person (member picker — value is a member's userId) ──
  if (field.type === 'person') {
    return <PersonCell value={value} members={members} onChange={onChange} panel={panel} readOnly={readOnly} label={field.name} />;
  }

  // ── date ──
  if (field.type === 'date') {
    if ((panel || editing) && !readOnly) {
      return (
        <input
          type="date"
          autoFocus={!panel}
          value={epochToInput(value)}
          onChange={(e) => onChange(inputToEpoch(e.target.value))}
          onBlur={() => setEditing(false)}
          aria-label={field.name}
          className="w-full bg-transparent px-2 py-1 text-sm text-gray-800 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500 rounded"
        />
      );
    }
    return (
      <button onClick={() => !readOnly && setEditing(true)} className={`w-full text-left px-2 py-1 text-sm text-gray-800 dark:text-gray-100 truncate ${readOnly ? '' : 'cursor-text'}`}>
        {value ? formatDate(value) : <span className="text-gray-300 dark:text-gray-600">—</span>}
      </button>
    );
  }

  // ── text-ish: text / longText / number / currency / url / person ──
  const isNumeric = field.type === 'number' || field.type === 'currency';
  const isLong = field.type === 'longText';

  if ((panel || editing) && !readOnly) {
    const commit = (v: string) => {
      if (isNumeric) { const n = parseFloat(v); onChange(v === '' ? null : Number.isFinite(n) ? n : null); }
      else onChange(v);
    };
    const common = {
      autoFocus: !panel,
      defaultValue: value == null ? '' : String(value),
      onBlur: (e: { target: { value: string } }) => { commit(e.target.value); setEditing(false); },
      'aria-label': field.name,
      className: 'w-full bg-transparent px-2 py-1 text-sm text-gray-800 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500 rounded',
    };
    if (isLong) {
      return (
        <textarea
          {...common}
          rows={panel ? 4 : 3}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur(); if (e.key === 'Escape') setEditing(false); }}
        />
      );
    }
    return (
      <input
        {...common}
        type={isNumeric ? 'number' : 'text'}
        inputMode={isNumeric ? 'decimal' : undefined}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false); }}
      />
    );
  }

  // display (grid, not editing)
  const lines = HEIGHT_LINES[rowHeight];
  let display: ReactNode;
  if (value == null || value === '') display = <span className="text-gray-300 dark:text-gray-600">—</span>;
  else if (field.type === 'currency') display = formatCurrency(value);
  else if (field.type === 'number') display = formatNumber(value);
  else if (field.type === 'url') display = <a href={String(value)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-purple-600 dark:text-purple-400 hover:underline">{String(value)}</a>;
  else display = String(value);

  return (
    <button
      onClick={() => !readOnly && field.type !== 'url' && setEditing(true)}
      onDoubleClick={() => !readOnly && setEditing(true)}
      className={`w-full text-left px-2 py-1 text-sm text-gray-800 dark:text-gray-100 ${readOnly ? '' : 'cursor-text'} ${lines === 1 ? 'truncate' : ''}`}
      style={lines > 1 ? { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : undefined}
    >
      {display}
    </button>
  );
}

// ─── Select cell + popover ──────────────────────────────────────────

function Chip({ name, color }: { name: string; color: string }) {
  const c = SELECT_COLORS[color] ?? SELECT_COLORS.gray;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${c.bg} ${c.text}`}>{name}</span>;
}

function SelectCell({ field, value, onChange, onAddOption, panel, readOnly }: { field: Field; value: CellValue; onChange: (v: CellValue) => void; onAddOption?: (n: string) => string; panel: boolean; readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [newName, setNewName] = useState('');
  useClickOutside(ref, () => setOpen(false), open);
  const selected = field.options?.find((o) => o.id === value);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => !readOnly && setOpen((v) => !v)} aria-label={field.name} className={`w-full text-left px-2 py-1 min-h-[28px] flex items-center gap-1 ${readOnly ? '' : 'cursor-pointer'} ${panel ? 'border border-purple-100 dark:border-gray-700 rounded-lg' : ''}`}>
        {selected ? <Chip name={selected.name} color={selected.color} /> : <span className="text-gray-300 dark:text-gray-600 text-sm">—</span>}
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-52 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-purple-100 dark:border-gray-700 p-1 max-h-60 overflow-y-auto">
          <button onClick={() => { onChange(null); setOpen(false); }} className="w-full text-left px-2 py-1.5 rounded text-xs text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">Kosongkan</button>
          {field.options?.map((o) => (
            <button key={o.id} onClick={() => { onChange(o.id); setOpen(false); }} className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">
              <Chip name={o.name} color={o.color} />
            </button>
          ))}
          {onAddOption && (
            <div className="flex gap-1 p-1 border-t border-gray-100 dark:border-gray-700 mt-1">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Opsi baru..." className="flex-1 min-w-0 text-xs bg-gray-50 dark:bg-gray-700 rounded px-2 py-1 outline-none" onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) { const id = onAddOption(newName.trim()); onChange(id); setNewName(''); setOpen(false); } }} />
              <button disabled={!newName.trim()} onClick={() => { const id = onAddOption(newName.trim()); onChange(id); setNewName(''); setOpen(false); }} className="text-xs bg-purple-600 disabled:opacity-40 text-white px-2 rounded cursor-pointer">+</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MultiSelectCell({ field, value, onChange, onAddOption, panel, readOnly }: { field: Field; value: string[]; onChange: (v: CellValue) => void; onAddOption?: (n: string) => string; panel: boolean; readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [newName, setNewName] = useState('');
  useClickOutside(ref, () => setOpen(false), open);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => !readOnly && setOpen((v) => !v)} aria-label={field.name} className={`w-full text-left px-2 py-1 min-h-[28px] flex items-center gap-1 flex-wrap ${readOnly ? '' : 'cursor-pointer'} ${panel ? 'border border-purple-100 dark:border-gray-700 rounded-lg' : ''}`}>
        {value.length ? value.map((id) => { const o = field.options?.find((op) => op.id === id); return o ? <Chip key={id} name={o.name} color={o.color} /> : null; }) : <span className="text-gray-300 dark:text-gray-600 text-sm">—</span>}
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-52 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-purple-100 dark:border-gray-700 p-1 max-h-60 overflow-y-auto">
          {field.options?.map((o) => (
            <button key={o.id} onClick={() => toggle(o.id)} className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2 cursor-pointer">
              <input type="checkbox" readOnly checked={value.includes(o.id)} className="w-3.5 h-3.5 accent-purple-600 pointer-events-none" />
              <Chip name={o.name} color={o.color} />
            </button>
          ))}
          {onAddOption && (
            <div className="flex gap-1 p-1 border-t border-gray-100 dark:border-gray-700 mt-1">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Opsi baru..." className="flex-1 min-w-0 text-xs bg-gray-50 dark:bg-gray-700 rounded px-2 py-1 outline-none" onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) { const id = onAddOption(newName.trim()); onChange([...value, id]); setNewName(''); } }} />
              <button disabled={!newName.trim()} onClick={() => { const id = onAddOption(newName.trim()); onChange([...value, id]); setNewName(''); }} className="text-xs bg-purple-600 disabled:opacity-40 text-white px-2 rounded cursor-pointer">+</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Rotating default colour for a newly-added option.
export function nextOptionColor(count: number): string {
  return SELECT_COLOR_KEYS[count % SELECT_COLOR_KEYS.length];
}

// ─── Person cell: searchable member picker (stores userId) ──────────

const PERSON_COLORS = ['bg-purple-500', 'bg-blue-500', 'bg-green-500', 'bg-amber-500', 'bg-pink-500', 'bg-teal-500', 'bg-red-500'];
function personColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length];
}

export function PersonAvatar({ name, userId, size = 16 }: { name: string; userId: string; size?: number }) {
  return (
    <span className={`inline-flex items-center justify-center rounded-full text-white font-bold shrink-0 ${personColor(userId)}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function PersonCell({ value, members, onChange, panel, readOnly, label }: {
  value: CellValue; members: { userId: string; name: string }[];
  onChange: (v: CellValue) => void; panel: boolean; readOnly?: boolean; label: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  const selected = members.find((m) => m.userId === value);
  const shown = members.filter((m) => m.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div ref={ref} className="relative">
      <button onClick={() => !readOnly && setOpen((v) => !v)} aria-label={label} className={`w-full text-left px-2 py-1 min-h-[28px] flex items-center gap-1.5 ${readOnly ? '' : 'cursor-pointer'} ${panel ? 'border border-purple-100 dark:border-gray-700 rounded-lg' : ''}`}>
        {selected ? (
          <><PersonAvatar name={selected.name} userId={selected.userId} /><span className="text-sm text-gray-800 dark:text-gray-100 truncate">{selected.name}</span></>
        ) : value ? (
          // a userId we can't resolve (e.g. member removed, or a public form view)
          <span className="text-sm text-gray-400 italic truncate">(bukan anggota)</span>
        ) : (
          <span className="text-gray-300 dark:text-gray-600 text-sm">—</span>
        )}
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-purple-100 dark:border-gray-700 p-1">
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Cari anggota…" className="w-full text-xs bg-gray-50 dark:bg-gray-700 rounded px-2 py-1.5 outline-none mb-1" />
          <div className="max-h-48 overflow-y-auto">
            <button onClick={() => { onChange(null); setOpen(false); }} className="w-full text-left px-2 py-1.5 rounded text-xs text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">Kosongkan</button>
            {shown.map((m) => (
              <button key={m.userId} onClick={() => { onChange(m.userId); setOpen(false); setQ(''); }} className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer flex items-center gap-2">
                <PersonAvatar name={m.name} userId={m.userId} size={20} />
                <span className="text-sm text-gray-700 dark:text-gray-200 truncate">{m.name}</span>
              </button>
            ))}
            {shown.length === 0 && <p className="text-[11px] text-gray-400 px-2 py-1.5">Tidak ada anggota cocok.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
