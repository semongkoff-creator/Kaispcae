import { useRef, useEffect } from 'react';
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
    <div className="pointer-events-auto bg-black/50 backdrop-blur-sm rounded-lg overflow-hidden w-40 border border-white/10 shadow-lg transition-all duration-300 animate-fade-in">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className="w-full h-24 object-cover bg-gray-800"
      />
      <div className="px-2 py-1 text-xs flex items-center justify-between">
        <span className="text-white/80 truncate flex-1">{name}</span>
        {isLocal && (
          <span className="flex gap-1">
            {micMuted && <span className="text-red-400">🔇</span>}
            {cameraOff && <span className="text-red-400">📷</span>}
          </span>
        )}
      </div>
    </div>
  );
}
