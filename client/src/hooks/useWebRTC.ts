import { useEffect, useRef, useCallback, useState } from 'react';
import { Socket } from 'socket.io-client';
import { ProximityPlayer, DISCONNECT_DEBOUNCE_MS } from '@kaispace/shared';
import { webrtcService, MAX_VIDEO_PEERS } from '@/services/webrtcService';
import { calcGain } from './useProximity';

interface UseWebRTCOptions {
  socketRef: React.MutableRefObject<Socket | null>;
  onRemoteStream?: (id: string, stream: MediaStream) => void;
}

export function useWebRTC({ socketRef, onRemoteStream }: UseWebRTCOptions) {
  const connectedRef = useRef<Set<string>>(new Set());
  const initRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const disconnectTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const screenShareErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // See the resync-glitch guard inside updateProximity below — timestamp of
  // when a mass-stale pattern was FIRST observed, so it can be suppressed
  // once and then, if it's still happening a bit later (a genuine mass
  // departure, not a one-off blip), let through rather than blocked forever.
  const massGlitchSinceRef = useRef<number | null>(null);

  // Mic starts muted / camera starts off — matches webrtcService disabling
  // both tracks right after acquiring them, so the UI doesn't show "live"
  // for the brief window before initMedia's result comes back.
  const [isMicMuted, setIsMicMuted] = useState(true);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  // Set only when getUserMedia genuinely failed (denied/no device) — lets
  // the UI explain why the mic/camera buttons aren't doing anything instead
  // of failing silently. Cleared on a successful (re)acquire.
  const [mediaError, setMediaError] = useState<string | null>(null);
  // QA (Load checklist item 3, "War Room share massal") — set when
  // startScreenShare is denied (room already at MAX_SCREEN_SHARES_PER_ROOM)
  // or otherwise fails, so the room-full case actually has a "pesan jelas"
  // instead of the button just silently doing nothing — previously
  // startScreenShare's own {success, error} result was discarded entirely
  // by toggleScreenShare below (only the boolean survived).
  const [screenShareError, setScreenShareError] = useState<string | null>(null);
  // QA (Fallback checklist item 9) — ids of peers whose WebRTC connection
  // has failed permanently (retried once, still failed) — see
  // webrtcService's onPeerConnectionStatus. Consumed by VideoGrid to show a
  // "connection lost" badge instead of a silently-frozen tile.
  const [failedPeers, setFailedPeers] = useState<Set<string>>(new Set());
  // Peers whose incoming screen-share frames have stalled (ICE still
  // nominally connected, but no new frames for a tick) — see
  // webrtcService's checkScreenStall/onScreenShareStalled. Consumed by
  // VideoGrid/MeetingView to show "Menyambung ulang..." over the frozen
  // picture instead of leaving it silently black.
  const [screenStalledPeers, setScreenStalledPeers] = useState<Set<string>>(new Set());

  // Guards against overlapping initLocalMedia() calls (e.g. mic and camera
  // buttons both clicked before the first request resolves) — NOT a
  // once-ever latch. The original version used `initRef` for that job,
  // which meant a single failed/denied first attempt (very possible if the
  // browser's native permission prompt hadn't been answered yet the instant
  // this fired on mount) permanently blocked every future retry — the
  // mic/camera buttons would then silently do nothing for the rest of the
  // session, no matter how many times they were clicked.
  const initMedia = useCallback(async () => {
    if (initRef.current) return;
    // The mic is all this needs to obtain. It used to also require a video
    // track before considering itself done, which no longer makes sense: the
    // camera is now acquired separately by enableCamera() and is absent by
    // design whenever it's off, so demanding one here would re-request the
    // microphone on every single camera toggle.
    if (streamRef.current?.getAudioTracks().length) return;
    initRef.current = true;
    const result = await webrtcService.initLocalMedia();
    streamRef.current = webrtcService.getLocalStream();
    initRef.current = false;
    if (streamRef.current) {
      setIsMicMuted(true);
      setIsCameraOn(false);
    }
    // result.error is set both on outright failure AND on the non-fatal
    // "camera busy, joined with audio only" fallback case (see
    // webrtcService.initLocalMedia) — surface it either way.
    setMediaError(streamRef.current ? (result.error ?? null) : (result.error || 'Camera/microphone unavailable'));
  }, []);

  // Deliberately has NO dependency array: it must re-check after every render.
  //
  // useSocket builds a BRAND-NEW socket whenever roomSlug/auth changes (see
  // its effect deps) — which is exactly what happens when you enter a room
  // from the lobby. socketRef is a ref, so that swap fires no effect at all.
  // Binding once on mount therefore left webrtcService signalling over the
  // lobby's dead socket for the entire session: every offer, answer and ICE
  // candidate went out on the new socket while the listeners sat on the old
  // one, so no peer connection ever completed — no camera, no audio, and no
  // error anywhere to explain it. Whether it worked came down to whether you
  // happened to reload while already inside the room (first socket is the
  // right one) or walked in from the lobby (it isn't), which is why it looked
  // like it worked for one person and not the other.
  //
  // The identity guard keeps this to a cheap comparison on the vast majority
  // of renders; setSocket only re-runs when the socket genuinely changed.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || webrtcService.getBoundSocket() === socket) return;

    // Peers negotiated over the previous socket can never recover — their
    // signalling path is gone. Tear them down and let the next proximity
    // tick rebuild against the live socket.
    webrtcService.disconnectAll();
    connectedRef.current.clear();

    webrtcService.setSocket(socket);
    // Only override the app's own handler when a caller actually supplied
    // one — registering an unconditional wrapper here would clobber the real
    // handler App.tsx installs (there is a single callback slot, last
    // registration wins).
    if (onRemoteStream) {
      webrtcService.setOnRemoteStream((id, stream) => onRemoteStream(id, stream));
    }
    webrtcService.setOnScreenShareEnded(() => setIsScreenSharing(false));
    webrtcService.setOnPeerConnectionStatus((id, failed) => {
      setFailedPeers((prev) => {
        const already = prev.has(id);
        if (failed === already) return prev;
        const next = new Set(prev);
        if (failed) next.add(id); else next.delete(id);
        return next;
      });
    });
    webrtcService.setOnScreenShareStalled((id, stalled) => {
      setScreenStalledPeers((prev) => {
        const already = prev.has(id);
        if (stalled === already) return prev;
        const next = new Set(prev);
        if (stalled) next.add(id); else next.delete(id);
        return next;
      });
    });
  });

  // §6 — connect for both 'full_visible' and 'translucent' (still shown,
  // just dimmed); only 'not_visible' disconnects. Disconnect is debounced
  // the same as before so a brief flicker across a tier boundary doesn't
  // tear the connection down and immediately rebuild it.
  //
  // QA (Load checklist item 1, "Concurrency tim penuh") — `sorted` below
  // gives priority to zone/table-mates (an intentional grouping, same as
  // before this change — always connect, always full volume/video) and
  // then to whoever's physically closest, NOT the order they happened to
  // enter proximity. In a crowded room this decides who gets one of the
  // limited MAX_TOTAL_PEERS/MAX_VIDEO_PEERS slots (see webrtcService)
  // FIRST. Deliberately does NOT evict an already-connected peer just
  // because someone else's rank improved mid-call — only NEW connection
  // attempts respect the ranking, so an ongoing conversation is never
  // interrupted by someone else walking closer. This trades perfect
  // fairness for stability, which matters more for a call already in
  // progress than for who wins a not-yet-made connection.
  const updateProximity = useCallback((nearby: ProximityPlayer[]) => {
    const visible = nearby.filter((p) => p.visibility !== 'not_visible');
    const sorted = [...visible].sort((a, b) => {
      if (!!a.viaZone !== !!b.viaZone) return a.viaZone ? -1 : 1;
      return a.distanceTiles - b.distanceTiles;
    });
    const inRangeIds = new Set(visible.map((p) => p.id));
    const connectedIds = connectedRef.current;

    // Recomputed fresh every tick from the CURRENT ranking — only takes
    // effect for a peer not yet connected (webrtcService locks
    // videoEligible in once at connection time and never revokes it, to
    // avoid camera flicker on an ongoing call — see its own comment).
    webrtcService.setVideoEligibleIds(sorted.slice(0, MAX_VIDEO_PEERS).map((p) => p.id));

    for (const p of sorted) {
      // Clear any pending disconnect timer
      const timer = disconnectTimers.current.get(p.id);
      if (timer) {
        clearTimeout(timer);
        disconnectTimers.current.delete(p.id);
      }

      if (!connectedIds.has(p.id)) {
        // Only mark them connected if the attempt actually started — when
        // local media isn't ready yet, or MAX_TOTAL_PEERS is already
        // reached, connectToPlayer is a no-op, and marking them anyway
        // meant this branch never ran again for that player, stranding
        // them silent for the rest of the session. Leaving them unmarked
        // lets the next proximity tick retry — same self-healing shape
        // whether the reason is "media not ready yet" or "room's crowded
        // right now, try again once someone else leaves range".
        // [webrtc-diag] Proximity fired for this player — did a connection
        // attempt actually start, or was it refused (no local media / no
        // socket / at cap)? A refusal here means nothing downstream ever runs.
        const started = webrtcService.connectToPlayer(p.id);
        console.log('[webrtc-diag] proximity connect', { peer: p.id, started, visibility: p.visibility });
        if (started) connectedIds.add(p.id);
      }

      // Zone-mates always get full volume; otherwise fall off with distance.
      webrtcService.setAudioVolume(p.id, p.viaZone ? 1 : calcGain(p.distanceTiles));
    }

    // Debounced disconnect for players out of range.
    //
    // Resync-glitch guard — a real walk-away drops one or two peers out of
    // range at a time; a MAJORITY of already-connected peers reading
    // out-of-range in this exact same tick is instead the signature of a
    // proximity glitch, not real movement (the diagnosed case: a server
    // restart clears the in-memory "resume where I left off" position
    // cache — see roomStore.ts's lastKnownPosition — so on reconnect
    // everyone's local position can briefly jump to the default spawn
    // point at once, making a room full of people who were just talking
    // all look like they scattered in the same instant).
    //
    // The FIRST tick this pattern is seen, disconnects are suppressed and
    // the moment is timestamped (massGlitchSinceRef) instead of acted on —
    // giving a real position correction (if one is coming) a window to
    // land before anything gets torn down. If the SAME pattern is still
    // true past RESYNC_GRACE_MS, this stops treating it as a blip: a
    // one-off render hiccup does not last that long, so at that point it's
    // either a genuine mass departure or a wrong position that isn't
    // self-correcting — either way, disconnecting is the right call, not
    // something to suppress forever. An isolated single-peer departure (the
    // normal case) never engages this branch at all, since staleIds.length
    // stays at 1.
    const RESYNC_GRACE_MS = 1500;
    const staleIds = [...connectedIds].filter((id) => !inRangeIds.has(id));
    const looksLikeResyncGlitch = staleIds.length >= 3 && staleIds.length > connectedIds.size / 2;

    if (looksLikeResyncGlitch) {
      if (massGlitchSinceRef.current === null) massGlitchSinceRef.current = Date.now();
      if (Date.now() - massGlitchSinceRef.current < RESYNC_GRACE_MS) {
        console.warn('[webrtc-diag] proximity resync-glitch guard: suppressing disconnect for', staleIds.length, 'of', connectedIds.size, 'connected peers this tick');
        return;
      }
      console.warn('[webrtc-diag] proximity resync-glitch guard: pattern persisted past', RESYNC_GRACE_MS, 'ms — treating as real, disconnecting normally');
    }
    massGlitchSinceRef.current = null;

    for (const id of staleIds) {
      if (!disconnectTimers.current.has(id)) {
        disconnectTimers.current.set(id, setTimeout(() => {
          webrtcService.disconnectFromPlayer(id);
          connectedIds.delete(id);
          disconnectTimers.current.delete(id);
        }, DISCONNECT_DEBOUNCE_MS));
      }
    }
  }, []);

  const toggleMic = useCallback(async () => {
    // This click is a user gesture — the one thing the browser was waiting
    // for before it would let any peer audio actually play.
    webrtcService.resumeAudio();
    let track = streamRef.current?.getAudioTracks()[0];
    // No track yet — either initMedia hasn't run, or it failed (e.g. the
    // browser's permission prompt on mount got missed/dismissed before the
    // user had a chance to answer it). Retry right here, since a click on
    // the mic button is itself a fresh user gesture the browser will
    // happily show the permission prompt again for.
    if (!track) {
      await initMedia();
      track = streamRef.current?.getAudioTracks()[0];
      if (!track) return false;
      track.enabled = true;
      setIsMicMuted(false);
      return true;
    }
    track.enabled = !track.enabled;
    setIsMicMuted(!track.enabled);
    return track.enabled;
  }, [initMedia]);

  // Off now means the device is RELEASED, not muted — so this acquires and
  // stops the camera rather than flipping track.enabled. The mic is never
  // touched here: audio lives on its own track that is acquired once and kept,
  // so turning the camera on or off can't disturb it (an earlier version
  // re-acquired the whole stream and silently re-muted a mic the user had
  // already turned on).
  const toggleCamera = useCallback(async () => {
    webrtcService.resumeAudio();

    // No local stream at all yet — the very first click also has to obtain
    // the mic, since that's what initMedia grants.
    if (!streamRef.current) {
      await initMedia();
      if (!streamRef.current) return false;
    }

    if (webrtcService.hasCamera()) {
      webrtcService.disableCamera();
      setIsCameraOn(false);
      return false;
    }

    const result = await webrtcService.enableCamera();
    setMediaError(result.error ?? null);
    setIsCameraOn(result.success);
    return result.success;
  }, [initMedia]);

  const toggleScreenShare = useCallback(async () => {
    if (webrtcService.isScreenSharing()) {
      webrtcService.stopScreenShare();
      setIsScreenSharing(false);
      return true;
    }
    const result = await webrtcService.startScreenShare();
    setIsScreenSharing(result.success);
    if (screenShareErrorTimerRef.current) clearTimeout(screenShareErrorTimerRef.current);
    if (result.success) {
      setScreenShareError(null);
    } else {
      // Self-dismissing one-off toast, same convention as App.tsx's
      // miniModeError — a denial/failure is a moment-in-time thing to
      // acknowledge, not a persistent state to keep displaying.
      setScreenShareError(result.error ?? 'Gagal memulai share layar.');
      screenShareErrorTimerRef.current = setTimeout(() => setScreenShareError(null), 6000);
    }
    return result.success;
  }, []);

  const setManualVolume = useCallback((id: string, volume: number) => {
    webrtcService.setManualVolume(id, volume);
  }, []);

  const destroy = useCallback(() => {
    for (const timer of disconnectTimers.current.values()) {
      clearTimeout(timer);
    }
    disconnectTimers.current.clear();
    if (screenShareErrorTimerRef.current) clearTimeout(screenShareErrorTimerRef.current);
    webrtcService.destroy();
    connectedRef.current.clear();
    initRef.current = false;
    streamRef.current = null;
    massGlitchSinceRef.current = null;
    setFailedPeers(new Set());
    setScreenStalledPeers(new Set());
  }, []);

  return {
    initMedia,
    updateProximity,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    isMicMuted,
    isCameraOn,
    isScreenSharing,
    mediaError,
    screenShareError,
    failedPeers,
    screenStalledPeers,
    setManualVolume,
    destroy,
    getLocalStream: () => webrtcService.getLocalStream(),
  };
}
