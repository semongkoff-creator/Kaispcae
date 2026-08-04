import { useEffect, useRef, useState } from 'react';
import { TILE_SIZE } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';

// Potong 6 — Background Music. Plays a 'bgm' media object's audio (looped, low
// volume) while the local player stands inside its area. Honest autoplay
// handling: audio only starts after the user has interacted with the page —
// until then we surface a "play" button rather than fighting the browser.
// Conversation always wins: while a proximity/meeting conversation is active the
// music pauses (simplest, never talks over people).

let audioUnlocked = false;
if (typeof window !== 'undefined') {
  const unlock = () => { audioUnlocked = true; window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

export interface BgmState {
  inAreaName: string | null; // non-null while inside a bgm area (drives the HUD)
  muted: boolean;
  setMuted: (m: boolean) => void;
  needsUnlock: boolean; // true when music wants to play but no gesture yet
  playNow: () => void; // user pressed the "play music" button
}

export function useBgm(conversationActive: boolean): BgmState {
  const [muted, setMuted] = useState(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [inAreaName, setInAreaName] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentIdRef = useRef<string | null>(null);
  const mutedRef = useRef(muted); mutedRef.current = muted;
  const convRef = useRef(conversationActive); convRef.current = conversationActive;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const st = useGameStore.getState();
      const lp = st.localPlayer;
      const tx = Math.floor(lp.x / TILE_SIZE), ty = Math.floor(lp.y / TILE_SIZE);
      const inside = st.mediaObjects.find((m) =>
        m.type === 'bgm' && m.payload.audioUrl &&
        tx >= m.x && tx < m.x + (m.payload.areaW ?? 1) && ty >= m.y && ty < m.y + (m.payload.areaH ?? 1),
      );
      const id = inside?.id ?? null;
      if (id !== currentIdRef.current) {
        currentIdRef.current = id;
        setInAreaName(inside ? (inside.payload as { name?: string }).name ?? 'Area' : null);
        if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
        if (inside?.payload.audioUrl) {
          const a = new Audio(inside.payload.audioUrl);
          a.loop = true;
          a.volume = Math.max(0, Math.min(1, inside.payload.volume ?? 0.3));
          // Bug media #1 — land on the position everyone else is (roughly) at,
          // instead of always starting fresh at 0 (see MediaPayload.startedAt's
          // doc comment for the shared-clock design). Needs the track's actual
          // duration to wrap the elapsed time correctly (it loops), which isn't
          // known synchronously from a bare `new Audio(url)` — wait for
          // 'loadedmetadata' unless it's already cached and available. Areas
          // placed before this field existed have no startedAt — falls through
          // to today's start-at-0 behavior untouched.
          const startedAt = inside.payload.startedAt;
          if (startedAt) {
            const applyElapsed = () => {
              const dur = a.duration;
              if (Number.isFinite(dur) && dur > 0) a.currentTime = ((Date.now() - startedAt) / 1000) % dur;
            };
            if (a.readyState >= a.HAVE_METADATA) applyElapsed();
            else a.addEventListener('loadedmetadata', applyElapsed, { once: true });
          }
          audioRef.current = a;
        }
      }
      const a = audioRef.current;
      if (a) {
        const shouldPlay = !mutedRef.current && !convRef.current;
        if (shouldPlay) {
          if (!audioUnlocked) { setNeedsUnlock(true); }
          else { setNeedsUnlock(false); if (a.paused) a.play().catch(() => {}); }
        } else if (!a.paused) {
          a.pause();
        }
      } else if (needsUnlock) {
        setNeedsUnlock(false);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); audioRef.current?.pause(); audioRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    inAreaName,
    muted,
    setMuted,
    needsUnlock,
    playNow: () => { audioUnlocked = true; setNeedsUnlock(false); audioRef.current?.play().catch(() => {}); },
  };
}
