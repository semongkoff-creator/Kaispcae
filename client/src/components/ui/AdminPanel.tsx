import { StarFill, AwardFill } from 'react-bootstrap-icons';
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
      className="absolute top-16 right-4 z-50 w-64 bg-white/95 backdrop-blur-md rounded-xl border border-purple-100 shadow-2xl p-3 pointer-events-auto"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <h3 className="text-gray-900 text-sm font-bold mb-3">Players ({players.length + 1} online)</h3>
      <div className="space-y-1.5 max-h-64 overflow-y-auto">
        {/* Local player */}
        <div className={`flex items-center justify-between px-2 py-1 rounded ${localIsAdmin ? 'bg-amber-100' : 'bg-purple-50/50'}`}>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: useGameStore.getState().localPlayer.color }} />
            <span className="text-gray-700 text-xs">{useGameStore.getState().localPlayer.name}</span>
            {isMasterAdmin && <StarFill className="text-amber-500" size={11} />}
            {localIsAdmin && !isMasterAdmin && <AwardFill className="text-amber-500" size={11} />}
          </div>
          <span className="text-gray-400 text-[10px]">You</span>
        </div>

        {players.map((p) => {
          const pIsAdmin = adminPlayerIds.has(p.userId ?? p.id);
          const pIsMaster = (p.userId ?? p.id) === masterAdminUserId;

          return (
            <div key={p.id} className={`flex items-center justify-between px-2 py-1 rounded ${pIsAdmin ? 'bg-amber-100' : 'bg-purple-50/50'}`}>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: p.color }} />
                <span className="text-gray-700 text-xs">{p.name}</span>
                {pIsMaster && <StarFill className="text-amber-500" size={11} title="Master Admin" />}
                {pIsAdmin && !pIsMaster && <AwardFill className="text-amber-500" size={11} />}
              </div>

              {localIsAdmin && !pIsAdmin && p.userId !== localUserId && (
                <button
                  onClick={() => onGrant(p.userId || p.id)}
                  className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-700 hover:bg-amber-200 cursor-pointer"
                >
                  Make Admin
                </button>
              )}
              {isMasterAdmin && pIsAdmin && !pIsMaster && (
                <button
                  onClick={() => onRevoke(p.userId || p.id)}
                  className="text-[10px] px-2 py-0.5 rounded bg-red-100 text-red-600 hover:bg-red-200 cursor-pointer"
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
