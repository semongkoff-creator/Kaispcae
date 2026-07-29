import { useEffect, useMemo, useRef, useState } from 'react';
import { XLg, PinFill } from 'react-bootstrap-icons';
import { ProximityPlayer, EmoteType, EMOTE_LIST, EMOTE_EMOJI, EMOTE_LABELS } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { getVideoTiles, VideoTile, latestReaction } from './VideoGrid';

interface MeetingViewProps {
  nearby: ProximityPlayer[];
  localStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  remoteScreenStreams: Map<string, MediaStream>;
  micMuted: boolean;
  cameraOff: boolean;
  onManualVolumeChange: (id: string, volume: number) => void;
  recordedTargetUserId?: string;
  isLocalBeingRecorded?: boolean;
  onClose: () => void;
  onEmote: (emote: EmoteType) => void;
}

// One normalized descriptor per video surface (local cam, local screen, each
// remote cam, each remote screen) so the featured-tile + thumbnail-strip layout
// works off a single list instead of four parallel branches.
interface MTile {
  key: string;
  name: string;
  stream?: MediaStream | null;
  isLocal: boolean;
  isScreen: boolean;
  translucent?: boolean;
  handRaised?: boolean;
  isBeingRecorded?: boolean;
  micMuted?: boolean;
  cameraOff?: boolean;
  speaking?: boolean;
  reactionSourceId?: string; // player id for latestReaction lookup (cam tiles)
  volumeTargetId?: string;   // remote id whose volume the main tile can adjust
}

// Bug 16 — Google-Meet-style layout: ONE large "featured" surface fills most of
// the screen, with everyone else as a bottom thumbnail strip. Featured priority:
// a pinned tile (click a thumbnail) → a screen share → the first remote → local.
// A NEW screen share always takes over (auto-pins) so presenting still auto-
// focuses. The bottom Mic/Camera/Hand/Share control row floats over this from
// App.tsx (unchanged); this is purely a layout/view mode — no WebRTC changes,
// and leaving it drops you right back onto the map where you already are.
export function MeetingView({
  nearby, localStream, localScreenStream, remoteStreams, remoteScreenStreams,
  micMuted, cameraOff, onManualVolumeChange, recordedTargetUserId, isLocalBeingRecorded, onClose, onEmote,
}: MeetingViewProps) {
  const playerRecords = useGameStore((s) => s.playerRecords);
  const localHandRaised = useGameStore((s) => s.localPlayer.handRaised);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const emoteEvents = useGameStore((s) => s.emoteEvents);
  const localSpeaking = useGameStore((s) => s.localSpeaking);
  const speakingPlayers = useGameStore((s) => s.speakingPlayers);
  const now = Date.now();

  const videoTiles = getVideoTiles(nearby, playerRecords, remoteStreams, remoteScreenStreams, recordedTargetUserId);
  const screenTiles = videoTiles.filter((t) => t.screenStream);

  // Build the unified tile list. Order matters: it decides the auto-featured
  // fallback (first screen, else first remote, else local).
  const tiles = useMemo<MTile[]>(() => {
    const out: MTile[] = [];
    if (localScreenStream) out.push({ key: 'local-screen', name: 'Layarmu', stream: localScreenStream, isLocal: true, isScreen: true });
    for (const t of screenTiles) out.push({ key: `${t.id}-screen`, name: `Layar ${t.name}`, stream: t.screenStream, isLocal: false, isScreen: true });
    if (localStream) out.push({ key: 'local-cam', name: 'Kamu', stream: localStream, isLocal: true, isScreen: false, micMuted, cameraOff, handRaised: localHandRaised, isBeingRecorded: isLocalBeingRecorded, speaking: localSpeaking && !micMuted, reactionSourceId: localPlayerId ?? undefined });
    for (const t of videoTiles) out.push({ key: t.id, name: t.name, stream: t.stream, isLocal: false, isScreen: false, translucent: t.translucent, handRaised: t.handRaised, isBeingRecorded: t.isBeingRecorded, speaking: speakingPlayers.has(t.id), reactionSourceId: t.id, volumeTargetId: t.id });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localStream, localScreenStream, micMuted, cameraOff, localHandRaised, isLocalBeingRecorded, localSpeaking, localPlayerId,
      videoTiles.map((t) => `${t.id}:${!!t.stream}:${t.translucent}:${t.handRaised}`).join(','),
      screenTiles.map((t) => t.id).join(',')]);

  const keys = tiles.map((t) => t.key);
  const screenKeys = tiles.filter((t) => t.isScreen).map((t) => t.key);

  const [pinnedKey, setPinnedKey] = useState<string | null>(null);

  // A brand-new screen share auto-takes the stage (clears any prior pin), like
  // Google Meet — this is what keeps "screen share becomes the main content"
  // automatic even if the user had pinned someone.
  const prevScreenKeysRef = useRef<string[]>([]);
  useEffect(() => {
    const added = screenKeys.find((k) => !prevScreenKeysRef.current.includes(k));
    if (added) setPinnedKey(added);
    prevScreenKeysRef.current = screenKeys;
  }, [screenKeys.join(',')]);

  // Drop a pin whose tile has gone away (peer left / stopped sharing) so the
  // stage falls back to auto instead of showing an empty featured area.
  useEffect(() => {
    if (pinnedKey && !keys.includes(pinnedKey)) setPinnedKey(null);
  }, [keys.join(','), pinnedKey]);

  const activeSpeakerKey = tiles.find((t) => !t.isScreen && !t.isLocal && t.speaking)?.key;
  const autoKey = screenKeys[0]
    ?? activeSpeakerKey
    ?? tiles.find((t) => !t.isScreen && !t.isLocal)?.key
    ?? tiles[0]?.key;
  const featuredKey = (pinnedKey && keys.includes(pinnedKey)) ? pinnedKey : autoKey;
  const featured = tiles.find((t) => t.key === featuredKey) ?? null;
  const thumbnails = tiles.filter((t) => t.key !== featuredKey);
  const isPinned = !!pinnedKey && pinnedKey === featuredKey;

  const renderTile = (t: MTile, main: boolean) => (
    <VideoTile
      name={t.name}
      stream={t.stream}
      isLocal={t.isLocal}
      isScreen={t.isScreen}
      micMuted={t.micMuted}
      cameraOff={t.cameraOff}
      translucent={t.translucent}
      handRaised={t.handRaised}
      isBeingRecorded={t.isBeingRecorded}
      speaking={t.speaking}
      reaction={t.reactionSourceId ? latestReaction(emoteEvents, t.reactionSourceId, now) : null}
      onVolumeChange={main && t.volumeTargetId ? (v) => onManualVolumeChange(t.volumeTargetId!, v) : undefined}
      large
    />
  );

  return (
    <div className="absolute inset-0 z-40 bg-gray-900/97 backdrop-blur-sm flex flex-col pointer-events-auto">
      {/* pl-20 clears the fixed Sidebar rail (z-50) pinned to the left edge. */}
      <div className="flex items-center justify-between pl-20 pr-6 py-3 shrink-0">
        <p className="text-white/70 text-sm font-medium">Meeting View — {tiles.length} {tiles.length === 1 ? 'peserta' : 'peserta'}</p>
        <button
          onClick={onClose}
          title="Keluar Meeting View"
          className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center cursor-pointer transition-colors"
        >
          <XLg size={16} />
        </button>
      </div>

      {/* Featured stage — fills the bulk of the screen. */}
      <div className="flex-1 min-h-0 flex items-center justify-center pl-20 pr-6">
        {featured ? (
          <div className="relative w-full h-full max-w-[1500px] mx-auto">
            {renderTile(featured, true)}
            {isPinned && (
              <button
                onClick={() => setPinnedKey(null)}
                title="Lepas sorotan (kembali otomatis)"
                className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 rounded-full bg-black/50 hover:bg-black/70 text-white text-[11px] px-2.5 py-1 backdrop-blur cursor-pointer"
              >
                <PinFill size={11} /> Lepas
              </button>
            )}
          </div>
        ) : (
          <p className="text-white/40 text-sm">Belum ada yang on-camera — dekati seseorang untuk mulai video chat.</p>
        )}
      </div>

      {/* Thumbnail strip — everyone else; click one to pin it as the stage. */}
      {thumbnails.length > 0 && (
        <div className="shrink-0 flex justify-center pl-20 pr-6 pt-3">
          <div className="flex gap-2 overflow-x-auto max-w-full pb-1">
            {thumbnails.map((t) => (
              <button
                key={t.key}
                onClick={() => setPinnedKey(t.key)}
                title={`Sorot ${t.name}`}
                className="shrink-0 w-40 h-24 rounded-lg overflow-hidden cursor-pointer ring-1 ring-white/10 hover:ring-purple-400/70 transition-all"
              >
                {renderTile(t, false)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quick-reactions strip (reuses the in-world emote pipeline). pb-20 lifts
          it clear of the persistent bottom-center HUD control row (Mic/Camera/
          Hand at bottom-6, z-50) which otherwise overlaps it. */}
      <div className="shrink-0 flex justify-center pb-20 pt-2">
        <div className="flex items-center gap-1 bg-white/10 border border-white/15 rounded-full px-2 py-1.5 backdrop-blur-sm pointer-events-auto">
          {EMOTE_LIST.map((emote) => (
            <button
              key={emote}
              onClick={() => onEmote(emote)}
              title={EMOTE_LABELS[emote]}
              className="w-9 h-9 rounded-full flex items-center justify-center text-xl hover:bg-white/20 hover:scale-110 active:scale-95 transition-all cursor-pointer"
            >
              {EMOTE_EMOJI[emote]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
