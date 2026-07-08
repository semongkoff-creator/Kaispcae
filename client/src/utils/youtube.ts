// §6 — Add Media (YouTube). Users paste whatever URL shape they have handy
// (share link, mobile link, or one that's already an embed) — this covers
// the formats the spec explicitly calls out: youtube.com/watch?v=, youtu.be/,
// m.youtube.com, plus youtube.com/embed/ for completeness.
export function parseYouTubeId(url: string): string | null {
  const trimmed = url.trim();
  const patterns = [
    /(?:youtube\.com|m\.youtube\.com)\/watch\?(?:.*&)?v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }
  // Bare video id pasted directly, no URL at all.
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  return null;
}
