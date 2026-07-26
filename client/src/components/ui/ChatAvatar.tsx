// Chat avatar — a round initial (or a photo, once profile photos exist). Kept
// as its own component precisely so that future work only has to start passing
// `photoUrl` and nothing else about the chat layout changes.
interface ChatAvatarProps {
  name: string;
  color: string;
  // Not used yet (no profile-photo upload exists) — the whole reason this is a
  // separate component is so wiring photos in later is a one-line change here.
  photoUrl?: string;
  size?: number;
}

export function ChatAvatar({ name, color, photoUrl, size = 28 }: ChatAvatarProps) {
  const initial = (name?.trim()?.[0] ?? '?').toUpperCase();
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name}
        className="rounded-full object-cover shrink-0 self-end"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0 self-end text-white font-semibold select-none"
      style={{ width: size, height: size, backgroundColor: color, fontSize: Math.round(size * 0.42) }}
      title={name}
    >
      {initial}
    </div>
  );
}

// Stable colour per user: the same seed (a userId, or a name when that's all we
// have) always maps to the same palette entry, so a person keeps one avatar
// colour across the whole conversation. Palette is fixed and hand-picked to
// stay legible with white text in both light and dark mode.
const AVATAR_PALETTE = [
  '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04',
  '#16a34a', '#0891b2', '#2563eb', '#9333ea', '#4f46e5',
];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
