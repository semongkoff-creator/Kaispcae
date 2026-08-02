import { useEffect, useRef } from 'react';
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
// media on elements removed from layout that way. Instead it's rendered at
// its normal size but shoved off-screen via fixed positioning, well outside
// the viewport, so nothing is ever painted on screen while the media
// pipeline still treats it as a live, playing element.
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

  if (!zoneId || !current || !videoId) return null;

  // Elapsed playback at embed time — a client that joins the zone (or just
  // had the tab backgrounded) after a track already started embeds roughly
  // in sync instead of from 0:00. A tab that joins the zone mid-song gets
  // this same MusicSessionState pushed the moment ZONE_ENTER is handled (see
  // zoneHandler.ts's sendMusicStateToSocket), so audio starts on its own —
  // no click, no popup to dismiss.
  const elapsedSec = current.pausedAt !== null
    ? Math.max(0, Math.floor((current.pausedAt - current.startedAt) / 1000))
    : Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000));

  return (
    <iframe
      key={videoId}
      ref={iframeRef}
      title="Music Bot audio (hidden — control via chat commands only)"
      src={`https://www.youtube.com/embed/${videoId}?autoplay=1&mute=0&rel=0&enablejsapi=1&start=${elapsedSec}`}
      allow="autoplay; encrypted-media"
      style={{ position: 'fixed', left: '-9999px', top: '-9999px', width: 1, height: 1, border: 'none' }}
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
