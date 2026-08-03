import { LockFill, HandIndexThumbFill } from 'react-bootstrap-icons';
import { ZoneKnockRequest, ZoneLockState } from '@virtualmeet/shared';

// All the zone-lock UI, kept in one strip above the HUD so it never collides
// with the room's own controls (the floating Chat button already taught us
// what that looks like).
export function ZoneLockBar({
  currentZone, lock, isKeyholder, knocks, deniedZoneId, deniedZoneName, pendingKnock, toast,
  onKnock, onCancelKnock, onDecide,
}: {
  currentZone: { id: string; name: string } | null;
  lock: ZoneLockState | undefined;
  isKeyholder: boolean;
  knocks: ZoneKnockRequest[];
  deniedZoneId: string | null;
  deniedZoneName: string | null;
  // Potongan A2 — set the moment we've knocked and not yet resolved.
  pendingKnock: { zoneId: string; zoneName: string } | null;
  toast: string | null;
  onKnock: () => void;
  onCancelKnock: () => void;
  onDecide: (k: ZoneKnockRequest, admit: boolean) => void;
}) {
  return (
    <>
      {/* Knock requests — only the keyholder ever receives these. */}
      {knocks.length > 0 && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 space-y-2 w-72">
          {knocks.map((k) => (
            <div key={k.zoneId + k.userId} className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-purple-200 dark:border-gray-700 p-3">
              <p className="text-xs text-gray-800 dark:text-gray-100">
                <span className="font-semibold">{k.playerName}</span> mau masuk <span className="font-semibold">{k.zoneName}</span>
              </p>
              <p className="text-[10px] text-gray-400 mb-2">Kamu yang mengunci zona ini, jadi kamu yang memutuskan.</p>
              <div className="flex gap-2">
                <button onClick={() => onDecide(k, true)} className="flex-1 py-1.5 rounded-lg bg-green-600 text-white text-xs font-medium cursor-pointer hover:bg-green-700">Izinkan</button>
                <button onClick={() => onDecide(k, false)} className="flex-1 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium cursor-pointer">Tolak</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Potongan A2 — already knocked, waiting on the keyholder's decision.
          Takes priority over the "bounced, offer to knock" card below: once
          you've knocked there's nothing left to offer, just a wait + a way
          out of it. Stays up regardless of exactly where you're standing —
          the point is you're still waiting, not that you haven't moved. */}
      {pendingKnock ? (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 w-72 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-purple-200 dark:border-gray-700 p-3">
          <p className="text-xs text-gray-800 dark:text-gray-100 inline-flex items-center gap-1.5">
            <HandIndexThumbFill size={11} className="text-purple-600" /> Menunggu persetujuan masuk <span className="font-semibold">{pendingKnock.zoneName}</span>...
          </p>
          <p className="text-[10px] text-gray-400 mb-2">Kamu tetap di luar sampai pengunci memutuskan.</p>
          <button onClick={onCancelKnock} className="w-full py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium cursor-pointer">
            Cancel
          </button>
        </div>
      ) : deniedZoneId && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 w-72 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-amber-200 dark:border-gray-700 p-3">
          <p className="text-xs text-gray-800 dark:text-gray-100 inline-flex items-center gap-1.5">
            <LockFill size={11} className="text-amber-600" /> <span className="font-semibold">{deniedZoneName ?? 'Zona ini'}</span> sedang dikunci
          </p>
          <p className="text-[10px] text-gray-400 mb-2">Kamu belum bisa masuk. Ketuk kalau memang perlu bergabung.</p>
          <button onClick={onKnock} className="w-full py-1.5 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700 inline-flex items-center justify-center gap-1.5">
            <HandIndexThumbFill size={11} /> Ketuk pintu
          </button>
        </div>
      )}

      {toast && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 px-3 py-1.5 rounded-lg bg-gray-900/90 text-white text-xs shadow-lg">
          {toast}
        </div>
      )}

      {/* No lock button here on purpose: locking lives in the existing
          Room Features → "Kunci <zona>" row, so there's one place to lock a
          room and one mental model. This strip only shows the state. */}
      {currentZone && lock && (
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 z-30 pb-20 pointer-events-none">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/95 dark:bg-gray-800/95 shadow-lg border border-gray-100 dark:border-gray-700">
            <LockFill size={10} className="text-amber-600 shrink-0" />
            <span className="text-[11px] text-gray-600 dark:text-gray-300 truncate max-w-[200px]">
              {currentZone.name} dikunci {isKeyholder ? 'olehmu' : lock.lockedByName}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
