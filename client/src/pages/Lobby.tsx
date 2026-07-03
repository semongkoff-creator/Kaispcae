import { useState, useEffect } from 'react';
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
    <div className="w-screen min-h-screen bg-gray-900 text-white">
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/5">
        <h1 className="text-xl font-bold">VirtualMeet</h1>
        <div className="flex items-center gap-3">
          <span className="text-white/60 text-sm">{user.displayName}</span>
          <button onClick={onLogout} className="text-white/40 hover:text-white text-sm cursor-pointer">Logout</button>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-6 py-8">
        {toast && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 bg-emerald-500/90 text-white text-xs px-3 py-1 rounded-full">{toast}</div>
        )}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold">Public Rooms</h2>
          <div className="flex gap-3">
            <input
              value={joinCode} onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoinByCode()}
              placeholder="Join with code..." maxLength={30}
              className="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 outline-none border border-white/10 focus:border-blue-400 w-48"
            />
            <button onClick={() => setShowCreate(!showCreate)} className="bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-lg cursor-pointer">+ Create Room</button>
          </div>
        </div>
        {showCreate && (
          <div className="bg-gray-800 rounded-xl p-4 mb-6 border border-white/10 flex gap-3 items-end">
            <div className="flex-1">
              <label className="text-white/50 text-xs block mb-1">Room Name</label>
              <input value={roomName} onChange={(e) => setRoomName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreate()} placeholder="My Awesome Room" maxLength={50} className="w-full bg-gray-700 text-white text-sm rounded-lg px-3 py-2 outline-none border border-white/10 focus:border-blue-400" />
            </div>
            <button onClick={handleCreate} className="bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium px-4 py-2 rounded-lg cursor-pointer">Create</button>
          </div>
        )}
        {loading ? (
          <p className="text-white/30">Loading rooms...</p>
        ) : rooms.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-white/30 text-lg mb-2">No rooms yet</p>
            <p className="text-white/20 text-sm">Create the first room to get started</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {rooms.map((room) => (
              <div key={room.id} className="bg-gray-800 rounded-xl p-5 border border-white/5 hover:border-blue-500/30 transition-all">
                <div className="flex items-start justify-between mb-1" onClick={() => onJoinRoom(room.slug)}>
                  <h3 className="font-semibold text-sm cursor-pointer">{room.name}</h3>
                  <span className="text-[10px] text-white/30 font-mono">{room.slug.slice(0, 8)}</span>
                </div>
                <p className="text-white/25 text-[10px] mb-3">Created by {room.ownerDisplayName}</p>
                <div className="flex items-center justify-between text-xs text-white/40">
                  <span onClick={() => onJoinRoom(room.slug)} className="cursor-pointer">{room.playerCount} / {room.maxPlayers} online</span>
                  {room.ownerId === user.id && (
                    deletingSlug === room.slug ? (
                      <div className="flex gap-1">
                        <button onClick={() => { handleDelete(room.slug); setDeletingSlug(null); }} className="text-[10px] text-red-400 hover:text-red-300 cursor-pointer">Confirm</button>
                        <button onClick={() => setDeletingSlug(null)} className="text-[10px] text-white/40 hover:text-white/70 cursor-pointer">Cancel</button>
                      </div>
                    ) : (
                      <button onClick={(e) => { e.stopPropagation(); setDeletingSlug(room.slug); }} className="text-red-400/60 hover:text-red-400 text-xs cursor-pointer">🗑️ Delete</button>
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
