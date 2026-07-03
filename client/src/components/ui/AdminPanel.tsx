import { useGameStore } from '@/stores/gameStore';

interface AdminPanelProps {
  onGrant: (userId: string) => void;
  onRevoke: (userId: string) => void;
}

export function AdminPanel({ onGrant, onRevoke }: AdminPanelProps) {
  const playerRecords = useGameStore((s) => s.playerRecords);
  const adminPlayerIds = useGameStore((s) => s.adminPlayerIds);
  const masterAdminUserId = useGameStore((s) => s.masterAdminUserId);
  const localUserId = useGameStore((s) => s.localUserId);
  const localIsAdmin = adminPlayerIds.has(localUserId);
  const isMasterAdmin = localUserId === masterAdminUserId;

  const players = Object.values(playerRecords);

  console.log('[AdminPanel] localUserId:', localUserId);
  console.log('[AdminPanel] masterAdminUserId:', masterAdminUserId);
  console.log('[AdminPanel] adminPlayerIds:', Array.from(adminPlayerIds));
  console.log('[AdminPanel] localIsAdmin:', localIsAdmin);
  console.log('[AdminPanel] isMasterAdmin:', isMasterAdmin);
  console.log('[AdminPanel] players:', players.map((p) => ({ name: p.name, userId: p.userId, isAdmin: p.isAdmin })));

  return (
    <div
      className="absolute top-16 right-4 z-50 w-64 bg-gray-800/95 backdrop-blur-md rounded-xl border border-white/10 shadow-2xl p-3 pointer-events-auto"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <h3 className="text-white text-sm font-bold mb-3">Players ({players.length + 1} online)</h3>
      <div className="space-y-1.5 max-h-64 overflow-y-auto">
        {/* Local player */}
        <div className={`flex items-center justify-between px-2 py-1 rounded ${localIsAdmin ? 'bg-yellow-500/10' : 'bg-white/5'}`}>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: useGameStore.getState().localPlayer.color }} />
            <span className="text-white/80 text-xs">{useGameStore.getState().localPlayer.name}</span>
            {isMasterAdmin && <span className="text-yellow-400 text-xs">⭐</span>}
            {localIsAdmin && !isMasterAdmin && <span className="text-yellow-400 text-xs">👑</span>}
          </div>
          <span className="text-white/30 text-[10px]">You</span>
        </div>

        {players.map((p) => {
          const pIsAdmin = adminPlayerIds.has(p.userId ?? p.id);
          const pIsMaster = (p.userId ?? p.id) === masterAdminUserId;

          return (
            <div key={p.id} className={`flex items-center justify-between px-2 py-1 rounded ${pIsAdmin ? 'bg-yellow-500/10' : 'bg-white/5'}`}>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: p.color }} />
                <span className="text-white/80 text-xs">{p.name}</span>
                {pIsMaster && <span className="text-yellow-400 text-xs" title="Master Admin">⭐</span>}
                {pIsAdmin && !pIsMaster && <span className="text-yellow-400 text-xs">👑</span>}
              </div>

              {localIsAdmin && !pIsAdmin && p.userId !== localUserId && (
                <button
                  onClick={() => onGrant(p.userId || p.id)}
                  className="text-[10px] px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 cursor-pointer"
                >
                  Make Admin
                </button>
              )}
              {isMasterAdmin && pIsAdmin && !pIsMaster && (
                <button
                  onClick={() => onRevoke(p.userId || p.id)}
                  className="text-[10px] px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 cursor-pointer"
                >
                  Revoke
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
