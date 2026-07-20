import { FileEarmarkFill, Download } from 'react-bootstrap-icons';

// Shared visual language for BOTH chat surfaces — the floating in-room panel
// (ChatPanel.tsx) and the full-screen module (MessengerApp.tsx). They are two
// views of the same conversations, so they have to look like the same product;
// keeping the avatar/bubble/date primitives here is what stops them drifting
// into two different-looking chats.

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
export const VIDEO_EXT_RE = /\.(mp4|webm|mov|avi)$/i;

// Deterministic per-person tint. Seeded on the user id, not the display name,
// so someone's colour survives a rename.
const AVATAR_TINTS = [
  'bg-rose-500', 'bg-orange-500', 'bg-amber-500', 'bg-lime-600',
  'bg-emerald-500', 'bg-teal-500', 'bg-sky-500', 'bg-indigo-500',
  'bg-violet-500', 'bg-fuchsia-500',
];

export function tintFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length];
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ name, seed, size = 40 }: { name: string; seed: string; size?: number }) {
  return (
    <div
      className={`${tintFor(seed)} rounded-full flex items-center justify-center text-white font-semibold shrink-0 select-none`}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.36) }}
    >
      {initialsOf(name)}
    </div>
  );
}

// A channel reads as a "#" tile rather than a person — the same distinction
// Lark draws between a group and a DM.
export function ChannelTile({ size = 40 }: { size?: number }) {
  return (
    <div
      className="rounded-lg bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-300 font-semibold shrink-0"
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.4) }}
    >
      #
    </div>
  );
}

// Conversation-list column: today → clock, yesterday → word, older → date.
export function listTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }
  const yst = new Date(now);
  yst.setDate(now.getDate() - 1);
  if (d.toDateString() === yst.toDateString()) return 'Kemarin';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Hari ini';
  const yst = new Date(now);
  yst.setDate(now.getDate() - 1);
  if (d.toDateString() === yst.toDateString()) return 'Kemarin';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

// Consecutive messages from one person within a few minutes stack without
// repeating the avatar and name — a wall of repeated names is noise.
export const GROUPING_WINDOW_MS = 5 * 60 * 1000;

export function isSameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

// Images and videos preview inline; everything else is a download row rather
// than a guess at how to render an arbitrary file type. The inline <img> uses
// a fixed box so a tiny sticker still reads as a deliberate preview instead of
// rendering at its native postage-stamp size.
export function Attachment({ url, fileName, own, compact = false }: { url: string; fileName?: string; own: boolean; compact?: boolean }) {
  if (IMAGE_EXT_RE.test(url)) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block mb-1">
        <img
          src={url}
          alt={fileName || 'Lampiran'}
          className={compact ? 'w-32 h-24 rounded-lg object-cover bg-gray-100' : 'max-w-full max-h-72 rounded-lg'}
        />
      </a>
    );
  }
  if (VIDEO_EXT_RE.test(url)) {
    return <video src={url} controls className={`${compact ? 'w-48' : 'max-w-full max-h-72'} rounded-lg mb-1 bg-black`} />;
  }
  return (
    <a
      href={url}
      download={fileName}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center gap-2 mb-1 px-2.5 py-2 rounded-lg text-xs ${
        own ? 'bg-white/20 hover:bg-white/30' : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'
      }`}
    >
      <FileEarmarkFill size={14} className="shrink-0" />
      <span className="truncate flex-1">{fileName || 'Unduh berkas'}</span>
      <Download size={12} className="shrink-0" />
    </a>
  );
}
