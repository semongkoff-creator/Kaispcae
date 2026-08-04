import { useEffect, useRef, useState } from 'react';
import { MusicNoteBeamed, X } from 'react-bootstrap-icons';
import { parseYouTubeId } from '@/utils/youtube';

// Focus Area (Room Editor "Focus area" tile effect) — while standing inside
// one, the player's presence is auto-set to workMode 'focus' (App.tsx's
// meetingZone/focusZone effect) and this panel becomes available. Unlike
// every OTHER music feature in this app (BGM areas via useBgm, Music Bot via
// musicHandler.ts's zone chat queue) — both shared/synced across everyone in
// range — this one is deliberately 100% local: nothing here ever touches a
// socket. Picking a file or pasting a link only plays audio in THIS tab, so
// two people standing in the same Focus area each hear only their own pick,
// exactly like a real pair of headphones. Unmounts (see App.tsx's
// `workMode === 'focus' &&` guard) the instant the player leaves the area,
// which stops playback for free — no explicit pause/cleanup wiring needed
// beyond revoking the object URL below.
export function FocusMusicPanel() {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<'upload' | 'youtube'>('upload');
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [youtubeInput, setYoutubeInput] = useState('');
  const [youtubeId, setYoutubeId] = useState<string | null>(null);
  const fileUrlRef = useRef<string | null>(null);

  // Revoke the previous object URL whenever it's replaced, and on unmount —
  // otherwise every file picked this session leaks its blob until page reload.
  useEffect(() => {
    fileUrlRef.current = fileUrl;
  }, [fileUrl]);
  useEffect(() => () => { if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current); }, []);

  const handleFilePick = (f: File | null) => {
    if (!f) return;
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    setFileUrl(URL.createObjectURL(f));
    setFileName(f.name);
  };

  const handleYoutubeSubmit = () => {
    const id = parseYouTubeId(youtubeInput);
    setYoutubeId(id);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Buka Focus Music"
        className="absolute bottom-20 left-16 z-50 w-9 h-9 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-amber-300 dark:border-amber-700 shadow-sm flex items-center justify-center text-amber-600 dark:text-amber-400 cursor-pointer pointer-events-auto"
      >
        <MusicNoteBeamed size={14} />
      </button>
    );
  }

  return (
    <div className="absolute bottom-20 left-16 z-50 w-64 bg-white/95 dark:bg-gray-800/95 backdrop-blur-sm border border-amber-300 dark:border-amber-700 rounded-xl shadow-lg p-3 pointer-events-auto text-xs text-gray-700 dark:text-gray-200">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
          <MusicNoteBeamed size={12} /> Focus Music
        </span>
        <button onClick={() => setOpen(false)} title="Sembunyikan" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
          <X size={13} />
        </button>
      </div>
      <p className="text-[10px] text-gray-400 dark:text-gray-500 mb-2">Cuma kamu yang dengar — pilihanmu tidak dibagikan ke orang lain di area ini.</p>

      <div className="flex gap-1 mb-2">
        <button
          onClick={() => setTab('upload')}
          className={`flex-1 py-1 rounded text-[11px] font-medium cursor-pointer ${tab === 'upload' ? 'bg-amber-600 text-white' : 'bg-amber-50 dark:bg-gray-700 text-amber-700 dark:text-amber-300'}`}
        >
          Upload
        </button>
        <button
          onClick={() => setTab('youtube')}
          className={`flex-1 py-1 rounded text-[11px] font-medium cursor-pointer ${tab === 'youtube' ? 'bg-amber-600 text-white' : 'bg-amber-50 dark:bg-gray-700 text-amber-700 dark:text-amber-300'}`}
        >
          YouTube
        </button>
      </div>

      {tab === 'upload' ? (
        <div>
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => handleFilePick(e.target.files?.[0] ?? null)}
            className="w-full text-[11px] mb-2 text-gray-500 dark:text-gray-400"
          />
          {fileUrl && (
            <>
              <p className="truncate mb-1 text-gray-500 dark:text-gray-400">{fileName}</p>
              <audio key={fileUrl} src={fileUrl} controls loop autoPlay className="w-full h-8" />
            </>
          )}
        </div>
      ) : (
        <div>
          <div className="flex gap-1 mb-2">
            <input
              value={youtubeInput}
              onChange={(e) => setYoutubeInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleYoutubeSubmit()}
              placeholder="Link atau ID YouTube"
              className="flex-1 min-w-0 bg-amber-50/50 dark:bg-gray-700/50 rounded px-2 py-1 text-[11px] outline-none border border-amber-100 dark:border-gray-700 focus:border-amber-500"
            />
            <button onClick={handleYoutubeSubmit} className="px-2 rounded bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-medium cursor-pointer">Putar</button>
          </div>
          {youtubeId && (
            <iframe
              key={youtubeId}
              title="Focus Music (YouTube)"
              width="100%"
              height="150"
              src={`https://www.youtube.com/embed/${youtubeId}?autoplay=1&loop=1&playlist=${youtubeId}`}
              allow="autoplay; encrypted-media"
              className="rounded"
              style={{ border: 'none' }}
            />
          )}
        </div>
      )}
    </div>
  );
}
