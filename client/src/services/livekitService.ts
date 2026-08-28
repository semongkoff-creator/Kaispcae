import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  type RemoteTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
  ConnectionQuality,
  type LocalTrackPublication,
} from 'livekit-client';
import { api } from './api';
import type { PeerQuality, QualityLevel, SelfVerdict } from './connectionQuality';
import { publishConnectionQuality, clearConnectionQuality } from '@/stores/connectionQuality';

// The LiveKit half of the media layer. Lives BESIDE webrtcService rather than
// replacing it: which one a room uses is decided by livekitRooms.ts, and a
// room on the mesh must be able to keep working untouched while this is
// developed against a single test room.
//
// The public surface mirrors webrtcService's where it matters, so App.tsx and
// VideoGrid can eventually call either through one interface. It is not a
// complete mirror yet — Fase A is connect, microphone, camera and remote
// tracks. Proximity subscription (Fase B) and screen share (Fase C) follow.

/**
 * One person in range, as useProximity reports them.
 *
 * Deliberately a local shape rather than the shared ProximityPlayer: the gain
 * is already computed by the caller (calcGain, or 1 for a zone-mate), so this
 * service never needs to know the distance curve — only the answer.
 */
export interface ProximityEntry {
  /** LiveKit identity — the ACCOUNT id, not the socket id. */
  userId?: string;
  distanceTiles: number;
  viaZone?: boolean;
  gain: number;
}

/**
 * How many nearby people's cameras to pull at once.
 *
 * The mesh cap existed because every camera was a separate encode on the
 * SENDER. Here the sender encodes once regardless, so this bounds only what
 * this browser decodes — which is why it can be the same number without the
 * old worry about what it costs everyone else.
 */
const MAX_VIDEO_SUBSCRIPTIONS = 6;

type RemoteStreamCb = (identity: string, stream: MediaStream) => void;
type SpeakingCb = (identity: string, speaking: boolean) => void;
type ConnectionCb = (state: 'connecting' | 'connected' | 'disconnected' | 'failed') => void;

class LiveKitService {
  private room: Room | null = null;
  private roomSlug: string | null = null;

  private onRemoteStream: RemoteStreamCb | null = null;
  private onRemoteStreamEnded: ((identity: string) => void) | null = null;
  private onRemoteScreenStream: RemoteStreamCb | null = null;
  private onRemoteScreenEnded: ((identity: string) => void) | null = null;
  private playerIdFor: ((identity: string) => string | null) | null = null;
  private onSpeakingChange: SpeakingCb | null = null;
  private onConnectionChange: ConnectionCb | null = null;

  setOnRemoteStream(cb: RemoteStreamCb) { this.onRemoteStream = cb; }
  setOnRemoteStreamEnded(cb: (identity: string) => void) { this.onRemoteStreamEnded = cb; }
  // Named to match webrtcService's own pair, so App wires both paths identically.
  setOnRemoteScreenStream(cb: RemoteStreamCb) { this.onRemoteScreenStream = cb; }
  setOnRemoteScreenEnded(cb: (identity: string) => void) { this.onRemoteScreenEnded = cb; }
  /**
   * How to turn a LiveKit identity into the player id the UI keys on.
   *
   * The same boundary the remote streams cross, and for the same reason: this
   * layer knows account ids, everything downstream knows player ids. Supplied
   * by App rather than looked up here, so the media service stays unaware the
   * game store exists.
   *
   * Without it the quality map is keyed by account id, MemberListPanel looks
   * up by player id, every lookup misses, and the bars read "no measurement"
   * while being fully populated — the failure that looks exactly like the one
   * this fixes.
   */
  setPlayerIdResolver(fn: (identity: string) => string | null) { this.playerIdFor = fn; }
  setOnSpeakingChange(cb: SpeakingCb) { this.onSpeakingChange = cb; }
  setOnConnectionChange(cb: ConnectionCb) { this.onConnectionChange = cb; }

  isConnected(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }

  getRoomSlug(): string | null {
    return this.roomSlug;
  }

  /**
   * Join the SFU room for a KaiSpace room.
   *
   * The token is fetched per join rather than cached: it is scoped to one room
   * and expires the same working day (see server/src/routes/livekit.ts), and
   * the server re-checks room access every time it mints one — so a person
   * whose access was revoked between two joins is refused at the second,
   * which a cached token would have let through.
   */
  async connect(roomSlug: string): Promise<{ success: boolean; error?: string }> {
    if (this.room) await this.disconnect();

    let token: string;
    let url: string;
    try {
      const res = await api.getLiveKitToken(roomSlug);
      token = res.token;
      url = res.url;
    } catch (err) {
      // 503 means this deployment has no LiveKit configured, which is a
      // legitimate state and not an error worth alarming anybody about — the
      // caller falls back to the mesh.
      return { success: false, error: err instanceof Error ? err.message : 'Could not get a LiveKit token' };
    }

    const room = new Room({
      // Let the SDK drop video it is not displaying and re-request it when it
      // is. This is the thing a mesh cannot do at all: it was sending every
      // viewer a full 1080p screen share even for a 96px thumbnail, because
      // there was only ever one quality to send.
      adaptiveStream: true,
      // Stop publishing layers nobody is subscribed to. In a room where most
      // cameras are off-screen most of the time, this is the difference
      // between encoding for the room and encoding for who is looking.
      dynacast: true,
    });

    this.room = room;
    this.roomSlug = roomSlug;
    this.wireEvents(room);

    this.onConnectionChange?.('connecting');
    try {
      await room.connect(url, token);
      this.onConnectionChange?.('connected');
      return { success: true };
    } catch (err) {
      this.onConnectionChange?.('failed');
      this.room = null;
      this.roomSlug = null;
      return { success: false, error: err instanceof Error ? err.message : 'Could not join the media room' };
    }
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.roomSlug = null;
    // Leaving a room must not carry its peers into the next one — same reason
    // webrtcService clears this on teardown.
    clearConnectionQuality();
    if (room) await room.disconnect();
    this.onConnectionChange?.('disconnected');
  }

  /**
   * One MediaStream per participant per purpose, held here and added to.
   *
   * The first version built a fresh `new MediaStream([track])` on every
   * TrackSubscribed and handed it over. The app keeps one entry per player, so
   * each arriving track replaced the last: a camera silenced the microphone,
   * and a screen share silenced both. That is the "suara hilang saat
   * sharescreen" report — the voice was never lost, the element playing it was
   * swapped for one holding only the screen.
   *
   * Two maps and not one, mirroring the mesh's own split (remoteStreams and
   * remoteScreenStreams in App.tsx): a share has to arrive without disturbing
   * the camera tile beside it.
   */
  private mediaStreams = new Map<string, MediaStream>();
  private screenStreams = new Map<string, MediaStream>();

  /**
   * The local camera/mic and the local screen, as two stable MediaStreams.
   *
   * Stable is the whole point: App reads these during render to fill its own
   * preview tile, and handing back `new MediaStream([...])` each call gives the
   * <video> a different object every frame, which resets srcObject and leaves
   * the tile flickering or black. Built once, mutated in place.
   */
  private localStream = new MediaStream();
  private localScreenStream = new MediaStream();

  /** Screen share is two sources, not one — the video and its tab/system audio. */
  private static isScreenSource(source: Track.Source): boolean {
    return source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio;
  }

  private streamFor(identity: string, screen: boolean): MediaStream {
    const map = screen ? this.screenStreams : this.mediaStreams;
    let stream = map.get(identity);
    if (!stream) {
      stream = new MediaStream();
      map.set(identity, stream);
    }
    return stream;
  }

  private forgetParticipant(identity: string): void {
    this.mediaStreams.delete(identity);
    this.screenStreams.delete(identity);
  }

  /**
   * LiveKit's own verdict, in the shape the signal bars already read.
   *
   * The mesh derived this from getStats() on every peer connection — RTT,
   * jitter, loss, the encoder's own limitation reason — and none of that
   * exists here, because none of those connections exist. So the bars sat at
   * "no measurement" for every room on this path: the strip showed a dash and
   * looked like a broken feature rather than a missing one.
   *
   * The SFU already computes this centrally and reports it per participant,
   * which is both cheaper than walking a stats graph per peer and, for the
   * local verdict, more honest: the mesh could never tell "my uplink is
   * saturated" from "theirs is" with one connection to measure, and refused to
   * guess below a peer count. The server sees every publisher and has no such
   * problem.
   *
   * No 'fair' tier: LiveKit reports Excellent/Good/Poor/Lost, and painting its
   * Good — which means a perfectly usable link — as a warning colour would
   * teach people to ignore the one state that matters.
   */
  private static toQuality(q: ConnectionQuality): { level: QualityLevel; bars: 0 | 1 | 2 | 3 } {
    switch (q) {
      case ConnectionQuality.Excellent: return { level: 'good', bars: 3 };
      case ConnectionQuality.Good:      return { level: 'good', bars: 2 };
      case ConnectionQuality.Poor:      return { level: 'poor', bars: 1 };
      // Lost is not "no data" — it is the worst possible reading, and zero
      // bars is reserved for not having measured yet.
      case ConnectionQuality.Lost:      return { level: 'poor', bars: 1 };
      default:                          return { level: 'unknown', bars: 0 };
    }
  }

  private publishQuality(room: Room): void {
    const peers = new Map<string, PeerQuality>();
    let affected = 0;
    for (const [identity, participant] of room.remoteParticipants) {
      // Keyed by player id, because that is what MemberListPanel looks up.
      const id = this.playerIdFor?.(identity);
      if (!id) continue;
      const { level, bars } = LiveKitService.toQuality(participant.connectionQuality);
      // relayed: the mesh read this off the nominated ICE candidate pair. Here
      // every stream goes through the SFU by definition, so the distinction
      // the mesh drew — direct versus TURN — has no meaning to carry over.
      peers.set(id, { level, bars, relayed: false });
      if (level === 'poor') affected++;
    }

    const own = LiveKitService.toQuality(room.localParticipant.connectionQuality);
    const self: SelfVerdict = {
      // LiveKit reports that a link is bad, never why. 'degraded' says exactly
      // that; claiming 'cpu' or 'bandwidth' would be inventing a diagnosis,
      // and this is the field that sends someone off to reset a router.
      cause: own.level === 'good' ? 'ok' : own.level === 'poor' ? 'degraded' : 'unknown',
      level: own.level,
      affected,
      total: peers.size,
    };

    publishConnectionQuality(peers, self);
  }

  private wireEvents(room: Room): void {
    // Reported by the server rather than polled, so there is no timer here and
    // nothing to tune.
    room.on(RoomEvent.ConnectionQualityChanged, () => this.publishQuality(room));
    room.on(RoomEvent.ParticipantConnected, () => this.publishQuality(room));
    room.on(RoomEvent.ParticipantDisconnected, () => this.publishQuality(room));

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      // identity is the KaiSpace user id — see the token endpoint, which sets
      // it deliberately so a LiveKit participant can be matched back to a
      // player on the map without a second lookup.
      if (track.kind !== Track.Kind.Audio && track.kind !== Track.Kind.Video) return;

      const screen = LiveKitService.isScreenSource(pub.source);
      const stream = this.streamFor(participant.identity, screen);
      // Added, not replaced — the mic and the camera belong to the same stream,
      // and a second arrival must not evict the first.
      if (!stream.getTracks().includes(track.mediaStreamTrack)) {
        stream.addTrack(track.mediaStreamTrack);
      }

      if (screen) this.onRemoteScreenStream?.(participant.identity, stream);
      else this.onRemoteStream?.(participant.identity, stream);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      const screen = LiveKitService.isScreenSource(pub.source);
      const map = screen ? this.screenStreams : this.mediaStreams;
      const stream = map.get(participant.identity);
      if (!stream) return;

      stream.removeTrack(track.mediaStreamTrack);

      // Only when nothing is left. Ending the whole stream because one track
      // stopped is what made stopping a share also drop the presenter's voice.
      if (stream.getTracks().length === 0) {
        map.delete(participant.identity);
        if (screen) this.onRemoteScreenEnded?.(participant.identity);
        else this.onRemoteStreamEnded?.(participant.identity);
      } else if (screen) {
        this.onRemoteScreenStream?.(participant.identity, stream);
      } else {
        this.onRemoteStream?.(participant.identity, stream);
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      this.forgetParticipant(participant.identity);
      this.onRemoteScreenEnded?.(participant.identity);
      this.onRemoteStreamEnded?.(participant.identity);
    });

    // Speaking detection, free.
    //
    // The mesh version of this is ~37 lines of AnalyserNode plumbing per peer,
    // tapped before the proximity gain so someone a few tiles away does not
    // register as silent. The SFU computes it centrally and reports it, which
    // is both cheaper and more accurate — it sees every publisher, not only
    // the ones this browser happens to be subscribed to.
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const speaking = new Set(speakers.map((s) => s.identity));
      for (const p of room.remoteParticipants.values()) {
        this.onSpeakingChange?.(p.identity, speaking.has(p.identity));
      }
      this.onSpeakingChange?.(room.localParticipant.identity, speaking.has(room.localParticipant.identity));
    });

    room.on(RoomEvent.Disconnected, () => {
      this.onConnectionChange?.('disconnected');
    });

    room.on(RoomEvent.Reconnecting, () => this.onConnectionChange?.('connecting'));
    room.on(RoomEvent.Reconnected, () => this.onConnectionChange?.('connected'));
  }

  // ── Local media ──────────────────────────────────────────────────────────
  //
  // One call each, against one connection. The mesh equivalent is a loop over
  // every peer plus a renegotiation per peer, which is what the m-line
  // ordering bug grew out of — there is no renegotiation here to get wrong.

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    await this.room?.localParticipant.setMicrophoneEnabled(enabled);
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    await this.room?.localParticipant.setCameraEnabled(enabled);
  }

  isMicrophoneEnabled(): boolean {
    return this.room?.localParticipant.isMicrophoneEnabled ?? false;
  }

  isCameraEnabled(): boolean {
    return this.room?.localParticipant.isCameraEnabled ?? false;
  }

  /** The local camera track, for the self-view tile. */
  getLocalVideoStream(): MediaStream | null {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Camera) as LocalTrackPublication | undefined;
    const track = pub?.track?.mediaStreamTrack;
    return track ? new MediaStream([track]) : null;
  }

  async switchMic(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice('audioinput', deviceId);
  }

  async switchCamera(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice('videoinput', deviceId);
  }

  async switchSpeaker(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice('audiooutput', deviceId);
  }

  /**
   * Per-listener volume, which is what proximity falloff drives.
   *
   * Built into the SDK, and applied to playback rather than to the sender —
   * so turning someone down costs them nothing and does not need renegotiating
   * with anyone. Same semantics as webrtcService's setAudioVolume, which is
   * why Fase B can reuse useProximity's output untouched.
   */
  setParticipantVolume(identity: string, volume: number): void {
    const participant = this.room?.remoteParticipants.get(identity);
    participant?.setVolume(Math.max(0, Math.min(1, volume)));
  }

  // ── Screen share ─────────────────────────────────────────────────────────

  /**
   * Start or stop sharing this screen.
   *
   * One call, one publication, whatever the room size. The mesh version had to
   * addTrack on every peer connection and renegotiate each one, which is where
   * both the black-tile bug and the m-line ordering failure came from — and
   * why MAX_SCREEN_SHARES_PER_ROOM had to be cut to 1: at ~600 kbps per viewer
   * on the presenter's own uplink, four simultaneous shares asked around
   * 36 Mbps of one office connection and took people's voices with it.
   *
   * Here the presenter uploads once and the server fans out, so that cap is a
   * property of the mesh and not of the product. It can go back up for rooms
   * on this path.
   */
  async setScreenShareEnabled(enabled: boolean): Promise<{ success: boolean; error?: string }> {
    const room = this.room;
    if (!room) return { success: false, error: 'Belum tersambung ke room media.' };
    try {
      await room.localParticipant.setScreenShareEnabled(
        enabled,
        {
          // Matches the mesh's own capture bounds (webrtcService's
          // SCREEN_SHARE_CONSTRAINTS): a shared screen is mostly static text,
          // so resolution is what keeps it readable and frames are what can be
          // dropped when the link is tight.
          resolution: { width: 1920, height: 1080, frameRate: 15 },
        },
        {
          // No simulcast, which is why a share stopped being legible.
          //
          // The room runs adaptiveStream, and it picks a layer from the SIZE
          // OF THE <video> ELEMENT the viewer is rendering into. A share in
          // the side strip is a few hundred pixels wide, so it was handed the
          // quarter-resolution layer and 11px code became a grey smear. That
          // is the right trade for a face — a 96px camera thumbnail has no use
          // for 1080p — and the wrong one for a screen, where being readable
          // IS the feature.
          //
          // Pinning quality per subscription was the other option and loses:
          // adaptiveStream recomputes from element size on the next update and
          // takes it back, so it would fight on every resize. With one layer
          // published there is simply nothing blurrier to fall back to.
          //
          // The cost is real and deliberate: a viewer on a weak link can no
          // longer be quietly given a smaller version. They get this or they
          // stutter. A share nobody can read has already failed, so stuttering
          // and sharp beats smooth and useless.
          simulcast: false,
          // 4 Mbps against LiveKit's 2.5 default for h1080fps15. Text is
          // unforgiving of compression in a way faces are not — and at 15fps
          // this is a third of what the same bitrate would cost at 30.
          screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 15 },
        },
      );
      return { success: true };
    } catch (err) {
      // The user dismissing the OS picker lands here and is not a failure
      // worth reporting as one — same distinction webrtcService draws between
      // NotAllowedError and a genuine capture problem.
      const name = err instanceof DOMException ? err.name : '';
      return {
        success: false,
        error: name === 'NotAllowedError' ? 'Share layar dibatalkan.' : 'Gagal memulai share layar.',
      };
    }
  }

  isScreenSharing(): boolean {
    return this.room?.localParticipant.isScreenShareEnabled ?? false;
  }

  /**
   * The local camera and microphone, for the app's own preview tile.
   *
   * The mesh path exposes the getUserMedia stream it captured; on this path
   * the tracks belong to the room, so they are collected into one stream that
   * matches the shape App already expects. Without this, App's direct
   * webrtcService.getLocalStream() returned null for every LiveKit room and
   * nobody could see themselves in Meeting View.
   */
  getLocalStream(): MediaStream | null {
    this.syncLocal(this.localStream, [Track.Source.Camera, Track.Source.Microphone]);
    return this.localStream.getTracks().length ? this.localStream : null;
  }

  /** The local screen capture, for the presenter's own preview tile. */
  getScreenStream(): MediaStream | null {
    this.syncLocal(this.localScreenStream, [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]);
    return this.localScreenStream.getTracks().length ? this.localScreenStream : null;
  }

  /** Bring one held stream in line with what the room currently publishes. */
  private syncLocal(stream: MediaStream, sources: Track.Source[]): void {
    const local = this.room?.localParticipant;
    const wanted = new Set<MediaStreamTrack>();
    if (local) {
      for (const source of sources) {
        const track = local.getTrackPublication(source)?.track?.mediaStreamTrack;
        if (track) wanted.add(track);
      }
    }
    for (const track of stream.getTracks()) if (!wanted.has(track)) stream.removeTrack(track);
    for (const track of wanted) if (!stream.getTracks().includes(track)) stream.addTrack(track);
  }

  // ── Proximity ────────────────────────────────────────────────────────────

  /**
   * Apply one proximity tick.
   *
   * The RULES do not live here and are not changing: useProximity.ts still
   * decides who is audible — zone isolation, Focus/DND, distance falloff,
   * table grouping, Spotlight — and this is only what its answer is fed into.
   * On the mesh that was connect/disconnect a peer connection; here it is
   * subscribe/unsubscribe a track that the server is already holding.
   *
   * That difference is the whole reason this migration is worth doing. A mesh
   * had to renegotiate to change who you could hear, and renegotiation is
   * where the m-line ordering failure came from. Subscribing touches no SDP at
   * all, so walking past somebody can no longer break a call.
   */
  applyProximity(nearby: ProximityEntry[]): void {
    const room = this.room;
    if (!room) return;

    // Ranked the same way the mesh ranked it: zone-mates first, then closest.
    // Only the top few get video — audio is cheap and everyone in range gets
    // it, cameras are not and never were.
    const ranked = [...nearby].sort((a, b) => {
      if (!!a.viaZone !== !!b.viaZone) return a.viaZone ? -1 : 1;
      return a.distanceTiles - b.distanceTiles;
    });
    const videoAllowed = new Set(ranked.slice(0, MAX_VIDEO_SUBSCRIPTIONS).map((p) => p.userId).filter(Boolean));
    const audible = new Map<string, ProximityEntry>();
    for (const p of ranked) if (p.userId) audible.set(p.userId, p);

    for (const [identity, participant] of room.remoteParticipants) {
      const entry = audible.get(identity);

      for (const pub of participant.trackPublications.values()) {
        const isVideo = pub.kind === Track.Kind.Video;
        // A screen share is never proximity-gated. Someone presenting is
        // addressing the room, and the mesh treated it the same way — it went
        // to every connected peer regardless of distance.
        const isScreen = pub.source === Track.Source.ScreenShare;

        const want = !!entry && (isScreen || !isVideo || videoAllowed.has(identity));
        if (pub.isSubscribed !== want) pub.setSubscribed(want);
      }

      // Zone-mates hear each other at full volume however far apart they are;
      // everyone else fades with distance. Identical to the mesh rule, and it
      // has to be, because it is the same useProximity output driving it.
      if (entry) this.setParticipantVolume(identity, entry.viaZone ? 1 : entry.gain);
    }
  }
}

export const livekitService = new LiveKitService();
