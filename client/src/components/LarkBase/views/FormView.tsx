import { Link45deg, EyeFill } from 'react-bootstrap-icons';
import { ViewProps } from './shared';
import { fieldMeta } from '../types';

// In-app side of a Form view: edit the form's heading, pick which fields it
// asks for (reusing `view.hidden`), and see a live preview of what the public
// link shows. Sharing itself goes through the normal share-link panel
// (Bagikan → Link berbagi → pilih view ini) so there's one link mechanism.
export function FormView({ view, visibleFields, fields, rows, canEditView, patchView }: ViewProps & { canEditView?: boolean }) {
  const asks = visibleFields.filter((f) => f.type !== 'formula'); // formulas are derived, never asked

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        {/* Preview */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm p-6">
          <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold mb-3 inline-flex items-center gap-1"><EyeFill size={11} /> Pratinjau formulir</p>
          <input
            value={view.formTitle ?? ''}
            onChange={(e) => patchView({ formTitle: e.target.value })}
            disabled={!canEditView}
            placeholder="Judul formulir…"
            className="w-full text-xl font-semibold bg-transparent text-gray-800 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500 rounded px-1 -mx-1 mb-1 disabled:cursor-default"
          />
          <textarea
            value={view.formDescription ?? ''}
            onChange={(e) => patchView({ formDescription: e.target.value })}
            disabled={!canEditView}
            rows={2}
            placeholder="Deskripsi singkat (opsional)…"
            className="w-full text-sm bg-transparent text-gray-500 dark:text-gray-400 outline-none focus:ring-1 focus:ring-purple-500 rounded px-1 -mx-1 mb-4 resize-none disabled:cursor-default"
          />
          <div className="space-y-3">
            {asks.map((f) => (
              <div key={f.id}>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1.5 mb-1">
                  <span className="w-4 text-center text-gray-400">{fieldMeta(f.type).icon}</span>{f.name}
                </label>
                <div className="h-9 rounded-lg border border-dashed border-gray-200 dark:border-gray-600 bg-gray-50/60 dark:bg-gray-900/30 flex items-center px-2 text-[11px] text-gray-400">
                  {fieldMeta(f.type).label}
                </div>
              </div>
            ))}
            {asks.length === 0 && <p className="text-sm text-gray-400">Semua kolom disembunyikan — formulir tidak menanyakan apa pun.</p>}
          </div>
          <button disabled className="mt-5 w-full bg-purple-600/60 text-white text-sm py-2 rounded-lg cursor-default">Kirim</button>
        </div>

        {/* Which fields the form asks */}
        <div className="space-y-3">
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold mb-2">Pertanyaan</p>
            <div className="space-y-0.5 max-h-64 overflow-y-auto">
              {fields.filter((f) => f.type !== 'formula').map((f) => (
                <label key={f.id} className={`flex items-center gap-2 px-1.5 py-1 rounded text-xs text-gray-700 dark:text-gray-200 ${canEditView ? 'hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer' : ''}`}>
                  <input
                    type="checkbox"
                    disabled={!canEditView}
                    checked={!view.hidden.includes(f.id)}
                    onChange={(e) => patchView({ hidden: e.target.checked ? view.hidden.filter((h) => h !== f.id) : [...view.hidden, f.id] })}
                    className="w-3.5 h-3.5 accent-purple-600"
                  />
                  {f.name}
                </label>
              ))}
            </div>
          </div>
          <div className="bg-purple-50 dark:bg-purple-900/20 rounded-xl border border-purple-100 dark:border-purple-900/40 p-3 text-xs text-gray-600 dark:text-gray-300">
            <p className="font-medium text-purple-700 dark:text-purple-300 mb-1 inline-flex items-center gap-1"><Link45deg size={13} /> Bagikan formulir</p>
            <p>Buka <b>Bagikan → Link berbagi</b>, pilih view <b>{view.name}</b>, lalu buat link. Siapa pun yang membuka link itu bisa mengisi formulir tanpa login — tiap kiriman jadi satu baris baru.</p>
            <p className="mt-1.5 text-gray-400">{rows.length} baris terkumpul di tabel ini.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
