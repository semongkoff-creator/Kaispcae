import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  type RemoteTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type LocalTrackPublication,
} from 'livekit-client';
import { api } from './api';

// The LiveKit half of the media layer. Lives BESIDE webrtcService rather than
// replacing it: which one a room uses is decided by livekitRooms.ts, and a
// room on the mesh must be able to keep working untouched while this is
// developed against a single test room.
//
// The public surface mirrors webrtcService's where it matters, so App.tsx and
// VideoGrid can eventually call either through one interface. It is not a
// complete mirror yet — Fase A is connect, microphone, camera and remote
// tracks. Proximity subscription (Fase B) and screen share (Fase C) follow.

type RemoteStreamCb = (identity: string, stream: MediaStream) => void;
type SpeakingCb = (identity: string, speaking: boolean) => void;
type ConnectionCb = (state: 'connecting' | 'connected' | 'disconnected' | 'failed') => void;

class LiveKitService {
  private room: Room | null = null;
  private roomSlug: string | null = null;

  private onRemoteStream: RemoteStreamCb | null = null;
  private onRemoteStreamEnded: ((identity: string) => void) | null = null;
  private onSpeakingChange: SpeakingCb | null = null;
  private onConnectionChange: ConnectionCb | null = null;

  setOnRemoteStream(cb: RemoteStreamCb) { this.onRemoteStream = cb; }
  setOnRemoteStreamEnded(cb: (identity: string) => void) { this.onRemoteStreamEnded = cb; }
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
    if (room) await room.disconnect();
    this.onConnectionChange?.('disconnected');
  }

  private wireEvents(room: Room): void {
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      // identity is the KaiSpace user id — see the token endpoint, which sets
      // it deliberately so a LiveKit participant can be matched back to a
      // player on the map without a second lookup.
      if (track.kind === Track.Kind.Audio || track.kind === Track.Kind.Video) {
        const stream = new MediaStream([track.mediaStreamTrack]);
        this.onRemoteStream?.(participant.identity, stream);
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (_t, _pub, participant: RemoteParticipant) => {
      this.onRemoteStreamEnded?.(participant.identity);
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
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
}

export const livekitService = new LiveKitService();
