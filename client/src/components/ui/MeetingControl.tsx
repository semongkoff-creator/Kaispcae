import { useState, useEffect } from 'react';
import { CameraVideoFill, BoxArrowUpRight, StopFill, ClockHistory, XLg } from 'react-bootstrap-icons';
import { api, MomRecord } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';

// A5 — shown only while the local avatar is inside a 'meeting'-type zone (see
// App). Starts/joins/ends a recorded Lark VC meeting; the "join" banner is
// driven by the MEETING_STARTED/ENDED broadcasts so everyone in the zone sees
// it. Recording (if the Lark plan supports it) fills in later, visible in the
// history panel.
export function MeetingControl({ roomId, zoneId }: { roomId: string; zoneId: string }) {
  const active = useGameStore((s) => s.activeMeetings[zoneId]);
  const localUserId = useGameStore((s) => s.localUserId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  const start = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.startMeeting(roomId, zoneId);
      window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal memulai meeting.');
    } finally { setBusy(false); }
  };

  const end = async () => {
    if (!active) return;
    setBusy(true); setErr('');
    try { await api.endMeeting(active.momRecordId); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Gagal mengakhiri meeting.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="absolute top-16 left-1/2 -translate-x-1/2 z-40 pointer-events-auto flex flex-col items-center gap-1">
      {active ? (
        <div className="flex items-center gap-2 bg-purple-600 text-white text-xs px-3 py-1.5 rounded-full shadow-lg">
          <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
          Meeting berlangsung
          <a href={active.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline font-medium">
            <BoxArrowUpRight size={11} /> Join via Lark
          </a>
          {active.startedBy === localUserId && (
            <button onClick={end} disabled={busy} className="inline-flex items-center gap-1 bg-white/20 hover:bg-white/30 rounded px-1.5 py-0.5 cursor-pointer disabled:opacity-50">
              <StopFill size={11} /> {busy ? '…' : 'End'}
            </button>
          )}
        </div>
      ) : (
        <button onClick={start} disabled={busy} className="inline-flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg cursor-pointer disabled:opacity-50">
          <CameraVideoFill size={12} /> {busy ? 'Memulai…' : 'Start Meeting'}
        </button>
      )}
      <button onClick={() => setHistoryOpen(true)} className="text-[10px] text-purple-600 dark:text-purple-300 hover:underline inline-flex items-center gap-1 cursor-pointer">
        <ClockHistory size={10} /> Riwayat meeting
      </button>
      {err && <span className="text-[10px] text-red-600 bg-white/95 dark:bg-gray-800/95 px-2 py-0.5 rounded shadow">{err}</span>}
      {historyOpen && <MeetingHistoryPanel roomId={roomId} onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}

function fmt(dt: string | null): string {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const STATUS_LABEL: Record<string, string> = {
  live: 'Berlangsung',
  ended: 'Selesai',
  recording_pending: 'Rekaman diproses…',
  recorded: 'Rekaman siap',
  unavailable: 'Rekaman tidak tersedia',
};

function MeetingHistoryPanel({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const [list, setList] = useState<MomRecord[] | null>(null);
  useEffect(() => {
    api.getMeetingHistory(roomId).then((r) => setList(r.meetings)).catch(() => setList([]));
  }, [roomId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl p-5 w-full max-w-md max-h-[70vh] overflow-y-auto shadow-xl border border-purple-100 dark:border-gray-700"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="flex items-center gap-2 text-gray-900 dark:text-gray-100 font-semibold text-sm"><ClockHistory size={15} /> Riwayat Meeting</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"><XLg size={15} /></button>
        </div>
        {list === null ? (
          <p className="text-gray-400 text-sm text-center py-6">Memuat…</p>
        ) : list.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-sm py-4">Belum ada meeting di room ini.</p>
        ) : (
          <div className="space-y-2">
            {list.map((m) => (
              <div key={m.id} className="rounded-lg border border-purple-100 dark:border-gray-700 p-2.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-gray-700 dark:text-gray-200 font-medium">{fmt(m.startTime)} → {fmt(m.endTime)}</span>
                  <span className="text-[10px] text-gray-500 dark:text-gray-400">{STATUS_LABEL[m.recordingStatus] ?? m.recordingStatus}</span>
                </div>
                {m.recordingUrl ? (
                  <a href={m.recordingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-purple-600 dark:text-purple-300 hover:underline mt-1">
                    <BoxArrowUpRight size={10} /> Buka rekaman
                  </a>
                ) : m.larkMeetingNo ? (
                  <span className="text-gray-400 dark:text-gray-500 mt-1 block">No. meeting: {m.larkMeetingNo}</span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
