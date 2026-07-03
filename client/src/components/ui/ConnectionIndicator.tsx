import { useGameStore } from '@/stores/gameStore';

export function ConnectionIndicator() {
  const isConnected = useGameStore((s) => s.isConnected);
  const playerRecords = useGameStore((s) => s.playerRecords);
  const remoteCount = Object.keys(playerRecords).length;
  const playerCount = remoteCount + 1;

  console.log('[HUD] ConnectionIndicator — remoteCount:', remoteCount, 'total:', playerCount, 'records:', Object.keys(playerRecords));

  return (
    <div className="absolute top-4 right-4 flex items-center gap-3 bg-black/40 backdrop-blur-sm rounded-lg px-3 py-2 pointer-events-none">
      <div className="flex items-center gap-1.5">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            isConnected ? 'bg-green-400 shadow-[0_0_6px_#4ade80]' : 'bg-red-400 shadow-[0_0_6px_#f87171]'
          }`}
        />
        <span className="text-white/80 text-xs font-medium">
          {isConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
      <div className="w-px h-4 bg-white/20" />
      <span className="text-white/80 text-xs">
        {playerCount} {playerCount === 1 ? 'player' : 'players'} online
      </span>
    </div>
  );
}
