import { Socket } from 'socket.io-client';
import { SocketEvents, MAX_SCREEN_SHARES_PER_ROOM } from '@kaispace/shared';

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

// Per-peer audio bug diagnosis — a peer stuck in ICE 'disconnected' (as
// opposed to 'failed') was never retried at all: the only automatic retry
// lived on the 'failed' branch below, and 'disconnected' has no timeout of
// its own, no UI signal, nothing. Browsers often self-heal a brief
// 'disconnected' blip within a second or two without help — this is why the
// bug was never "every call", just some pairs, some of the time — but when
// the ICE agent doesn't recover on its own, this app previously had zero
// path back to audio for that one peer short of a full page reload (a fresh
// RTCPeerConnection gets a fresh ICE gathering attempt, which is why reload
// looked like a fix without anything actually being repaired). Long enough
// that a real transient blip clears on its own first, short enough that
// someone genuinely stuck isn't silent for too long.
const ICE_DISCONNECTED_TIMEOUT_MS = 5000;

// Screen-share stall recovery — deliberately separate from the ICE
// disconnected/failed handling above. A laggy link can stop delivering
// screen-share frames while iceConnectionState stays 'connected' the whole
// time (no packet loss severe enough to ever trip ICE, just not enough
// throughput for a 1080p-ish capture) — the ICE watchdog above would never
// fire for this at all. restartIce() is a much lighter recovery than tearing
// down the whole peer (audio/camera keep running undisturbed); if repeated
// attempts don't clear the stall, the link is likely bad enough that ICE
// itself will eventually report disconnected/failed too, and the existing
// watchdog above takes over from there on its own — no coordination needed.
const SCREEN_STALL_RECOVERY_MAX_ATTEMPTS = 3;
const SCREEN_STALL_RECOVERY_BASE_DELAY_MS = 2000;

// Fallback classifier, used only until the presenter's RTC_SCREEN_SHARE
// announcement is known. A camera is published in the same MediaStream as the
// microphone; a screen comes from getDisplayMedia in a stream of its own with
// no audio. Kept as a backstop rather than deleted: the announcement can
// arrive after the track on a slow link, and a peer that briefly showed
// nothing would be worse than one classified by a good guess.
function arrivedWithAudioOrUngrouped(event: RTCTrackEvent, peer: { videoStream: MediaStream | null }): boolean {
  if ((event.streams[0]?.getAudioTracks().length ?? 0) > 0) return true;
  // No stream grouping at all — nothing to reason from, so fall back to the
  // old "first video is the camera" rule rather than dropping the track.
  return !peer.videoStream && !event.streams[0];
}

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

// QA (Load checklist item 1, "Concurrency tim penuh") — a mesh's cost is
// O(n) simultaneous peer connections per client, each up to 3 tracks
// (mic/camera/screen). Previously fully unbounded: 25 people packed
// together meant up to 24 connections per client, ~300 system-wide. Two
// caps, applied in priority order (closest/zone-mates first — see
// useWebRTC's updateProximity, the only caller that decides rank):
// - MAX_TOTAL_PEERS: hard ceiling on simultaneous connections at all.
//   Anyone beyond this simply isn't connected to (silently retried by the
//   next proximity tick, same as the existing "local media not ready yet"
//   case) — self-healing as people move, never a hard error.
// - MAX_VIDEO_PEERS (<= MAX_TOTAL_PEERS): of those connected, only this
//   many closest ALSO get a camera track added — the rest are audio-only.
//   Voice chat (the cheap track) still works at full range up to the total
//   cap; video (the expensive one) is reserved for whoever's actually
//   nearest. Decided once at connection time, not renegotiated later if
//   rank shifts mid-call — see updateProximity's own comment for why.
export const MAX_TOTAL_PEERS = 16;
export const MAX_VIDEO_PEERS = 8;

// QA (Load checklist item 3, "War Room share massal") — previously
// unbounded: getDisplayMedia({video: true}) with no constraints at all lets
// the browser capture at native display resolution/framerate (easily
// 4K/60fps on a modern monitor), and every viewer decodes that same full
// stream regardless of whether it's their featured tile or a ~96px
// thumbnail — there's no per-viewer quality tier in a plain mesh (that
// needs an SFU/simulcast this app doesn't have). Bounding the SENDER's
// resolution/framerate caps the worst case for every viewer uniformly.
// 1080p/15fps is still plenty readable for a shared screen (text, slides,
// browser windows) while cutting encode cost and bitrate substantially
// versus an unbounded native capture.
const SCREEN_SHARE_CONSTRAINTS: MediaTrackConstraints = {
  width: { max: 1920 },
  height: { max: 1080 },
  frameRate: { ideal: 15, max: 15 },
};
// Applied via RTCRtpSender.setParameters — a hard ceiling on encoded
// bitrate per peer connection, independent of the constraints above (which
// only bound capture resolution/framerate, not what the encoder actually
// sends once network conditions are factored in). 2.5 Mbps is comfortably
// enough for 1080p/15fps screen content (mostly static regions — text,
// slides — compress far better than natural video) while keeping a single
// share's total mesh cost (this × however many peers) bounded and
// predictable rather than opportunistically maxing out available bandwidth.
const SCREEN_SHARE_MAX_BITRATE_BPS = 2_500_000;

// Volume smoothing. 25ms/tick with a 0.25 factor settles a full-range
// change in roughly 150ms — fast enough that walking past someone still
// tracks their distance, slow enough that no single step is audible.
const VOLUME_RAMP_INTERVAL_MS = 25;
const VOLUME_RAMP_FACTOR = 0.25;

// ── DIAGNOSTIC INSTRUMENTATION (opt-in) ──────────────────────────────────
// Added to locate where two-way audio breaks. It was running for EVERY user
// in production, unconditionally: fifteen console.log sites plus a 5-second
// timer calling getStats() on every peer (one of the more expensive WebRTC
// calls there is) and logging an object per peer, forever. Objects logged to
// the console are also retained by devtools once it has been opened, so it
// leaked memory on top of the CPU cost.
//
// Kept rather than deleted — the audio issue it was built for may not be
// settled — but off unless asked for. Two ways in:
//   - automatically in a dev build
//   - localStorage.setItem('vm_webrtc_diag', '1') then reload, in any build,
//     which is what makes it usable against a real deployment
// The manual webrtcDiag() console hook works regardless of the flag, so a
// one-off snapshot never needs a reload.
const DIAG_ENABLED = (() => {
  if (import.meta.env.DEV) return true;
  try {
    return localStorage.getItem('vm_webrtc_diag') === '1';
  } catch {
    // Storage can throw outright under strict privacy settings.
    return false;
  }
})();

// Buffered in memory (never localStorage/sessionStorage — gone on reload)
// so a non-technical person on a real call doesn't have to manually
// scroll/select console output: they run webrtcDiagExport() once (see
// bottom of file) and get the whole session's log as one copyable block.
// Capped so a long-running room can't grow this unbounded.
const diagLog: string[] = [];
const MAX_DIAG_LOG_LINES = 2000;

function diag(event: string, data?: unknown): void {
  if (!DIAG_ENABLED) return;
  if (data === undefined) console.log(`[webrtc-diag] ${event}`);
  else console.log(`[webrtc-diag] ${event}`, data);
  diagLog.push(`${new Date().toISOString()} ${event}${data === undefined ? '' : ' ' + JSON.stringify(data)}`);
  if (diagLog.length > MAX_DIAG_LOG_LINES) diagLog.shift();
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
  // MediaStream.id this peer announced as their screen share, from
  // RTC_SCREEN_SHARE. Null when they aren't sharing.
  screenStreamId: string | null;
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
  // Where the volume is headed, and where it currently is. Split so the
  // 5Hz proximity tick can move the target in one jump while what the
  // listener hears slides there smoothly — see applyGain / rampVolumes.
  targetVolume: number;
  currentVolume: number;
  retryCount: number;
  remoteDescSet: boolean;
  iceQueue: RTCIceCandidateInit[];
  // Per-peer audio bug — set while ICE sits in 'disconnected', cleared the
  // moment it leaves that state for any reason (recovered, failed, or torn
  // down). Lets oniceconnectionstatechange treat a disconnect that never
  // clears within ICE_DISCONNECTED_TIMEOUT_MS the same as an outright
  // 'failed' one, and lets disconnectFromPlayer cancel it so a stale timer
  // never fires against a peer that's already gone.
  disconnectedTimer: ReturnType<typeof setTimeout> | null;
  // Guards onnegotiationneeded (see createPeer) — addTrack() during
  // createPeer's initial setup fires it immediately on both sides, but the
  // very first offer/answer is already handled manually below (to preserve
  // the existing glare-avoidance rule); only once that's done should a
  // LATER addTrack (screen share) be allowed to trigger an automatic
  // renegotiation offer.
  initialNegotiationDone: boolean;
  // Bug fix — a real race, not just the glare hypothesis above: if
  // syncTracksToPeers() (called the instant initLocalMedia() resolves —
  // e.g. mic permission was slow, or this peer connection was answered via
  // handleOffer moments before local media became ready) calls addTrack()
  // WHILE this peer's own initial offer/answer chain is still in flight,
  // the resulting onnegotiationneeded fires with initialNegotiationDone
  // still false and used to be silently dropped — with no error, no log,
  // nothing. The sender technically exists on the RTCPeerConnection
  // (addTrack succeeded locally) but was never actually announced to the
  // remote side in any SDP, so their ontrack never fires for it: exactly a
  // one-directional "I can hear everyone but them" per-pair failure,
  // because every OTHER peer's connection didn't happen to hit this exact
  // timing window. Set true only in that one dropped-event case; checked
  // and cleared right after initialNegotiationDone flips true (both offer
  // and answer paths below) to fire the renegotiation that was missed.
  pendingRenegotiation: boolean;
  // Reference to createPeer's own `renegotiate` closure — set once, right
  // after that const is defined, purely so connectToPlayer/handleOffer
  // (outside createPeer's closure, operating on this same peer object) can
  // fire the exact same logic when consuming a pendingRenegotiation flag.
  // Optional only because the interface requires initializing the peer
  // object before this closure exists — always set by the time createPeer
  // returns.
  renegotiate?: () => Promise<void>;
  // MAX_VIDEO_PEERS — this peer's rank was within the video cap at
  // connection time. Gates BOTH createPeer's own initial camera addTrack
  // (see includeVideo there) AND enableCamera()'s later per-peer loop
  // (turning the camera on well after this peer already connected
  // audio-only must not silently bypass the same cap).
  videoEligible: boolean;
  // Screen-share stall recovery (see SCREEN_STALL_RECOVERY_* above) — true
  // while this peer's incoming screen-share frames have stopped advancing
  // (checked in reportStats()) but ICE hasn't (yet) reported
  // disconnected/failed. Drives the "Menyambung ulang..." overlay and gates
  // attemptScreenRecovery so a peer already mid-recovery doesn't get a
  // second overlapping restartIce() loop started against it.
  screenStalled: boolean;
}

class WebRTCService {
  private peers = new Map<string, PeerConnection>();
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  // MAX_VIDEO_PEERS — ids ranked within the video cap as of the most recent
  // proximity tick (see useWebRTC's updateProximity, the sole writer via
  // setVideoEligibleIds). Consulted by BOTH connectToPlayer (we initiate the
  // offer) and handleOffer (they do, via glare-avoidance's lower-socket-id
  // rule) so the cap holds regardless of which side happens to create the
  // offer for a given pair — a purely per-call flag would only have covered
  // the outbound half.
  private videoEligibleIds = new Set<string>();
  // §7 — lazily created per peer being recorded, so a peer's audioGain (fed
  // by their mic, already routed to the speakers) can ALSO fan out into a
  // capturable MediaStream for MediaRecorder — Web Audio nodes support
  // multiple simultaneous connections, so this doesn't affect normal playback.
  private audioDestNodes = new Map<string, MediaStreamAudioDestinationNode>();
  private audioContext: AudioContext | null = null;

  // Chosen input/output devices, remembered across sessions. Applied as
  // `ideal` (never `exact`) when auto-acquiring on join so a device that has
  // since been unplugged silently falls back to the system default instead of
  // throwing OverconstrainedError and leaving the user with no mic/camera.
  // An explicit user pick (switchMic/switchCamera) does use `exact`, because
  // there a silent fall-back to a different device would be a lie.
  private selectedMicId = localStorage.getItem('meetkai.micId');
  private selectedCameraId = localStorage.getItem('meetkai.cameraId');
  private selectedSpeakerId = localStorage.getItem('meetkai.speakerId');
  private analyserNode: AnalyserNode | null = null;
  private socket: Socket | null = null;
  private onRemoteStream: ((id: string, stream: MediaStream) => void) | null = null;
  private onRemoteScreenStream: ((id: string, stream: MediaStream) => void) | null = null;
  private onRemoteScreenEnded: ((id: string) => void) | null = null;
  private onSpeakingChange: ((id: string, speaking: boolean) => void) | null = null;
  private onScreenShareEnded: (() => void) | null = null;
  // QA (Fallback checklist item 9, "Server/A-V down: status jelas") — fired
  // once a peer's ICE connection fails PERMANENTLY (the single automatic
  // retry in oniceconnectionstatechange below also failed), and again with
  // recovered=true if it later reaches 'connected'/'completed' (self-heals)
  // or the peer is torn down for any other reason (disconnectFromPlayer —
  // no point showing "connection lost" for someone who just walked away).
  // Before this, a permanently-failed peer had NO callback path at all —
  // their video tile just silently froze on the last frame forever.
  private onPeerConnectionStatus: ((id: string, failed: boolean) => void) | null = null;
  // Screen-share stall recovery (see SCREEN_STALL_RECOVERY_* above) — fires
  // whenever a peer's screenStalled flips, so the UI can swap the frozen
  // picture for a "Menyambung ulang..." overlay instead of showing nothing.
  private onScreenShareStalled: ((id: string, stalled: boolean) => void) | null = null;
  private analyserInterval: ReturnType<typeof setInterval> | null = null;
  // Runs only while at least one peer's volume is still travelling —
  // rampVolumes stops it once everyone has arrived.
  private volumeRampInterval: ReturnType<typeof setInterval> | null = null;

  setSocket(socket: Socket) {
    this.socket = socket;
    this.setupSignaling(socket);
  }

  // Lets callers detect that the socket they hold is no longer the one
  // signalling runs on — see the rebind effect in useWebRTC.
  getBoundSocket(): Socket | null {
    return this.socket;
  }

  // MAX_VIDEO_PEERS — called once per proximity tick from useWebRTC, BEFORE
  // that tick's connectToPlayer calls, so both connectToPlayer and any
  // inbound handleOffer that lands afterward see the current ranking.
  setVideoEligibleIds(ids: Iterable<string>) {
    this.videoEligibleIds = new Set(ids);
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

  setOnScreenShareStalled(cb: (id: string, stalled: boolean) => void) {
    this.onScreenShareStalled = cb;
  }

  setOnSpeakingChange(cb: (id: string, speaking: boolean) => void) {
    this.onSpeakingChange = cb;
  }

  setOnScreenShareEnded(cb: () => void) {
    this.onScreenShareEnded = cb;
  }

  setOnPeerConnectionStatus(cb: (id: string, failed: boolean) => void) {
    this.onPeerConnectionStatus = cb;
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
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: this.selectedMicId ? { deviceId: { ideal: this.selectedMicId } } : true,
      });
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

  // ---- Device selection ----------------------------------------------------

  // Labels are only filled in once permission for that KIND of device has been
  // granted: the mic is granted on join so mics/speakers are labelled, but
  // camera labels stay empty until the camera has been switched on at least
  // once. The UI shows a generic "Camera N" placeholder for the unlabelled.
  async listDevices(): Promise<{ mics: MediaDeviceInfo[]; cameras: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] }> {
    let devices: MediaDeviceInfo[] = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* ignore */ }
    return {
      mics: devices.filter((d) => d.kind === 'audioinput'),
      cameras: devices.filter((d) => d.kind === 'videoinput'),
      speakers: devices.filter((d) => d.kind === 'audiooutput'),
    };
  }

  getSelectedDevices(): { micId: string | null; cameraId: string | null; speakerId: string | null } {
    return { micId: this.selectedMicId, cameraId: this.selectedCameraId, speakerId: this.selectedSpeakerId };
  }

  // Swap the microphone live. replaceTrack (via syncTracksToPeers) needs no
  // renegotiation, so peers keep hearing this person with no drop.
  async switchMic(deviceId: string): Promise<void> {
    this.selectedMicId = deviceId;
    localStorage.setItem('meetkai.micId', deviceId);
    if (!this.localStream) return;

    const old = this.localStream.getAudioTracks()[0];
    // A freshly acquired track is enabled; if the user is currently muted the
    // new mic must stay muted too, or changing device would silently un-mute.
    const wasEnabled = old ? old.enabled : false;

    const fresh = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    const track = fresh.getAudioTracks()[0];
    if (!track) return;
    track.enabled = wasEnabled;

    if (old) { old.stop(); this.localStream.removeTrack(old); }
    this.localStream.addTrack(track);

    // Re-point the speaking-detection analyser at the new track — the old
    // source fed off the now-stopped one. Same wiring finishLocalMediaSetup
    // uses, minus its one-time setup.
    if (this.audioContext) {
      const source = this.audioContext.createMediaStreamSource(this.localStream);
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      source.connect(this.analyserNode);
    }

    this.syncTracksToPeers();
  }

  // Swap the camera. Only acts live if the camera is on; otherwise the id is
  // remembered and enableCamera() picks it up next time it's turned on.
  async switchCamera(deviceId: string): Promise<void> {
    this.selectedCameraId = deviceId;
    localStorage.setItem('meetkai.cameraId', deviceId);
    const stream = this.localStream;
    if (!stream) return;
    const old = stream.getVideoTracks()[0];
    if (!old) return;

    const fresh = await navigator.mediaDevices.getUserMedia({
      video: { ...CAMERA_CONSTRAINTS, deviceId: { exact: deviceId } },
    });
    const track = fresh.getVideoTracks()[0];
    if (!track) return;

    old.stop();
    stream.removeTrack(old);
    stream.addTrack(track);
    for (const peer of this.peers.values()) {
      const sender = this.cameraSender(peer);
      if (sender) sender.replaceTrack(track).catch(() => {});
      else this.videoSenders.add(peer.pc.addTrack(track, stream));
    }
  }

  // Redirect everyone's voice to the chosen speaker. setSinkId is Chromium-only
  // — on browsers without it this resolves to a no-op and playback stays on the
  // default device.
  async switchSpeaker(deviceId: string): Promise<void> {
    this.selectedSpeakerId = deviceId;
    localStorage.setItem('meetkai.speakerId', deviceId);
    for (const peer of this.peers.values()) {
      const el = peer.audioEl as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
      await el?.setSinkId?.(deviceId).catch(() => {});
    }
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
      const cam = await navigator.mediaDevices.getUserMedia({
        video: this.selectedCameraId
          ? { ...CAMERA_CONSTRAINTS, deviceId: { ideal: this.selectedCameraId } }
          : CAMERA_CONSTRAINTS,
      });
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
      // MAX_VIDEO_PEERS — a peer marked audio-only at connection time (too
      // far down the priority rank when they connected) stays that way even
      // if the LOCAL camera gets turned on well after the fact; otherwise
      // this loop would silently hand every audio-only peer a camera track
      // and defeat the cap the moment anyone toggled their camera.
      if (!peer.videoEligible) continue;
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

  // Records where this peer's volume SHOULD be. The actual move happens in
  // rampVolumes below, a step at a time.
  //
  // This used to write the new volume straight through. That was fine while
  // proximity recomputed 60x/sec — each step was a fraction of a percent —
  // but proximity now runs at 5/sec (see App.tsx's PROXIMITY_TICK_MS), and
  // at walking speed that is a jump of up to ~0.4 in a single assignment.
  // Stepping a volume that hard is audible as a click, and HTMLMediaElement
  // .volume has no scheduling API to smooth it, so the smoothing has to be
  // done here.
  private applyGain(peer: PeerConnection) {
    peer.targetVolume = Math.max(0, Math.min(1, peer.proximityGain * peer.manualVolume));
    // Push the current level out straight away, before any ramping. ontrack
    // calls this the moment it attaches a fresh <audio> element, and a brand
    // new element defaults to volume 1 — if the ramp had already settled at,
    // say, 0.3 for this peer, waiting for the next ramp tick (which would
    // see nothing left to move and skip the write entirely) would leave them
    // playing at full volume permanently.
    this.writePeerVolume(peer);
    this.ensureVolumeRamp();
  }

  private writePeerVolume(peer: PeerConnection): void {
    // The element is what the user actually hears, so proximity falloff has
    // to land here — the gain node alone only affects the recording tap.
    if (peer.audioEl) peer.audioEl.volume = peer.currentVolume;
    // A peer created before the AudioContext existed (offer arrived ahead of
    // local media) has no gain node — proximity ticks must not throw on it.
    if (peer.audioGain) peer.audioGain.gain.value = peer.currentVolume;
  }

  private ensureVolumeRamp(): void {
    if (this.volumeRampInterval) return;
    this.volumeRampInterval = setInterval(() => this.rampVolumes(), VOLUME_RAMP_INTERVAL_MS);
  }

  // Exponential approach — each tick closes a fixed fraction of the
  // remaining distance, so a big jump moves fast at first and settles
  // gently, and a small one is essentially instant. Snaps the last sliver
  // rather than approaching zero forever, which also lets the interval stop
  // once every peer has arrived.
  private rampVolumes(): void {
    let anyMoving = false;
    for (const peer of this.peers.values()) {
      const target = peer.targetVolume;
      let current = peer.currentVolume;
      if (Math.abs(target - current) < 0.005) {
        if (current === target) continue;
        current = target;
      } else {
        current += (target - current) * VOLUME_RAMP_FACTOR;
        anyMoving = true;
      }
      peer.currentVolume = current;
      this.writePeerVolume(peer);
    }
    if (!anyMoving && this.volumeRampInterval) {
      clearInterval(this.volumeRampInterval);
      this.volumeRampInterval = null;
    }
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
      // QA (Stabilitas checklist item 12, "Kuota biaya API") — TURN relay
      // bandwidth is the one genuinely metered/billable cost in this app's
      // WebRTC layer, and previously had ZERO visibility beyond this
      // console-only diagnostic (see this file's own top-of-file comment on
      // why that's a problem). A rough per-peer-connection COUNT (not
      // actual bytes — that figure only exists on the TURN server itself,
      // out of this app's reach) reported once per successful connection,
      // aggregated server-side and surfaced via /api/health, gives an
      // operator at least an early trend signal instead of finding out
      // usage grew only when the TURN provider's bill arrives.
      if (viaTurn) this.socket?.emit(SocketEvents.TURN_RELAY_USED);
    } catch (err) {
      diag('path check failed', { peer: remoteId, err: String(err) });
    }
  }

  // [webrtc-diag] §7 — cumulative packet counts from the last tick, per peer,
  // purely so reportStats() below can turn "total packets since the call
  // started" into "packets in the last ~5s" (see its own comment for why the
  // cumulative number alone is misleading for a mid-call stall).
  private lastPacketCounts = new Map<string, { in: number; out: number }>();
  // Screen-share stall recovery — cumulative framesReceived on the SCREEN
  // track's own receiver, last tick, per peer. Scoped to that one receiver
  // (RTCRtpReceiver.getStats(), not the aggregate pc.getStats()) so a peer
  // whose camera is flowing fine doesn't mask their stalled screen share, or
  // vice versa — the two tracks are counted completely independently.
  private lastScreenFrameCounts = new Map<string, number>();

  // [webrtc-diag] The decisive measurement, and the reason this whole pass
  // exists: whether audio BYTES are actually crossing the wire.
  //   bytesReceived climbing  → transport is fine, the fault is playback.
  //   bytesReceived stuck at 0 → nothing is arriving; transport (ICE/TURN) or
  //                              the sending side is at fault.
  // Guessing between those two without measuring is exactly what went wrong
  // in the previous two attempts.
  //
  // `verdict` turns the raw numbers below into the one thing this
  // investigation is actually asking for — which of the 4 failure directions
  // this peer is in RIGHT NOW — instead of leaving that as manual
  // cross-referencing across several log lines. Cumulative bytesReceived
  // staying nonzero forever after an early success would otherwise read as
  // "fine" even if it has been stalled for the last 10 minutes — inDelta/
  // outDelta (packets since the LAST tick, ~5s ago) is what actually proves
  // "flowing right now" vs "flowed once, then stopped".
  async reportStats(force = false): Promise<void> {
    // getStats() walks the whole RTC stats graph per peer — never run it on
    // a timer unless diagnostics are actually switched on. `force` is the
    // manual window.webrtcDiag() hook, which is always allowed.
    if (!force && !DIAG_ENABLED) return;
    const log = force
      ? (event: string, data?: unknown) => console.log(`[webrtc-diag] ${event}`, data ?? '')
      : diag;
    if (!this.peers.size) { log('stats: no peers connected'); return; }
    for (const [id, peer] of this.peers) {
      const ice = peer.pc.iceConnectionState;
      const out: Record<string, unknown> = {
        ice,
        conn: peer.pc.connectionState,
        elPaused: peer.audioEl?.paused,
        elMuted: peer.audioEl?.muted,
        trackMuted: peer.audioEl ? (peer.audioEl.srcObject as MediaStream | null)?.getAudioTracks()[0]?.muted : undefined,
        ctx: this.audioContext?.state,
      };
      let audioInPackets = 0;
      let audioOutPackets = 0;
      try {
        const stats = await peer.pc.getStats();
        stats.forEach((r: Record<string, unknown>) => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') {
            out.audioIn_bytes = r.bytesReceived;
            out.audioIn_packets = r.packetsReceived;
            audioInPackets = typeof r.packetsReceived === 'number' ? r.packetsReceived : 0;
          }
          if (r.type === 'outbound-rtp' && r.kind === 'audio') {
            out.audioOut_bytes = r.bytesSent;
            out.audioOut_packets = r.packetsSent;
            audioOutPackets = typeof r.packetsSent === 'number' ? r.packetsSent : 0;
          }
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
            out.pathLocal = r.localCandidateId;
            out.pathRemote = r.remoteCandidateId;
          }
          if (r.type === 'local-candidate' && r.id === out.pathLocal) out.localType = r.candidateType;
          if (r.type === 'remote-candidate' && r.id === out.pathRemote) out.remoteType = r.candidateType;
        });

        const prev = this.lastPacketCounts.get(id) ?? { in: 0, out: 0 };
        const inDelta = audioInPackets - prev.in;
        const outDelta = audioOutPackets - prev.out;
        this.lastPacketCounts.set(id, { in: audioInPackets, out: audioOutPackets });
        out.audioIn_deltaSinceLastTick = inDelta;
        out.audioOut_deltaSinceLastTick = outDelta;

        const iceOk = ice === 'connected' || ice === 'completed';
        out.verdict = !peer.audioEl ? 'NO_TRACK (belum pernah terima track audio dari peer ini)'
          : !iceOk ? `ICE_NOT_CONNECTED (${ice})`
          : outDelta <= 0 ? 'SENDER_NOT_SENDING (kita tidak kirim audio ke peer ini)'
          : inDelta <= 0 ? 'RECEIVER_NOT_RECEIVING (audio dari peer ini tidak sampai)'
          : (peer.audioEl.paused || this.audioContext?.state === 'suspended') ? 'RECEIVING_NOT_PLAYING (sampai tapi tidak diputar)'
          : 'OK';
      } catch (err) {
        out.statsError = String(err);
      }
      log(`stats [peer ${id}]`, out);

      await this.checkScreenStall(id, peer);
    }
  }

  // Screen-share stall detection — separate try/catch from the audio pass
  // above so a receiver.getStats() failure here can never suppress the
  // audio verdict, and separate iteration entirely from
  // reportSelectedPath()'s pc-wide getStats() call, since this needs stats
  // scoped to exactly one receiver (see lastScreenFrameCounts' own comment).
  private async checkScreenStall(id: string, peer: PeerConnection): Promise<void> {
    if (!peer.remoteScreenStream) {
      // Not (or no longer) receiving a screen share from this peer at all —
      // nothing to evaluate. Drop any stale baseline so a LATER share from
      // this same peer starts its own fresh baseline tick, same as a
      // brand-new peer would (see the `prevFrames === undefined` check
      // below), rather than diffing against frame counts from a previous,
      // unrelated share.
      this.lastScreenFrameCounts.delete(id);
      if (peer.screenStalled) {
        peer.screenStalled = false;
        this.onScreenShareStalled?.(id, false);
      }
      return;
    }
    const screenTrack = peer.remoteScreenStream.getVideoTracks()[0];
    const receiver = screenTrack && peer.pc.getReceivers().find((r) => r.track === screenTrack);
    if (!receiver) return;
    try {
      const stats = await receiver.getStats();
      let framesReceived: number | undefined;
      stats.forEach((r: Record<string, unknown>) => {
        if (r.type === 'inbound-rtp') framesReceived = typeof r.framesReceived === 'number' ? r.framesReceived : undefined;
      });
      if (framesReceived === undefined) return;
      const prevFrames = this.lastScreenFrameCounts.get(id);
      this.lastScreenFrameCounts.set(id, framesReceived);
      // No baseline yet (share just started, or just switched peers above) —
      // one tick to establish a starting point rather than comparing against
      // 0 and reading a brand-new share as instantly stalled.
      if (prevFrames === undefined) return;
      const stalled = framesReceived - prevFrames <= 0;
      diag('screen frames', { peer: id, framesReceived, deltaSinceLastTick: framesReceived - prevFrames, stalled });
      if (stalled === peer.screenStalled) return;
      peer.screenStalled = stalled;
      this.onScreenShareStalled?.(id, stalled);
      if (stalled) void this.attemptScreenRecovery(id, peer, 1);
    } catch (err) {
      diag('screen stall check error', { peer: id, err: String(err) });
    }
  }

  // Lighter-weight recovery than the full disconnectFromPlayer+connectToPlayer
  // rebuild oniceconnectionstatechange falls back to (see
  // SCREEN_STALL_RECOVERY_* above) — restartIce() leaves audio/camera on this
  // same peer connection completely undisturbed. Backs off between attempts
  // (2s, 4s, 6s) rather than hammering restartIce(); if the stall outlasts
  // every attempt, this simply stops trying and leaves screenStalled true —
  // the overlay keeps showing "Menyambung ulang...", and if the link is
  // genuinely dead (not just slow), ICE itself will reach
  // disconnected/failed on its own and the EXISTING watchdog
  // (oniceconnectionstatechange) takes over the full-reconnect path
  // completely independently of this one.
  private attemptScreenRecovery(id: string, peer: PeerConnection, attempt: number): void {
    if (!peer.screenStalled) return; // recovered already (checkScreenStall cleared it) — nothing to do
    if (this.peers.get(id) !== peer) return; // this exact peer object was torn down/replaced since the stall was first seen
    diag('screen stall recovery attempt', { peer: id, attempt });
    try {
      peer.pc.restartIce();
    } catch (err) {
      diag('restartIce error', { peer: id, err: String(err) });
    }
    if (attempt >= SCREEN_STALL_RECOVERY_MAX_ATTEMPTS) return;
    setTimeout(() => {
      if (peer.screenStalled && this.peers.get(id) === peer) this.attemptScreenRecovery(id, peer, attempt + 1);
    }, SCREEN_STALL_RECOVERY_BASE_DELAY_MS * attempt);
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

  private createPeer(remoteId: string, includeVideo: boolean): PeerConnection {
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
      screenStreamId: this.announcedScreens.get(remoteId) ?? null,
      speaking: false,
      videoStream: null,
      remoteScreenStream: null,
      screenSender: null,
      proximityGain: 1,
      manualVolume: 1,
      targetVolume: 1,
      currentVolume: 1,
      retryCount: 0,
      remoteDescSet: false,
      videoEligible: includeVideo,
      iceQueue: [],
      initialNegotiationDone: false,
      pendingRenegotiation: false,
      disconnectedTimer: null,
      screenStalled: false,
    };

    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) pc.addTrack(audioTrack, this.localStream);
      // MAX_VIDEO_PEERS — audio is cheap and always included up to the
      // total-peer cap; the camera track (the expensive one) is only added
      // for whoever was closest at connection time. `enableCamera()`
      // (turning the camera on AFTER this peer already connected audio-only)
      // still reaches them separately — see its own addTrack loop below,
      // which is untouched by this flag.
      const camTrack = includeVideo ? this.localStream.getVideoTracks()[0] : undefined;
      if (camTrack) pc.addTrack(camTrack, this.localStream);
    }
    // Pick up an already-in-progress screen share when connecting mid-share
    // (e.g. someone joins after sharing already started).
    if (this.screenStream) {
      const screenTrack = this.screenStream.getVideoTracks()[0];
      if (screenTrack) peer.screenSender = this.capScreenShareBitrate(pc.addTrack(screenTrack, this.screenStream));
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
        // [webrtc-diag] §6 — ontrack above only logs muted/enabled ONCE, at
        // the moment the track arrives. A track that goes mute mid-call (the
        // browser does this on its own when it stops receiving RTP for a
        // beat, independent of the ICE state above — this is exactly the
        // "connected but silent, no error" shape the reported bug has) would
        // otherwise leave zero trace anywhere in this file.
        event.track.onmute = () => diag('remote audio track MUTED', { from: remoteId, ice: pc.iceConnectionState });
        event.track.onunmute = () => diag('remote audio track unmuted', { from: remoteId });
        event.track.onended = () => diag('remote audio track ENDED', { from: remoteId, ice: pc.iceConnectionState });
        // Route to the chosen speaker if one was picked. setSinkId exists only
        // on Chromium (Firefox largely lacks output selection) — optional
        // chaining just no-ops where it's unsupported.
        if (this.selectedSpeakerId) {
          (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
            .setSinkId?.(this.selectedSpeakerId).catch(() => {});
        }
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

      // Camera or screen? Decided by which MediaStream the track arrived in,
      // NOT by arrival order.
      //
      // The camera is always added alongside the microphone (both live on
      // localStream), while a screen share is captured on its own via
      // getDisplayMedia and carries no audio. So a video track that shares a
      // stream with an audio track is a camera; one that arrives alone is a
      // screen.
      //
      // Order used to work only by accident: the camera was acquired at join
      // and merely disabled when "off", so it always arrived first and the
      // screen was always second. Once the camera started being released
      // while off, someone sharing their screen with the camera off sent the
      // SCREEN as their first video track — it was then filed as a camera,
      // complete with a volume slider, and never appeared as a shared screen
      // at all.
      const inboundId = event.streams[0]?.id;
      // Preferred answer: the presenter told us which stream is their screen
      // (RTC_SCREEN_SHARE). No inference involved.
      const announced = peer.screenStreamId ?? this.announcedScreens.get(remoteId) ?? null;
      const isCamera = announced && inboundId
        ? inboundId !== announced
        // Fallback for the window before that announcement lands (or if it is
        // lost): a camera travels in the same MediaStream as the microphone,
        // a screen is captured on its own by getDisplayMedia and carries no
        // audio. Still order-independent — just less certain than being told.
        : arrivedWithAudioOrUngrouped(event, peer);

      if (isCamera) {
        // Overwrites any previous camera stream rather than ignoring the new
        // one: a peer who turns their camera back on after it was released
        // sends a genuinely new track, and keeping the old dead one would
        // leave their tile frozen on the last frame before they switched off.
        const stream = new MediaStream([event.track]);
        peer.videoStream = stream;
        this.onRemoteStream?.(remoteId, stream);
      } else if (!peer.remoteScreenStream) {
        const stream = new MediaStream([event.track]);
        peer.remoteScreenStream = stream;
        this.onRemoteScreenStream?.(remoteId, stream);
        event.track.onended = () => {
          peer.remoteScreenStream = null;
          this.lastScreenFrameCounts.delete(remoteId);
          if (peer.screenStalled) {
            peer.screenStalled = false;
            this.onScreenShareStalled?.(remoteId, false);
          }
          this.onRemoteScreenEnded?.(remoteId);
        };
      }
    };

    // Fires when addTrack (screen share start, or syncTracksToPeers backfilling
    // audio once local media becomes ready) happens after the initial
    // offer/answer already completed — creates a fresh offer to renegotiate
    // the new m-line. Extracted to a named function so the pendingRenegotiation
    // fix below (both initialNegotiationDone = true sites) can call the exact
    // same logic manually, not just react to the browser's own event.
    const renegotiate = async () => {
      try {
        // [webrtc-diag] §8 — this comment block's original assumption ("only
        // one side ever renegotiates at a time, the person toggling screen
        // share") is not actually true: enableCamera() below also calls
        // addTrack() the first time a videoEligible peer's camera turns on,
        // which fires this same handler. Two people in a pair turning their
        // camera on within the same moment — an ordinary "everyone camera on"
        // start-of-meeting pattern, not an edge case — means BOTH sides can
        // hit this handler near-simultaneously: classic SDP glare, no perfect-
        // negotiation/rollback here to absorb it.
        //
        // Bug fix (screen-share blackout) — this used to just `return` here,
        // silently, same failure shape as the initialNegotiationDone gap
        // above: addTrack() had already run (the sender exists locally) but
        // its SDP was never announced to the remote side, permanently — for
        // a screen share specifically, that's a peer stuck on a black tile
        // for the rest of the call. A busy meeting (screen share starting
        // right as someone's camera comes on, or several peers connecting
        // in the same tick) hits this far more than an idle one, since more
        // than one addTrack lands on the same pc close together. Marking
        // pendingRenegotiation here and firing it from onsignalingstatechange
        // once the pc actually returns to 'stable' recovers it, the same way
        // initialNegotiationDone's own pendingRenegotiation catch-up does for
        // the very first negotiation.
        if (!this.socket) {
          diag('negotiationneeded SKIPPED (no socket)', { peer: remoteId });
          return;
        }
        if (pc.signalingState !== 'stable') {
          peer.pendingRenegotiation = true;
          diag('negotiationneeded SKIPPED (not stable), deferred', { peer: remoteId, signalingState: pc.signalingState });
          return;
        }
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit(SocketEvents.RTC_OFFER, {
          fromId: this.socket.id,
          toId: remoteId,
          payload: pc.localDescription,
        });
      } catch (err) {
        console.error('[webrtc] renegotiation error:', err);
        diag('renegotiation error', { peer: remoteId, err: String(err) });
      }
    };
    peer.renegotiate = renegotiate;

    pc.onnegotiationneeded = async () => {
      // addTrack() during this same createPeer() call also fires this —
      // the very first offer/answer is handled manually below instead, so
      // ignore it until that's done (see initialNegotiationDone's doc comment).
      //
      // Bug fix — this used to just `return` here, silently. If addTrack()
      // was called (by syncTracksToPeers, backfilling audio the instant
      // local media becomes ready) WHILE the initial offer/answer for this
      // exact peer is still in flight, the browser fires this event exactly
      // once — dropping it here meant that track's sender existed locally
      // but was NEVER announced to the remote side in any SDP, ever. See
      // pendingRenegotiation's own doc comment for the full mechanics; this
      // now remembers the miss instead of losing it.
      if (!peer.initialNegotiationDone) {
        peer.pendingRenegotiation = true;
        diag('negotiationneeded deferred (initial negotiation still in flight)', { peer: remoteId });
        return;
      }
      void renegotiate();
    };

    // Shared by the 'failed' branch below AND the 'disconnected' timeout —
    // same one-shot retry, then give up and let a future proximity tick (or
    // the peer going out of range and back in) pick it up, same as any other
    // not-yet-connected peer. Named so both call sites stay in lockstep
    // instead of drifting into two slightly different recovery paths.
    const handleConnectionBroken = () => {
      if (peer.retryCount < 1) {
        peer.retryCount++;
        console.log('[webrtc] retrying connection to', remoteId);
        this.disconnectFromPlayer(remoteId);
        setTimeout(() => this.connectToPlayer(remoteId), 1000);
      } else {
        // The one automatic retry above already failed too — this is a
        // permanent failure, not a transient blip. Nothing left to try on
        // its own; the next proximity tick (if this player is still
        // nearby) is what eventually gets a fresh attempt going, via the
        // normal connectToPlayer() path — same as any other "not yet
        // connected" peer.
        console.warn('[webrtc] connection to', remoteId, 'failed permanently after retry');
        this.onPeerConnectionStatus?.(remoteId, true);
      }
    };

    // [webrtc-diag] §8 — the other half of proving/disproving the glare
    // hypothesis above: a connection whose negotiation desynced (both sides
    // sent an offer at once) would show signalingState bouncing through an
    // unexpected sequence (e.g. stuck in 'have-local-offer', or an
    // out-of-order 'have-remote-offer') instead of the normal
    // stable -> have-local-offer -> stable / stable -> have-remote-offer ->
    // stable round trip — independent of what oniceconnectionstatechange
    // reports, since ICE can stay 'connected' throughout a purely SDP-level
    // desync.
    pc.onsignalingstatechange = () => {
      diag('signaling state', { peer: remoteId, signalingState: pc.signalingState });
      // Catch-up for renegotiate()'s own pendingRenegotiation deferral (see
      // its doc comment) — the pc just left whatever busy state blocked the
      // earlier attempt, so replay it now instead of leaving that track
      // (screen share, camera, ...) unannounced for the rest of the call.
      if (pc.signalingState === 'stable' && peer.pendingRenegotiation) {
        peer.pendingRenegotiation = false;
        void peer.renegotiate?.();
      }
    };

    pc.oniceconnectionstatechange = () => {
      // [webrtc-diag] §4 — the single most decisive signal. Never reaching
      // 'connected'/'completed' means no media path exists at all, which is a
      // TURN problem, not an audio-code problem.
      diag('ICE state', { peer: remoteId, ice: pc.iceConnectionState, conn: pc.connectionState });

      // Per-peer audio bug — 'disconnected' used to fall through here with no
      // handling at all: no retry, no UI signal, and (see connectToPlayer's
      // early-return on `this.peers.has(remoteId)`) no other path in this
      // app ever revisits an already-created peer while it's still in
      // proximity range. A pair stuck like this stayed silent for the rest
      // of the session unless one side reloaded. Give the ICE agent a real
      // window to self-heal first (very common, usually within a second or
      // two) — only escalate if 'disconnected' is still true once the timer
      // actually fires.
      if (pc.iceConnectionState === 'disconnected') {
        if (!peer.disconnectedTimer) {
          peer.disconnectedTimer = setTimeout(() => {
            peer.disconnectedTimer = null;
            if (pc.iceConnectionState === 'disconnected') {
              console.warn('[webrtc] ICE stuck in disconnected for', remoteId, '— treating as failed');
              handleConnectionBroken();
            }
          }, ICE_DISCONNECTED_TIMEOUT_MS);
        }
      } else if (peer.disconnectedTimer) {
        // Left 'disconnected' for any other reason (recovered, moved on to
        // 'failed' below, or the connection is being torn down) — the
        // pending timer above no longer applies and must not fire later
        // against whatever state this peer is in by then.
        clearTimeout(peer.disconnectedTimer);
        peer.disconnectedTimer = null;
      }

      // The only honest proof that TURN is doing anything: which candidate
      // pair actually won. 'relay' on either end means media is going through
      // the TURN server; 'host'/'srflx' means it connected directly and TURN
      // was never needed (so a successful call proves nothing about TURN).
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        void this.reportSelectedPath(remoteId, pc);
        this.onPeerConnectionStatus?.(remoteId, false);
      }
      if (pc.iceConnectionState === 'failed') {
        handleConnectionBroken();
      }
    };

    return peer;
  }

  // Returns false when the connection could NOT be started — the caller must
  // then leave this peer un-marked so a later proximity tick retries. Marking
  // it connected regardless meant that anyone whose media was still being
  // acquired when a neighbour first came into range was never connected to
  // for the rest of the session: no audio, no video, no error, no retry.
  //
  // MAX_TOTAL_PEERS — the caller (useWebRTC's updateProximity) is the only
  // place that knows everyone's proximity rank, so it implicitly decides
  // "should this connect at all" by only calling this for peers within the
  // total cap; "should this one get video" is read from videoEligibleIds
  // (set by that same caller just before, via setVideoEligibleIds) rather
  // than a per-call param, so the SAME decision applies whether we end up
  // as the offerer (this method) or the answerer (handleOffer, below).
  connectToPlayer(remoteId: string): boolean {
    if (this.peers.has(remoteId)) return true;
    if (!this.socket?.connected) return false;
    if (!this.localStream) return false;
    if (this.peers.size >= MAX_TOTAL_PEERS) {
      console.log('[webrtc] at MAX_TOTAL_PEERS, refusing new connection to', remoteId);
      return false;
    }

    const includeVideo = this.videoEligibleIds.has(remoteId);
    console.log('[webrtc] connecting to', remoteId, includeVideo ? '(with video)' : '(audio-only)');
    const peer = this.createPeer(remoteId, includeVideo);
    this.peers.set(remoteId, peer);

    // Someone walking up mid-presentation missed the original announcement —
    // it was broadcast once, before they were connected. Re-announcing on each
    // new connection means the marker is never something you had to be present
    // for. Idempotent: receivers just overwrite the same id.
    if (this.screenStream) {
      this.socket?.emit(SocketEvents.RTC_SCREEN_SHARE, { streamId: this.screenStream.id });
    }

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
          // Bug fix — fire the renegotiation onnegotiationneeded silently
          // deferred (see pendingRenegotiation's own doc comment) while
          // this initial offer/answer was still in flight — otherwise a
          // track added via syncTracksToPeers() in that exact window would
          // never actually get announced to the remote side.
          if (peer.pendingRenegotiation) {
            peer.pendingRenegotiation = false;
            void peer.renegotiate?.();
          }
        })
        .catch((err) => { console.error('[webrtc] offer error:', err); diag('offer error', { peer: remoteId, err: String(err) }); });
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
      // MAX_VIDEO_PEERS applies symmetrically here too — glare-avoidance
      // (lower socket id offers) means roughly half of all pairs land in
      // THIS path rather than connectToPlayer's, and the cap must hold
      // either way, not just for pairs we happened to initiate ourselves.
      // MAX_TOTAL_PEERS is deliberately NOT enforced on this inbound path —
      // there's no clean way to "politely refuse" an offer already in
      // flight (the sender would just see it silently time out), and the
      // outbound half already keeps the count bounded in practice.
      peer = this.createPeer(fromId, this.videoEligibleIds.has(fromId));
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
          this.lastScreenFrameCounts.delete(fromId);
          if (peer!.screenStalled) {
            peer!.screenStalled = false;
            this.onScreenShareStalled?.(fromId, false);
          }
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
        // Bug fix — same as connectToPlayer's offer path: fire whatever
        // renegotiation was silently deferred while this initial answer was
        // still in flight (see pendingRenegotiation's own doc comment).
        if (peer!.pendingRenegotiation) {
          peer!.pendingRenegotiation = false;
          void peer!.renegotiate?.();
        }
      })
      .catch((err) => { console.error('[webrtc] answer error:', err); diag('answer error', { peer: fromId, err: String(err) }); });
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
        .catch((err) => { console.error('[webrtc] setRemote error:', err); diag('setRemote (answer) error', { peer: fromId, err: String(err) }); });
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
      // Cancel the pending disconnected->failed escalation (if any) — this
      // peer is going away for some other reason (walked out of range, the
      // retry above tearing down before its own reconnect, explicit
      // cleanup), so that timer must not fire later and call
      // handleConnectionBroken() against a peer that no longer exists.
      if (peer.disconnectedTimer) {
        clearTimeout(peer.disconnectedTimer);
        peer.disconnectedTimer = null;
      }
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
      // Same reasoning as lastPacketCounts.delete below — a reconnect's
      // brand-new receiver starts framesReceived at 0, so a stale prior
      // count would read as an instant, spurious stall on the first tick.
      // Also clears any "Menyambung ulang..." overlay left showing for a
      // peer that's now gone entirely (their tile disappears anyway once
      // onRemoteScreenEnded above removes them, but this keeps
      // screenStalled from lingering true against a discarded peer object).
      this.lastScreenFrameCounts.delete(id);
      if (peer.screenStalled) {
        peer.screenStalled = false;
        this.onScreenShareStalled?.(id, false);
      }
      peer.analyser?.disconnect();
      peer.analyser = null;
      this.peers.delete(id);
      this.audioDestNodes.get(id)?.disconnect();
      this.audioDestNodes.delete(id);
      // [webrtc-diag] A reconnect starts a brand-new RTCPeerConnection whose
      // packet counters reset to 0 — a stale prev value from the old
      // connection would otherwise produce a nonsensical negative delta (and
      // a false SENDER_NOT_SENDING/RECEIVER_NOT_RECEIVING verdict) on the
      // very first tick after reconnecting.
      this.lastPacketCounts.delete(id);
      // Torn down for ANY reason (proximity left, retry-then-reconnect,
      // explicit cleanup) — a stale "connection lost" badge from an earlier
      // permanent failure must not linger once the peer itself is gone.
      this.onPeerConnectionStatus?.(id, false);
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

  // QA (Load checklist item 3) — the AUTHORITATIVE slot check, run against
  // the server. No longer gates the OS picker (see startScreenShare for why
  // that ordering was the bug); it now runs after capture has already
  // started, and a denial tears that capture back down.
  //
  // socket.once (not .on) — one-shot request/response, not an ongoing
  // subscription; a stray timeout-path response arriving late must not leak
  // a listener that fires again on some later unrelated grant/deny.
  //
  // The timeout is a pure safety net (server unreachable, request dropped),
  // treated as "granted" so a socket hiccup can never permanently block a
  // legitimate share — matching this app's existing "a check that can't be
  // verified fails open, not closed" posture (see roomHandler.ts's approval-
  // gate comments). It was 4000ms, which was catastrophic while this call
  // still blocked the picker: the server had a path that replied nothing at
  // all, so the user simply watched a dead button for four seconds. That
  // silent path is fixed server-side (rtcHandler.ts always answers now), and
  // this is 1500ms because nothing is waiting on the picker any more — the
  // only cost of the timeout now is how long a genuinely unreachable server
  // delays the confirmation of a share that has already started.
  private requestScreenShareSlot(): Promise<{ granted: boolean; reason?: string }> {
    return new Promise((resolve) => {
      const socket = this.socket;
      if (!socket?.connected) { resolve({ granted: true }); return; }
      const timer = setTimeout(() => {
        socket.off(SocketEvents.RTC_SCREEN_SHARE_GRANTED, onGranted);
        socket.off(SocketEvents.RTC_SCREEN_SHARE_DENIED, onDenied);
        resolve({ granted: true });
      }, 1500);
      const onGranted = () => { clearTimeout(timer); socket.off(SocketEvents.RTC_SCREEN_SHARE_DENIED, onDenied); resolve({ granted: true }); };
      const onDenied = (data: { reason?: string }) => { clearTimeout(timer); socket.off(SocketEvents.RTC_SCREEN_SHARE_GRANTED, onGranted); resolve({ granted: false, reason: data?.reason }); };
      socket.once(SocketEvents.RTC_SCREEN_SHARE_GRANTED, onGranted);
      socket.once(SocketEvents.RTC_SCREEN_SHARE_DENIED, onDenied);
      socket.emit(SocketEvents.RTC_SCREEN_SHARE_REQUEST);
    });
  }

  // QA (Load checklist item 3) — bounds encoded bitrate regardless of
  // network conditions; without this, WebRTC's own congestion control will
  // happily use however much bandwidth is available, which is exactly the
  // "one uncapped stream × N peers" cost the checklist item flags. Shared
  // by both places a screen track gets added to a peer connection
  // (starting a fresh share, and picking up an already-in-progress one when
  // a new peer connects mid-share — see createPeer). setParameters on a
  // sender that hasn't sent a frame yet still needs an `encodings` entry to
  // exist first — RTCRtpSender always has one after addTrack, so this is
  // safe without waiting on a negotiation round trip.
  private capScreenShareBitrate(sender: RTCRtpSender): RTCRtpSender {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = SCREEN_SHARE_MAX_BITRATE_BPS;
    sender.setParameters(params).catch((e) => console.warn('[webrtc] setParameters (screen bitrate cap) failed:', e));
    return sender;
  }

  // §6 — adds the screen capture as its OWN sender/track on every existing
  // peer connection (triggers onnegotiationneeded above), rather than
  // replaceTrack()-ing the camera sender — camera and screen now travel as
  // 2 independent tracks so both render as separate boxes simultaneously,
  // instead of screen share replacing the camera view entirely.
  // Ordering here is load-bearing, and getting it wrong is what made the
  // button feel broken. getDisplayMedia() requires TRANSIENT USER ACTIVATION,
  // which browsers expire a few seconds after the click (5s in Chrome). This
  // used to await a socket round-trip for a slot FIRST, which meant:
  //   - the OS picker could not appear until the server answered, so every
  //     share cost a round-trip of dead air, and a slow/silent answer cost
  //     the whole safety-net timeout; and
  //   - that wait spent the activation budget, so a slow answer made
  //     getDisplayMedia throw NotAllowedError — reported to the user as
  //     "permission denied" for a prompt they were never shown.
  // So capture goes FIRST, on the still-fresh activation, and the server
  // check follows. The original intent of the pre-check (don't prompt for
  // screen capture just to refuse the share) is kept by the local screen
  // below, which needs no round-trip at all.
  async startScreenShare(): Promise<{ success: boolean; error?: string }> {
    // Local, synchronous, zero-latency pre-screen. announcedScreens is
    // already maintained off the room-wide RTC_SCREEN_SHARE broadcast (see
    // setupSignaling), so the count is free — no request, no waiting, no
    // activation spent. It can UNDER-count (it only sees peers this client
    // has connected to — proximity-gated), never over-count, which is
    // exactly the right direction to be wrong in: a false "room is full"
    // would block a legitimate share, while a miss just falls through to
    // the authoritative server check below.
    if (this.announcedScreens.size >= MAX_SCREEN_SHARES_PER_ROOM) {
      return {
        success: false,
        error: `Sudah ada ${this.announcedScreens.size} orang share layar di room ini (maks ${MAX_SCREEN_SHARES_PER_ROOM}). Coba lagi setelah salah satu berhenti.`,
      };
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: SCREEN_SHARE_CONSTRAINTS });
    } catch (err: unknown) {
      // Now that capture runs first on a fresh gesture, NotAllowedError
      // really does mean the user dismissed the picker — it is no longer
      // the ambiguous "or the activation expired while we waited" it was
      // before. NotFoundError/NotReadableError are a genuinely different
      // failure (no capturable surface, or the OS refused to hand it over)
      // and used to be flattened into one unhelpful message.
      const name = err instanceof DOMException ? err.name : '';
      const message =
        name === 'NotAllowedError' ? 'Share layar dibatalkan.'
        : name === 'NotFoundError' || name === 'NotReadableError' ? 'Tidak ada layar yang bisa dibagikan.'
        : 'Gagal memulai share layar.';
      console.warn('[webrtc] getDisplayMedia failed:', name || err);
      return { success: false, error: message };
    }

    // Authoritative check, now that capture is already running. On a denial
    // the capture we just started has to be torn back down — the user picked
    // a surface for a share that isn't going to happen.
    const slot = await this.requestScreenShareSlot();
    if (!slot.granted) {
      stream.getTracks().forEach((t) => t.stop());
      return { success: false, error: slot.reason || 'Room ini sudah penuh yang share layar.' };
    }

    // stopScreenShare() may have run while we were awaiting the slot (the
    // user hit the button again, or the share ended some other way). Adopting
    // this stream now would resurrect a share that was already cancelled and
    // leave a track nothing ever stops.
    if (this.screenStream) {
      stream.getTracks().forEach((t) => t.stop());
      return { success: false, error: 'Share layar dibatalkan.' };
    }

    this.screenStream = stream;
    const screenTrack = stream.getVideoTracks()[0];
    screenTrack.onended = () => this.stopScreenShare();
    // Announce BEFORE adding the track, so the id is already known by the
    // time the renegotiated track shows up at the other end and there is no
    // window where it has to be guessed at.
    this.socket?.emit(SocketEvents.RTC_SCREEN_SHARE, { streamId: stream.id });

    for (const peer of this.peers.values()) {
      // addTrack() below fires onnegotiationneeded synchronously — its own
      // handler (see createPeer) already defers via pendingRenegotiation
      // when this peer's initial offer/answer is still in flight, or when
      // the connection isn't 'stable' yet, and replays it once ready. No
      // extra bookkeeping needed here.
      peer.screenSender = this.capScreenShareBitrate(peer.pc.addTrack(screenTrack, stream));
    }
    return { success: true };
  }

  stopScreenShare() {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.socket?.emit(SocketEvents.RTC_SCREEN_SHARE, { streamId: null });

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
    // Cleared here and NOT in disconnectFromPlayer: someone walking out of
    // proximity range is still presenting, so forgetting their announcement
    // would force the next reconnection back onto the fallback guess. Leaving
    // the room is the point at which none of it is true any more.
    this.announcedScreens.clear();
    if (this.analyserInterval) clearInterval(this.analyserInterval);
    if (this.volumeRampInterval) { clearInterval(this.volumeRampInterval); this.volumeRampInterval = null; }
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.audioContext?.close();
    this.socket = null;
  }

  // Screen-share stream ids announced by peers, kept outside the peer record
  // so an announcement that arrives BEFORE we've connected to that person
  // isn't lost — createPeer seeds itself from here.
  private announcedScreens = new Map<string, string>();

  private setupSignaling(socket: Socket) {
    socket.on(SocketEvents.RTC_SCREEN_SHARE, (data: { fromId: string; streamId: string | null }) => {
      if (!data?.fromId) return;
      const peer = this.peers.get(data.fromId);
      if (data.streamId) {
        this.announcedScreens.set(data.fromId, data.streamId);
        if (peer) peer.screenStreamId = data.streamId;
      } else {
        this.announcedScreens.delete(data.fromId);
        if (peer) peer.screenStreamId = null;
        // A stop announcement retracts the panel immediately, without waiting
        // for the track's own `ended` event — which is precisely the signal
        // that proved unreliable and left ghost panels behind.
        if (peer?.remoteScreenStream) {
          peer.remoteScreenStream = null;
          this.lastScreenFrameCounts.delete(data.fromId);
          if (peer.screenStalled) {
            peer.screenStalled = false;
            this.onScreenShareStalled?.(data.fromId, false);
          }
          this.onRemoteScreenEnded?.(data.fromId);
        }
      }
    });

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
    // and back on, which reads as flicker rather than speech. Applies to the
    // local mic too (tracked under the 'local' key in the same `quiet` map
    // as remote peers below) — it used to flip on the raw threshold with no
    // debounce at all, so your OWN ring flickered on every short pause even
    // after remote peers were already smoothed out.
    // Was 4 (~400ms) — still shorter than a lot of ordinary conversational
    // pauses (breath, sentence boundary, thinking), so the ring kept
    // dropping and re-triggering multiple times over a single continuous
    // turn of speech, not just once at the true start/end. 6 (~600ms) still
    // reads as prompt but tolerates a normal mid-sentence pause without
    // flapping.
    const QUIET_TICKS_TO_STOP = 6; // ~600ms at the 100ms interval below
    const quiet = new Map<string, number>();
    // Scratch buffer shared by every peer's loudness read — see the loop.
    let peerBuf = new Uint8Array(0);

    this.analyserInterval = setInterval(() => {
      if (this.analyserNode) {
        const loud = WebRTCService.loudness(this.analyserNode, data) > SPEAKING_THRESHOLD;
        if (loud) {
          quiet.set('local', 0);
          if (!localSpeaking) {
            localSpeaking = true;
            this.onSpeakingChange?.('local', true);
          }
        } else if (localSpeaking) {
          const n = (quiet.get('local') ?? 0) + 1;
          quiet.set('local', n);
          if (n >= QUIET_TICKS_TO_STOP) {
            localSpeaking = false;
            this.onSpeakingChange?.('local', false);
          }
        }
      }

      // Same measurement for every connected peer. Reads only — see the
      // analyser's doc comment on PeerConnection.
      for (const [id, peer] of this.peers) {
        if (!peer.analyser) continue;
        // Reuse one buffer across peers and ticks. This used to allocate a
        // fresh ~1KB Uint8Array per peer per tick — at 10 ticks/sec with a
        // full mesh that is ~80KB/sec of pure garbage, purely to be read
        // once and thrown away. Every analyser here is created with the same
        // fftSize, so one buffer sized to the largest seen fits them all;
        // getByteTimeDomainData fills only as much as it needs.
        if (peerBuf.length < peer.analyser.frequencyBinCount) {
          peerBuf = new Uint8Array(peer.analyser.frequencyBinCount);
        }
        const buf = peerBuf;
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
  // Always available, flag or not — a snapshot on demand costs nothing until
  // someone actually asks for it.
  (window as unknown as { webrtcDiag: () => void }).webrtcDiag = () => { void webrtcService.reportStats(true); };
  // [webrtc-diag] For someone reproducing the bug who isn't going to
  // manually scroll/select console output mid-meeting: run
  // webrtcDiagExport() in the console once, and the whole session's log
  // (every ICE change, ontrack, play() result, and 5s stats tick, in order)
  // is copied to the clipboard as one block, ready to paste back. Falls back
  // to printing it plainly if the Clipboard API is unavailable/blocked
  // (e.g. no secure context, or the permission prompt was never answered).
  (window as unknown as { webrtcDiagExport: () => string }).webrtcDiagExport = () => {
    const text = diagLog.join('\n');
    navigator.clipboard?.writeText(text).then(
      () => console.log(`[webrtc-diag] ${diagLog.length} baris disalin ke clipboard — tinggal paste & kirim.`),
      () => console.log(`[webrtc-diag] gagal salin otomatis (${diagLog.length} baris) — copy manual teks di bawah ini:\n${text}`),
    );
    return text;
  };
  if (DIAG_ENABLED) {
    // Printed once at load so "did my .env.local actually get picked up?" is
    // answerable without guessing — the URL is shown, the credential never is.
    console.log('[webrtc-diag] TURN configured:', !!(TURN_URL && TURN_USERNAME && TURN_CREDENTIAL), TURN_URL ? `(${TURN_URL})` : '(STUN only)');
    // The polling half is the expensive part, so it only exists when the
    // flag is on.
    setInterval(() => { void webrtcService.reportStats(); }, 5000);
  }
}
