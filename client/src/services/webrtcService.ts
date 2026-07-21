import { Socket } from 'socket.io-client';
import { SocketEvents } from '@virtualmeet/shared';

// STUN alone only tells a peer its public address — it can't help when the
// network refuses direct peer-to-peer traffic at all, which is the norm on
// office/campus WiFi and symmetric-NAT mobile networks. That's the case where
// someone's camera silently never appears while everything else works. A TURN
// server relays the media instead, at the cost of bandwidth.
//
// Credentials come from the environment and are NEVER committed: Vite inlines
// VITE_* into the client bundle, so anyone can read them in DevTools — that's
// inherent to browser-side TURN, not something this code can prevent. Keeping
// them in env still matters, because it means they can be rotated or revoked
// without touching source. A server-issued short-lived credential is the real
// fix if this ever needs to be locked down.
//
// STUN stays FIRST and TURN is only listed alongside it: ICE already prefers
// a direct path and falls back to relay only when direct fails, so normal
// connections cost no relay bandwidth. With the env unset this degrades
// cleanly to exactly the previous STUN-only behaviour.
const TURN_URL = import.meta.env.VITE_TURN_URL as string | undefined;
const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME as string | undefined;
const TURN_CREDENTIAL = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined;

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // All three are required — a TURN entry missing username/credential is
    // rejected by the browser and would take the whole ICE config down with it.
    ...(TURN_URL && TURN_USERNAME && TURN_CREDENTIAL
      ? [{
          // Comma-separated env allows listing several transports at once
          // (Open Relay publishes :443 over both UDP and TCP/TLS — the TCP one
          // is what gets through firewalls that drop UDP entirely).
          urls: TURN_URL.split(',').map((u) => u.trim()).filter(Boolean),
          username: TURN_USERNAME,
          credential: TURN_CREDENTIAL,
        }]
      : []),
  ],
};

// ── DIAGNOSTIC INSTRUMENTATION (temporary) ───────────────────────────────
// Purely observational: added to locate where two-way audio breaks, after
// two code-reading fixes failed to resolve it. Remove once the real cause is
// found and fixed — it must not become permanent noise in the console.
function diag(event: string, data?: unknown): void {
  if (data === undefined) console.log(`[webrtc-diag] ${event}`);
  else console.log(`[webrtc-diag] ${event}`, data);
}

// Whether an SDP actually carries an audio m-line, and which direction it
// declares. "sendrecv"/"sendonly" on both sides is what two-way audio needs;
// "recvonly" or a missing m=audio means this side is not sending at all.
function sdpAudioInfo(sdp: string | undefined): { hasAudio: boolean; direction: string } {
  if (!sdp) return { hasAudio: false, direction: 'no-sdp' };
  const idx = sdp.indexOf('m=audio');
  if (idx === -1) return { hasAudio: false, direction: 'none' };
  const section = sdp.slice(idx, sdp.indexOf('m=', idx + 1) === -1 ? undefined : sdp.indexOf('m=', idx + 1));
  const dir = ['sendrecv', 'sendonly', 'recvonly', 'inactive'].find((d) => section.includes(`a=${d}`));
  return { hasAudio: true, direction: dir ?? 'unspecified' };
}

interface PeerConnection {
  pc: RTCPeerConnection;
  audioGain: GainNode;
  // The peer's voice is played through a real <audio> element, NOT through
  // the Web Audio graph. Two independent reasons, both fatal on their own:
  //
  //  1. An AudioContext built outside a user gesture starts "suspended" and
  //     stays silent forever — the exact trap soundEffects.ts documents and
  //     already works around for in-game SFX. Voice was still walking into it.
  //  2. Chrome does not pull audio out of a REMOTE MediaStream through
  //     createMediaStreamSource unless that stream is also attached to a
  //     media element. A peer who is audio-only (their camera failed) gets no
  //     video tile at all, so nothing else was ever holding their stream.
  //
  // audioGain stays wired up for the recording tap and keeps mirroring the
  // volume, so §7 recording is unaffected.
  audioEl: HTMLAudioElement | null;
  videoStream: MediaStream | null;
  // §6 (RTC upgrade) — the peer's incoming SCREEN video, tracked separately
  // from videoStream (their camera) so both can render as distinct boxes at
  // once, per the spec's "2 track terpisah... UI render sebagai 2 box
  // berbeda" requirement.
  remoteScreenStream: MediaStream | null;
  screenSender: RTCRtpSender | null;
  // Combined into audioGain.gain.value as proximityGain * manualVolume —
  // proximity drives the automatic distance falloff (existing behavior),
  // manualVolume is the new per-listener slider (§6), purely client-side
  // per the spec ("tidak perlu sinkron ke server").
  proximityGain: number;
  manualVolume: number;
  retryCount: number;
  remoteDescSet: boolean;
  iceQueue: RTCIceCandidateInit[];
  // Guards onnegotiationneeded (see createPeer) — addTrack() during
  // createPeer's initial setup fires it immediately on both sides, but the
  // very first offer/answer is already handled manually below (to preserve
  // the existing glare-avoidance rule); only once that's done should a
  // LATER addTrack (screen share) be allowed to trigger an automatic
  // renegotiation offer.
  initialNegotiationDone: boolean;
}

class WebRTCService {
  private peers = new Map<string, PeerConnection>();
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  // §7 — lazily created per peer being recorded, so a peer's audioGain (fed
  // by their mic, already routed to the speakers) can ALSO fan out into a
  // capturable MediaStream for MediaRecorder — Web Audio nodes support
  // multiple simultaneous connections, so this doesn't affect normal playback.
  private audioDestNodes = new Map<string, MediaStreamAudioDestinationNode>();
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private socket: Socket | null = null;
  private onRemoteStream: ((id: string, stream: MediaStream) => void) | null = null;
  private onRemoteScreenStream: ((id: string, stream: MediaStream) => void) | null = null;
  private onRemoteScreenEnded: ((id: string) => void) | null = null;
  private onSpeakingChange: ((id: string, speaking: boolean) => void) | null = null;
  private onScreenShareEnded: (() => void) | null = null;
  private analyserInterval: ReturnType<typeof setInterval> | null = null;

  setSocket(socket: Socket) {
    this.socket = socket;
    this.setupSignaling(socket);
  }

  // Lets callers detect that the socket they hold is no longer the one
  // signalling runs on — see the rebind effect in useWebRTC.
  getBoundSocket(): Socket | null {
    return this.socket;
  }

  setOnRemoteStream(cb: (id: string, stream: MediaStream) => void) {
    this.onRemoteStream = cb;
  }

  setOnRemoteScreenStream(cb: (id: string, stream: MediaStream) => void) {
    this.onRemoteScreenStream = cb;
  }

  setOnRemoteScreenEnded(cb: (id: string) => void) {
    this.onRemoteScreenEnded = cb;
  }

  setOnSpeakingChange(cb: (id: string, speaking: boolean) => void) {
    this.onSpeakingChange = cb;
  }

  setOnScreenShareEnded(cb: () => void) {
    this.onScreenShareEnded = cb;
  }

  async initLocalMedia(): Promise<{ success: boolean; error?: string }> {
    // Retrying after an earlier audio-only fallback (see below) — stop
    // those tracks first rather than leaking them once replaced.
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 320, height: 240, frameRate: 15 },
      });
      this.finishLocalMediaSetup();
      this.syncTracksToPeers();
      return { success: true };
    } catch (err: unknown) {
      // Video-specific failures (camera already open in another app/tab,
      // no camera present, etc.) shouldn't also take down the microphone —
      // retry audio-only so at least mic/proximity-audio still works, and
      // report the camera issue as a non-fatal heads-up rather than
      // failing the whole join.
      if (err instanceof DOMException && ['NotReadableError', 'OverconstrainedError', 'NotFoundError'].includes(err.name)) {
        try {
          this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          this.finishLocalMediaSetup();
          this.syncTracksToPeers();
          return { success: true, error: 'Camera unavailable (already in use elsewhere?) — joined with audio only' };
        } catch (audioErr: unknown) {
          console.warn('[webrtc] audio-only fallback also failed:', audioErr);
        }
      }
      const message = err instanceof DOMException
        ? err.name === 'NotAllowedError' ? 'Camera/microphone permission denied'
          : err.name === 'NotReadableError' ? 'Could not start camera/mic — already in use by another app or browser tab'
          : err.name === 'NotFoundError' ? 'No camera or microphone found on this device'
          : err.message
        : 'Failed to access media devices';
      console.warn('[webrtc]', message);
      return { success: false, error: message };
    }
  }

  private finishLocalMediaSetup(): void {
    const stream = this.localStream!;
    // [webrtc-diag] §1 — what getUserMedia actually handed back. A track that
    // is missing, already 'ended', or permanently disabled explains silence
    // before any peer connection is even involved.
    diag('local media', {
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
      audio: stream.getAudioTracks().map((t) => ({ enabled: t.enabled, readyState: t.readyState, muted: t.muted, label: t.label })),
    });
    // Mic/camera should start OFF on join — getUserMedia grants the tracks
    // enabled by default, which would otherwise broadcast audio/video the
    // instant someone enters a room, before they've chosen to turn
    // anything on.
    stream.getAudioTracks().forEach((t) => { t.enabled = false; });
    stream.getVideoTracks().forEach((t) => { t.enabled = false; });

    // Reused across re-acquires, never recreated: every already-connected
    // peer's audioGain node belongs to THIS context, and nodes from two
    // different AudioContexts can't be wired together — building a fresh one
    // on a camera retry would orphan every existing peer's audio graph.
    if (!this.audioContext) this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(stream);
    // Same reason the context is reused: the old analyser was fed by the now
    // stopped stream, so re-point the speaking detector at the new one.
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 256;
    source.connect(this.analyserNode);

    if (this.analyserInterval) clearInterval(this.analyserInterval);
    this.startSpeakingDetection();
  }

  // Re-acquiring media (the camera-retry path) builds a BRAND-NEW MediaStream
  // and stops every track of the old one — including the audio track that
  // existing RTCPeerConnections are still sending. Without this, clicking
  // "Camera" after the audio-only fallback left every peer receiving a dead
  // audio track and no video at all, permanently, until a page reload: the
  // one action a user takes to fix their camera was silently cutting their
  // voice to everyone nearby.
  //
  // replaceTrack() swaps the outgoing track in place with no renegotiation,
  // so the common case (audio sender already exists) is instant. Only a
  // genuinely new camera track needs addTrack, which fires
  // onnegotiationneeded and renegotiates — the same path screen sharing
  // already uses.
  private syncTracksToPeers(): void {
    const stream = this.localStream;
    if (!stream) return;
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    const videoTrack = stream.getVideoTracks()[0] ?? null;

    for (const [remoteId, peer] of this.peers) {
      const senders = peer.pc.getSenders();
      const audioSender = senders.find((s) => s.track?.kind === 'audio');
      // Exclude the screen-share sender — that one carries the display
      // capture, not the camera, and must not be overwritten by it.
      const videoSender = senders.find((s) => s.track?.kind === 'video' && s !== peer.screenSender);

      try {
        if (audioTrack) {
          if (audioSender) audioSender.replaceTrack(audioTrack).catch(() => {});
          else peer.pc.addTrack(audioTrack, stream);
        }
        if (videoTrack) {
          if (videoSender) videoSender.replaceTrack(videoTrack).catch(() => {});
          else peer.pc.addTrack(videoTrack, stream);
        }
      } catch (err) {
        console.error('[webrtc] failed to sync tracks to', remoteId, err);
      }
    }
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getScreenStream(): MediaStream | null {
    return this.screenStream;
  }

  private applyGain(peer: PeerConnection) {
    const volume = Math.max(0, Math.min(1, peer.proximityGain * peer.manualVolume));
    // The element is what the user actually hears, so proximity falloff has
    // to land here — the gain node alone only affects the recording tap.
    if (peer.audioEl) peer.audioEl.volume = volume;
    // A peer created before the AudioContext existed (offer arrived ahead of
    // local media) has no gain node — proximity ticks must not throw on it.
    if (!peer.audioGain) return;
    peer.audioGain.gain.value = volume;
  }

  // Browsers refuse both AudioContext.resume() and <audio>.play() until the
  // page has seen a real user gesture, and a peer can easily connect before
  // that ever happens. Called from the mic/camera buttons — themselves
  // gestures — to un-stick anything that was blocked earlier.
  resumeAudio(): void {
    diag('resumeAudio (user gesture)', { ctxBefore: this.audioContext?.state, peers: this.peers.size });
    if (this.audioContext?.state === 'suspended') this.audioContext.resume().catch(() => {});
    for (const peer of this.peers.values()) {
      peer.audioEl?.play()
        .then(() => diag('resume play() OK', { volume: peer.audioEl?.volume }))
        .catch((err) => diag('resume play() BLOCKED', { name: err?.name }));
    }
  }

  // [webrtc-diag] Names the winning candidate pair in plain terms, so "is TURN
  // being used?" is answerable from one log line instead of inference.
  private async reportSelectedPath(remoteId: string, pc: RTCPeerConnection): Promise<void> {
    try {
      const stats = await pc.getStats();
      let pairLocal: string | undefined;
      let pairRemote: string | undefined;
      const types: Record<string, string> = {};
      stats.forEach((r: Record<string, unknown>) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
          pairLocal = r.localCandidateId as string;
          pairRemote = r.remoteCandidateId as string;
        }
        if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
          types[r.id as string] = r.candidateType as string;
        }
      });
      const local = pairLocal ? types[pairLocal] : undefined;
      const remote = pairRemote ? types[pairRemote] : undefined;
      const viaTurn = local === 'relay' || remote === 'relay';
      diag(viaTurn ? 'PATH via TURN (relay)' : 'PATH direct (no TURN needed)', {
        peer: remoteId, localType: local, remoteType: remote,
      });
    } catch (err) {
      diag('path check failed', { peer: remoteId, err: String(err) });
    }
  }

  // [webrtc-diag] The decisive measurement, and the reason this whole pass
  // exists: whether audio BYTES are actually crossing the wire.
  //   bytesReceived climbing  → transport is fine, the fault is playback.
  //   bytesReceived stuck at 0 → nothing is arriving; transport (ICE/TURN) or
  //                              the sending side is at fault.
  // Guessing between those two without measuring is exactly what went wrong
  // in the previous two attempts.
  async reportStats(): Promise<void> {
    if (!this.peers.size) { diag('stats: no peers connected'); return; }
    for (const [id, peer] of this.peers) {
      const out: Record<string, unknown> = {
        ice: peer.pc.iceConnectionState,
        conn: peer.pc.connectionState,
        elVolume: peer.audioEl?.volume,
        elPaused: peer.audioEl?.paused,
        ctx: this.audioContext?.state,
      };
      try {
        const stats = await peer.pc.getStats();
        stats.forEach((r: Record<string, unknown>) => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') {
            out.audioIn_bytes = r.bytesReceived;
            out.audioIn_packets = r.packetsReceived;
          }
          if (r.type === 'outbound-rtp' && r.kind === 'audio') {
            out.audioOut_bytes = r.bytesSent;
            out.audioOut_packets = r.packetsSent;
          }
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
            out.pathLocal = r.localCandidateId;
            out.pathRemote = r.remoteCandidateId;
          }
          if (r.type === 'local-candidate' && r.id === out.pathLocal) out.localType = r.candidateType;
          if (r.type === 'remote-candidate' && r.id === out.pathRemote) out.remoteType = r.candidateType;
        });
      } catch (err) {
        out.statsError = String(err);
      }
      diag(`stats [peer ${id}]`, out);
    }
  }

  // Proximity-driven — called on every proximity tick (see useWebRTC.ts).
  setAudioVolume(id: string, volume: number) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.proximityGain = Math.max(0, Math.min(1, volume));
    this.applyGain(peer);
  }

  // §6 — manual per-listener slider, independent of proximity.
  setManualVolume(id: string, volume: number) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.manualVolume = Math.max(0, Math.min(1, volume));
    this.applyGain(peer);
  }

  // §7 — combines the peer's video with a fresh tap of their mixed audio,
  // for MediaRecorder to capture — see the audioDestNodes doc comment above
  // for why this doesn't touch playback. Prefers their screen-share track
  // over their camera when they're presenting one: that's the whole thing
  // they chose to show (their screen/window), not just their face, which is
  // the closest this mesh architecture can get to "record the whole UI" for
  // someone who isn't me — I only ever see what they actively send.
  getRecordingStream(id: string): MediaStream | null {
    const peer = this.peers.get(id);
    const videoTrack = peer?.remoteScreenStream?.getVideoTracks()[0] ?? peer?.videoStream?.getVideoTracks()[0];
    if (!peer || !videoTrack) return null;

    const combined = new MediaStream([videoTrack]);
    if (this.audioContext) {
      let destNode = this.audioDestNodes.get(id);
      if (!destNode) {
        destNode = this.audioContext.createMediaStreamDestination();
        peer.audioGain.connect(destNode);
        this.audioDestNodes.set(id, destNode);
      }
      const audioTrack = destNode.stream.getAudioTracks()[0];
      if (audioTrack) combined.addTrack(audioTrack);
    }
    return combined;
  }

  getSocketId(): string | undefined {
    return this.socket?.id;
  }

  private createPeer(remoteId: string): PeerConnection {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    // A peer can now be created before local media exists (see handleOffer),
    // so the context can't be assumed — without one, this peer would have no
    // gain node and their incoming audio would never reach the speakers.
    if (!this.audioContext) this.audioContext = new AudioContext();
    const audioCtx = this.audioContext;
    const audioGain = audioCtx ? audioCtx.createGain() : (null as unknown as GainNode);

    const peer: PeerConnection = {
      pc,
      audioGain,
      audioEl: null,
      videoStream: null,
      remoteScreenStream: null,
      screenSender: null,
      proximityGain: 1,
      manualVolume: 1,
      retryCount: 0,
      remoteDescSet: false,
      iceQueue: [],
      initialNegotiationDone: false,
    };

    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) pc.addTrack(audioTrack, this.localStream);
      const camTrack = this.localStream.getVideoTracks()[0];
      if (camTrack) pc.addTrack(camTrack, this.localStream);
    }
    // Pick up an already-in-progress screen share when connecting mid-share
    // (e.g. someone joins after sharing already started).
    if (this.screenStream) {
      const screenTrack = this.screenStream.getVideoTracks()[0];
      if (screenTrack) peer.screenSender = pc.addTrack(screenTrack, this.screenStream);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && this.socket) {
        this.socket.emit(SocketEvents.RTC_ICE_CANDIDATE, {
          fromId: this.socket.id,
          toId: remoteId,
          payload: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      // Fall back to wrapping the bare track: a sender that never associated
      // a MediaStream (or a track added by a later renegotiation) arrives
      // with an empty event.streams, and dropping it here silently lost the
      // peer's voice or picture entirely.
      const inboundStream = event.streams[0] ?? new MediaStream([event.track]);

      // [webrtc-diag] §3 — proof a remote track arrived at all, and in what
      // condition. 'muted: true' here is normal for a moment right after
      // arrival; still muted seconds later means no media is flowing.
      diag('ontrack', {
        from: remoteId, kind: event.track.kind,
        readyState: event.track.readyState, muted: event.track.muted,
        enabled: event.track.enabled, hadStream: !!event.streams[0],
      });

      if (event.track.kind === 'audio') {
        // Real element = actual playback (see audioEl's doc comment).
        const el = peer.audioEl ?? document.createElement('audio');
        el.srcObject = inboundStream;
        el.autoplay = true;
        // Never route the peer's voice back into the mic that is capturing
        // this machine's own speakers.
        (el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
        peer.audioEl = el;
        this.applyGain(peer);
        // Rejects only when no gesture has happened yet; resumeAudio() below
        // retries on the next click, exactly as soundEffects.ts does.
        // [webrtc-diag] §5 — a rejection here IS the autoplay policy blocking
        // playback, which is otherwise completely invisible.
        el.play()
          .then(() => diag('audio play() OK', { from: remoteId, volume: el.volume, muted: el.muted, ctx: this.audioContext?.state }))
          .catch((err) => diag('audio play() BLOCKED', { from: remoteId, name: err?.name, message: err?.message }));

        // Kept purely so getRecordingStream()'s tap still has a live source.
        // Deliberately NOT connected to audioCtx.destination — that would
        // play the same voice a second time on top of the element.
        const audioCtx2 = this.audioContext;
        if (audioCtx2 && peer.audioGain) {
          try {
            audioCtx2.createMediaStreamSource(inboundStream).connect(peer.audioGain);
          } catch { /* already connected for this peer */ }
        }
        return;
      }

      // First incoming video track for this peer = their camera; a SECOND,
      // distinct one (grouped under a different sender-side MediaStream,
      // see startScreenShare) = their screen share.
      if (!peer.videoStream) {
        const stream = new MediaStream([event.track]);
        peer.videoStream = stream;
        this.onRemoteStream?.(remoteId, stream);
      } else if (!peer.remoteScreenStream) {
        const stream = new MediaStream([event.track]);
        peer.remoteScreenStream = stream;
        this.onRemoteScreenStream?.(remoteId, stream);
        event.track.onended = () => {
          peer.remoteScreenStream = null;
          this.onRemoteScreenEnded?.(remoteId);
        };
      }
    };

    // Fires when addTrack (screen share start) happens after the initial
    // offer/answer already completed — creates a fresh offer to renegotiate
    // the new m-line. Simplification: no full perfect-negotiation/rollback,
    // since in this app only one side ever renegotiates at a time (the
    // person toggling their own screen share), not both simultaneously.
    pc.onnegotiationneeded = async () => {
      try {
        // addTrack() during this same createPeer() call also fires this —
        // the very first offer/answer is handled manually below instead, so
        // ignore it until that's done (see initialNegotiationDone's doc comment).
        if (!peer.initialNegotiationDone) return;
        if (pc.signalingState !== 'stable' || !this.socket) return;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit(SocketEvents.RTC_OFFER, {
          fromId: this.socket.id,
          toId: remoteId,
          payload: pc.localDescription,
        });
      } catch (err) {
        console.error('[webrtc] renegotiation error:', err);
      }
    };

    pc.oniceconnectionstatechange = () => {
      // [webrtc-diag] §4 — the single most decisive signal. Never reaching
      // 'connected'/'completed' means no media path exists at all, which is a
      // TURN problem, not an audio-code problem.
      diag('ICE state', { peer: remoteId, ice: pc.iceConnectionState, conn: pc.connectionState });
      // The only honest proof that TURN is doing anything: which candidate
      // pair actually won. 'relay' on either end means media is going through
      // the TURN server; 'host'/'srflx' means it connected directly and TURN
      // was never needed (so a successful call proves nothing about TURN).
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        void this.reportSelectedPath(remoteId, pc);
      }
      if (pc.iceConnectionState === 'failed' && peer.retryCount < 1) {
        peer.retryCount++;
        console.log('[webrtc] retrying connection to', remoteId);
        this.disconnectFromPlayer(remoteId);
        setTimeout(() => this.connectToPlayer(remoteId), 1000);
      }
    };

    return peer;
  }

  // Returns false when the connection could NOT be started — the caller must
  // then leave this peer un-marked so a later proximity tick retries. Marking
  // it connected regardless meant that anyone whose media was still being
  // acquired when a neighbour first came into range was never connected to
  // for the rest of the session: no audio, no video, no error, no retry.
  connectToPlayer(remoteId: string): boolean {
    if (this.peers.has(remoteId)) return true;
    if (!this.socket?.connected) return false;
    if (!this.localStream) return false;

    console.log('[webrtc] connecting to', remoteId);
    const peer = this.createPeer(remoteId);
    this.peers.set(remoteId, peer);

    // Glare avoidance: lower socket id creates the offer
    const localId = this.socket.id!;
    const shouldCreateOffer = localId < remoteId;

    if (shouldCreateOffer) {
      peer.pc.createOffer()
        .then((offer) => peer.pc.setLocalDescription(offer))
        .then(() => {
          // [webrtc-diag] §2 — does the offer we send actually contain audio,
          // and do we declare ourselves as sending it?
          diag('OFFER sent', {
            from: localId, to: remoteId,
            ...sdpAudioInfo(peer.pc.localDescription?.sdp),
            senders: peer.pc.getSenders().map((s) => s.track?.kind ?? 'null-track'),
          });
          this.socket?.emit(SocketEvents.RTC_OFFER, {
            fromId: localId,
            toId: remoteId,
            payload: peer.pc.localDescription,
          });
          peer.initialNegotiationDone = true;
        })
        .catch((err) => console.error('[webrtc] offer error:', err));
    }
    return true;
  }

  handleOffer(fromId: string, sdp: RTCSessionDescriptionInit) {
    // Deliberately NOT gated on localStream being ready. Dropping the offer
    // here was silent and final — the offering side sits waiting for an
    // answer that never comes, with no retry, so whoever's mic/camera
    // permission was still pending when a neighbour walked up stayed
    // permanently mute and invisible to them. Answer now with whatever
    // tracks exist (possibly none); syncTracksToPeers() attaches them the
    // moment media is acquired.
    console.log('[webrtc] received offer from', fromId);

    // If PC already exists (from connectToPlayer, or an earlier
    // negotiation round), reuse it — this is also the path a mid-call
    // renegotiation offer (e.g. the peer just started screen sharing) comes
    // through, so it must NOT assume "first offer ever".
    let peer = this.peers.get(fromId);
    if (!peer) {
      peer = this.createPeer(fromId);
      this.peers.set(fromId, peer);
    }
    const pc = peer.pc;

    pc.setRemoteDescription(new RTCSessionDescription(sdp))
      .then(() => {
        peer!.remoteDescSet = true;
        for (const c of peer!.iceQueue) {
          pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
        peer!.iceQueue = [];
        return pc.createAnswer();
      })
      .then((answer) => pc.setLocalDescription(answer))
      .then(() => {
        // [webrtc-diag] §2 — the mirror of the offer log: an offer that
        // carried audio but an answer that does not (or says recvonly)
        // pinpoints which side stopped sending.
        diag('ANSWER sent', {
          from: this.socket?.id, to: fromId,
          offerHad: sdpAudioInfo(sdp.sdp),
          answerHas: sdpAudioInfo(pc.localDescription?.sdp),
          senders: pc.getSenders().map((s) => s.track?.kind ?? 'null-track'),
        });
        this.socket?.emit(SocketEvents.RTC_ANSWER, {
          fromId: this.socket!.id,
          toId: fromId,
          payload: pc.localDescription,
        });
        peer!.initialNegotiationDone = true;
      })
      .catch((err) => console.error('[webrtc] answer error:', err));
  }

  handleAnswer(fromId: string, sdp: RTCSessionDescriptionInit) {
    const peer = this.peers.get(fromId);
    if (peer) {
      peer.pc.setRemoteDescription(new RTCSessionDescription(sdp))
        .then(() => {
          peer.remoteDescSet = true;
          for (const c of peer.iceQueue) {
            peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
          peer.iceQueue = [];
        })
        .catch((err) => console.error('[webrtc] setRemote error:', err));
    }
  }

  handleIceCandidate(fromId: string, candidate: RTCIceCandidateInit) {
    const peer = this.peers.get(fromId);
    if (!peer) return;

    if (peer.remoteDescSet) {
      peer.pc.addIceCandidate(new RTCIceCandidate(candidate))
        .catch((err) => console.error('[webrtc] ice candidate error:', err));
    } else {
      peer.iceQueue.push(candidate);
    }
  }

  disconnectFromPlayer(id: string) {
    const peer = this.peers.get(id);
    if (peer) {
      peer.pc.close();
      // Detach before dropping the reference — an <audio> still holding a
      // srcObject keeps the stream (and its decoder) alive after the peer
      // is gone.
      if (peer.audioEl) {
        peer.audioEl.pause();
        peer.audioEl.srcObject = null;
        peer.audioEl = null;
      }
      this.peers.delete(id);
      this.audioDestNodes.get(id)?.disconnect();
      this.audioDestNodes.delete(id);
      console.log('[webrtc] disconnected from', id);
    }
  }

  disconnectAll() {
    for (const id of this.peers.keys()) {
      this.disconnectFromPlayer(id);
    }
  }

  isScreenSharing(): boolean {
    return !!this.screenStream;
  }

  // §6 — adds the screen capture as its OWN sender/track on every existing
  // peer connection (triggers onnegotiationneeded above), rather than
  // replaceTrack()-ing the camera sender — camera and screen now travel as
  // 2 independent tracks so both render as separate boxes simultaneously,
  // instead of screen share replacing the camera view entirely.
  async startScreenShare(): Promise<{ success: boolean; error?: string }> {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      this.screenStream = stream;
      const screenTrack = stream.getVideoTracks()[0];
      screenTrack.onended = () => this.stopScreenShare();

      for (const peer of this.peers.values()) {
        peer.screenSender = peer.pc.addTrack(screenTrack, stream);
      }
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Screen share permission denied'
        : 'Failed to start screen share';
      console.warn('[webrtc]', message);
      return { success: false, error: message };
    }
  }

  stopScreenShare() {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach((t) => t.stop());
    this.screenStream = null;

    for (const peer of this.peers.values()) {
      if (peer.screenSender) {
        peer.pc.removeTrack(peer.screenSender);
        peer.screenSender = null;
      }
    }
    this.onScreenShareEnded?.();
  }

  destroy() {
    this.disconnectAll();
    if (this.analyserInterval) clearInterval(this.analyserInterval);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.audioContext?.close();
    this.socket = null;
  }

  private setupSignaling(socket: Socket) {
    socket.on(SocketEvents.RTC_OFFER, (signal: { fromId: string; payload: RTCSessionDescriptionInit }) => {
      this.handleOffer(signal.fromId, signal.payload);
    });

    socket.on(SocketEvents.RTC_ANSWER, (signal: { fromId: string; payload: RTCSessionDescriptionInit }) => {
      this.handleAnswer(signal.fromId, signal.payload);
    });

    socket.on(SocketEvents.RTC_ICE_CANDIDATE, (signal: { fromId: string; payload: RTCIceCandidateInit }) => {
      this.handleIceCandidate(signal.fromId, signal.payload);
    });
  }

  private startSpeakingDetection() {
    if (!this.analyserNode) return;
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    let localSpeaking = false;

    this.analyserInterval = setInterval(() => {
      if (!this.analyserNode) return;
      this.analyserNode.getByteTimeDomainData(data);

      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        sum += Math.abs(data[i] - 128);
      }
      const avg = sum / data.length;
      const speaking = avg > 15;

      if (speaking !== localSpeaking) {
        localSpeaking = speaking;
        this.onSpeakingChange?.('local', speaking);
      }
    }, 100);
  }
}

export const webrtcService = new WebRTCService();

// [webrtc-diag] Auto-report every 5s so the log captures the whole session
// without anyone having to remember to run anything, plus a manual hook
// (`webrtcDiag()` in the console) for checking a specific moment — e.g.
// right while the other person is speaking.
if (typeof window !== 'undefined') {
  // Printed once at load so "did my .env.local actually get picked up?" is
  // answerable without guessing — the URL is shown, the credential never is.
  console.log('[webrtc-diag] TURN configured:', !!(TURN_URL && TURN_USERNAME && TURN_CREDENTIAL), TURN_URL ? `(${TURN_URL})` : '(STUN only)');
  (window as unknown as { webrtcDiag: () => void }).webrtcDiag = () => { void webrtcService.reportStats(); };
  setInterval(() => { void webrtcService.reportStats(); }, 5000);
}
