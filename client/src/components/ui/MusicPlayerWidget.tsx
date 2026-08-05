import { useEffect, useMemo, useRef } from 'react';
import { useGameStore } from '@/stores/gameStore';

interface MusicPlayerWidgetProps {
  // The zone the local player is currently standing in, or null on the open
  // floor — Music Bot sessions are strictly per-zone (see musicHandler.ts),
  // so this only ever plays THAT zone's session, never any other zone's,
  // even if one elsewhere in the room happens to be playing too.
  zoneId: string | null;
}

// Headless playback for Music Bot (!play/!skip/!pause/!resume/!queue/!stop in
// ChatPanel's zone chat) — deliberately renders NO visible box, thumbnail, or
// button anywhere. The chat command is the only control surface; the bot's
// own chat replies ("Now playing: ...") are the only "now playing" indicator.
//
// display:none is NOT used to hide the iframe — browsers can pause/throttle
// media on elements removed from layout that way. It also must NOT be
// positioned off-screen (e.g. left: -9999px) for the same reason: Chrome's
// viewport-intersection throttling treats an iframe that never intersects
// the viewport rect the same as an invisible one, and throttles its
// internal requestAnimationFrame loop — which is exactly what YouTube's
// embedded player uses for buffering/quality-adaptation timing, so the
// audio came out continuously glitchy/stuttering even though the postMessage
// play/pause control itself worked fine. Kept inside the viewport at (0,0)
// instead, shrunk to 1x1 and opacity:0 so it's imperceptible without ever
// leaving the intersecting/visible region the browser's media pipeline
// checks.
export function MusicPlayerWidget({ zoneId }: MusicPlayerWidgetProps) {
  const session = useGameStore((s) => (zoneId ? s.musicSessionsByZone[zoneId] : undefined));
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const current = session?.current ?? null;
  const videoId = current?.track.videoId ?? null;

  // Pause/resume in place via postMessage rather than reloading the iframe
  // (a reload would restart the video from 0, discarding the whole point of
  // MusicSessionState.pausedAt keeping playback position across a pause).
  // This fires purely off server state pushed by the !pause/!resume chat
  // commands — there is no local click/drag handler anywhere driving it.
  useEffect(() => {
    const w = iframeRef.current?.contentWindow;
    if (!w || !current) return;
    const func = current.pausedAt !== null ? 'pauseVideo' : 'playVideo';
    w.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');
    // Only re-run when pause state flips or the track itself changes — NOT
    // on every startedAt adjustment (resume shifts startedAt forward, which
    // would otherwise needlessly re-fire this).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.pausedAt, videoId]);

  // Bug — this used to be a plain `const` recomputed on every render (via
  // Date.now() while playing), baked straight into the iframe's `src`. Since
  // `key` only changes on an actual track change, React doesn't remount for
  // a pause/resume — it just patches the existing iframe's `src` attribute,
  // and setting .src on an already-live iframe forces a full reload/
  // navigation. That reload spun up a BRAND NEW YouTube player (autoplay=1)
  // that started playing from scratch, racing the pauseVideo postMessage
  // sent in the very same render — the reload always won, so a chat "Lagu
  // sudah dijeda" confirmation never actually paused anything, and ANY
  // MUSIC_STATE broadcast for the zone (someone else's !play, a resume, …)
  // could unexpectedly restart playback for everyone. Memoized on videoId
  // ALONE — computed once when a track first appears, never touched again
  // by a later pause/resume — so postMessage is the only thing that ever
  // controls play/pause after the initial embed.
  const src = useMemo(() => {
    if (!current || !videoId) return null;
    // Elapsed playback at embed time — a client that joins the zone (or
    // just had the tab backgrounded) after a track already started embeds
    // roughly in sync instead of from 0:00. A tab that joins the zone
    // mid-song gets this same MusicSessionState pushed the moment
    // ZONE_ENTER is handled (see zoneHandler.ts's sendMusicStateToSocket),
    // so audio starts on its own — no click, no popup to dismiss.
    const elapsedSec = current.pausedAt !== null
      ? Math.max(0, Math.floor((current.pausedAt - current.startedAt) / 1000))
      : Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000));
    return `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=0&rel=0&enablejsapi=1&start=${elapsedSec}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  if (!zoneId || !current || !videoId || !src) return null;

  return (
    <iframe
      key={videoId}
      ref={iframeRef}
      title="Music Bot audio (hidden — control via chat commands only)"
      src={src}
      allow="autoplay; encrypted-media"
      style={{ position: 'fixed', left: 0, top: 0, width: 1, height: 1, opacity: 0, border: 'none', pointerEvents: 'none' }}
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
