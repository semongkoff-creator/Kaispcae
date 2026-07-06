import { useState, useEffect } from 'react';
import { TrashFill } from 'react-bootstrap-icons';
import { io } from 'socket.io-client';
import { api, RoomInfo } from '@/services/api';
import { UserProfile } from '@/services/api';

interface LobbyProps {
  user: UserProfile;
  onJoinRoom: (slug: string) => void;
  onLogout: () => void;
}

export function Lobby({ user, onJoinRoom, onLogout }: LobbyProps) {
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [toast, setToast] = useState('');

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

  useEffect(() => {
    const socket = io('http://localhost:3001', { transports: ['websocket', 'polling'] });
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

  const handleCreate = async () => {
    if (!roomName.trim()) return;
    try { const room = await api.createRoom(roomName); onJoinRoom(room.slug); } catch (err) { console.error(err); }
  };

  const handleJoinByCode = async () => {
    const code = joinCode.trim();
    if (!code) return;
    try { const room = await api.getRoom(code); onJoinRoom(room.slug); } catch { alert('Room not found'); }
  };

  const handleDelete = async (slug: string) => {
    try {
      await api.deleteRoom(slug);
      setRooms((prev) => prev.filter((r) => r.slug !== slug));
      setToast('Room deleted');
      setTimeout(() => setToast(''), 2000);
    } catch (err) {
      alert('Failed to delete room');
    }
  };

  return (
    <div className="w-screen min-h-screen bg-gradient-to-br from-white to-purple-50 text-gray-900">
      <header className="px-6 py-4 flex items-center justify-between border-b border-purple-100">
        <h1 className="text-xl font-bold text-gray-900">VirtualMeet</h1>
        <div className="flex items-center gap-3">
          <span className="text-gray-500 text-sm">{user.displayName}</span>
          <button onClick={onLogout} className="text-gray-400 hover:text-gray-700 text-sm cursor-pointer">Logout</button>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-6 py-8">
        {toast && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 bg-emerald-500/90 text-white text-xs px-3 py-1 rounded-full">{toast}</div>
        )}
        {lastRoom && (
          <div className="flex items-center justify-between bg-purple-50 border border-purple-100 rounded-xl px-4 py-3 mb-6">
            <p className="text-gray-700 text-sm">
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
          <h2 className="text-lg font-semibold text-gray-900">Public Rooms</h2>
          <div className="flex gap-3">
            <input
              value={joinCode} onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoinByCode()}
              placeholder="Join with code..." maxLength={30}
              className="bg-white text-gray-900 placeholder-gray-400 text-sm rounded-lg px-3 py-2 outline-none border border-purple-100 focus:border-purple-500 w-48 shadow-sm"
            />
            <button onClick={() => setShowCreate(!showCreate)} className="bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-4 py-2 rounded-lg cursor-pointer">+ Create Room</button>
          </div>
        </div>
        {showCreate && (
          <div className="bg-white rounded-xl p-4 mb-6 border border-purple-100 shadow-sm flex gap-3 items-end">
            <div className="flex-1">
              <label className="text-gray-500 text-xs block mb-1">Room Name</label>
              <input value={roomName} onChange={(e) => setRoomName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreate()} placeholder="My Awesome Room" maxLength={50} className="w-full bg-purple-50/50 text-gray-900 placeholder-gray-400 text-sm rounded-lg px-3 py-2 outline-none border border-purple-100 focus:border-purple-500" />
            </div>
            <button onClick={handleCreate} className="bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium px-4 py-2 rounded-lg cursor-pointer">Create</button>
          </div>
        )}
        {loading ? (
          <p className="text-gray-400">Loading rooms...</p>
        ) : rooms.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-gray-400 text-lg mb-2">No rooms yet</p>
            <p className="text-gray-400 text-sm">Create the first room to get started</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {rooms.map((room) => {
              const isConfirmingDelete = deletingSlug === room.slug;
              const handleJoinClick = () => { if (!isConfirmingDelete) onJoinRoom(room.slug); };
              return (
              <div
                key={room.id}
                className={`rounded-xl p-5 border shadow-sm transition-all ${
                  isConfirmingDelete
                    ? 'bg-red-50 border-red-200 ring-2 ring-red-200'
                    : 'bg-white border-purple-100 hover:border-purple-300 hover:shadow-md'
                }`}
              >
                <div className="flex items-start justify-between mb-1" onClick={handleJoinClick}>
                  <h3 className={`font-semibold text-sm text-gray-900 ${isConfirmingDelete ? '' : 'cursor-pointer'}`}>{room.name}</h3>
                  <span className="text-[10px] text-gray-400 font-mono">{room.slug.slice(0, 8)}</span>
                </div>
                <p className="text-gray-400 text-[10px] mb-3">Created by {room.ownerDisplayName}</p>
                {isConfirmingDelete ? (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-red-600 font-medium">Delete this room permanently?</span>
                    <div className="flex gap-2">
                      <button onClick={() => { handleDelete(room.slug); setDeletingSlug(null); }} className="text-[10px] font-semibold text-white bg-red-500 hover:bg-red-600 px-2 py-1 rounded cursor-pointer">Confirm</button>
                      <button onClick={() => setDeletingSlug(null)} className="text-[10px] text-gray-500 hover:text-gray-700 bg-white border border-gray-200 px-2 py-1 rounded cursor-pointer">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between text-xs text-gray-500">
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
    </div>
  );
}
