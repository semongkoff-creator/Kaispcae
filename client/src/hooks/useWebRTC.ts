import { useEffect, useRef, useCallback, useState } from 'react';
import { Socket } from 'socket.io-client';
import { ProximityPlayer, DISCONNECT_DEBOUNCE_MS } from '@virtualmeet/shared';
import { webrtcService } from '@/services/webrtcService';
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
    // Already fully set up (both tracks present) — nothing to retry. An
    // audio-only stream (from the camera-busy fallback) does NOT count as
    // "done" here, so a later camera retry can still try again.
    const hasAudio = !!streamRef.current?.getAudioTracks().length;
    const hasVideo = !!streamRef.current?.getVideoTracks().length;
    if (hasAudio && hasVideo) return;
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
  });

  // §6 — connect for both 'full_visible' and 'translucent' (still shown,
  // just dimmed); only 'not_visible' disconnects. Disconnect is debounced
  // the same as before so a brief flicker across a tier boundary doesn't
  // tear the connection down and immediately rebuild it.
  const updateProximity = useCallback((nearby: ProximityPlayer[]) => {
    const inRangeIds = new Set(nearby.filter((p) => p.visibility !== 'not_visible').map((p) => p.id));
    const connectedIds = connectedRef.current;

    for (const p of nearby) {
      if (p.visibility !== 'not_visible') {
        // Clear any pending disconnect timer
        const timer = disconnectTimers.current.get(p.id);
        if (timer) {
          clearTimeout(timer);
          disconnectTimers.current.delete(p.id);
        }

        if (!connectedIds.has(p.id)) {
          // Only mark them connected if the attempt actually started — when
          // local media isn't ready yet connectToPlayer is a no-op, and
          // marking them anyway meant this branch never ran again for that
          // player, stranding them silent for the rest of the session.
          // Leaving them unmarked lets the next proximity tick retry.
          // [webrtc-diag] Proximity fired for this player — did a connection
          // attempt actually start, or was it refused (no local media / no
          // socket)? A refusal here means nothing downstream ever runs.
          const started = webrtcService.connectToPlayer(p.id);
          console.log('[webrtc-diag] proximity connect', { peer: p.id, started, visibility: p.visibility });
          if (started) connectedIds.add(p.id);
        }

        // Zone-mates always get full volume; otherwise fall off with distance.
        webrtcService.setAudioVolume(p.id, p.viaZone ? 1 : calcGain(p.distanceTiles));
      }
    }

    // Debounced disconnect for players out of range
    for (const id of connectedIds) {
      if (!inRangeIds.has(id)) {
        if (!disconnectTimers.current.has(id)) {
          disconnectTimers.current.set(id, setTimeout(() => {
            webrtcService.disconnectFromPlayer(id);
            connectedIds.delete(id);
            disconnectTimers.current.delete(id);
          }, DISCONNECT_DEBOUNCE_MS));
        }
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

  const toggleCamera = useCallback(async () => {
    webrtcService.resumeAudio();
    let track = streamRef.current?.getVideoTracks()[0];
    if (!track) {
      // If mic was already unmuted on the previous (audio-only fallback)
      // stream, remember that — initLocalMedia stops the old tracks and
      // hands back a brand-new stream, whose audio track otherwise starts
      // muted again by default, silently re-muting a mic the user had
      // already turned on.
      const wasMicUnmuted = !!streamRef.current?.getAudioTracks()[0]?.enabled;
      await initMedia();
      track = streamRef.current?.getVideoTracks()[0];
      if (!track) return false;
      track.enabled = true;
      setIsCameraOn(true);
      if (wasMicUnmuted) {
        const newAudioTrack = streamRef.current?.getAudioTracks()[0];
        if (newAudioTrack) {
          newAudioTrack.enabled = true;
          setIsMicMuted(false);
        }
      }
      return true;
    }
    track.enabled = !track.enabled;
    setIsCameraOn(track.enabled);
    return track.enabled;
  }, [initMedia]);

  const toggleScreenShare = useCallback(async () => {
    if (webrtcService.isScreenSharing()) {
      webrtcService.stopScreenShare();
      setIsScreenSharing(false);
      return true;
    }
    const result = await webrtcService.startScreenShare();
    setIsScreenSharing(result.success);
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
    webrtcService.destroy();
    connectedRef.current.clear();
    initRef.current = false;
    streamRef.current = null;
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
    setManualVolume,
    destroy,
    getLocalStream: () => webrtcService.getLocalStream(),
  };
}
