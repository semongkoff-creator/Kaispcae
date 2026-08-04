import { useEffect, useState, useCallback } from 'react';
import { XLg, ArrowClockwise, CheckCircleFill } from 'react-bootstrap-icons';
import { api, ApiError, LarkChatSummary } from '@/services/api';

// Bagian 4 — admin UI for binding this room's #general channel to a Lark
// group. The sync mechanism itself (server/src/lib/larkChatSync.ts, an
// inbound webhook + outbound relay on every channel message) was already
// fully built; this was the missing piece — GET/PUT /api/rooms/:slug/
// lark-map (routes/larkChatMap.ts) had no caller anywhere in the client,
// so no room could ever actually be mapped and nothing ever reached Lark,
// not because the sync was broken but because there was no way to turn it
// on. `chats` (every group the bot already belongs to) comes back from the
// same GET call — the bot must be manually invited to a group in Lark
// first; this panel only lets an admin PICK from ones it's already in.
export function LarkSyncPanel({ roomSlug, onClose }: { roomSlug: string; onClose: () => void }) {
  const [chats, setChats] = useState<LarkChatSummary[]>([]);
  const [mappedChatId, setMappedChatId] = useState<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { map, chats } = await api.getLarkChatMap(roomSlug);
      setChats(chats);
      setMappedChatId(map?.chatId ?? null);
      setSelectedChatId(map?.chatId ?? null);
    } catch {
      setError('Gagal memuat daftar grup Lark.');
    } finally {
      setLoading(false);
    }
  }, [roomSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const chat = chats.find((c) => c.chatId === selectedChatId);
      await api.setLarkChatMap(roomSlug, selectedChatId, chat?.name ?? null);
      setMappedChatId(selectedChatId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal menyimpan pemetaan grup Lark.');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    setError('');
    try {
      await api.setLarkChatMap(roomSlug, null);
      setMappedChatId(null);
      setSelectedChatId(null);
    } catch {
      setError('Gagal menghapus pemetaan grup Lark.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="absolute inset-0 z-40 bg-purple-50/95 dark:bg-gray-900/95 backdrop-blur-md pl-14 pointer-events-auto overflow-y-auto">
      <div className="max-w-2xl mx-auto px-5 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-gray-900 dark:text-gray-100 text-lg font-bold">Lark Sync</h2>
            <p className="text-gray-500 dark:text-gray-400 text-xs">
              Hubungkan channel #general room ini ke grup Lark — pesan (termasuk @mention) akan saling sinkron dua arah.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void load()} title="Muat ulang" className="text-gray-500 hover:text-purple-600 dark:text-gray-400 cursor-pointer p-1.5"><ArrowClockwise size={16} /></button>
            <button onClick={onClose} title="Tutup" className="text-gray-500 hover:text-gray-800 dark:text-gray-400 cursor-pointer p-1.5"><XLg size={18} /></button>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm py-10 text-center">Memuat daftar grup Lark…</p>
        ) : (
          <>
            {error && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs px-3 py-2 mb-3 flex items-center justify-between">
                <span>{error}</span>
                <button onClick={() => void load()} className="underline cursor-pointer">Coba lagi</button>
              </div>
            )}

            {chats.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-sm py-6 text-center">
                Bot Lark belum tergabung di grup manapun. Undang bot ke grup Lark tujuan dulu, lalu klik muat ulang.
              </p>
            ) : (
              <div className="space-y-1.5 mb-4">
                {chats.map((c) => {
                  const selected = selectedChatId === c.chatId;
                  return (
                    <button
                      key={c.chatId}
                      onClick={() => setSelectedChatId(c.chatId)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left text-sm cursor-pointer transition-colors ${
                        selected
                          ? 'bg-purple-100 dark:bg-purple-900/30 border-purple-400 dark:border-purple-600 text-purple-900 dark:text-purple-200'
                          : 'bg-white dark:bg-gray-800 border-purple-100 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:border-purple-300'
                      }`}
                    >
                      <span className="truncate">{c.name}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {mappedChatId === c.chatId && <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">Aktif</span>}
                        {selected && <CheckCircleFill size={14} className="text-purple-600 dark:text-purple-400" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => void handleSave()}
                disabled={saving || !selectedChatId || selectedChatId === mappedChatId}
                className="flex-1 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium cursor-pointer"
              >
                {saving ? 'Menyimpan…' : 'Simpan pemetaan'}
              </button>
              {mappedChatId && (
                <button
                  onClick={() => void handleClear()}
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 text-gray-600 dark:text-gray-300 text-sm cursor-pointer"
                >
                  Hapus
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
