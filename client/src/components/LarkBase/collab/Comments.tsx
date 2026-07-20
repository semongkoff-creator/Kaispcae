import { useEffect, useRef, useState } from 'react';
import { Trash, PencilFill, Check2, At, Reply } from 'react-bootstrap-icons';
import { baseRoleAtLeast } from '@virtualmeet/shared';
import { useServerBase } from '../serverStore';
import { baseApi, CommentDto } from '../api';
import { useClickOutside } from '../components/useClickOutside';
import { colorForUser } from './PresenceBar';

// Threaded comments for one record, shown inside RecordPanel. Composer has an
// @mention picker (base members) → server notifies only those users.
export function Comments({ recordId }: { recordId: string }) {
  const members = useServerBase((s) => s.members);
  const currentUser = useServerBase((s) => s.currentUser);
  const myRole = useServerBase((s) => s.myRole);
  const lastCommentEvent = useServerBase((s) => s.lastCommentEvent);
  const noteLocalComment = useServerBase((s) => s.noteLocalComment);

  const canComment = baseRoleAtLeast(myRole ?? undefined, 'commenter');
  const [comments, setComments] = useState<CommentDto[]>([]);
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [showMention, setShowMention] = useState(false);
  const mentionRef = useRef<HTMLDivElement>(null);
  useClickOutside(mentionRef, () => setShowMention(false), showMention);

  const load = () => baseApi.getComments(recordId).then((r) => setComments(r.comments)).catch(() => {});
  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [recordId]);
  // live: refetch when a comment lands on THIS record
  useEffect(() => { if (lastCommentEvent?.recordId === recordId) load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [lastCommentEvent]);

  const nameOf = (id: string) => members.find((mm) => mm.userId === id)?.name ?? 'seseorang';

  const addMention = (userId: string, name: string) => {
    if (!mentions.includes(userId)) setMentions([...mentions, userId]);
    setBody((b) => `${b}${b && !b.endsWith(' ') ? ' ' : ''}@${name} `);
    setShowMention(false);
  };

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    try {
      await baseApi.addComment(recordId, text, mentions, replyTo ?? undefined);
      setBody(''); setMentions([]); setReplyTo(null);
      noteLocalComment(recordId);
      load();
    } catch { /* ignore */ }
  };
  const saveEdit = async (id: string) => { const t = editText.trim(); if (t) { await baseApi.editComment(id, { body: t }).catch(() => {}); } setEditingId(null); load(); };
  const remove = async (id: string) => { if (!window.confirm('Hapus komentar?')) return; await baseApi.deleteComment(id).catch(() => {}); load(); };
  const toggleResolve = async (c: CommentDto) => { await baseApi.editComment(c.id, { resolved: !c.resolved }).catch(() => {}); load(); };

  const top = comments.filter((c) => !c.parentId);
  const repliesOf = (id: string) => comments.filter((c) => c.parentId === id);

  const renderComment = (c: CommentDto, isReply = false) => (
    <div key={c.id} className={`${isReply ? 'ml-6' : ''} group/c py-1.5`}>
      <div className="flex items-start gap-2">
        <span className={`w-6 h-6 rounded-full ${colorForUser(c.authorId)} text-white text-[10px] font-bold flex items-center justify-center shrink-0`}>{c.authorName.charAt(0).toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{c.authorName}</span>
            <span className="text-[10px] text-gray-400">{new Date(c.createdAt).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            {c.resolved && <span className="text-[9px] text-green-600 bg-green-50 dark:bg-green-900/30 rounded px-1">selesai</span>}
          </div>
          {editingId === c.id ? (
            <div className="flex gap-1 mt-1">
              <input value={editText} onChange={(e) => setEditText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(c.id); if (e.key === 'Escape') setEditingId(null); }} autoFocus className="flex-1 text-xs bg-gray-50 dark:bg-gray-700 rounded px-2 py-1 outline-none" />
              <button onClick={() => saveEdit(c.id)} className="text-purple-600 cursor-pointer"><Check2 size={14} /></button>
            </div>
          ) : (
            <p className="text-sm text-gray-700 dark:text-gray-200 break-words whitespace-pre-wrap">{highlightMentions(c.body)}</p>
          )}
          {canComment && (
            <div className="flex items-center gap-2 mt-0.5 opacity-0 group-hover/c:opacity-100 transition-opacity">
              {!isReply && <button onClick={() => { setReplyTo(c.id); }} className="text-[10px] text-gray-400 hover:text-purple-600 inline-flex items-center gap-0.5 cursor-pointer"><Reply size={10} /> Balas</button>}
              <button onClick={() => toggleResolve(c)} className="text-[10px] text-gray-400 hover:text-green-600 cursor-pointer">{c.resolved ? 'Buka lagi' : 'Selesai'}</button>
              {c.authorId === currentUser?.id && <>
                <button onClick={() => { setEditingId(c.id); setEditText(c.body); }} className="text-gray-300 hover:text-purple-600 cursor-pointer"><PencilFill size={10} /></button>
                <button onClick={() => remove(c.id)} className="text-gray-300 hover:text-red-500 cursor-pointer"><Trash size={10} /></button>
              </>}
            </div>
          )}
          {repliesOf(c.id).map((r) => renderComment(r, true))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 pt-3 mt-1">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Komentar {comments.length ? `(${comments.length})` : ''}</p>
      <div className="space-y-0.5 mb-2">
        {top.length === 0 && <p className="text-xs text-gray-400">Belum ada komentar.</p>}
        {top.map((c) => renderComment(c))}
      </div>

      {canComment && (
        <div className="relative">
          {replyTo && <p className="text-[10px] text-gray-400 mb-1">Membalas komentar · <button onClick={() => setReplyTo(null)} className="text-purple-500 cursor-pointer">batal</button></p>}
          <div className="flex items-end gap-1">
            <textarea value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }} rows={2} placeholder="Tulis komentar… (Ctrl+Enter kirim)" className="flex-1 text-sm bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 outline-none focus:ring-1 focus:ring-purple-500 resize-none" />
            <div ref={mentionRef} className="relative">
              <button onClick={() => setShowMention((v) => !v)} title="Sebut anggota" aria-label="Sebut anggota" className="p-1.5 text-gray-400 hover:text-purple-600 cursor-pointer"><At size={16} /></button>
              {showMention && (
                <div className="absolute z-50 bottom-full right-0 mb-1 w-44 max-h-48 overflow-y-auto bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-100 dark:border-gray-700 p-1">
                  {members.filter((mm) => mm.userId !== currentUser?.id).map((mm) => (
                    <button key={mm.userId} onClick={() => addMention(mm.userId, mm.name)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer text-sm text-gray-700 dark:text-gray-200">
                      <span className={`w-5 h-5 rounded-full ${colorForUser(mm.userId)} text-white text-[9px] font-bold flex items-center justify-center`}>{mm.name.charAt(0).toUpperCase()}</span>
                      {mm.name}
                    </button>
                  ))}
                  {members.filter((mm) => mm.userId !== currentUser?.id).length === 0 && <p className="text-[11px] text-gray-400 px-2 py-1">Belum ada anggota lain.</p>}
                </div>
              )}
            </div>
            <button onClick={send} disabled={!body.trim()} className="bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white text-xs px-3 py-2 rounded-lg cursor-pointer shrink-0">Kirim</button>
          </div>
          {mentions.length > 0 && <p className="text-[10px] text-gray-400 mt-1">Menyebut: {mentions.map(nameOf).join(', ')}</p>}
        </div>
      )}
    </div>
  );
}

// Bold @Name tokens in a comment body.
function highlightMentions(text: string) {
  const parts = text.split(/(@[\p{L}0-9_.]+)/u);
  return parts.map((p, i) => (p.startsWith('@') ? <span key={i} className="text-purple-600 dark:text-purple-400 font-medium">{p}</span> : <span key={i}>{p}</span>));
}
