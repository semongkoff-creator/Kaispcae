import { StarFill, AwardFill, PersonBadgeFill } from 'react-bootstrap-icons';
import { useGameStore } from '@/stores/gameStore';
import { Role, roleAtLeast } from '@virtualmeet/shared';

interface AdminPanelProps {
  onGrantAdmin: (userId: string) => void;
  onRevokeAdmin: (userId: string) => void;
  onGrantStaff: (userId: string) => void;
  onRevokeStaff: (userId: string) => void;
}

// Resolves a specific player's role from the room's raw admin/staff sets —
// the same precedence as the server's getRole() in roomHandler.ts (owner >
// admin > staff > member), just computed client-side for display since the
// broadcast only carries the raw id sets, not a per-player role field.
function resolveRole(uid: string, masterAdminUserId: string, adminIds: Set<string>, staffIds: Set<string>): Role {
  if (uid === masterAdminUserId) return 'owner';
  if (adminIds.has(uid)) return 'admin';
  if (staffIds.has(uid)) return 'staff';
  return 'member';
}

export function AdminPanel({ onGrantAdmin, onRevokeAdmin, onGrantStaff, onRevokeStaff }: AdminPanelProps) {
  const playerRecords = useGameStore((s) => s.playerRecords);
  const adminPlayerIds = useGameStore((s) => s.adminPlayerIds);
  const staffPlayerIds = useGameStore((s) => s.staffPlayerIds);
  const masterAdminUserId = useGameStore((s) => s.masterAdminUserId);
  const localUserId = useGameStore((s) => s.localUserId);
  const localRole = useGameStore((s) => s.localRole);

  const players = Object.values(playerRecords);

  return (
    <div
      className="absolute top-16 right-4 z-50 w-72 bg-white/95 dark:bg-gray-900/95 backdrop-blur-md rounded-xl border border-purple-100 dark:border-gray-700 shadow-2xl p-3 pointer-events-auto"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <h3 className="text-gray-900 dark:text-gray-100 text-sm font-bold mb-1">Players ({players.length + 1} online)</h3>
      <p className="text-gray-400 dark:text-gray-500 text-[10px] mb-3">Your role: <span className="font-medium capitalize">{localRole}</span></p>
      <div className="space-y-1.5 max-h-64 overflow-y-auto">
        {/* Local player */}
        <PlayerRow
          name={useGameStore.getState().localPlayer.name}
          color={useGameStore.getState().localPlayer.color}
          role={localRole}
          isLocal
        />

        {players.map((p) => {
          const uid = p.userId ?? p.id;
          const role = resolveRole(uid, masterAdminUserId, adminPlayerIds, staffPlayerIds);
          return (
            <PlayerRow
              key={p.id}
              name={p.name}
              color={p.color}
              role={role}
              isLocal={false}
              // Granting/revoking a tier requires being strictly above the
              // target's CURRENT tier's own grant requirement — mirrors the
              // server's canAccess() check (shared/permissions.ts's
              // FEATURE_MIN_ROLE), this is only the UI-side reflection of
              // it, the server re-validates independently either way.
              canGrantAdmin={roleAtLeast(localRole, 'admin') && role !== 'owner' && role !== 'admin'}
              canRevokeAdmin={roleAtLeast(localRole, 'owner') && role === 'admin'}
              canGrantStaff={roleAtLeast(localRole, 'admin') && role === 'member'}
              canRevokeStaff={roleAtLeast(localRole, 'admin') && role === 'staff'}
              onGrantAdmin={() => onGrantAdmin(uid)}
              onRevokeAdmin={() => onRevokeAdmin(uid)}
              onGrantStaff={() => onGrantStaff(uid)}
              onRevokeStaff={() => onRevokeStaff(uid)}
            />
          );
        })}
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: Role }) {
  if (role === 'owner') return <StarFill className="text-amber-500" size={11} title="Owner" />;
  if (role === 'admin') return <AwardFill className="text-amber-500" size={11} title="Admin" />;
  if (role === 'staff') return <PersonBadgeFill className="text-purple-400" size={11} title="Staff" />;
  return null;
}

function PlayerRow({
  name,
  color,
  role,
  isLocal,
  canGrantAdmin,
  canRevokeAdmin,
  canGrantStaff,
  canRevokeStaff,
  onGrantAdmin,
  onRevokeAdmin,
  onGrantStaff,
  onRevokeStaff,
}: {
  name: string;
  color: string;
  role: Role;
  isLocal: boolean;
  canGrantAdmin?: boolean;
  canRevokeAdmin?: boolean;
  canGrantStaff?: boolean;
  canRevokeStaff?: boolean;
  onGrantAdmin?: () => void;
  onRevokeAdmin?: () => void;
  onGrantStaff?: () => void;
  onRevokeStaff?: () => void;
}) {
  const highlighted = role === 'owner' || role === 'admin' || role === 'staff';
  return (
    <div className={`flex items-center justify-between px-2 py-1 rounded gap-1 ${highlighted ? 'bg-amber-100' : 'bg-purple-50/50 dark:bg-gray-700/50'}`}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <span className="text-gray-700 dark:text-gray-300 text-xs truncate">{name}</span>
        {!isLocal && <RoleBadge role={role} />}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {isLocal ? (
          <span className="text-gray-400 dark:text-gray-500 text-[10px]">You</span>
        ) : (
          <>
            {canGrantStaff && (
              <button onClick={onGrantStaff} className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 hover:bg-purple-200 cursor-pointer">
                +Staff
              </button>
            )}
            {canRevokeStaff && (
              <button onClick={onRevokeStaff} className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 hover:bg-red-200 cursor-pointer">
                −Staff
              </button>
            )}
            {canGrantAdmin && (
              <button onClick={onGrantAdmin} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 hover:bg-amber-200 cursor-pointer">
                Make Admin
              </button>
            )}
            {canRevokeAdmin && (
              <button onClick={onRevokeAdmin} className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 hover:bg-red-200 cursor-pointer">
                Revoke
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
