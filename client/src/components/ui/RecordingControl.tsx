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
  spotlightedPlayers: SpotlightedPlayer[];
  activeRecording: ActiveRecordingInfo | null;
  isRecordingMine: boolean;
  uploading: boolean;
  roomSlug: string;
  onStart: (targetUserId: string, title: string) => void;
  onStop: () => void;
}

// §7 — Screen Recording controls: start (with a target picker when more
// than one person is spotlighted), the active-recording badge, a stop
// button visible only to whoever started it (spec's own explicit rule —
// not even another admin can stop someone else's recording), and a small
// list of past recordings available to download.
export function RecordingControl({ spotlightedPlayers, activeRecording, isRecordingMine, uploading, roomSlug, onStart, onStop }: RecordingControlProps) {
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
    if (spotlightedPlayers.length === 0) return;
    if (spotlightedPlayers.length === 1) {
      startWithTarget(spotlightedPlayers[0].userId);
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

  return (
    <div className="relative">
      <div className="flex gap-1.5">
        {isRecordingMine ? (
          <button
            onClick={onStop}
            disabled={uploading}
            className="px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-red-600 text-white border-red-500 disabled:opacity-60"
          >
            <StopCircleFill size={12} /> {uploading ? 'Uploading...' : 'Stop Recording'}
          </button>
        ) : activeRecording ? (
          <div className="px-3 py-2 rounded-lg text-xs font-medium border bg-red-50 text-red-600 border-red-200 inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> REC: {activeRecording.targetName}
          </div>
        ) : (
          <button
            onClick={handleRecordClick}
            disabled={spotlightedPlayers.length === 0}
            title={spotlightedPlayers.length === 0 ? 'Spotlight seseorang dulu untuk merekam' : 'Record'}
            className="px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-white/90 backdrop-blur-sm text-purple-700 hover:text-purple-800 border-purple-200 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RecordCircleFill size={12} /> Record
          </button>
        )}

        <button
          onClick={loadRecordings}
          className="px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-white/90 backdrop-blur-sm text-purple-700 hover:text-purple-800 border-purple-200 shadow-sm"
        >
          <Download size={12} /> Recordings
        </button>
      </div>

      {showPicker && (
        <div className="absolute bottom-full mb-1.5 left-0 w-48 bg-white rounded-lg shadow-xl border border-purple-100 p-2 z-50">
          <p className="text-gray-400 text-[10px] mb-1 px-1">Pilih target rekaman:</p>
          {spotlightedPlayers.map((p) => (
            <button
              key={p.userId}
              onClick={() => startWithTarget(p.userId)}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-purple-50 text-xs text-gray-700 cursor-pointer"
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      {showList && (
        <div className="absolute bottom-full mb-1.5 right-0 w-64 max-h-64 overflow-y-auto bg-white rounded-lg shadow-xl border border-purple-100 p-2 z-50">
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
      )}
    </div>
  );
}
