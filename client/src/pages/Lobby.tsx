import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TrashFill, InfoCircle, SunFill, MoonFill, BoxArrowRight, XLg, Check2, ChevronDown, ThreeDotsVertical, Search, BoxArrowInRight, Image, GearFill, PencilFill, XCircleFill, Files } from 'react-bootstrap-icons';
import { SettingsPanel } from '@/components/ui/SettingsPanel';
import { io } from 'socket.io-client';
import { RoomTheme, RoomTemplateId, ROOM_TEMPLATES } from '@kaispace/shared';
import { api, RoomInfo } from '@/services/api';
import { UserProfile, UserPreferences } from '@/services/api';
import { showPrompt, showConfirm } from '@/stores/modalStore';
import { CreditsModal } from '@/components/ui/CreditsModal';
import { GlobalModal } from '@/components/ui/GlobalModal';
import { Theme } from '@/hooks/useTheme';
import { SERVER_URL } from '@/services/serverUrl';
import { useProfiles } from '@/hooks/useProfiles';

interface LobbyProps {
  user: UserProfile;
  onJoinRoom: (slug: string) => void;
  onLogout: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  onUpdatePreferences: (patch: UserPreferences) => void;
}

// Small preview images for the theme picker — one representative crop per theme.
const THEME_OPTIONS: { value: RoomTheme; label: string; preview: string }[] = [
  { value: 'modern-interiors', label: 'Modern Interiors', preview: '/assets/tilesets/modern-office/Modern_Office_Singles_32x32/Modern_Office_Singles_32x32_205.png' },
  { value: 'scifi-office', label: 'Sci-Fi Office', preview: '/assets/tilesets/scifi-office/Machines/arcade.rsi/icon.png' },
];

export function Lobby({ user, onJoinRoom, onLogout, theme, onToggleTheme, onUpdatePreferences }: LobbyProps) {
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
  // Real photo (for accounts that have one) — same
  // batched lookup ChatPanel/VideoGrid already use for OTHER people's
  // avatars, reused here for this account's own. Deliberately not added to
  // /auth/me's UserProfile (see that endpoint's own doc comment: the photo
  // column is heavy enough it's kept out of the hot path on purpose).
  // Falls back to the existing initials circle when null (self-registered
  // accounts with no photo, or before the lookup resolves).
  const myPhoto = useProfiles([user.id]).get(user.id)?.photo ?? null;
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
  // Figma "kaispace" reference — all four of these are purely presentational
  // additions over data that's already fetched (or an existing input just
  // moved behind a toggle, same pattern showCreate below already uses), not
  // new server logic:
  // - showUserMenu: the header chip becomes a real dropdown instead of a
  //   static chip + separate logout icon.
  // - activeTab: 'recent' (today's full list, unchanged default) vs
  //   'mine' (client-side filter to rooms this account owns — the only
  //   "my space" concept the existing RoomInfo data actually supports).
  // - search: client-side name filter over the already-fetched `rooms`
  //   array — no server search endpoint exists to call instead.
  // - showJoinInput: the join-code input now hides behind a button (Figma
  //   shows a compact "Join with Code" pill, not an always-open field),
  //   toggled exactly like showCreate already toggles the create panel.
  const [showUserMenu, setShowUserMenu] = useState(false);
  // Portaled to document.body (see below) rather than nested under <header>
  // — header has backdrop-blur-sm, which makes it a containing block for
  // fixed-position descendants, so a plain `fixed inset-0` click-catcher
  // nested inside it only covers the header's own strip, not the full
  // screen, letting clicks "pierce through" to the room grid underneath
  // while the menu stays open. Portal + window listener sidesteps this
  // entirely — same pattern as PlayerCard.tsx/Tooltip.tsx.
  const userMenuBtnRef = useRef<HTMLButtonElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [userMenuPos, setUserMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<'recent' | 'mine'>('recent');
  const [search, setSearch] = useState('');
  const [showJoinInput, setShowJoinInput] = useState(false);
  // Per-card "..." menu — same idea as showUserMenu above, just keyed by
  // which card's menu is open (only ever one at a time).
  const [openMenuSlug, setOpenMenuSlug] = useState<string | null>(null);
  // Cover-image upload — one shared hidden <input>, since only one card can
  // ever be mid-upload at a time; pendingCoverSlugRef remembers which room
  // the NEXT file-picker selection applies to (the input's onChange fires
  // after this render's closure is long gone, so it can't just be a local
  // variable). coverUploadSlug (state, not ref) drives the busy indicator.
  const coverFileInputRef = useRef<HTMLInputElement>(null);
  const pendingCoverSlugRef = useRef<string | null>(null);
  const [coverUploadSlug, setCoverUploadSlug] = useState<string | null>(null);

  const handleCoverButtonClick = (slug: string) => {
    pendingCoverSlugRef.current = slug;
    coverFileInputRef.current?.click();
  };

  const handleRename = async (slug: string, currentName: string) => {
    const next = await showPrompt('Nama baru untuk room ini:', currentName, { title: 'Ganti Nama Room' });
    if (next === null) return; // cancelled
    const trimmed = next.trim();
    if (!trimmed || trimmed === currentName) return;
    try {
      await api.renameRoom(slug, trimmed);
      setRooms((prev) => prev.map((r) => (r.slug === slug ? { ...r, name: trimmed } : r)));
      showToast('Nama room diperbarui', 'success');
    } catch {
      showToast('Gagal mengganti nama room', 'error');
    }
  };

  const handleRemoveCover = async (slug: string) => {
    const ok = await showConfirm('Hapus cover room ini? Kembali ke tampilan placeholder default.', {
      title: 'Hapus Cover', confirmLabel: 'Hapus', danger: true,
    });
    if (!ok) return;
    try {
      await api.setRoomCover(slug, null);
      setRooms((prev) => prev.map((r) => (r.slug === slug ? { ...r, coverImage: null } : r)));
      showToast('Cover dihapus', 'success');
    } catch {
      showToast('Gagal menghapus cover', 'error');
    }
  };

  // "Salin Room" — copies the room's current layout into a new room, stays
  // on the Lobby (unlike + Create Space, which jumps straight in) so the
  // admin can see the fresh card land, then decide whether to open it.
  const handleDuplicate = async (slug: string, currentName: string) => {
    const next = await showPrompt('Nama untuk room hasil salinan:', `${currentName} (Copy)`, { title: 'Salin Room' });
    if (next === null) return; // cancelled
    const trimmed = next.trim();
    if (!trimmed) return;
    try {
      await api.duplicateRoom(slug, trimmed);
      showToast('Room berhasil disalin', 'success');
      api.getRooms().then((res) => setRooms(res.rooms));
    } catch {
      showToast('Gagal menyalin room', 'error');
    }
  };

  const handleCoverFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const slug = pendingCoverSlugRef.current;
    e.target.value = ''; // allow re-picking the same file later
    if (!file || !slug) return;
    // Same validation RoomEditorPage's reference-image upload already
    // applies (uploadReferenceImage) — mirrored here rather than trusting
    // the generic /uploads endpoint's own (broader) allowlist alone.
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      showToast('Cover harus PNG atau JPEG', 'error');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast('Ukuran cover maksimal 5MB', 'error');
      return;
    }
    setCoverUploadSlug(slug);
    try {
      const { url } = await api.uploadMedia(file, slug);
      await api.setRoomCover(slug, url);
      setRooms((prev) => prev.map((r) => (r.slug === slug ? { ...r, coverImage: url } : r)));
      showToast('Cover diperbarui', 'success');
    } catch {
      showToast('Gagal mengganti cover', 'error');
    } finally {
      setCoverUploadSlug(null);
    }
  };

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

  // Newest first — matches the API's own createdAt-desc order. Tab/search
  // are both plain client-side filters on top of that, never a new fetch.
  const visibleRooms = rooms
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .filter((r) => activeTab === 'recent' || r.ownerId === user.id)
    .filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase()));

  useEffect(() => {
    // Multi-tenant Fase 4 — must send the auth token, same as useSocket.ts's
    // main game connection: the server now scopes these lobby broadcasts to
    // the caller's own org (io.to(`org:<id>`) instead of io.emit()), which
    // requires socket.data.organizationId to have been resolved at
    // handshake — an anonymous connection (as this previously was) would
    // silently stop receiving these events entirely.
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'], auth: { token: localStorage.getItem('vm_token') || undefined } });
    socket.on('lobby:room_updated', (data: { roomId: string; playerCount: number }) => {
      setRooms((prev) => prev.map((r) =>
        (r.id === data.roomId || r.slug === data.roomId) ? { ...r, playerCount: data.playerCount } : r
      ));
    });
    socket.on('lobby:room_removed', (data: { roomId: string }) => {
      setRooms((prev) => prev.filter((r) => r.id !== data.roomId && r.slug !== data.roomId));
    });
    return () => { socket.removeAllListeners(); socket.disconnect(); };
  }, []);

  useLayoutEffect(() => {
    if (!showUserMenu) { setUserMenuPos(null); return; }
    const btn = userMenuBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setUserMenuPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
  }, [showUserMenu]);

  useEffect(() => {
    if (!showUserMenu) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (userMenuRef.current?.contains(target)) return;
      if (userMenuBtnRef.current?.contains(target)) return;
      setShowUserMenu(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowUserMenu(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [showUserMenu]);

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
        <h1 className="text-xl font-bold tracking-tight text-gray-900 dark:text-gray-100">KaiSpace</h1>

        {/* User dropdown — Figma shows only plain "Name ▾", no avatar and no
            separate theme-toggle icon sitting beside it (both existed as
            visible header elements before this pass). Neither capability is
            gone: the avatar moved inside the open menu, and the theme
            toggle is now a row in that same menu instead of its own button
            — same onToggleTheme/onLogout calls, just relocated. */}
        <div className="relative">
          <button
            ref={userMenuBtnRef}
            onClick={() => setShowUserMenu((v) => !v)}
            className="flex items-center gap-1.5 cursor-pointer"
          >
            <span className="text-gray-900 dark:text-gray-100 text-sm font-medium max-w-[12rem] truncate">{user.displayName}</span>
            <ChevronDown size={12} className="text-gray-400 dark:text-gray-500 shrink-0" />
          </button>

          {showUserMenu && userMenuPos && createPortal(
              <div
                ref={userMenuRef}
                style={{ position: 'fixed', top: userMenuPos.top, right: userMenuPos.right }}
                className="w-52 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-purple-100 dark:border-gray-700 py-1.5 z-50"
              >
                <div className="flex items-center gap-2.5 px-3.5 py-2 border-b border-purple-50 dark:border-gray-700">
                  {myPhoto ? (
                    <img src={myPhoto} alt="" className="w-7 h-7 rounded-full object-cover shrink-0 shadow-sm" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-500 to-fuchsia-500 flex items-center justify-center text-white text-[11px] font-bold shrink-0 shadow-sm">
                      {userInitials}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-gray-800 dark:text-gray-100 text-sm font-medium truncate">{user.displayName}</p>
                    <p className={`text-[10px] font-semibold uppercase tracking-wide ${isAdmin ? 'text-purple-500 dark:text-purple-400' : 'text-gray-400 dark:text-gray-500'}`}>
                      {isAdmin ? 'Admin' : 'Member'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={onToggleTheme}
                  className="w-full flex items-center gap-2 px-3.5 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer"
                >
                  {theme === 'dark' ? <SunFill size={13} /> : <MoonFill size={13} />}
                  {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
                </button>
                <button
                  onClick={() => { setShowUserMenu(false); setShowSettings(true); }}
                  className="w-full flex items-center gap-2 px-3.5 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer"
                >
                  <GearFill size={13} /> Settings
                </button>
                <button
                  onClick={() => { setShowUserMenu(false); onLogout(); }}
                  className="w-full flex items-center gap-2 px-3.5 py-2 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer"
                >
                  <BoxArrowRight size={14} /> Logout
                </button>
              </div>,
              document.body
            )}
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-6 py-8">
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
              className="bg-[#3B1E54] hover:bg-[#4A1E6D] text-white text-xs font-medium px-3 py-1.5 rounded-lg cursor-pointer"
            >
              Rejoin
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          {/* Recent / My Space — Recent is today's unchanged default list;
              My Space filters client-side to rooms owned by this account
              (see visibleRooms above), the only "mine" concept the current
              data supports. */}
          <div className="flex items-center gap-4">
            <button
              onClick={() => setActiveTab('recent')}
              className={`text-sm cursor-pointer ${activeTab === 'recent' ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'}`}
            >
              Recent
            </button>
            <span className="text-gray-200 dark:text-gray-700">|</span>
            <button
              onClick={() => setActiveTab('mine')}
              className={`text-sm cursor-pointer ${activeTab === 'mine' ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'}`}
            >
              My Space
            </button>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="relative">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 pointer-events-none" />
              <input
                value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search Spaces" maxLength={50}
                className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-sm rounded-lg pl-8 pr-3 py-2 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500 w-48 shadow-sm"
              />
            </div>

            <div className="relative">
              <button
                onClick={() => setShowJoinInput((v) => !v)}
                className="flex items-center gap-1.5 bg-purple-100 hover:bg-purple-200 dark:bg-purple-900/40 dark:hover:bg-purple-900/60 text-[#3B1E54] dark:text-purple-300 text-sm font-medium px-3.5 py-2 rounded-lg cursor-pointer whitespace-nowrap"
              >
                <BoxArrowInRight size={13} /> Join with Code
              </button>
              {showJoinInput && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowJoinInput(false)} />
                  <div className="absolute right-0 top-full mt-2 w-64 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-purple-100 dark:border-gray-700 p-3 z-50">
                    <label className="text-gray-500 dark:text-gray-400 text-xs block mb-1.5">Room code</label>
                    <div className="flex gap-2">
                      <input
                        autoFocus
                        value={joinCode} onChange={(e) => setJoinCode(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleJoinByCode()}
                        placeholder="Enter code..." maxLength={30}
                        className="flex-1 bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-sm rounded-lg px-3 py-2 outline-none border border-purple-100 dark:border-gray-600 focus:border-purple-500"
                      />
                      <button
                        onClick={handleJoinByCode}
                        className="bg-[#3B1E54] hover:bg-[#4A1E6D] text-white text-sm font-medium px-3 py-2 rounded-lg cursor-pointer"
                      >
                        Go
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            {isAdmin && (
              <button onClick={() => setShowCreate(!showCreate)} className="bg-[#3B1E54] hover:bg-[#4A1E6D] text-white text-sm font-medium px-4 py-2 rounded-lg cursor-pointer whitespace-nowrap">+ Create Space</button>
            )}
          </div>
        </div>

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
            {search || activeTab === 'mine' ? (
              <p className="text-gray-400 dark:text-gray-500 text-lg">
                {search ? `Tidak ada space bernama "${search}"` : 'Kamu belum punya space sendiri'}
              </p>
            ) : (
              <>
                <p className="text-gray-400 dark:text-gray-500 text-lg mb-2">Belum ada room</p>
                <p className="text-gray-400 dark:text-gray-500 text-sm">{isAdmin ? 'Buat room pertama lewat tombol "+ Create Space" di atas.' : 'Tunggu admin membuat room, atau masuk lewat kode.'}</p>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {visibleRooms.map((room) => {
              const isConfirmingDelete = deletingSlug === room.slug;
              const isMenuOpen = openMenuSlug === room.slug;
              const handleJoinClick = () => { if (!isConfirmingDelete) onJoinRoom(room.slug); };
              return (
              <div
                key={room.id}
                onClick={handleJoinClick}
                className={`rounded-xl border shadow-sm transition-all ${
                  isConfirmingDelete
                    ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 ring-2 ring-red-200 dark:ring-red-800'
                    : 'bg-white dark:bg-gray-800 border-purple-100 dark:border-gray-700 hover:border-purple-300 hover:shadow-md cursor-pointer'
                }`}
              >
                {/* A room with no coverImage set yet still shows the Figma
                    reference's own literal "COVER IMG" placeholder.
                    overflow-hidden + rounded-t-xl moved here from the card's
                    outer div — the "..." menu below opens BELOW the button
                    (top-full), and the outer div clipping it there cut the
                    dropdown down to a barely-visible sliver poking out of
                    the card's bottom edge instead of showing it. This is the
                    only child that actually needs its own corners clipped
                    (the cover image/gradient); the outer div's rounded-xl
                    alone already reads as rounded since nothing else here
                    has a background that would bleed past it. */}
                <div className="relative aspect-[16/9] rounded-t-xl bg-gradient-to-br from-[#3B1E54] to-[#4A1E6D] flex items-center justify-center overflow-hidden">
                  {room.coverImage ? (
                    // object-contain, not cover — a cover can be any aspect
                    // ratio (a wide logo wordmark, a photo, etc.); cropping
                    // it to fill this 16:9 box zoomed into an arbitrary
                    // center slice (e.g. a wordmark losing its first
                    // and last letters). Showing the whole image letterboxed
                    // against the same gradient background is more
                    // predictable than guessing a crop that happens to work.
                    <img src={room.coverImage} alt="" className="absolute inset-0 w-full h-full object-contain" />
                  ) : (
                    <span className="text-white/40 text-xs font-medium tracking-wide">COVER IMG</span>
                  )}
                  {coverUploadSlug === room.slug && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-white text-xs">Mengunggah…</div>
                  )}
                  <span className="absolute top-3 right-3 flex items-center gap-1 bg-black/30 backdrop-blur-sm rounded-full pl-1.5 pr-2 py-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <span className="text-white text-[10px] font-medium">{room.playerCount}</span>
                  </span>
                </div>
                <div className="px-4 py-3.5 flex items-center justify-between">
                  {isConfirmingDelete ? (
                    <div className="flex items-center justify-between w-full text-xs">
                      <span className="text-red-600 dark:text-red-400 font-medium">Delete this room?</span>
                      <div className="flex gap-2">
                        <button onClick={(e) => { e.stopPropagation(); handleDelete(room.slug); setDeletingSlug(null); }} className="text-[10px] font-semibold text-white bg-red-500 hover:bg-red-600 px-2 py-1 rounded cursor-pointer">Confirm</button>
                        <button onClick={(e) => { e.stopPropagation(); setDeletingSlug(null); }} className="text-[10px] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 px-2 py-1 rounded cursor-pointer">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <h3 className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate">{room.name}</h3>
                      {/* "Ganti Cover" (any global admin — cover is a
                          room-presentation thing, same accountRole:'admin'
                          gate as "+ Create Space" above) and Delete
                          (owner-only, unchanged) share one "..." menu now
                          instead of Delete's own always-visible link. */}
                      {(room.ownerId === user.id || isAdmin) && (
                        <div className="relative shrink-0">
                          <button
                            onClick={(e) => { e.stopPropagation(); setOpenMenuSlug(isMenuOpen ? null : room.slug); }}
                            className="w-6 h-6 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer"
                          >
                            <ThreeDotsVertical size={14} />
                          </button>
                          {isMenuOpen && (
                            <>
                              <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setOpenMenuSlug(null); }} />
                              <div className="absolute right-0 top-full mt-1 w-36 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-purple-100 dark:border-gray-700 py-1 z-50">
                                {/* Rename — same gate as the "..." button itself
                                    (owner OR global admin), matching what the
                                    server's room:update check actually allows
                                    (resolveRoomRole grants 'owner' to the
                                    creator regardless of accountRole — see
                                    routes/rooms.ts's PATCH /:slug/name). */}
                                <button
                                  onClick={(e) => { e.stopPropagation(); setOpenMenuSlug(null); handleRename(room.slug, room.name); }}
                                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer"
                                >
                                  <PencilFill size={11} /> Rename
                                </button>
                                {isAdmin && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setOpenMenuSlug(null); handleCoverButtonClick(room.slug); }}
                                    className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer"
                                  >
                                    <Image size={11} /> Ganti Cover
                                  </button>
                                )}
                                {/* Hapus Cover — only shown when there's
                                    actually a cover to remove (no point
                                    offering it against the empty-placeholder
                                    state). Same isAdmin gate as Ganti Cover,
                                    since it's the same "change the room's
                                    presentation" permission, just clearing
                                    instead of setting (setRoomCover already
                                    accepts coverImage: null server-side). */}
                                {isAdmin && room.coverImage && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setOpenMenuSlug(null); handleRemoveCover(room.slug); }}
                                    className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer"
                                  >
                                    <XCircleFill size={11} /> Hapus Cover
                                  </button>
                                )}
                                {/* Salin Room — gated on isAdmin specifically
                                    (not room.ownerId), matching the SERVER's
                                    accountRole:'admin' check (duplicating
                                    creates a genuinely new room, same gate as
                                    "+ Create Space" — a non-admin owner of
                                    THIS room still can't create a new one). */}
                                {isAdmin && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setOpenMenuSlug(null); handleDuplicate(room.slug, room.name); }}
                                    className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer"
                                  >
                                    <Files size={11} /> Salin Room
                                  </button>
                                )}
                                {room.ownerId === user.id && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setDeletingSlug(room.slug); setOpenMenuSlug(null); }}
                                    className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer"
                                  >
                                    <TrashFill size={11} /> Delete
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </main>
      <footer className="max-w-6xl mx-auto px-6 py-6 flex justify-center">
        <button
          onClick={() => setShowCredits(true)}
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xs cursor-pointer inline-flex items-center gap-1.5"
        >
          <InfoCircle size={12} /> Credits / About
        </button>
      </footer>
      {showCredits && <CreditsModal onClose={() => setShowCredits(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} onUpdatePreferences={onUpdatePreferences} onLogout={onLogout} />}
      {/* Chat CS moved into ChatPanel.tsx (a new "CS" tab, in-room only) —
          see CsChatConversation.tsx. Lobby has no ChatPanel of its own, so
          Chat CS is no longer reachable from here at all (a deliberate
          product tradeoff, not an oversight). */}
      <input
        ref={coverFileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={handleCoverFileChange}
      />
      {/* App.tsx mounts its own <GlobalModal /> for the in-room view, but
          that tree is never reached while on this page (MainApp returns
          <Lobby /> in its own early-return, before GlobalModal's spot lower
          down) — so showAlert/showConfirm/showPrompt from here (e.g.
          handleRename below) pushed into modalStore with nothing ever
          rendering it, and the returned promise just hung forever with no
          dialog ever appearing. Lobby needs its own instance. */}
      <GlobalModal />
    </div>
  );
}
