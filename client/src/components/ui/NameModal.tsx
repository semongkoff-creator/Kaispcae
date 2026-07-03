import { useState } from 'react';

const STORAGE_KEY = 'virtualmeet-player-name';

interface NameModalProps {
  onSubmit: (name: string) => void;
}

export function NameModal({ onSubmit }: NameModalProps) {
  const savedName = localStorage.getItem(STORAGE_KEY) || '';
  const [name, setName] = useState(savedName);

  const handleSubmit = () => {
    const trimmed = name.trim();
    const displayName = trimmed || `Player-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem(STORAGE_KEY, displayName);
    onSubmit(displayName);
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl p-8 w-full max-w-sm shadow-xl shadow-purple-100/50 border border-purple-100">
        <h2 className="text-gray-900 text-xl font-bold mb-2">Welcome to VirtualMeet</h2>
        <p className="text-gray-500 text-sm mb-6">Enter your display name to join the room.</p>

        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Your name"
          autoFocus
          maxLength={20}
          className="w-full bg-purple-50/50 text-gray-900 placeholder-gray-400 rounded-lg px-4 py-3 mb-4 outline-none border border-purple-100 focus:border-purple-500 transition-colors"
        />

        <button
          onClick={handleSubmit}
          className="w-full bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-lg py-3 transition-colors cursor-pointer"
        >
          Join Room
        </button>
      </div>
    </div>
  );
}
