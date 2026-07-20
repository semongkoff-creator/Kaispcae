import { useRef, useState } from 'react';
import { BaseRole, can } from '@virtualmeet/shared';
import { Field, FieldType, FIELD_TYPES, SelectOption, SELECT_COLORS, SELECT_COLOR_KEYS, uid } from '../types';
import { useClickOutside } from './useClickOutside';
import { useServerBase } from '../serverStore';

interface FieldMenuProps {
  field: Field;
  onApply: (patch: Partial<Field>) => void; // rename / type / options / formula
  onInsertLeft: () => void;
  onInsertRight: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function FieldMenu({ field, onApply, onInsertLeft, onInsertRight, onDelete, onClose }: FieldMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, onClose, true);
  const [name, setName] = useState(field.name);
  const [showTypes, setShowTypes] = useState(false);
  const [formula, setFormula] = useState(field.formula ?? '');
  const myRole = useServerBase((s) => s.myRole);
  const isOwner = can('base:manageMembers', { role: myRole ?? undefined });

  const commitName = () => { const n = name.trim(); if (n && n !== field.name) onApply({ name: n }); };

  const changeType = (type: FieldType) => {
    const patch: Partial<Field> = { type };
    // Seed options when switching INTO a choice type that has none yet.
    if ((type === 'select' || type === 'multiSelect') && (!field.options || field.options.length === 0)) {
      patch.options = [];
    }
    if (type === 'formula' && !field.formula) patch.formula = '';
    onApply(patch);
    setShowTypes(false);
  };

  const setOptions = (options: SelectOption[]) => onApply({ options });

  return (
    <div ref={ref} className="absolute z-40 top-full left-0 mt-1 w-64 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-purple-100 dark:border-gray-700 p-2 text-sm" onPointerDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => { if (e.key === 'Enter') { commitName(); onClose(); } }}
        aria-label="Nama kolom"
        className="w-full bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-gray-900 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500 mb-1"
      />

      {/* Type */}
      <button onClick={() => setShowTypes((v) => !v)} className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 cursor-pointer">
        <span className="text-gray-400 text-xs">Tipe</span>
        <span className="font-medium">{FIELD_TYPES.find((f) => f.type === field.type)?.label}</span>
      </button>
      {showTypes && (
        <div className="grid grid-cols-2 gap-0.5 p-1 max-h-48 overflow-y-auto">
          {FIELD_TYPES.map((ft) => (
            <button key={ft.type} onClick={() => changeType(ft.type)} className={`text-left px-2 py-1.5 rounded-lg hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer ${ft.type === field.type ? 'bg-purple-100 dark:bg-gray-600' : ''}`}>
              <span className="inline-block w-4 text-gray-400 text-xs">{ft.icon}</span> {ft.label}
            </button>
          ))}
        </div>
      )}

      {/* Options editor for select / multiSelect */}
      {(field.type === 'select' || field.type === 'multiSelect') && (
        <OptionsEditor options={field.options ?? []} onChange={setOptions} />
      )}

      {/* Formula editor */}
      {field.type === 'formula' && (
        <div className="p-1">
          <textarea
            value={formula}
            onChange={(e) => setFormula(e.target.value)}
            onBlur={() => onApply({ formula })}
            rows={2}
            placeholder="{Durasi (menit)} / 60 * {Rate / jam}"
            className="w-full font-mono text-xs bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-gray-900 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500"
          />
          <p className="text-[10px] text-gray-400 mt-1">Fungsi: CONCAT, IF, ROUND, LEN, UPPER, LOWER, TODAY. Referensi: {'{Nama Field}'}.</p>
        </div>
      )}

      {/* Per-field permission — owner only. Hidden fields are stripped from
          the API response for roles below the threshold, not just CSS-hidden. */}
      {isOwner && (
        <div className="p-1 border-t border-gray-100 dark:border-gray-700 mt-1 space-y-1">
          <p className="text-[10px] text-gray-400 px-1">Izin kolom</p>
          <label className="flex items-center justify-between gap-2 px-1">
            <span className="text-[11px] text-gray-500 dark:text-gray-400">Terlihat oleh</span>
            <select
              value={field.access?.hiddenBelowRole ?? ''}
              onChange={(e) => onApply({ access: { ...field.access, hiddenBelowRole: (e.target.value || undefined) as BaseRole | undefined } })}
              className="text-[11px] bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none cursor-pointer"
            >
              <option value="">Semua anggota</option>
              <option value="editor">Editor ke atas</option>
              <option value="owner">Hanya pemilik</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2 px-1">
            <span className="text-[11px] text-gray-500 dark:text-gray-400">Bisa diedit oleh</span>
            <select
              value={field.access?.readOnlyBelowRole ?? ''}
              onChange={(e) => onApply({ access: { ...field.access, readOnlyBelowRole: (e.target.value || undefined) as BaseRole | undefined } })}
              className="text-[11px] bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none cursor-pointer"
            >
              <option value="">Editor ke atas</option>
              <option value="owner">Hanya pemilik</option>
            </select>
          </label>
        </div>
      )}

      <div className="border-t border-gray-100 dark:border-gray-700 my-1" />
      <button onClick={() => { onInsertLeft(); onClose(); }} className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 cursor-pointer">← Sisipkan kolom kiri</button>
      <button onClick={() => { onInsertRight(); onClose(); }} className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 cursor-pointer">Sisipkan kolom kanan →</button>
      <button onClick={() => { onDelete(); onClose(); }} className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 cursor-pointer">Hapus kolom</button>
    </div>
  );
}

function OptionsEditor({ options, onChange }: { options: SelectOption[]; onChange: (o: SelectOption[]) => void }) {
  const [newName, setNewName] = useState('');
  const [colorFor, setColorFor] = useState<string | null>(null);

  const rename = (id: string, name: string) => onChange(options.map((o) => (o.id === id ? { ...o, name } : o)));
  const recolor = (id: string, color: string) => { onChange(options.map((o) => (o.id === id ? { ...o, color } : o))); setColorFor(null); };
  const remove = (id: string) => onChange(options.filter((o) => o.id !== id));
  const add = () => { const n = newName.trim(); if (!n) return; onChange([...options, { id: uid('opt'), name: n, color: SELECT_COLOR_KEYS[options.length % SELECT_COLOR_KEYS.length] }]); setNewName(''); };

  return (
    <div className="p-1 border-t border-gray-100 dark:border-gray-700 mt-1">
      <p className="text-[10px] text-gray-400 px-1 mb-1">Opsi</p>
      <div className="max-h-40 overflow-y-auto space-y-0.5">
        {options.map((o) => (
          <div key={o.id} className="flex items-center gap-1 relative">
            <button onClick={() => setColorFor(colorFor === o.id ? null : o.id)} aria-label="Ganti warna" className={`w-4 h-4 rounded-full shrink-0 cursor-pointer ${SELECT_COLORS[o.color]?.dot ?? 'bg-gray-400'}`} />
            {colorFor === o.id && (
              <div className="absolute z-50 top-5 left-0 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-100 dark:border-gray-700 p-1 flex flex-wrap gap-1 w-32">
                {SELECT_COLOR_KEYS.map((c) => (
                  <button key={c} onClick={() => recolor(o.id, c)} className={`w-4 h-4 rounded-full cursor-pointer ${SELECT_COLORS[c].dot}`} aria-label={c} />
                ))}
              </div>
            )}
            <input value={o.name} onChange={(e) => rename(o.id, e.target.value)} className="flex-1 min-w-0 text-xs bg-transparent px-1 py-0.5 rounded outline-none focus:bg-gray-50 dark:focus:bg-gray-700 text-gray-800 dark:text-gray-100" />
            <button onClick={() => remove(o.id)} aria-label="Hapus opsi" className="text-gray-300 hover:text-red-500 text-xs px-1 cursor-pointer">✕</button>
          </div>
        ))}
      </div>
      <div className="flex gap-1 mt-1">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder="Tambah opsi..." className="flex-1 min-w-0 text-xs bg-gray-50 dark:bg-gray-700 rounded px-2 py-1 outline-none" />
        <button disabled={!newName.trim()} onClick={add} className="text-xs bg-purple-600 disabled:opacity-40 text-white px-2 rounded cursor-pointer">+</button>
      </div>
    </div>
  );
}
