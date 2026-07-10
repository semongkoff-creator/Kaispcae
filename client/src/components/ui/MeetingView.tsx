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
      <div className="flex items-center justify-between px-6 py-4">
        <p className="text-white/70 text-sm font-medium">Meeting View — {totalTiles} {totalTiles === 1 ? 'tile' : 'tiles'}</p>
        <button
          onClick={onClose}
          title="Exit Meeting View"
          className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center cursor-pointer transition-colors"
        >
          <XLg size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {totalTiles === 0 ? (
          <div className="w-full h-full flex items-center justify-center">
            <p className="text-white/40 text-sm">Nobody's on camera right now — walk up to someone to start a video chat.</p>
          </div>
        ) : (
          <div className="grid gap-4 h-full" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gridAutoRows: 'minmax(160px, 1fr)' }}>
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
