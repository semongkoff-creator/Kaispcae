import { useState } from 'react';
import { RecordCircleFill, StopCircleFill, Download } from 'react-bootstrap-icons';
import { Recording } from '@virtualmeet/shared';
import { ActiveRecordingInfo } from '@/stores/gameStore';
import { api, ApiError } from '@/services/api';

interface SpotlightedPlayer {
  userId: string;
  name: string;
}

interface RecordingControlProps {
  recordingTargets: SpotlightedPlayer[];
  activeRecording: ActiveRecordingInfo | null;
  isRecordingMine: boolean;
  uploading: boolean;
  roomSlug: string;
  onStart: (targetUserId: string, title: string) => void;
  onStop: () => void;
  // 'sidebar': icon-only, popovers open to the right — see Sidebar.tsx.
  // Omit (or 'standalone') for the original labeled-button floating bar.
  variant?: 'standalone' | 'sidebar';
}

// §7 — Screen Recording controls: start (with a target picker when more
// than one person is spotlighted), the active-recording badge, a stop
// button visible only to whoever started it (spec's own explicit rule —
// not even another admin can stop someone else's recording), and a small
// list of past recordings available to download.
export function RecordingControl({ recordingTargets, activeRecording, isRecordingMine, uploading, roomSlug, onStart, onStop, variant = 'standalone' }: RecordingControlProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [showList, setShowList] = useState(false);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [error, setError] = useState('');

  const startWithTarget = (targetUserId: string) => {
    const title = window.prompt('Judul rekaman:', 'Sesi Meeting');
    setShowPicker(false);
    if (!title?.trim()) return;
    onStart(targetUserId, title.trim());
  };

  const handleRecordClick = () => {
    if (recordingTargets.length === 0) return;
    if (recordingTargets.length === 1) {
      startWithTarget(recordingTargets[0].userId);
      return;
    }
    setShowPicker((v) => !v);
  };

  const loadRecordings = async () => {
    setShowList((v) => !v);
    setError('');
    try {
      const res = await api.getRecordings(roomSlug);
      setRecordings(res.recordings);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat daftar rekaman');
    }
  };

  const handleDownload = async (rec: Recording) => {
    try {
      await api.downloadRecording(rec.id, rec.title);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal download rekaman');
    }
  };

  const isSidebar = variant === 'sidebar';

  const recordButton = isRecordingMine ? (
    <button
      onClick={onStop}
      disabled={uploading}
      title={uploading ? 'Uploading...' : 'Stop Recording'}
      className={isSidebar
        ? 'w-10 h-10 rounded-lg flex items-center justify-center bg-red-600 text-white disabled:opacity-60 cursor-pointer'
        : 'px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-red-600 text-white border-red-500 disabled:opacity-60'}
    >
      <StopCircleFill size={isSidebar ? 16 : 12} /> {!isSidebar && (uploading ? 'Uploading...' : 'Stop Recording')}
    </button>
  ) : activeRecording ? (
    isSidebar ? (
      <div title={`REC: ${activeRecording.targetName}`} className="w-10 h-10 rounded-lg flex items-center justify-center bg-red-50 text-red-600">
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
      </div>
    ) : (
      <div className="px-3 py-2 rounded-lg text-xs font-medium border bg-red-50 text-red-600 border-red-200 inline-flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> REC: {activeRecording.targetName}
      </div>
    )
  ) : (
    <button
      onClick={handleRecordClick}
      disabled={recordingTargets.length === 0}
      title="Record"
      className={isSidebar
        ? 'w-10 h-10 rounded-lg flex items-center justify-center text-purple-700 hover:bg-purple-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer'
        : 'px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-white/90 backdrop-blur-sm text-purple-700 hover:text-purple-800 border-purple-200 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed'}
    >
      <RecordCircleFill size={isSidebar ? 16 : 12} /> {!isSidebar && 'Record'}
    </button>
  );

  const recordingsButton = (
    <button
      onClick={loadRecordings}
      title="Recordings"
      className={isSidebar
        ? 'w-10 h-10 rounded-lg flex items-center justify-center text-purple-700 hover:bg-purple-50 transition-all cursor-pointer'
        : 'px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-white/90 backdrop-blur-sm text-purple-700 hover:text-purple-800 border-purple-200 shadow-sm'}
    >
      <Download size={isSidebar ? 16 : 12} /> {!isSidebar && 'Recordings'}
    </button>
  );

  const pickerPanel = showPicker && (
    <div className={isSidebar ? 'absolute top-0 left-full ml-2 w-48 bg-white rounded-lg shadow-xl border border-purple-100 p-2 z-50' : 'absolute bottom-full mb-1.5 left-0 w-48 bg-white rounded-lg shadow-xl border border-purple-100 p-2 z-50'}>
      <p className="text-gray-400 text-[10px] mb-1 px-1">Pilih target rekaman:</p>
      {recordingTargets.map((p) => (
        <button
          key={p.userId}
          onClick={() => startWithTarget(p.userId)}
          className="w-full text-left px-2 py-1.5 rounded hover:bg-purple-50 text-xs text-gray-700 cursor-pointer"
        >
          {p.name}
        </button>
      ))}
    </div>
  );

  const listPanel = showList && (
    <div className={isSidebar ? 'absolute top-0 left-full ml-2 w-64 max-h-64 overflow-y-auto bg-white rounded-lg shadow-xl border border-purple-100 p-2 z-50' : 'absolute bottom-full mb-1.5 right-0 w-64 max-h-64 overflow-y-auto bg-white rounded-lg shadow-xl border border-purple-100 p-2 z-50'}>
      <p className="text-gray-900 text-xs font-semibold mb-1.5 px-1">Recordings</p>
      {error && <p className="text-red-500 text-[10px] px-1 mb-1">{error}</p>}
      {recordings.length === 0 && <p className="text-gray-400 text-[10px] px-1">Belum ada rekaman.</p>}
      {recordings.map((rec) => (
        <div key={rec.id} className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-purple-50/50 gap-2">
          <div className="min-w-0">
            <p className="text-xs text-gray-700 truncate">{rec.title}</p>
            <p className="text-[10px] text-gray-400 truncate">
              {rec.targetName} · {rec.status}
              {rec.status === 'done' && ` · ${rec.maxDownloads - rec.downloadCount} left`}
            </p>
          </div>
          {/* No extra client-side ownership check needed — GET
              /rooms/:slug/recordings already only returns rows this
              user is allowed to see (their own as target, or all of
              them if admin+), and the download route re-checks the
              same rule independently anyway. */}
          {rec.status === 'done' && (
            <button onClick={() => handleDownload(rec)} title="Download" className="text-purple-500 hover:text-purple-700 cursor-pointer shrink-0">
              <Download size={13} />
            </button>
          )}
        </div>
      ))}
    </div>
  );

  if (isSidebar) {
    return (
      <>
        <div className="relative">
          {recordButton}
          {pickerPanel}
        </div>
        <div className="relative">
          {recordingsButton}
          {listPanel}
        </div>
      </>
    );
  }

  return (
    <div className="relative">
      <div className="flex gap-1.5">
        {recordButton}
        {recordingsButton}
      </div>
      {pickerPanel}
      {listPanel}
    </div>
  );
}
