import { useState } from 'react';
import { X, TrashFill } from 'react-bootstrap-icons';
import { DeskNoteData } from '@kaispace/shared';

const NOTE_MAX_LENGTH = 300;

interface NoteModalProps {
  noteId: string;
  note: DeskNoteData | undefined;
  localUserId: string;
  // Guests never get the server-side NOTE_EDIT/NOTE_DELETE handlers at all
  // (see index.ts's registration list — same posture as furniture
  // assignment), so writing would silently do nothing server-side. Treated
  // as read-only here too, rather than letting a guest "save" an edit that
  // quietly never persists.
  isGuest?: boolean;
  onSave: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

// QA #7/#8/#9 — view/edit/delete a note placed via Add Media (see
// AddMediaPanel.tsx, which handles CREATING a new one — this modal only
// opens for an EXISTING note, clicked from its marker on the map). Two
// states: yours (editable/deletable) or someone else's (read-only —
// "Pembuat edit/hapus; lain baca saja", no admin override).
export function NoteModal({ noteId, note, localUserId, isGuest, onSave, onDelete, onClose }: NoteModalProps) {
  const isAuthor = !isGuest && note?.authorUserId === localUserId;
  const [text, setText] = useState(note?.text ?? '');

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-4 w-full mx-4 max-w-sm"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-gray-400 dark:text-gray-500 text-xs inline-flex items-center gap-1.5">
            📝 {note ? `Catatan oleh ${note.authorName}` : 'Catatan'}
          </span>
          <button onClick={onClose} title="Tutup" className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 cursor-pointer">
            <X size={18} />
          </button>
        </div>

        {!note ? (
          // Deleted by its author (or by us, just now) while this was open.
          <p className="text-gray-400 dark:text-gray-500 text-sm italic">Catatan ini sudah dihapus.</p>
        ) : isAuthor ? (
          <>
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, NOTE_MAX_LENGTH))}
              placeholder="Tulis catatan di sini…"
              rows={4}
              className="w-full text-sm bg-gray-50 dark:bg-gray-900/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2 outline-none border border-gray-200 dark:border-gray-700 focus:border-amber-400 resize-none"
            />
            <div className="flex items-center justify-between mt-1 mb-3">
              <span className="text-[10px] text-gray-400">{text.length}/{NOTE_MAX_LENGTH}</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { const t = text.trim(); if (t) { onSave(noteId, t); onClose(); } }}
                disabled={!text.trim()}
                className="flex-1 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white text-sm font-medium cursor-pointer"
              >
                Simpan
              </button>
              <button
                onClick={() => { onDelete(noteId); onClose(); }}
                title="Hapus catatan"
                className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-500 hover:bg-red-100 dark:hover:bg-red-900/40 cursor-pointer inline-flex items-center justify-center"
              >
                <TrashFill size={14} />
              </button>
            </div>
          </>
        ) : (
          // "Pembuat edit/hapus; lain baca saja" — no textarea, no buttons.
          <p className="text-gray-800 dark:text-gray-100 text-sm whitespace-pre-wrap break-words">{note.text}</p>
        )}
      </div>
    </div>
  );
}
