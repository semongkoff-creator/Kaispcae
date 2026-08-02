import { useGameStore } from '@/stores/gameStore';

export function ConnectionIndicator() {
  const isConnected = useGameStore((s) => s.isConnected);
  const playerRecords = useGameStore((s) => s.playerRecords);
  const remoteCount = Object.keys(playerRecords).length;
  const playerCount = remoteCount + 1;

  console.log('[HUD] ConnectionIndicator — remoteCount:', remoteCount, 'total:', playerCount, 'records:', Object.keys(playerRecords));

  return (
    <div className="flex items-center gap-3 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-100 dark:border-gray-700 shadow-sm rounded-lg px-3 py-2 pointer-events-none">
      <div className="flex items-center gap-1.5">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            isConnected ? 'bg-emerald-500 shadow-[0_0_6px_#10b981]' : 'bg-red-500 shadow-[0_0_6px_#ef4444]'
          }`}
        />
        <span className="text-gray-700 dark:text-gray-300 text-xs font-medium">
          {isConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
      <div className="w-px h-4 bg-purple-100" />
      <span className="text-gray-700 dark:text-gray-300 text-xs">
        {playerCount} {playerCount === 1 ? 'player' : 'players'} online
      </span>
    </div>
  );
}
