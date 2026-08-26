import { useState, useRef, useLayoutEffect, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { RecordCircleFill, StopCircleFill, Download, PlayCircleFill, PauseFill, X } from 'react-bootstrap-icons';
import { Recording } from '@kaispace/shared';
import { ActiveRecordingInfo } from '@/stores/gameStore';
import { api, ApiError } from '@/services/api';
import { showPrompt } from '@/stores/modalStore';

const FLYOUT_MARGIN = 8;

// Mirrors Tooltip.tsx's own portal-based fix for the identical bug: these
// popovers only appear with variant="sidebar", where they're nested inside
// Sidebar's "Room Features" menu (overflow-y-auto) — a plain `position:
// absolute` popup trying to escape to the right gets clipped by that
// ancestor's own scroll box instead of floating beside it (the browser then
// grows a horizontal scrollbar to reach the clipped content, instead of
// showing it as a floating overlay). A portal to document.body, positioned
// from the trigger's real getBoundingClientRect, escapes that clip entirely.
// The 'standalone' variant isn't nested inside any clipping ancestor, so it
// keeps its original `absolute` positioning untouched.
function useFlyoutPosition(triggerRef: RefObject<HTMLButtonElement>, open: boolean) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) { setStyle(null); return; }

    const reposition = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const preferredLeft = rect.right + FLYOUT_MARGIN;
      const overflowsRight = preferredLeft + panelRect.width > vw - FLYOUT_MARGIN;
      let left = overflowsRight ? rect.left - FLYOUT_MARGIN - panelRect.width : preferredLeft;
      let top = rect.top;

      left = Math.min(Math.max(left, FLYOUT_MARGIN), vw - panelRect.width - FLYOUT_MARGIN);
      top = Math.min(Math.max(top, FLYOUT_MARGIN), vh - panelRect.height - FLYOUT_MARGIN);
      setStyle({ top, left });
    };

    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, triggerRef]);

  return { panelRef, style };
}

interface RecordingTarget {
  userId: string;
  name: string;
}

interface RecordingControlProps {
  recordingTargets: RecordingTarget[];
  activeRecording: ActiveRecordingInfo | null;
  isRecordingMine: boolean;
  isPaused: boolean;
  uploading: boolean;
  roomSlug: string;
  onStart: (targetUserId: string, title: string) => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  // 'sidebar': icon-only, popovers open to the right — see Sidebar.tsx.
  // Omit (or 'standalone') for the original labeled-button floating bar.
  variant?: 'standalone' | 'sidebar';
}

// §7 — Screen Recording controls: start (with a target picker if more than
// one target is ever offered; today it's just "Myself"), the active-recording
// badge, a stop button visible only to whoever started it (spec's own explicit
// rule — not even another admin can stop someone else's recording), and a
// small list of past recordings available to download.
export function RecordingControl({ recordingTargets, activeRecording, isRecordingMine, isPaused, uploading, roomSlug, onStart, onStop, onPause, onResume, variant = 'standalone' }: RecordingControlProps) {
  const isSidebar = variant === 'sidebar';
  const [showPicker, setShowPicker] = useState(false);
  const [showList, setShowList] = useState(false);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');
  const recordButtonRef = useRef<HTMLButtonElement>(null);
  const recordingsButtonRef = useRef<HTMLButtonElement>(null);
  const picker = useFlyoutPosition(recordButtonRef, isSidebar && showPicker);
  const list = useFlyoutPosition(recordingsButtonRef, isSidebar && showList);

  const startWithTarget = async (targetUserId: string) => {
    const title = await showPrompt(
      'Judul rekaman:\n\nSaat browser minta pilih layar/tab, pilih "Tab ini" (This Tab) — supaya rekaman tidak terputus kalau kamu pindah ke tab lain.',
      'Sesi Meeting',
    );
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

  const handlePreview = async (rec: Recording) => {
    try {
      const url = await api.previewRecording(rec.id);
      setPreviewUrl(url);
      setPreviewTitle(rec.title);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat preview');
    }
  };

  const closePreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPreviewTitle('');
  };

  const recordButton = isRecordingMine ? (
    <div className="flex items-center gap-1.5">
      <button
        onClick={isPaused ? onResume : onPause}
        title={isPaused ? 'Lanjutkan' : 'Jeda'}
        className={isSidebar
          ? 'w-10 h-10 rounded-lg flex items-center justify-center bg-amber-500 text-white cursor-pointer'
          : 'px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-amber-500 text-white border-amber-400'}
      >
        {isPaused ? <PlayCircleFill size={isSidebar ? 16 : 12} /> : <PauseFill size={isSidebar ? 16 : 12} />}
        {!isSidebar && (isPaused ? 'Lanjutkan' : 'Jeda')}
      </button>
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
    </div>
  ) : activeRecording ? (
    isSidebar ? (
      <div title={`REC: ${activeRecording.targetName}`} className="w-10 h-10 rounded-lg flex items-center justify-center bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400">
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
      </div>
    ) : (
      <div className="px-3 py-2 rounded-lg text-xs font-medium border bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800 inline-flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> REC: {activeRecording.targetName}
      </div>
    )
  ) : (
    <button
      ref={recordButtonRef}
      onClick={handleRecordClick}
      disabled={recordingTargets.length === 0}
      title="Record"
      className={isSidebar
        ? 'w-10 h-10 rounded-lg flex items-center justify-center text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer'
        : 'px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm text-purple-700 dark:text-purple-300 hover:text-purple-800 border-purple-200 dark:border-gray-600 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed'}
    >
      <RecordCircleFill size={isSidebar ? 16 : 12} /> {!isSidebar && 'Record'}
    </button>
  );

  const recordingsButton = (
    <button
      ref={recordingsButtonRef}
      onClick={loadRecordings}
      title="Recordings"
      className={isSidebar
        ? 'w-10 h-10 rounded-lg flex items-center justify-center text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-700 transition-all cursor-pointer'
        : 'px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm text-purple-700 dark:text-purple-300 hover:text-purple-800 border-purple-200 dark:border-gray-600 shadow-sm'}
    >
      <Download size={isSidebar ? 16 : 12} /> {!isSidebar && 'Recordings'}
    </button>
  );

  const pickerContent = (
    <>
      <p className="text-gray-400 dark:text-gray-500 text-[10px] mb-1 px-1">Pilih target rekaman:</p>
      {recordingTargets.map((p) => (
        <button
          key={p.userId}
          onClick={() => startWithTarget(p.userId)}
          className="w-full text-left px-2 py-1.5 rounded hover:bg-purple-50 dark:hover:bg-gray-700 text-xs text-gray-700 dark:text-gray-300 cursor-pointer"
        >
          {p.name}
        </button>
      ))}
    </>
  );

  const pickerPanel = showPicker && (
    isSidebar ? createPortal(
      <div
        ref={picker.panelRef}
        style={picker.style ? { position: 'fixed', top: picker.style.top, left: picker.style.left } : { position: 'fixed', top: -9999, left: -9999 }}
        className="w-48 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-purple-100 dark:border-gray-700 p-2 z-[9999]"
      >
        {pickerContent}
      </div>,
      document.body,
    ) : (
      <div className="absolute top-full mt-1.5 left-0 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-purple-100 dark:border-gray-700 p-2 z-50">
        {pickerContent}
      </div>
    )
  );

  const listContent = (
    <>
      <p className="text-gray-900 dark:text-gray-100 text-xs font-semibold mb-1.5 px-1">Recordings</p>
      {error && <p className="text-red-500 text-[10px] px-1 mb-1">{error}</p>}
      {recordings.length === 0 && <p className="text-gray-400 dark:text-gray-500 text-[10px] px-1">Belum ada rekaman.</p>}
      {recordings.map((rec) => (
        <div key={rec.id} className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-purple-50/50 dark:hover:bg-gray-700/50 gap-2">
          <div className="min-w-0">
            <p className="text-xs text-gray-700 dark:text-gray-300 truncate">{rec.title}</p>
            <p className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
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
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => handlePreview(rec)} title="Preview" className="text-purple-500 hover:text-purple-700 cursor-pointer">
                <PlayCircleFill size={13} />
              </button>
              <button onClick={() => handleDownload(rec)} title="Download" className="text-purple-500 hover:text-purple-700 cursor-pointer">
                <Download size={13} />
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );

  const listPanel = showList && (
    isSidebar ? createPortal(
      <div
        ref={list.panelRef}
        style={list.style ? { position: 'fixed', top: list.style.top, left: list.style.left } : { position: 'fixed', top: -9999, left: -9999 }}
        className="w-64 max-h-64 overflow-y-auto bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-purple-100 dark:border-gray-700 p-2 z-[9999]"
      >
        {listContent}
      </div>,
      document.body,
    ) : (
      <div className="absolute top-full mt-1.5 right-0 w-64 max-h-64 overflow-y-auto bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-purple-100 dark:border-gray-700 p-2 z-50">
        {listContent}
      </div>
    )
  );

  const previewModal = previewUrl && createPortal(
    <div className="fixed inset-0 z-[10000] bg-black/80 flex items-center justify-center p-4" onClick={closePreview}>
      <div className="relative max-w-3xl w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <p className="text-white text-sm font-medium truncate">{previewTitle}</p>
          <button onClick={closePreview} title="Tutup" className="text-white hover:text-gray-300 cursor-pointer">
            <X size={20} />
          </button>
        </div>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- recordings have no caption track */}
        <video src={previewUrl} controls autoPlay className="w-full rounded-lg" />
      </div>
    </div>,
    document.body,
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
        {previewModal}
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
      {previewModal}
    </div>
  );
}
