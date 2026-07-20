import { PresenceUser } from '@virtualmeet/shared';

// Avatars of everyone currently viewing this base (top-right). Own avatar is
// shown first with a subtle ring; a soft colour per user id keeps them
// distinguishable (also reused for edit-cell outlines in Fase B).
const AVATAR_COLORS = ['bg-purple-500', 'bg-blue-500', 'bg-green-500', 'bg-amber-500', 'bg-pink-500', 'bg-teal-500', 'bg-red-500'];
export function colorForUser(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function PresenceBar({ users, meId }: { users: PresenceUser[]; meId: string }) {
  if (!users.length) return null;
  const ordered = [...users].sort((a, b) => (a.userId === meId ? -1 : b.userId === meId ? 1 : 0));
  const shown = ordered.slice(0, 5);
  const extra = ordered.length - shown.length;
  return (
    <div className="flex items-center -space-x-1.5" title={`${users.length} orang sedang membuka`}>
      {shown.map((u) => (
        <span
          key={u.userId}
          title={u.userId === meId ? `${u.name} (kamu)` : u.name}
          className={`w-6 h-6 rounded-full ${colorForUser(u.userId)} text-white text-[10px] font-bold flex items-center justify-center border-2 border-white dark:border-gray-900 ${u.userId === meId ? 'ring-2 ring-purple-300' : ''}`}
        >
          {u.name.charAt(0).toUpperCase()}
        </span>
      ))}
      {extra > 0 && <span className="w-6 h-6 rounded-full bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-200 text-[10px] font-bold flex items-center justify-center border-2 border-white dark:border-gray-900">+{extra}</span>}
    </div>
  );
}
