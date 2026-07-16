import { useState, useEffect } from 'react';
import { TrashFill, InfoCircle, SunFill, MoonFill, BoxArrowRight, XLg, Check2, Search, LockFill } from 'react-bootstrap-icons';
import { io } from 'socket.io-client';
import { RoomTheme, RoomTemplateId, ROOM_TEMPLATES } from '@virtualmeet/shared';
import { api, RoomInfo } from '@/services/api';
import { UserProfile } from '@/services/api';
import { CreditsModal } from '@/components/ui/CreditsModal';
import { Theme } from '@/hooks/useTheme';
import { SERVER_URL } from '@/services/serverUrl';

interface LobbyProps {
  user: UserProfile;
  onJoinRoom: (slug: string) => void;
  onLogout: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

// Small preview images for the theme picker — one representative crop per theme.
const THEME_OPTIONS: { value: RoomTheme; label: string; preview: string }[] = [
  { value: 'modern-interiors', label: 'Modern Interiors', preview: '/assets/tilesets/modern-office/Modern_Office_Singles_32x32/Modern_Office_Singles_32x32_205.png' },
  { value: 'scifi-office', label: 'Sci-Fi Office', preview: '/assets/tilesets/scifi-office/Machines/arcade.rsi/icon.png' },
];

export function Lobby({ user, onJoinRoom, onLogout, theme, onToggleTheme }: LobbyProps) {
  const isAdmin = user.accountRole === 'admin';
  // Initials for the header avatar chip — first letters of the first two
  // words (e.g. "Budi Santoso" → "BS"), or the first two characters for a
  // single-word name. Falls back to "?" if the display name is somehow empty.
  const userInitials = (() => {
    const parts = user.displayName.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  })();
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [roomTheme, setRoomTheme] = useState<RoomTheme>('scifi-office');
  const [roomTemplate, setRoomTemplate] = useState<RoomTemplateId>('main-office');
  const [joinCode, setJoinCode] = useState('');
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  // In-app toast (replaces the browser's native alert() for join/delete
  // feedback). `type` drives the color + icon.
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };
  const [showCredits, setShowCredits] = useState(false);
  const [nameError, setNameError] = useState(false);
  // Room-list search + sort (the list can grow to hundreds of rooms).
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'recent' | 'active'>('recent');

  useEffect(() => {
    api.getRooms()
      .then((res) => setRooms(res.rooms))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // "Continue where you left off" — only offered if that room still exists
  // (deleted rooms just silently don't show this, no dead-link risk).
  const lastRoomSlug = localStorage.getItem('vm_last_room_slug');
  const lastRoom = rooms.find((r) => r.slug === lastRoomSlug);

  // Filter by name/slug/creator, then sort. 'recent' matches the API's own
  // default createdAt-desc order; 'active' surfaces the busiest rooms first.
  const q = search.trim().toLowerCase();
  const visibleRooms = rooms
    .filter((r) =>
      !q ||
      r.name.toLowerCase().includes(q) ||
      r.slug.toLowerCase().includes(q) ||
      r.ownerDisplayName.toLowerCase().includes(q),
    )
    .slice()
    .sort((a, b) =>
      sortBy === 'active'
        ? b.playerCount - a.playerCount
        : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    socket.on('lobby:room_updated', (data: { roomId: string; playerCount: number }) => {
      setRooms((prev) => prev.map((r) =>
        (r.id === data.roomId || r.slug === data.roomId) ? { ...r, playerCount: data.playerCount } : r
      ));
    });
    socket.on('lobby:room_removed', (data: { roomId: string }) => {
      setRooms((prev) => prev.filter((r) => r.id !== data.roomId && r.slug !== data.roomId));
    });
    socket.on('lobby:room_lock', (data: { roomId: string; locked: boolean }) => {
      setRooms((prev) => prev.map((r) =>
        (r.id === data.roomId || r.slug === data.roomId) ? { ...r, locked: data.locked } : r
      ));
    });
    return () => { socket.removeAllListeners(); socket.disconnect(); };
  }, []);

  const handleCreate = async () => {
    // Previously a silent no-op — clicking Create with an empty name did
    // nothing at all, with zero feedback, which reads exactly like "the
    // button is broken" rather than "type a name first".
    if (!roomName.trim()) { setNameError(true); return; }
    setNameError(false);
    try { const room = await api.createRoom(roomName, undefined, undefined, roomTheme, roomTemplate); onJoinRoom(room.slug); } catch (err) { console.error(err); }
  };

  const handleJoinByCode = async () => {
    const code = joinCode.trim();
    if (!code) return;
    try { const room = await api.getRoom(code); onJoinRoom(room.slug); } catch { showToast(`Room "${code}" tidak ditemukan — cek lagi kodenya`, 'error'); }
  };

  const handleDelete = async (slug: string) => {
    try {
      await api.deleteRoom(slug);
      setRooms((prev) => prev.filter((r) => r.slug !== slug));
      showToast('Room dihapus', 'success');
    } catch (err) {
      showToast('Gagal menghapus room', 'error');
    }
  };

  return (
    <div className="w-screen h-screen overflow-y-auto bg-gradient-to-br from-white to-purple-50 dark:from-gray-900 dark:to-gray-950 text-gray-900 dark:text-gray-100">
      <header className="px-6 py-3.5 flex items-center justify-between border-b border-purple-100 dark:border-gray-800 backdrop-blur-sm">
        <h1 className="text-xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
          Virtual<span className="text-purple-600 dark:text-purple-400">Meet</span>
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="w-9 h-9 rounded-full border border-purple-100 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 flex items-center justify-center text-purple-600 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-700 hover:border-purple-300 dark:hover:border-gray-600 transition-colors cursor-pointer"
          >
            {theme === 'dark' ? <SunFill size={14} /> : <MoonFill size={14} />}
          </button>

          {/* User chip: initials avatar + name + role badge */}
          <div className="flex items-center gap-2.5 pl-1 pr-2.5 py-1 rounded-full border border-purple-100 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-500 to-fuchsia-500 flex items-center justify-center text-white text-[11px] font-bold shrink-0 shadow-sm">
              {userInitials}
            </div>
            <div className="flex flex-col leading-none">
              <span className="text-gray-800 dark:text-gray-100 text-sm font-medium max-w-[9rem] truncate">{user.displayName}</span>
              <span className={`text-[10px] font-semibold uppercase tracking-wide mt-0.5 ${isAdmin ? 'text-purple-500 dark:text-purple-400' : 'text-gray-400 dark:text-gray-500'}`}>
                {isAdmin ? 'Admin' : 'Member'}
              </span>
            </div>
          </div>

          <button
            onClick={onLogout}
            title="Logout"
            className="w-9 h-9 rounded-full border border-transparent text-gray-400 dark:text-gray-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 hover:border-red-200 dark:hover:border-red-800 flex items-center justify-center transition-colors cursor-pointer"
          >
            <BoxArrowRight size={16} />
          </button>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-6 py-8">
        {toast && (
          // Outer layer does the positioning (flex), so the inner card's
          // fade-in animation transform never fights a positioning transform.
          // Top-center, sitting in the header band.
          <div className="fixed inset-x-0 top-3 z-[80] flex justify-center pointer-events-none">
            <div
              role="status"
              className={`flex items-center gap-2.5 pl-3.5 pr-4 py-2.5 rounded-xl shadow-2xl border text-sm font-medium animate-fade-in ${
                toast.type === 'error'
                  ? 'bg-white dark:bg-gray-800 border-red-200 dark:border-red-800 text-red-600 dark:text-red-400'
                  : 'bg-white dark:bg-gray-800 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400'
              }`}
            >
              <span className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${toast.type === 'error' ? 'bg-red-100 dark:bg-red-900/40' : 'bg-emerald-100 dark:bg-emerald-900/40'}`}>
                {toast.type === 'error' ? <XLg size={12} /> : <Check2 size={14} />}
              </span>
              {toast.msg}
            </div>
          </div>
        )}
        {lastRoom && (
          <div className="flex items-center justify-between bg-purple-50 dark:bg-gray-800 border border-purple-100 dark:border-gray-700 rounded-xl px-4 py-3 mb-6">
            <p className="text-gray-700 dark:text-gray-300 text-sm">
              Continue where you left off — <span className="font-semibold">{lastRoom.name}</span>
            </p>
            <button
              onClick={() => onJoinRoom(lastRoom.slug)}
              className="bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium px-3 py-1.5 rounded-lg cursor-pointer"
            >
              Rejoin
            </button>
          </div>
        )}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Public Rooms</h2>
          <div className="flex gap-3">
            <input
              value={joinCode} onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoinByCode()}
              placeholder="Join with code..." maxLength={30}
              className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-sm rounded-lg px-3 py-2 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500 w-48 shadow-sm"
            />
            {isAdmin && (
              <button onClick={() => setShowCreate(!showCreate)} className="bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-4 py-2 rounded-lg cursor-pointer">+ Create Room</button>
            )}
          </div>
        </div>

        {/* Search + sort — the room list can be hundreds of rooms long. */}
        {!loading && rooms.length > 0 && (
          <div className="flex items-center gap-2 mb-5 flex-wrap">
            <div className="relative flex-1 min-w-[12rem] max-w-sm">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari room (nama / kode / pembuat)..."
                className="w-full bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-sm rounded-lg pl-8 pr-8 py-2 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500 shadow-sm"
              />
              {search && (
                <button onClick={() => setSearch('')} title="Clear" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
                  <XLg size={11} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-1 bg-purple-50 dark:bg-gray-800 rounded-lg p-0.5 border border-purple-100 dark:border-gray-700">
              {(['recent', 'active'] as const).map((key) => (
                <button
                  key={key}
                  onClick={() => setSortBy(key)}
                  className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors cursor-pointer ${
                    sortBy === key ? 'bg-purple-600 text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                  }`}
                >
                  {key === 'recent' ? 'Terbaru' : 'Paling ramai'}
                </button>
              ))}
            </div>
            <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto tabular-nums">{visibleRooms.length} room</span>
          </div>
        )}
        {showCreate && isAdmin && (
          <div className="bg-white dark:bg-gray-800 rounded-xl p-4 mb-6 border border-purple-100 dark:border-gray-700 shadow-sm">
            <div className="flex gap-3 items-end mb-3">
              <div className="flex-1">
                <label className="text-gray-500 dark:text-gray-400 text-xs block mb-1">Room Name</label>
                <input
                  value={roomName}
                  onChange={(e) => { setRoomName(e.target.value); if (nameError) setNameError(false); }}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  placeholder="My Awesome Room"
                  maxLength={50}
                  className={`w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-sm rounded-lg px-3 py-2 outline-none border focus:border-purple-500 ${nameError ? 'border-red-300 ring-1 ring-red-200' : 'border-purple-100 dark:border-gray-600'}`}
                />
                {nameError && <p className="text-red-500 text-[11px] mt-1">Type a room name first</p>}
              </div>
              <button onClick={handleCreate} className="bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium px-4 py-2 rounded-lg cursor-pointer">Create</button>
            </div>
            <label className="text-gray-500 dark:text-gray-400 text-xs block mb-1.5">Layout</label>
            <div className="flex gap-2 mb-3">
              {ROOM_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => setRoomTemplate(tpl.id)}
                  title={tpl.description}
                  className={`flex-1 text-left px-3 py-2 rounded-lg border cursor-pointer transition-all ${
                    roomTemplate === tpl.id ? 'bg-purple-50 dark:bg-gray-700 border-purple-400 ring-1 ring-purple-300' : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-600 hover:border-purple-200'
                  }`}
                >
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-200 block">{tpl.name}</span>
                  <span className="text-gray-400 dark:text-gray-500 text-[10px] block leading-snug">{tpl.description}</span>
                </button>
              ))}
            </div>
            <label className="text-gray-500 dark:text-gray-400 text-xs block mb-1.5">Theme</label>
            <div className="flex gap-2">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setRoomTheme(opt.value)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left cursor-pointer transition-all ${
                    roomTheme === opt.value ? 'bg-purple-50 dark:bg-gray-700 border-purple-400 ring-1 ring-purple-300' : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-600 hover:border-purple-200'
                  }`}
                >
                  <div
                    className="w-8 h-8 rounded bg-gray-900 shrink-0"
                    style={{
                      backgroundImage: `url(${opt.preview})`,
                      backgroundSize: 'cover',
                      imageRendering: 'pixelated',
                    }}
                  />
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{opt.label}</span>
                </button>
              ))}
            </div>
            {roomTheme === 'scifi-office' && (
              <p className="text-gray-400 dark:text-gray-500 text-[10px] mt-2">
                Uses art from Space Station 14 (CC-BY-SA 3.0).{' '}
                <button onClick={() => setShowCredits(true)} className="text-purple-500 hover:text-purple-700 underline cursor-pointer">Credits</button>
              </p>
            )}
          </div>
        )}
        {loading ? (
          <p className="text-gray-400 dark:text-gray-500">Loading rooms...</p>
        ) : rooms.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-gray-400 dark:text-gray-500 text-lg mb-2">No rooms yet</p>
            <p className="text-gray-400 dark:text-gray-500 text-sm">Create the first room to get started</p>
          </div>
        ) : visibleRooms.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-gray-400 dark:text-gray-500 text-lg mb-2">Tidak ada room yang cocok</p>
            <p className="text-gray-400 dark:text-gray-500 text-sm">Coba kata kunci lain, atau <button onClick={() => setSearch('')} className="text-purple-500 hover:text-purple-700 underline cursor-pointer">hapus pencarian</button>.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleRooms.map((room) => {
              const isConfirmingDelete = deletingSlug === room.slug;
              const handleJoinClick = () => { if (!isConfirmingDelete) onJoinRoom(room.slug); };
              return (
              <div
                key={room.id}
                className={`rounded-xl p-5 border shadow-sm transition-all ${
                  isConfirmingDelete
                    ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 ring-2 ring-red-200 dark:ring-red-800'
                    : 'bg-white dark:bg-gray-800 border-purple-100 dark:border-gray-700 hover:border-purple-300 hover:shadow-md'
                }`}
              >
                <div className="flex items-start justify-between mb-1" onClick={handleJoinClick}>
                  <h3 className={`font-semibold text-sm text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5 ${isConfirmingDelete ? '' : 'cursor-pointer'}`}>
                    {room.locked && (
                      <span title="Locked — knock to enter" className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 shrink-0">
                        <LockFill size={9} />
                      </span>
                    )}
                    {room.name}
                  </h3>
                  <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">{room.slug.slice(0, 8)}</span>
                </div>
                <p className="text-gray-400 dark:text-gray-500 text-[10px] mb-3">Created by {room.ownerDisplayName}</p>
                {isConfirmingDelete ? (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-red-600 dark:text-red-400 font-medium">Delete this room permanently?</span>
                    <div className="flex gap-2">
                      <button onClick={() => { handleDelete(room.slug); setDeletingSlug(null); }} className="text-[10px] font-semibold text-white bg-red-500 hover:bg-red-600 px-2 py-1 rounded cursor-pointer">Confirm</button>
                      <button onClick={() => setDeletingSlug(null)} className="text-[10px] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 px-2 py-1 rounded cursor-pointer">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                    <span onClick={handleJoinClick} className="cursor-pointer">{room.playerCount} / {room.maxPlayers} online</span>
                    {room.ownerId === user.id && (
                      <button onClick={(e) => { e.stopPropagation(); setDeletingSlug(room.slug); }} className="text-red-500/70 hover:text-red-500 text-xs cursor-pointer inline-flex items-center gap-1"><TrashFill size={11} /> Delete</button>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </main>
      <footer className="max-w-4xl mx-auto px-6 py-6 flex justify-center">
        <button
          onClick={() => setShowCredits(true)}
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xs cursor-pointer inline-flex items-center gap-1.5"
        >
          <InfoCircle size={12} /> Credits / About
        </button>
      </footer>
      {showCredits && <CreditsModal onClose={() => setShowCredits(false)} />}
    </div>
  );
}
