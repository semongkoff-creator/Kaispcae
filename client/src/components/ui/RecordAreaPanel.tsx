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

// Standing inside a "Record Area" zone (Room Editor tool, Task 1 of this
// plan) shows this panel — a different zone type, and a different feature
// entirely, from a Meeting-type zone.
// Reuses the SAME recording state App.tsx already centralizes for the
// existing standalone RecordingControl (single source of truth — starting
// here or from the standalone control hits the identical
// requestRecording/stopMyRecording/pauseRecording/resumeRecording calls, so
// the server's existing one-recording-per-room lock behaves identically
// regardless of which surface triggered it).
export function RecordAreaPanel({ canRecord, hasTarget, isRecordingMine, isPaused, uploading, onStart, onStop, onPause, onResume }: RecordAreaPanelProps) {
  if (!canRecord) return null;

  if (isRecordingMine) {
    return (
      <div className="absolute top-16 right-1/2 -translate-x-48 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-600 text-white text-xs font-medium shadow-lg pointer-events-auto">
        <span className={`w-1.5 h-1.5 rounded-full bg-white ${isPaused ? '' : 'animate-pulse'}`} />
        {isPaused ? 'Rekaman dijeda' : 'Merekam'}
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
