import { getConfig } from '../config';

// Music Bot's YouTube Data API v3 caller — same shape as the other
// feature-specific service functions: read config, return a clear "not
// configured" result when the key is unset (never throw), wrap the fetch in
// try/catch, and log with a [youtube] prefix on any failure.
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

// QA (Stabilitas checklist item 12, "Kuota biaya API") — the free tier's
// default daily budget is 10,000 units; search.list costs 100/call,
// videos.list (duration lookup) costs 1. Previously the ONLY guard was
// musicHandler.ts's 10s-per-socket cooldown, which bounds burst rate but
// not total daily volume — a single account alone could still exhaust the
// entire day's quota well before anyone noticed (100 units/call means the
// free tier's whole budget is only ~100 searches/day). This is a
// PROACTIVE, in-memory (not per-account — global, matching how the quota
// itself is billed per API key/project, not per user) counter that refuses
// a call BEFORE it's made once the budget's gone, rather than only
// reacting to Google's own 403 after the fact (searchYoutube/
// getVideoDurationSec below still keep that reactive handling too, as a
// backstop for whatever this estimate doesn't perfectly track). Resets at
// WIB midnight — arbitrary but consistent with this codebase's other
// daily-boundary conventions.
// Conservative default (80% of the free tier) leaves headroom for the
// duration-lookup calls layered on top of every search.
const DAILY_UNIT_BUDGET = Number(process.env.YOUTUBE_DAILY_UNIT_BUDGET) || 8000;
const SEARCH_COST_UNITS = 100;
const DURATION_LOOKUP_COST_UNITS = 1;

function wibToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

let quotaDay = wibToday();
let unitsUsedToday = 0;

function tryReserveUnits(cost: number): boolean {
  const today = wibToday();
  if (today !== quotaDay) { quotaDay = today; unitsUsedToday = 0; }
  if (unitsUsedToday + cost > DAILY_UNIT_BUDGET) return false;
  unitsUsedToday += cost;
  return true;
}

// Exposed for /api/health (see index.ts) — an operator watching for
// runaway usage otherwise has no visibility into this at all.
export function getYoutubeQuotaStatus(): { unitsUsedToday: number; dailyBudget: number; day: string } {
  const today = wibToday();
  if (today !== quotaDay) { quotaDay = today; unitsUsedToday = 0; }
  return { unitsUsedToday, dailyBudget: DAILY_UNIT_BUDGET, day: quotaDay };
}

export type YoutubeSearchResult =
  | { ok: true; videoId: string; title: string; thumbnail: string }
  | { ok: false; reason: 'not_configured' | 'no_results' | 'quota_exceeded' | 'error' };

export async function searchYoutube(query: string): Promise<YoutubeSearchResult> {
  const cfg = getConfig();
  if (!cfg.YOUTUBE_API_KEY) return { ok: false, reason: 'not_configured' };
  if (!tryReserveUnits(SEARCH_COST_UNITS)) {
    console.warn('[youtube] daily unit budget reached — refusing search before calling the API');
    return { ok: false, reason: 'quota_exceeded' };
  }
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
  if (!tryReserveUnits(DURATION_LOOKUP_COST_UNITS)) {
    console.warn('[youtube] daily unit budget reached — skipping duration lookup');
    return null;
  }
  try {
    const res = await fetch(`${YT_BASE}/videos?part=contentDetails&id=${encodeURIComponent(videoId)}&key=${cfg.YOUTUBE_API_KEY}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[youtube] duration lookup failed:', res.status, body?.error?.message ?? 'unknown');
      return null;
    }
    const iso = body?.items?.[0]?.contentDetails?.duration;
    if (typeof iso !== 'string') {
      console.log(`[youtube-diag] ${videoId} — no contentDetails.duration in response`);
      return null;
    }
    const parsed = parseIso8601Duration(iso);
    console.log(`[youtube-diag] ${videoId} — duration "${iso}" parsed as ${parsed}s`);
    return parsed;
  } catch (e) {
    console.error('[youtube] duration lookup error:', e);
    return null;
  }
}

// YouTube's contentDetails.duration is ISO 8601 ("PT3M33S", "PT1H2M", "PT45S").
// Bug fix — an unparseable string (e.g. "P0D" for a livestream, which has no
// "T" time component at all) used to return 0 here, and getVideoDurationSec's
// `?? FALLBACK_DURATION_SEC` never caught it since 0 isn't nullish — the
// caller then scheduled the auto-advance timer to fire almost immediately
// instead of falling back to the 4-minute default. Returns null on a genuine
// parse failure now so the fallback actually applies.
function parseIso8601Duration(iso: string): number | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const hours = parseInt(m[1] ?? '0', 10);
  const minutes = parseInt(m[2] ?? '0', 10);
  const seconds = parseInt(m[3] ?? '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}
