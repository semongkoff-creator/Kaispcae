import { XLg } from 'react-bootstrap-icons';
import { ProximityPlayer } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { getVideoTiles, VideoTile } from './VideoGrid';

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
}

// A focused, full-screen call layout — everyone currently visible gets a
// large tile in a responsive grid instead of the small stack of floating
// tiles VideoGrid.tsx shows by default. The game world keeps running behind
// this (movement/proximity don't pause), so leaving Meeting View drops you
// right back into wherever you already are — this is purely a viewing mode,
// not a separate "meeting room" state the server needs to know about.
export function MeetingView({
  nearby, localStream, localScreenStream, remoteStreams, remoteScreenStreams,
  micMuted, cameraOff, onManualVolumeChange, recordedTargetUserId, isLocalBeingRecorded, onClose,
}: MeetingViewProps) {
  const playerRecords = useGameStore((s) => s.playerRecords);
  const videoTiles = getVideoTiles(nearby, playerRecords, remoteStreams, remoteScreenStreams, recordedTargetUserId);
  const screenTiles = videoTiles.filter((t) => t.screenStream);
  const totalTiles = (localStream ? 1 : 0) + (localScreenStream ? 1 : 0) + videoTiles.length + screenTiles.length;

  return (
    <div className="absolute inset-0 z-40 bg-gray-900/97 backdrop-blur-sm flex flex-col pointer-events-auto">
      {/* pl-20 (not px-6/pl-6) — the Sidebar rail (Sidebar.tsx) is a fixed
          w-14 (56px) strip pinned to the left edge at z-50, ABOVE this
          view's z-40, so it stays reachable while Meeting View is active.
          Without this extra left offset, the header title and the first
          column of video tiles below started at the same x=0 edge and
          rendered partially hidden underneath the rail — reads exactly like
          "cut off" content rather than an overlapping-layer issue. */}
      <div className="flex items-center justify-between pl-20 pr-6 py-4">
        <p className="text-white/70 text-sm font-medium">Meeting View — {totalTiles} {totalTiles === 1 ? 'tile' : 'tiles'}</p>
        <button
          onClick={onClose}
          title="Exit Meeting View"
          className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center cursor-pointer transition-colors"
        >
          <XLg size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pl-20 pr-6 pb-6">
        {totalTiles === 0 ? (
          <div className="w-full h-full flex items-center justify-center">
            <p className="text-white/40 text-sm">Nobody's on camera right now — walk up to someone to start a video chat.</p>
          </div>
        ) : (
          // min-h-full (not h-full) — h-full forced this grid's own box to
          // exactly the scroll container's visible height, which is fine
          // when tiles fit, but once more rows were needed than fit in that
          // fixed height, tiles rendering below it visually read as "cut
          // off" instead of the outer overflow-y-auto container actually
          // scrolling to reveal them. min-h-full keeps the empty-space case
          // (few tiles) filling the view while letting the grid grow taller
          // than the viewport — and scroll — once it needs to.
          <div className="grid gap-4 min-h-full" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gridAutoRows: 'minmax(160px, 1fr)' }}>
            {localStream && (
              <VideoTile name="You" stream={localStream} isLocal micMuted={micMuted} cameraOff={cameraOff} isBeingRecorded={isLocalBeingRecorded} large />
            )}
            {localScreenStream && (
              <VideoTile name="Your screen" stream={localScreenStream} isLocal isScreen large />
            )}
            {videoTiles.map((tile) => (
              <VideoTile
                key={tile.id}
                name={tile.name}
                stream={tile.stream}
                isLocal={false}
                translucent={tile.translucent}
                onVolumeChange={(v) => onManualVolumeChange(tile.id, v)}
                isBeingRecorded={tile.isBeingRecorded}
                large
              />
            ))}
            {screenTiles.map((tile) => (
              <VideoTile key={`${tile.id}-screen`} name={`${tile.name}'s screen`} stream={tile.screenStream!} isLocal={false} isScreen large />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
