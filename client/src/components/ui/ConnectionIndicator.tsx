import { useSyncExternalStore } from 'react';
import { useGameStore } from '@/stores/gameStore';
import { SignalBars } from './SignalBars';
import { selfVerdictMessage } from '@/services/connectionQuality';
import { subscribeConnectionQuality, getSelfVerdictSnapshot } from '@/stores/connectionQuality';

const BARS = { good: 3, fair: 2, poor: 1, unknown: 0 } as const;

export function ConnectionIndicator() {
  const isConnected = useGameStore((s) => s.isConnected);
  const playerRecords = useGameStore((s) => s.playerRecords);
  const remoteCount = Object.keys(playerRecords).length;
  const playerCount = remoteCount + 1;

  // Subscribed here rather than read from gameStore: this changes on a 5s
  // timer for every peer, and gameStore wakes most of the app. See
  // stores/connectionQuality.ts.
  const verdict = useSyncExternalStore(subscribeConnectionQuality, getSelfVerdictSnapshot);
  const advice = selfVerdictMessage(verdict);

  return (
    <div className="font-login-body flex flex-col gap-1 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-login-border-soft dark:border-gray-700 shadow-sm rounded-lg px-3 py-2 max-w-[19rem]">
      <div className="flex items-center gap-3 pointer-events-none">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              isConnected ? 'bg-emerald-500 shadow-[0_0_6px_#10b981]' : 'bg-red-500 shadow-[0_0_6px_#ef4444] animate-pulse'
            }`}
          />
          {/* QA (Fallback checklist item 9) — "Disconnected" read as a dead
              end, but socket.io's reconnection here is left at its library
              default (infinite retries, see useSocket.ts) — the honest state
              while red is "still trying", not "gave up". Pulsing dot + this
              copy communicate that instead of implying nothing is happening. */}
          <span className="text-gray-700 dark:text-gray-300 text-xs font-medium">
            {isConnected ? 'Connected' : 'Menyambung ulang…'}
          </span>
        </div>
        {/* The dot above is the SIGNALLING socket; these bars are the MEDIA
            path, and the two fail independently. The old indicator only had
            the dot, so a room where every voice connection had failed still
            read "Connected" — technically true and completely misleading,
            which is how "is it the app or my internet?" became unanswerable
            from inside the app.

            Alone in a room there is nothing to measure, and both obvious
            treatments of that mislead: hollow bars read as "no signal" — a
            fault, on a connection that is perfectly healthy — while removing
            the meter entirely reads as the feature breaking. Both were tried
            and both prompted the same question. A dash keeps the slot where
            the eye already expects it and says "not applicable" rather than
            "zero", which is the honest state. */}
        <div className="w-px h-4 bg-login-border-soft dark:bg-gray-700" />
        {verdict.total > 0 ? (
          <SignalBars
            level={verdict.level}
            bars={BARS[verdict.level]}
            title={`${verdict.total - verdict.affected}/${verdict.total} koneksi suara sehat`}
          />
        ) : (
          <span
            className="text-gray-400 dark:text-gray-500 text-xs leading-none select-none"
            title="Kualitas suara diukur dari koneksi ke peserta lain. Belum ada peserta lain di sekitar kamu."
          >
            —
          </span>
        )}
        <div className="w-px h-4 bg-login-border-soft dark:bg-gray-700" />
        <span className="text-gray-700 dark:text-gray-300 text-xs">
          {playerCount} {playerCount === 1 ? 'player' : 'players'} online
        </span>
      </div>

      {/* Only rendered when there is something to act on. A permanent "your
          connection is fine" line is noise, and noise is what people stop
          reading before the one time it matters. */}
      {advice && (
        <p className="text-[11px] leading-snug text-amber-700 dark:text-amber-400 pointer-events-none">
          {advice}
        </p>
      )}
    </div>
  );
}
