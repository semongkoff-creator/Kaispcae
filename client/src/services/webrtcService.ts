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

// Mean sample deviation above which someone counts as talking. Kept as one
// constant so the local mic and remote peers can never disagree about what
// "speaking" means.
const SPEAKING_THRESHOLD = 15;

// Camera capture settings. Previously a hard 320x240 @15fps — QVGA, roughly a
// twelfth of the pixels below, which is why video looked poor no matter what:
// the picture was already gone at capture time, and no amount of encoding can
// restore detail that was never sampled.
//
// `ideal` rather than exact on every field: a webcam that can't reach 720p, or
// a connection that can't carry it, degrades to the closest it can manage
// instead of failing the whole getUserMedia call with OverconstrainedError.
// This is a mesh — each person encodes a separate stream per nearby peer — so
// the cost scales with how many people are standing together, and rises
// sharply when media is relayed through TURN.
const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
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
  // Read-only loudness tap for the speaking indicator — see ontrack. Never
  // connected onward, so it can't affect what anyone hears.
  analyser: AnalyserNode | null;
  // Last emitted speaking state, so the callback only fires on a change
  // rather than ten times a second.
  speaking: boolean;
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
      // MIC ONLY. Joining a room no longer opens the camera at all — the
      // camera is acquired by enableCamera() the moment it's switched on, and
      // released again the moment it's switched off. Asking for both here and
      // then stopping the video track would still flash the indicator light
      // on every join, which is exactly the behaviour this avoids.
      //
      // It also deletes a whole failure mode: the old call asked for camera
      // and mic together, so a camera already in use by another app failed
      // the combined request and needed an audio-only retry to rescue the
      // microphone. Nothing to rescue if the camera was never requested.
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.finishLocalMediaSetup();
      this.syncTracksToPeers();
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof DOMException
        ? err.name === 'NotAllowedError' ? 'Izin mikrofon ditolak'
          : err.name === 'NotReadableError' ? 'Mikrofon sedang dipakai aplikasi atau tab lain'
          : err.name === 'NotFoundError' ? 'Tidak ada mikrofon terdeteksi'
          : err.message
        : 'Gagal mengakses mikrofon';
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
    // Mic: disabled, not stopped. Muting a mic is instant and reversible, and
    // nobody expects the microphone to be released just because they're muted.
    stream.getAudioTracks().forEach((t) => { t.enabled = false; });
    // Camera: genuinely STOPPED and dropped from the stream, not merely
    // disabled. `enabled = false` only blanks the frames being sent — the
    // device stays open, the sensor keeps capturing, the indicator light
    // stays lit and the browser keeps showing its recording dot. Someone
    // whose camera is "off" is entitled to believe the camera is off.
    // enableCamera() re-acquires it on demand.
    stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });

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

  // The camera sender for a peer — the screen-share sender is excluded, since
  // it is also a video track and overwriting it would replace someone's
  // presentation with their face.
  private cameraSender(peer: PeerConnection): RTCRtpSender | undefined {
    return peer.pc.getSenders().find((s) => s !== peer.screenSender && (s.track?.kind === 'video' || (!s.track && this.videoSenders.has(s))));
  }

  // Senders that have carried a camera track at least once. Needed because a
  // sender whose track was replaced with null reports kind 'null' and would
  // otherwise be indistinguishable from an audio sender, leaving a fresh
  // camera track with nowhere to go and forcing a pointless renegotiation.
  private videoSenders = new Set<RTCRtpSender>();

  // Acquires the camera on demand. Requested separately from the mic so the
  // device is only ever open while the camera is actually on — see
  // finishLocalMediaSetup for why "off" has to mean released, not muted.
  async enableCamera(): Promise<{ success: boolean; error?: string }> {
    if (!this.localStream) return { success: false, error: 'No local stream' };
    if (this.localStream.getVideoTracks().length) return { success: true };

    let track: MediaStreamTrack;
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS });
      track = cam.getVideoTracks()[0];
      if (!track) return { success: false, error: 'No camera track' };
    } catch (err: unknown) {
      const name = err instanceof DOMException ? err.name : '';
      return {
        success: false,
        error: name === 'NotAllowedError' ? 'Izin kamera ditolak'
          : name === 'NotReadableError' ? 'Kamera sedang dipakai aplikasi lain'
          : name === 'NotFoundError' ? 'Tidak ada kamera terdeteksi'
          : 'Gagal menyalakan kamera',
      };
    }

    this.localStream.addTrack(track);

    // replaceTrack on an existing sender swaps the outgoing media with no
    // renegotiation at all — instant, and it can't disturb the audio m-line.
    // addTrack is only needed the first time, when no camera sender exists yet.
    for (const peer of this.peers.values()) {
      const sender = this.cameraSender(peer);
      if (sender) sender.replaceTrack(track).catch(() => {});
      else this.videoSenders.add(peer.pc.addTrack(track, this.localStream));
    }
    return { success: true };
  }

  // Releases the camera: stops the device, drops the track from the local
  // stream, and hands peers a null track so they see video end rather than a
  // frozen last frame.
  disableCamera(): void {
    const stream = this.localStream;
    if (!stream) return;

    for (const peer of this.peers.values()) {
      const sender = this.cameraSender(peer);
      if (sender) {
        this.videoSenders.add(sender);
        sender.replaceTrack(null).catch(() => {});
      }
    }
    for (const t of stream.getVideoTracks()) {
      t.stop();
      stream.removeTrack(t);
    }
  }

  hasCamera(): boolean {
    return !!this.localStream?.getVideoTracks().length;
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
      analyser: null,
      speaking: false,
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
            const src = audioCtx2.createMediaStreamSource(inboundStream);
            src.connect(peer.audioGain);
            // Second branch off the SAME source, purely to measure loudness
            // for the "is this person talking" ring on their tile. It is a
            // leaf — nothing is connected onward from it — so it reads the
            // signal without being part of any path that produces sound.
            // Same shape as the local-mic analyser in finishLocalMediaSetup.
            //
            // Tapped BEFORE audioGain deliberately: gain carries the
            // proximity falloff, so reading after it would make someone
            // standing a few tiles away register as silent even while they
            // are clearly speaking.
            const analyser = audioCtx2.createAnalyser();
            analyser.fftSize = 256;
            src.connect(analyser);
            peer.analyser = analyser;
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
        // Second net for a retracted screen share. Stopping a share calls
        // removeTrack on the sender, which renegotiates — and this offer IS
        // that renegotiation. The receiving track's `ended` event is supposed
        // to fire too, but it doesn't do so dependably across browsers, and
        // when it doesn't the screen stays on screen forever. Checking the
        // track's readyState at the exact moment the renegotiation lands is
        // precise and needs no timer or polling.
        const screenTrack = peer!.remoteScreenStream?.getVideoTracks()[0];
        if (peer!.remoteScreenStream && (!screenTrack || screenTrack.readyState === 'ended')) {
          peer!.remoteScreenStream = null;
          this.onRemoteScreenEnded?.(fromId);
        }
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
      // A peer who walks out of range mid-sentence would otherwise leave
      // their tile glowing forever, since no further tick can clear it.
      if (peer.speaking) {
        peer.speaking = false;
        this.onSpeakingChange?.(id, false);
      }
      // Same class of problem, and the cause of the "ghost" screen panel:
      // the ONLY thing that used to retract a shared screen was the remote
      // track's own `ended` event. Closing a PeerConnection does not reliably
      // fire that, so a presenter who dropped off — disconnected, or simply
      // walked out of range — left their screen on everyone's display until
      // a page reload. Retract it here, where we already know they're gone.
      if (peer.remoteScreenStream) {
        peer.remoteScreenStream = null;
        this.onRemoteScreenEnded?.(id);
      }
      peer.analyser?.disconnect();
      peer.analyser = null;
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

  // Mean deviation from the 128 midpoint of an 8-bit waveform. Extracted so
  // local and remote are judged by the exact same measure — two thresholds
  // that drifted apart would make one person's ring behave differently from
  // another's for no visible reason.
  // Uint8Array<ArrayBuffer>, not plain Uint8Array: the default parameter is
  // ArrayBufferLike, which includes SharedArrayBuffer, and
  // getByteTimeDomainData refuses that.
  private static loudness(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += Math.abs(buf[i] - 128);
    return sum / buf.length;
  }

  private startSpeakingDetection() {
    if (!this.analyserNode) return;
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    let localSpeaking = false;
    // Rising edge fires immediately (the ring should appear the moment
    // someone starts talking), but it takes several consecutive quiet ticks
    // to drop again — otherwise the gap between two words switches it off
    // and back on, which reads as flicker rather than speech.
    const QUIET_TICKS_TO_STOP = 4; // ~400ms at the 100ms interval below
    const quiet = new Map<string, number>();

    this.analyserInterval = setInterval(() => {
      if (this.analyserNode) {
        const speaking = WebRTCService.loudness(this.analyserNode, data) > SPEAKING_THRESHOLD;
        if (speaking !== localSpeaking) {
          localSpeaking = speaking;
          this.onSpeakingChange?.('local', speaking);
        }
      }

      // Same measurement for every connected peer. Reads only — see the
      // analyser's doc comment on PeerConnection.
      for (const [id, peer] of this.peers) {
        if (!peer.analyser) continue;
        const buf = new Uint8Array(peer.analyser.frequencyBinCount);
        const loud = WebRTCService.loudness(peer.analyser, buf) > SPEAKING_THRESHOLD;

        if (loud) {
          quiet.set(id, 0);
          if (!peer.speaking) {
            peer.speaking = true;
            this.onSpeakingChange?.(id, true);
          }
        } else if (peer.speaking) {
          const n = (quiet.get(id) ?? 0) + 1;
          quiet.set(id, n);
          if (n >= QUIET_TICKS_TO_STOP) {
            peer.speaking = false;
            this.onSpeakingChange?.(id, false);
          }
        }
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
