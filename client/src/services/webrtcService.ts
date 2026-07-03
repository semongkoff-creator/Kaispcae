import { Socket } from 'socket.io-client';
import { SocketEvents } from '@virtualmeet/shared';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

interface PeerConnection {
  pc: RTCPeerConnection;
  audioGain: GainNode;
  videoStream: MediaStream | null;
  retryCount: number;
  remoteDescSet: boolean;
  iceQueue: RTCIceCandidateInit[];
}

class WebRTCService {
  private peers = new Map<string, PeerConnection>();
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private socket: Socket | null = null;
  private onRemoteStream: ((id: string, stream: MediaStream) => void) | null = null;
  private onSpeakingChange: ((id: string, speaking: boolean) => void) | null = null;
  private onScreenShareEnded: (() => void) | null = null;
  private analyserInterval: ReturnType<typeof setInterval> | null = null;

  // The video track actually being sent to peers — the webcam track, or the
  // screen-share track while one is active.
  private getActiveVideoTrack(): MediaStreamTrack | null {
    return this.screenStream?.getVideoTracks()[0] ?? this.localStream?.getVideoTracks()[0] ?? null;
  }

  setSocket(socket: Socket) {
    this.socket = socket;
    this.setupSignaling(socket);
  }

  setOnRemoteStream(cb: (id: string, stream: MediaStream) => void) {
    this.onRemoteStream = cb;
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

  setAudioVolume(id: string, volume: number) {
    const peer = this.peers.get(id);
    if (peer) {
      peer.audioGain.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  getSocketId(): string | undefined {
    return this.socket?.id;
  }

  connectToPlayer(remoteId: string) {
    if (this.peers.has(remoteId)) return;
    if (!this.socket?.connected) return;
    if (!this.localStream) return;

    console.log('[webrtc] connecting to', remoteId);

    const pc = new RTCPeerConnection(ICE_SERVERS);
    const audioCtx = this.audioContext;
    const audioGain = audioCtx ? audioCtx.createGain() : null;
    let videoStream: MediaStream | null = null;

    const peer: PeerConnection = {
      pc,
      audioGain: audioGain!,
      videoStream: null,
      retryCount: 0,
      remoteDescSet: false,
      iceQueue: [],
    };

    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) pc.addTrack(audioTrack, this.localStream);
    const videoTrack = this.getActiveVideoTrack();
    if (videoTrack) pc.addTrack(videoTrack, this.screenStream ?? this.localStream);

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
      if (!event.streams[0] || !audioCtx || !audioGain) return;

      const audioSource = audioCtx.createMediaStreamSource(event.streams[0]);
      audioSource.connect(audioGain).connect(audioCtx.destination);

      if (!videoStream && event.track.kind === 'video') {
        videoStream = new MediaStream([event.track]);
        peer.videoStream = videoStream;
        this.onRemoteStream?.(remoteId, videoStream);
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

    this.peers.set(remoteId, peer);

    // Glare avoidance: lower socket id creates the offer
    const localId = this.socket.id!;
    const shouldCreateOffer = localId < remoteId;

    if (shouldCreateOffer) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          this.socket?.emit(SocketEvents.RTC_OFFER, {
            fromId: localId,
            toId: remoteId,
            payload: pc.localDescription,
          });
        })
        .catch((err) => console.error('[webrtc] offer error:', err));
    }
  }

  handleOffer(fromId: string, sdp: RTCSessionDescriptionInit) {
    if (!this.localStream) return;
    console.log('[webrtc] received offer from', fromId);

    // If PC already exists (from connectToPlayer), reuse it
    let peer = this.peers.get(fromId);
    let pc: RTCPeerConnection;
    let audioGain: GainNode | null;
    let videoStream: MediaStream | null = null;
    const audioCtx = this.audioContext;

    if (peer) {
      pc = peer.pc;
      audioGain = peer.audioGain;
    } else {
      pc = new RTCPeerConnection(ICE_SERVERS);
      audioGain = audioCtx ? audioCtx.createGain() : null;
      peer = {
        pc,
        audioGain: audioGain!,
        videoStream: null,
        retryCount: 0,
        remoteDescSet: false,
        iceQueue: [],
      };

      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) pc.addTrack(audioTrack, this.localStream);
      const videoTrack = this.getActiveVideoTrack();
      if (videoTrack) pc.addTrack(videoTrack, this.screenStream ?? this.localStream);

      pc.onicecandidate = (event) => {
        if (event.candidate && this.socket) {
          this.socket.emit(SocketEvents.RTC_ICE_CANDIDATE, {
            fromId: this.socket.id,
            toId: fromId,
            payload: event.candidate,
          });
        }
      };

      pc.ontrack = (event) => {
        if (!event.streams[0] || !audioCtx || !audioGain) return;
        const audioSource = audioCtx.createMediaStreamSource(event.streams[0]);
        audioSource.connect(audioGain).connect(audioCtx.destination);

        if (!videoStream && event.track.kind === 'video') {
          videoStream = new MediaStream([event.track]);
          peer!.videoStream = videoStream;
          this.onRemoteStream?.(fromId, videoStream);
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed' && peer!.retryCount < 1) {
          peer!.retryCount++;
          this.disconnectFromPlayer(fromId);
          setTimeout(() => this.connectToPlayer(fromId), 1000);
        }
      };

      this.peers.set(fromId, peer);
    }

    pc.setRemoteDescription(new RTCSessionDescription(sdp))
      .then(() => {
        peer!.remoteDescSet = true;
        // Flush queued ICE candidates
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
      })
      .catch((err) => console.error('[webrtc] answer error:', err));
  }

  handleAnswer(fromId: string, sdp: RTCSessionDescriptionInit) {
    const peer = this.peers.get(fromId);
    if (peer) {
      peer.pc.setRemoteDescription(new RTCSessionDescription(sdp))
        .then(() => {
          peer.remoteDescSet = true;
          // Flush queued ICE candidates
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
      // Queue if remote description not yet set
      peer.iceQueue.push(candidate);
    }
  }

  disconnectFromPlayer(id: string) {
    const peer = this.peers.get(id);
    if (peer) {
      peer.pc.close();
      this.peers.delete(id);
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

  // Swaps the outgoing video track on every existing peer connection to the
  // screen capture, and remembers it so new connections made mid-share pick
  // it up too (see getActiveVideoTrack / connectToPlayer / handleOffer).
  async startScreenShare(): Promise<{ success: boolean; error?: string }> {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      this.screenStream = stream;
      const screenTrack = stream.getVideoTracks()[0];

      // Browser's native "Stop sharing" control ends the track directly.
      screenTrack.onended = () => this.stopScreenShare();

      for (const peer of this.peers.values()) {
        const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack).catch(() => {});
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

    const camTrack = this.localStream?.getVideoTracks()[0] ?? null;
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender && camTrack) sender.replaceTrack(camTrack).catch(() => {});
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
