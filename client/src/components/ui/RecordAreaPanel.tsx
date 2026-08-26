import { useEffect, useState } from 'react';
import { RecordCircleFill, StopCircleFill, PauseFill, PlayCircleFill } from 'react-bootstrap-icons';

interface RecordAreaPanelProps {
  canRecord: boolean;
  hasTarget: boolean;
  isRecordingMine: boolean;
  isPaused: boolean;
  uploading: boolean;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
}

function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

// Standing inside a "Record Area" zone (Room Editor tool, Task 1 of the
// Record Area Zone plan) shows this panel — a different zone type, and a
// different feature entirely, from a Meeting-type zone. Reuses the SAME
// recording state App.tsx already centralizes for the Sidebar's Recording
// control (single source of truth — starting here or from the Sidebar hits
// the identical requestRecording/stopMyRecording/pauseRecording/
// resumeRecording calls, so the server's existing one-recording-per-room
// lock behaves identically regardless of which surface triggered it).
export function RecordAreaPanel({ canRecord, hasTarget, isRecordingMine, isPaused, uploading, onStart, onStop, onPause, onResume }: RecordAreaPanelProps) {
  // Live elapsed-time readout, entirely local to this panel — nothing
  // outside it needs this number, so it doesn't belong in
  // useScreenRecording.ts's shared hook state. Ticks once a second while
  // actively recording; freezes (stops incrementing, does NOT reset)
  // while paused, so the same readout keeps showing instead of switching
  // to different text on pause. Resets to 0 whenever a FRESH recording
  // starts (isRecordingMine's false->true transition) or ends. Must sit
  // above both early returns below — React's Rules of Hooks require every
  // hook to run unconditionally on every render.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!isRecordingMine) {
      setElapsedSeconds(0);
      return;
    }
    if (isPaused) return;
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [isRecordingMine, isPaused]);

  if (!canRecord) return null;

  if (isRecordingMine) {
    return (
      <div className="absolute top-16 right-1/2 -translate-x-48 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-orange-600 text-white text-xs font-medium shadow-lg pointer-events-auto">
        <span className={`w-1.5 h-1.5 rounded-full bg-white ${isPaused ? '' : 'animate-pulse'}`} />
        {formatElapsed(elapsedSeconds)}
        <button onClick={isPaused ? onResume : onPause} disabled={uploading} title={isPaused ? 'Lanjutkan' : 'Jeda'} className="ml-1 cursor-pointer disabled:opacity-60">
          {isPaused ? <PlayCircleFill size={14} /> : <PauseFill size={14} />}
        </button>
        <button onClick={onStop} disabled={uploading} title={uploading ? 'Uploading...' : 'Stop'} className="cursor-pointer disabled:opacity-60">
          <StopCircleFill size={14} />
        </button>
      </div>
    );
  }

  if (!hasTarget) return null;

  return (
    <button
      onClick={onStart}
      title="Mulai rekam"
      className="absolute top-16 right-1/2 -translate-x-48 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm text-purple-700 dark:text-purple-300 text-xs font-medium border border-purple-200 dark:border-gray-600 shadow-sm cursor-pointer pointer-events-auto"
    >
      <RecordCircleFill size={14} /> Start Recording
    </button>
  );
}
