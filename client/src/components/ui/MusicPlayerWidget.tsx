import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '@/stores/gameStore';

interface MusicPlayerWidgetProps {
  // The zone the local player is currently standing in, or null on the open
  // floor — Music Bot sessions are strictly per-zone (see musicHandler.ts),
  // so this widget only ever shows THAT zone's session, never any other
  // zone's, even if one elsewhere in the room happens to be playing too.
  zoneId: string | null;
}

// Renders whenever the current zone has an active Music Bot session (see
// !play/!skip/etc in ChatPanel's "Private" zone chat tab). A small embedded
// YouTube iframe, same postMessage IFrame API convention as the existing Add
// Media YouTube auto-embed in GameCanvas.tsx (autoplay muted, with an
// explicit "Nyalakan suara" unmute button — browsers block autoplay with
// sound regardless of what the embed URL asks for).
export function MusicPlayerWidget({ zoneId }: MusicPlayerWidgetProps) {
  const session = useGameStore((s) => (zoneId ? s.musicSessionsByZone[zoneId] : undefined));
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [unmuted, setUnmuted] = useState(false);

  const current = session?.current ?? null;
  const videoId = current?.track.videoId ?? null;

  // Reset the unmute affordance whenever the embedded video itself changes —
  // otherwise switching tracks silently carries over the PREVIOUS video's
  // mute state instead of re-prompting.
  useEffect(() => { setUnmuted(false); }, [videoId]);

  // Pause/resume in place via postMessage rather than reloading the iframe
  // (a reload would restart the video from 0, discarding the whole point of
  // MusicSessionState.pausedAt keeping playback position across a pause).
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

  if (!zoneId || !current) return null;

  // Elapsed playback at embed time — a client that joins the zone (or just
  // had the tab backgrounded) after a track already started embeds roughly
  // in sync instead of from 0:00. There is no continuous re-sync afterward;
  // YouTube's own playback clock takes over from here, which is close
  // enough for a "listen together" cue and not worth a drift-correction loop.
  const elapsedSec = current.pausedAt !== null
    ? Math.max(0, Math.floor((current.pausedAt - current.startedAt) / 1000))
    : Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000));

  return (
    <div className="absolute bottom-24 right-4 z-30 w-64 rounded-xl overflow-hidden shadow-2xl border border-purple-200 dark:border-purple-800 bg-white/95 dark:bg-gray-900/95 backdrop-blur-md pointer-events-auto">
      <div className="relative w-full aspect-video bg-black">
        <iframe
          key={videoId}
          ref={iframeRef}
          title="Music Bot"
          src={`https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&rel=0&enablejsapi=1&start=${elapsedSec}`}
          allow="autoplay; encrypted-media; picture-in-picture"
          className="w-full h-full"
        />
        {!unmuted && (
          <button
            onClick={() => {
              const w = iframeRef.current?.contentWindow;
              if (!w) return;
              w.postMessage(JSON.stringify({ event: 'command', func: 'unMute', args: [] }), '*');
              w.postMessage(JSON.stringify({ event: 'command', func: 'playVideo', args: [] }), '*');
              setUnmuted(true);
            }}
            className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-red-600 hover:bg-red-700 text-white text-[11px] font-semibold px-3 py-1 shadow-lg cursor-pointer animate-pulse"
          >
            🔇 Nyalakan suara
          </button>
        )}
      </div>
      <div className="p-2">
        <p className="text-[11px] font-medium text-gray-800 dark:text-gray-100 truncate">🎵 {current.track.title}</p>
        <p className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
          Diminta oleh {current.track.requestedBy}{current.pausedAt !== null ? ' · dijeda' : ''}
        </p>
        {session && session.queue.length > 0 && (
          <p className="text-[10px] text-purple-500 dark:text-purple-400 mt-0.5">{session.queue.length} lagu di antrean</p>
        )}
      </div>
    </div>
  );
}
