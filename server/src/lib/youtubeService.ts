import { getConfig } from '../config';

// Music Bot's YouTube Data API v3 caller — same shape as larkVc.ts's
// feature-specific service functions: read config, return a clear "not
// configured" result when the key is unset (never throw), wrap the fetch in
// try/catch, and log with a [youtube] prefix on any failure.
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

export type YoutubeSearchResult =
  | { ok: true; videoId: string; title: string; thumbnail: string }
  | { ok: false; reason: 'not_configured' | 'no_results' | 'quota_exceeded' | 'error' };

export async function searchYoutube(query: string): Promise<YoutubeSearchResult> {
  const cfg = getConfig();
  if (!cfg.YOUTUBE_API_KEY) return { ok: false, reason: 'not_configured' };
  try {
    const url = `${YT_BASE}/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=1&key=${cfg.YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- YouTube's error body shape isn't worth a full type
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body?.error?.errors?.[0]?.reason;
      console.error('[youtube] search failed:', res.status, reason ?? body?.error?.message ?? 'unknown');
      // Quota exhaustion comes back as HTTP 403 with reason 'quotaExceeded'
      // (daily) or 'rateLimitExceeded' (burst) — both read the same to a
      // caller: stop hitting the API until it resets.
      if (res.status === 403 && (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded')) {
        return { ok: false, reason: 'quota_exceeded' };
      }
      return { ok: false, reason: 'error' };
    }
    const item = body?.items?.[0];
    if (!item?.id?.videoId) return { ok: false, reason: 'no_results' };
    return {
      ok: true,
      videoId: item.id.videoId,
      title: item.snippet?.title ?? 'Untitled',
      thumbnail: item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url ?? '',
    };
  } catch (e) {
    console.error('[youtube] search error:', e);
    return { ok: false, reason: 'error' };
  }
}

// Duration lookup (1 quota unit, vs 100 for search) — used only for the
// auto-advance timer; a failed/missing lookup falls back to a fixed
// duration in the caller rather than blocking playback entirely.
export async function getVideoDurationSec(videoId: string): Promise<number | null> {
  const cfg = getConfig();
  if (!cfg.YOUTUBE_API_KEY) return null;
  try {
    const res = await fetch(`${YT_BASE}/videos?part=contentDetails&id=${encodeURIComponent(videoId)}&key=${cfg.YOUTUBE_API_KEY}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[youtube] duration lookup failed:', res.status, body?.error?.message ?? 'unknown');
      return null;
    }
    const iso = body?.items?.[0]?.contentDetails?.duration;
    if (typeof iso !== 'string') return null;
    return parseIso8601Duration(iso);
  } catch (e) {
    console.error('[youtube] duration lookup error:', e);
    return null;
  }
}

// YouTube's contentDetails.duration is ISO 8601 ("PT3M33S", "PT1H2M", "PT45S").
function parseIso8601Duration(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  const hours = parseInt(m[1] ?? '0', 10);
  const minutes = parseInt(m[2] ?? '0', 10);
  const seconds = parseInt(m[3] ?? '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}
