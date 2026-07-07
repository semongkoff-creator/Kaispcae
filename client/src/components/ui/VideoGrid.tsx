import { useRef, useEffect } from 'react';
import { MicMuteFill, CameraVideoOffFill } from 'react-bootstrap-icons';
import { ProximityPlayer } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';

interface VideoGridProps {
  nearby: ProximityPlayer[];
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  micMuted: boolean;
  cameraOff: boolean;
}

export function VideoGrid({ nearby, localStream, remoteStreams, micMuted, cameraOff }: VideoGridProps) {
  const playerRecords = useGameStore((s) => s.playerRecords);

  const videoTiles = nearby
    .filter((p) => p.inProximity)
    .map((p) => ({
      id: p.id,
      name: playerRecords[p.id]?.name || 'Unknown',
      stream: remoteStreams.get(p.id)!,
    }))
    .filter((t) => t.stream);

  return (
    <div className="absolute top-16 right-4 z-20 flex flex-col gap-2 pointer-events-none">
      {localStream && (
        <VideoTile
          name="You"
          stream={localStream}
          isLocal
          micMuted={micMuted}
          cameraOff={cameraOff}
        />
      )}
      {videoTiles.map((tile) => (
        <VideoTile
          key={tile.id}
          name={tile.name}
          stream={tile.stream}
          isLocal={false}
        />
      ))}
    </div>
  );
}

function VideoTile({
  name,
  stream,
  isLocal,
  micMuted,
  cameraOff,
}: {
  name: string;
  stream: MediaStream;
  isLocal: boolean;
  micMuted?: boolean;
  cameraOff?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    video.play().catch(() => {});
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <div className="pointer-events-auto bg-white/90 backdrop-blur-sm rounded-lg overflow-hidden w-40 border border-purple-200 shadow-lg transition-all duration-300 animate-fade-in">
      {/* Mirror the LOCAL self-preview only — raising your right hand should
          show on the right side of YOUR OWN preview, same as a real mirror
          (every video call app does this for the self-view). Remote tiles
          stay unmirrored so you see others exactly as their camera sees
          them. This is purely a browser-side style on the <video> element —
          it can't touch the actual MediaStreamTrack sent to WebRTC peers,
          so remote viewers were never at risk of seeing a flipped feed. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        style={{ transform: isLocal ? 'scaleX(-1)' : 'none' }}
        className="w-full h-24 object-cover bg-purple-100"
      />
      <div className="px-2 py-1 text-xs flex items-center justify-between">
        <span className="text-gray-700 truncate flex-1">{name}</span>
        {isLocal && (
          <span className="flex gap-1">
            {micMuted && <MicMuteFill className="text-red-500" size={12} />}
            {cameraOff && <CameraVideoOffFill className="text-red-500" size={12} />}
          </span>
        )}
      </div>
    </div>
  );
}
