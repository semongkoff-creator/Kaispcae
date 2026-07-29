import { useState, useEffect, useCallback } from 'react';
import { GeoAltFill, BookmarkFill, ArrowUp, ArrowDown, Trash, PlusCircle } from 'react-bootstrap-icons';
import { TeleportLocation, OwnerBookmark, TILE_SIZE } from '@virtualmeet/shared';
import { api, ApiError } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';

interface TeleportPanelProps {
  roomSlug: string;
  isOwner: boolean;
  // Bug 4 — may the viewer MANAGE team locations (add/delete/reorder)? Using
  // them (jumping) is open to everyone who can see the panel; only staff+ get
  // the edit controls. The server enforces the same split independently.
  canManage: boolean;
  onTeleport: (kind: 'admin' | 'bookmark', locationId: string) => void;
  onClose: () => void;
}

const MAX_TELEPORT_LOCATIONS = 20;

// §4 — Teleport. Two independent lists (see the Prisma models' doc
// comments for why they're kept separate rather than merged): Team
// Locations (shared, staff+, capped at 20) and My Bookmarks (personal,
// owner-only, scoped to this room specifically). Reordering uses plain
// up/down buttons rather than drag-and-drop — same end result (send the
// server a full new order, see api.ts's reorder* calls) without pulling in
// a DnD library for what's a short, infrequently-reordered list.
export function TeleportPanel({ roomSlug, isOwner, canManage, onTeleport, onClose }: TeleportPanelProps) {
  const [tab, setTab] = useState<'team' | 'bookmarks'>('team');
  const [locations, setLocations] = useState<TeleportLocation[]>([]);
  const [bookmarks, setBookmarks] = useState<OwnerBookmark[]>([]);
  const [error, setError] = useState('');
  const localPlayer = useGameStore((s) => s.localPlayer);

  const loadLocations = useCallback(() => {
    api.getTeleportLocations(roomSlug).then((res) => setLocations(res.locations)).catch(() => {});
  }, [roomSlug]);

  const loadBookmarks = useCallback(() => {
    if (!isOwner) return;
    api.getBookmarks(roomSlug).then((res) => setBookmarks(res.bookmarks)).catch(() => {});
  }, [roomSlug, isOwner]);

  useEffect(() => { loadLocations(); loadBookmarks(); }, [loadLocations, loadBookmarks]);

  const currentTile = () => ({
    x: Math.floor(localPlayer.x / TILE_SIZE),
    y: Math.floor(localPlayer.y / TILE_SIZE),
  });

  const handleAddLocation = async () => {
    if (locations.length >= MAX_TELEPORT_LOCATIONS) {
      setError(`Maksimal ${MAX_TELEPORT_LOCATIONS} lokasi`);
      return;
    }
    const { x, y } = currentTile();
    const name = window.prompt('Nama lokasi:', `Lokasi ${locations.length + 1}`);
    if (!name?.trim()) return;
    try {
      await api.addTeleportLocation(roomSlug, name.trim(), x, y);
      loadLocations();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal menambah lokasi');
    }
  };

  const handleAddBookmark = async () => {
    const { x, y } = currentTile();
    const label = window.prompt('Label bookmark:', `Bookmark ${bookmarks.length + 1}`);
    if (!label?.trim()) return;
    try {
      await api.addBookmark(roomSlug, label.trim(), x, y);
      loadBookmarks();
    } catch {
      setError('Gagal menambah bookmark');
    }
  };

  const moveLocation = async (index: number, dir: -1 | 1) => {
    const next = [...locations];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setLocations(next);
    await api.reorderTeleportLocations(roomSlug, next.map((l) => l.id)).catch(() => loadLocations());
  };

  const moveBookmark = async (index: number, dir: -1 | 1) => {
    const next = [...bookmarks];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setBookmarks(next);
    await api.reorderBookmarks(roomSlug, next.map((b) => b.id)).catch(() => loadBookmarks());
  };

  return (
    <div
      className="absolute top-20 left-16 z-50 w-64 bg-white/95 dark:bg-gray-900/95 backdrop-blur-md rounded-xl border border-purple-100 dark:border-gray-700 shadow-2xl p-3 pointer-events-auto"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-gray-900 dark:text-gray-100 text-sm font-bold">Teleport</h3>
        <button onClick={onClose} className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-xs cursor-pointer">✕</button>
      </div>

      {isOwner && (
        <div className="flex gap-1 mb-3">
          <button
            onClick={() => setTab('team')}
            className={`flex-1 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${tab === 'team' ? 'bg-purple-600 text-white' : 'bg-purple-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-purple-100 dark:hover:bg-gray-600'}`}
          >
            Team
          </button>
          <button
            onClick={() => setTab('bookmarks')}
            className={`flex-1 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${tab === 'bookmarks' ? 'bg-purple-600 text-white' : 'bg-purple-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-purple-100 dark:hover:bg-gray-600'}`}
          >
            My Bookmarks
          </button>
        </div>
      )}

      {error && <p className="text-red-500 text-[10px] mb-2">{error}</p>}

      {tab === 'team' ? (
        <>
          <div className="space-y-1 mb-2 max-h-56 overflow-y-auto">
            {locations.map((loc, i) => (
              <div key={loc.id} className="flex items-center justify-between px-2 py-1.5 rounded bg-purple-50/50 dark:bg-gray-700/50 gap-1">
                <button
                  onClick={() => onTeleport('admin', loc.id)}
                  className="flex-1 flex items-center gap-1.5 text-left text-gray-700 dark:text-gray-300 text-xs truncate cursor-pointer hover:text-purple-700"
                  title={`Go to ${loc.name}`}
                >
                  <GeoAltFill size={11} className="text-purple-500 shrink-0" /> {loc.name}
                </button>
                {/* Bug 4 — reorder/delete are manage-only (staff+). Members
                    still get the jump button above. */}
                {canManage && (
                  <>
                    <button onClick={() => moveLocation(i, -1)} disabled={i === 0} className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-30 cursor-pointer"><ArrowUp size={10} /></button>
                    <button onClick={() => moveLocation(i, 1)} disabled={i === locations.length - 1} className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-30 cursor-pointer"><ArrowDown size={10} /></button>
                    <button
                      onClick={() => api.deleteTeleportLocation(roomSlug, loc.id).then(loadLocations)}
                      className="text-red-400 hover:text-red-600 cursor-pointer"
                    >
                      <Trash size={10} />
                    </button>
                  </>
                )}
              </div>
            ))}
            {locations.length === 0 && <p className="text-gray-400 dark:text-gray-500 text-[10px] text-center py-2">Belum ada lokasi.</p>}
          </div>
          {canManage && (
            <button
              onClick={handleAddLocation}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-gray-600 text-xs font-medium cursor-pointer"
            >
              <PlusCircle size={12} /> Add current location ({locations.length}/{MAX_TELEPORT_LOCATIONS})
            </button>
          )}
        </>
      ) : (
        <>
          <div className="space-y-1 mb-2 max-h-56 overflow-y-auto">
            {bookmarks.map((bm, i) => (
              <div key={bm.id} className="flex items-center justify-between px-2 py-1.5 rounded bg-purple-50/50 dark:bg-gray-700/50 gap-1">
                <button
                  onClick={() => onTeleport('bookmark', bm.id)}
                  className="flex-1 flex items-center gap-1.5 text-left text-gray-700 dark:text-gray-300 text-xs truncate cursor-pointer hover:text-purple-700"
                  title={`Go to ${bm.label}`}
                >
                  <BookmarkFill size={11} className="text-amber-500 shrink-0" /> {bm.label}
                </button>
                <button onClick={() => moveBookmark(i, -1)} disabled={i === 0} className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-30 cursor-pointer"><ArrowUp size={10} /></button>
                <button onClick={() => moveBookmark(i, 1)} disabled={i === bookmarks.length - 1} className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-30 cursor-pointer"><ArrowDown size={10} /></button>
                <button
                  onClick={() => api.deleteBookmark(roomSlug, bm.id).then(loadBookmarks)}
                  className="text-red-400 hover:text-red-600 cursor-pointer"
                >
                  <Trash size={10} />
                </button>
              </div>
            ))}
            {bookmarks.length === 0 && <p className="text-gray-400 dark:text-gray-500 text-[10px] text-center py-2">Belum ada bookmark.</p>}
          </div>
          <button
            onClick={handleAddBookmark}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-gray-600 text-xs font-medium cursor-pointer"
          >
            <PlusCircle size={12} /> Add current location
          </button>
          <p className="text-gray-400 dark:text-gray-500 text-[10px] mt-2 leading-relaxed">
            Bookmark khusus room ini — tidak ikut ke room lain.
          </p>
        </>
      )}
    </div>
  );
}
