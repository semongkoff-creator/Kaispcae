import { Socket } from 'socket.io-client';
import { SocketEvents } from '@virtualmeet/shared';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

interface PeerConnection {
  pc: RTCPeerConnection;
  audioGain: GainNode;
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
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 320, height: 240, frameRate: 15 },
      });

      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.localStream);
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      source.connect(this.analyserNode);

      this.startSpeakingDetection();
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof DOMException
        ? err.name === 'NotAllowedError' ? 'Microphone/camera permission denied' : err.message
        : 'Failed to access media devices';
      console.warn('[webrtc]', message);
      return { success: false, error: message };
    }
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getScreenStream(): MediaStream | null {
    return this.screenStream;
  }

  private applyGain(peer: PeerConnection) {
    peer.audioGain.gain.value = Math.max(0, Math.min(1, peer.proximityGain * peer.manualVolume));
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

  // §7 — combines the peer's already-decoded camera video track with a
  // fresh tap of their mixed audio, for MediaRecorder to capture — see the
  // audioDestNodes doc comment above for why this doesn't touch playback.
  getRecordingStream(id: string): MediaStream | null {
    const peer = this.peers.get(id);
    if (!peer?.videoStream) return null;
    const videoTrack = peer.videoStream.getVideoTracks()[0];
    if (!videoTrack) return null;

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
    const audioCtx = this.audioContext;
    const audioGain = audioCtx ? audioCtx.createGain() : (null as unknown as GainNode);

    const peer: PeerConnection = {
      pc,
      audioGain,
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
      if (!event.streams[0]) return;

      if (event.track.kind === 'audio') {
        const audioCtx2 = this.audioContext;
        if (audioCtx2 && peer.audioGain) {
          const audioSource = audioCtx2.createMediaStreamSource(event.streams[0]);
          audioSource.connect(peer.audioGain).connect(audioCtx2.destination);
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
      if (pc.iceConnectionState === 'failed' && peer.retryCount < 1) {
        peer.retryCount++;
        console.log('[webrtc] retrying connection to', remoteId);
        this.disconnectFromPlayer(remoteId);
        setTimeout(() => this.connectToPlayer(remoteId), 1000);
      }
    };

    return peer;
  }

  connectToPlayer(remoteId: string) {
    if (this.peers.has(remoteId)) return;
    if (!this.socket?.connected) return;
    if (!this.localStream) return;

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
          this.socket?.emit(SocketEvents.RTC_OFFER, {
            fromId: localId,
            toId: remoteId,
            payload: peer.pc.localDescription,
          });
          peer.initialNegotiationDone = true;
        })
        .catch((err) => console.error('[webrtc] offer error:', err));
    }
  }

  handleOffer(fromId: string, sdp: RTCSessionDescriptionInit) {
    if (!this.localStream) return;
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
