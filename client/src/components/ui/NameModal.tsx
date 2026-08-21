import { useState } from 'react';

interface NameModalProps {
  // specs/2026-08-21-room-entry-name-prompt-design.md — the caller decides
  // the pre-fill (App.tsx: playerName ?? user.displayName, itself seeded
  // from user.roomDisplayName ?? user.displayName at login). This
  // component no longer reads localStorage itself.
  initialName: string;
  onSubmit: (name: string) => void;
}

export function NameModal({ initialName, onSubmit }: NameModalProps) {
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();

  // specs/2026-08-21-room-entry-name-prompt-design.md — deliberate reversal
  // of this component's old behavior: empty/whitespace-only input is now a
  // hard block, not a "Player-xxxx" random fallback. The submit button
  // stays disabled until there's a real name, mirroring GuestEntry.tsx's
  // existing `disabled={loading || !name.trim() || !password}` pattern.
  const handleSubmit = () => {
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 w-full max-w-sm shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700">
        <h2 className="text-gray-900 dark:text-gray-100 text-xl font-bold mb-2">Welcome to KaiSpace</h2>
        <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">Enter your display name to join the room.</p>

        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Your name"
          autoFocus
          maxLength={20}
          className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-4 py-3 mb-4 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500 transition-colors"
        />

        <button
          onClick={handleSubmit}
          disabled={!trimmed}
          className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-3 transition-colors cursor-pointer"
        >
          Join Room
        </button>
      </div>
    </div>
  );
}
