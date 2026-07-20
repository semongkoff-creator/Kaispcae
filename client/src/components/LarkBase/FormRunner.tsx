import { useState } from 'react';
import { CheckCircleFill } from 'react-bootstrap-icons';
import { Field, View, CellValue, SELECT_COLORS } from './types';
import { submitShareForm } from './api';

// The PUBLIC face of a Form view (opened via ?share=<token>). Renders one
// input per asked field and posts each submission as a new record. No login,
// no store — it only knows what the share payload gave it.
export function FormRunner({ token, view, fields, password }: { token: string; view: View; fields: Field[]; password?: string }) {
  const asks = fields.filter((f) => !view.hidden.includes(f.id) && f.type !== 'formula');
  const [cells, setCells] = useState<Record<string, CellValue>>({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (id: string, v: CellValue) => setCells((c) => ({ ...c, [id]: v }));

  const submit = async () => {
    setSending(true); setErr(null);
    try { await submitShareForm(token, cells, password); setSent(true); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Gagal mengirim'); }
    finally { setSending(false); }
  };

  if (sent) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center">
          <CheckCircleFill size={40} className="text-green-500 mx-auto mb-3" />
          <p className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-1">Terkirim. Terima kasih!</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Jawabanmu sudah tercatat.</p>
          <button onClick={() => { setCells({}); setSent(false); }} className="text-sm text-purple-600 hover:text-purple-800 cursor-pointer">Isi lagi</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-xl mx-auto bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm p-6">
        <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-1">{view.formTitle || view.name}</h1>
        {view.formDescription && <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{view.formDescription}</p>}
        <div className="space-y-4 mt-4">
          {asks.map((f) => (
            <div key={f.id}>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">{f.name}</label>
              <FormInput field={f} value={cells[f.id]} onChange={(v) => set(f.id, v)} />
            </div>
          ))}
          {asks.length === 0 && <p className="text-sm text-gray-400">Formulir ini belum menanyakan apa pun.</p>}
        </div>
        {err && <p className="text-xs text-red-500 mt-3">{err}</p>}
        <button onClick={submit} disabled={sending || asks.length === 0} className="mt-5 w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm py-2.5 rounded-lg cursor-pointer">
          {sending ? 'Mengirim…' : 'Kirim'}
        </button>
      </div>
    </div>
  );
}

function FormInput({ field, value, onChange }: { field: Field; value: CellValue; onChange: (v: CellValue) => void }) {
  const cls = 'w-full text-sm bg-gray-50 dark:bg-gray-700 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-purple-500 text-gray-800 dark:text-gray-100';
  switch (field.type) {
    case 'longText':
      return <textarea rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={`${cls} resize-none`} />;
    case 'number': case 'currency':
      return <input type="number" value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} className={cls} />;
    case 'checkbox':
      return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 accent-purple-600 cursor-pointer" />;
    case 'date':
      return <input type="date" value={value ? new Date(Number(value)).toISOString().slice(0, 10) : ''} onChange={(e) => { const [y, m, d] = e.target.value.split('-').map(Number); onChange(e.target.value ? new Date(y, m - 1, d, 10).getTime() : null); }} className={cls} />;
    case 'rating':
      return (
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((i) => (
            <button key={i} onClick={() => onChange(value === i ? i - 1 : i)} aria-label={`Rating ${i}`} className={`text-xl cursor-pointer ${typeof value === 'number' && i <= value ? 'text-amber-400' : 'text-gray-300'}`}>★</button>
          ))}
        </div>
      );
    case 'select':
      return (
        <div className="flex flex-wrap gap-1.5">
          {field.options?.map((o) => {
            const on = value === o.id; const c = SELECT_COLORS[o.color] ?? SELECT_COLORS.gray;
            return <button key={o.id} onClick={() => onChange(on ? null : o.id)} className={`text-xs px-2 py-1 rounded-full cursor-pointer ${on ? `${c.bg} ${c.text} ring-1 ring-purple-400` : 'bg-gray-100 dark:bg-gray-700 text-gray-500'}`}>{o.name}</button>;
          })}
        </div>
      );
    case 'multiSelect': {
      const arr = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {field.options?.map((o) => {
            const on = arr.includes(o.id); const c = SELECT_COLORS[o.color] ?? SELECT_COLORS.gray;
            return <button key={o.id} onClick={() => onChange(on ? arr.filter((x) => x !== o.id) : [...arr, o.id])} className={`text-xs px-2 py-1 rounded-full cursor-pointer ${on ? `${c.bg} ${c.text} ring-1 ring-purple-400` : 'bg-gray-100 dark:bg-gray-700 text-gray-500'}`}>{o.name}</button>;
          })}
        </div>
      );
    }
    case 'person':
      // Public form: the submitter isn't a logged-in member, so we ask for a
      // name instead of a member id (an editor can assign the real person later).
      return <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder="Nama" className={cls} />;
    case 'url':
      return <input type="url" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder="https://…" className={cls} />;
    default:
      return <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={cls} />;
  }
}
