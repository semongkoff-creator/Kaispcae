import { useMemo, useRef, useState } from 'react';
import {
  Icon,
  X,
  MegaphoneFill,
  EmojiFrownFill,
  SpeakerFill,
  CloudUploadFill,
  EmojiLaughingFill,
  BriefcaseFill,
  Wind,
  QuestionCircleFill,
  BellFill,
  TrophyFill,
} from 'react-bootstrap-icons';
import { SoundboardSoundData, SOUNDBOARD_DEFAULT_SOUNDS, SOUNDBOARD_MAX_DURATION_MS, SOUNDBOARD_MAX_FILE_BYTES, hasFeatureAccess } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { api, ApiError } from '@/services/api';

// One icon per default sound id — purely decorative, picked to match each
// clip's name. Custom uploaded sounds (no fixed id) all get the same generic
// speaker icon below instead of trying to guess one from a user-typed name.
const DEFAULT_SOUND_ICONS: Record<string, Icon> = {
  'default-cat-laugh': EmojiLaughingFill,
  'default-fahhh-pump': MegaphoneFill,
  'default-kerja-kerja-kerja': BriefcaseFill,
  'default-fart': Wind,
  'default-kak-gem-paham': QuestionCircleFill,
  'default-aa-kasian-aa': EmojiFrownFill,
  'default-boxing-bell': BellFill,
  'default-ronaldo-siuu': TrophyFill,
};

const ACCEPTED_EXT = ['.mp3', '.ogg', '.wav'];
const ACCEPTED_MIME = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave'];

// Reads the file's actual playable duration via a real <audio> element rather
// than trusting the file's byte size alone — a tiny/short-looking file could
// still decode into something longer, and the server only backstops on file
// size (no audio-decoding library available there either, see routes/rooms.ts's
// doc comment) — this is the one place duration is actually checked.
function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const ms = audio.duration * 1000;
      URL.revokeObjectURL(url);
      if (!Number.isFinite(ms) || ms <= 0) reject(new Error('Tidak bisa membaca durasi file audio.'));
      else resolve(ms);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('File audio tidak valid.'));
    };
    audio.src = url;
  });
}

interface SoundboardPanelProps {
  roomSlug: string;
  emitSoundboardPlay: (soundId: string) => void;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}

export function SoundboardPanel({ roomSlug, emitSoundboardPlay, open, onToggle, onClose }: SoundboardPanelProps) {
  const customSounds = useGameStore((s) => s.soundboardSounds);
  const addSoundboardSound = useGameStore((s) => s.addSoundboardSound);
  const localRole = useGameStore((s) => s.localRole);
  // Uploading a new custom sound is admin+ (see shared/permissions.ts's
  // 'soundboard:upload') — hidden entirely, not disabled, same convention as
  // ParticipantPanel's onKick/onSummon: a member below admin never sees an
  // affordance for an action they can't take.
  const canUpload = hasFeatureAccess(localRole, 'soundboard:upload');
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Client-side-only cooldown feedback (server enforces the real one) — just
  // so the grid visibly greys out instead of silently doing nothing for the
  // 3s after a click, which read as "the button is broken".
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const onCooldown = Date.now() < cooldownUntil;

  const allSounds = useMemo<SoundboardSoundData[]>(
    () => [...SOUNDBOARD_DEFAULT_SOUNDS, ...customSounds],
    [customSounds],
  );

  const play = (soundId: string) => {
    if (onCooldown) return;
    emitSoundboardPlay(soundId);
    setCooldownUntil(Date.now() + 3000);
  };

  const handleFile = async (file: File) => {
    setError(null);
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ACCEPTED_MIME.includes(file.type) && !ACCEPTED_EXT.includes(ext)) {
      setError('Format tidak didukung — hanya mp3/ogg/wav.');
      return;
    }
    if (file.size > SOUNDBOARD_MAX_FILE_BYTES) {
      setError(`Ukuran file maksimal ${Math.round(SOUNDBOARD_MAX_FILE_BYTES / 1024)}KB.`);
      return;
    }
    let durationMs: number;
    try {
      durationMs = await readAudioDuration(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'File audio tidak valid.');
      return;
    }
    if (durationMs > SOUNDBOARD_MAX_DURATION_MS) {
      setError(`Maksimal ${SOUNDBOARD_MAX_DURATION_MS / 1000} detik.`);
      return;
    }
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 30) || 'Sound';
    setUploading(true);
    try {
      const sound = await api.uploadSoundboardSound(roomSlug, file, name, durationMs);
      // Also add it locally right away — SOUNDBOARD_SOUND_ADDED will arrive
      // for everyone else (and dedupes by id if it loops back to us too).
      addSoundboardSound(sound);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload gagal.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="relative z-40 pointer-events-auto">
      <button
        onClick={onToggle}
        title="Soundboard"
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
          open ? 'bg-purple-600 text-white' : 'bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-800 border border-purple-100 dark:border-gray-700 shadow-sm'
        }`}
      >
        <SpeakerFill size={14} />
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-2 w-72 max-h-[60vh] bg-white/95 dark:bg-gray-900/95 backdrop-blur-md rounded-xl border border-purple-100 dark:border-gray-700 shadow-2xl flex flex-col pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="p-3 border-b border-purple-100 dark:border-gray-700 flex items-center justify-between">
            <span className="text-gray-900 dark:text-gray-100 text-sm font-medium">Soundboard</span>
            <button onClick={onClose} title="Close" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
              <X size={14} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            <div className="grid grid-cols-3 gap-2">
              {allSounds.map((sound) => {
                const Icon = DEFAULT_SOUND_ICONS[sound.id] ?? SpeakerFill;
                return (
                  <button
                    key={sound.id}
                    onClick={() => play(sound.id)}
                    disabled={onCooldown}
                    title={sound.createdByName ? `${sound.name} — diunggah oleh ${sound.createdByName}` : sound.name}
                    className={`flex flex-col items-center gap-1 rounded-lg border border-purple-100 dark:border-gray-700 py-2 px-1 transition-colors ${
                      onCooldown
                        ? 'opacity-40 cursor-not-allowed'
                        : 'cursor-pointer bg-purple-50/50 dark:bg-gray-800/50 hover:bg-purple-100 dark:hover:bg-gray-700'
                    }`}
                  >
                    <Icon size={18} className="text-purple-600 dark:text-purple-300" />
                    <span className="text-[10px] text-gray-700 dark:text-gray-300 truncate w-full text-center">{sound.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {canUpload && (
            <div className="p-3 border-t border-purple-100 dark:border-gray-700">
              {error && <p className="text-red-500 text-[11px] mb-2">{error}</p>}
              <button
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
                className="w-full flex items-center justify-center gap-2 text-xs font-medium text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-gray-800 hover:bg-purple-100 dark:hover:bg-gray-700 rounded-lg py-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <CloudUploadFill size={13} />
                {uploading ? 'Mengunggah…' : 'Upload Sound'}
              </button>
              <p className="text-gray-400 dark:text-gray-500 text-[10px] mt-1.5 text-center">mp3/ogg/wav · maks {SOUNDBOARD_MAX_DURATION_MS / 1000} detik</p>
              <input
                ref={inputRef}
                type="file"
                accept=".mp3,.ogg,.wav,audio/mpeg,audio/ogg,audio/wav"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  e.target.value = '';
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
