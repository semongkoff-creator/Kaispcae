import { useRef, useState } from 'react';
import { Image, PlayBtnFill, StickyFill, Paperclip, CameraFill } from 'react-bootstrap-icons';
import { MediaType, MediaPayload, TILE_SIZE } from '@virtualmeet/shared';
import { api, ApiError } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';
import { parseYouTubeId } from '@/utils/youtube';

interface AddMediaPanelProps {
  onAdd: (type: MediaType, x: number, y: number, payload?: MediaPayload) => void;
  onScreenshot: () => void;
  onClose: () => void;
}

// §6 — Add Media. Every placeable type lands at the player's CURRENT tile,
// same "add at current location" convention already established by
// Teleport's "Add current location" (TeleportPanel.tsx) — simpler than a
// separate click-to-place mode, and consistent within the app.
export function AddMediaPanel({ onAdd, onScreenshot, onClose }: AddMediaPanelProps) {
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentTile = () => {
    const { localPlayer } = useGameStore.getState();
    return { x: Math.floor(localPlayer.x / TILE_SIZE), y: Math.floor(localPlayer.y / TILE_SIZE) };
  };

  const handleImageSelect = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const { url } = await api.uploadMedia(file);
      const { x, y } = currentTile();
      onAdd('image', x, y, { url });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal upload gambar');
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelect = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const { url, fileName } = await api.uploadMedia(file);
      const { x, y } = currentTile();
      onAdd('file', x, y, { url, fileName });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal upload file');
    } finally {
      setUploading(false);
    }
  };

  const handleYoutubeSubmit = () => {
    const videoId = parseYouTubeId(youtubeUrl);
    if (!videoId) {
      setError('Link YouTube tidak valid');
      return;
    }
    const { x, y } = currentTile();
    onAdd('youtube', x, y, { videoId });
    onClose();
  };

  const handleWhiteboardAdd = () => {
    const { x, y } = currentTile();
    onAdd('whiteboard', x, y);
    onClose();
  };

  return (
    <div
      className="absolute bottom-16 left-4 z-50 w-72 bg-white/95 backdrop-blur-md rounded-xl border border-purple-100 shadow-2xl p-3 pointer-events-auto"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-gray-900 text-sm font-bold">Add Media</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xs cursor-pointer">✕</button>
      </div>

      {error && <p className="text-red-500 text-[10px] mb-2">{error}</p>}

      <div className="grid grid-cols-2 gap-2 mb-3">
        <button
          onClick={() => imageInputRef.current?.click()}
          disabled={uploading}
          className="flex flex-col items-center gap-1 py-3 rounded-lg bg-purple-50 text-purple-700 hover:bg-purple-100 text-xs font-medium cursor-pointer disabled:opacity-50"
        >
          <Image size={16} /> Image
        </button>
        <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={(e) => handleImageSelect(e.target.files?.[0])} />

        <button
          onClick={handleWhiteboardAdd}
          className="flex flex-col items-center gap-1 py-3 rounded-lg bg-purple-50 text-purple-700 hover:bg-purple-100 text-xs font-medium cursor-pointer"
        >
          <StickyFill size={16} /> Whiteboard
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex flex-col items-center gap-1 py-3 rounded-lg bg-purple-50 text-purple-700 hover:bg-purple-100 text-xs font-medium cursor-pointer disabled:opacity-50"
        >
          <Paperclip size={16} /> File
        </button>
        <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => handleFileSelect(e.target.files?.[0])} />

        <button
          onClick={() => { onScreenshot(); onClose(); }}
          className="flex flex-col items-center gap-1 py-3 rounded-lg bg-purple-50 text-purple-700 hover:bg-purple-100 text-xs font-medium cursor-pointer"
        >
          <CameraFill size={16} /> Screenshot
        </button>
      </div>

      <div className="flex items-center gap-1.5 mb-1">
        <PlayBtnFill size={12} className="text-purple-500 shrink-0" />
        <span className="text-gray-700 text-xs font-medium">YouTube</span>
      </div>
      <div className="flex gap-1.5">
        <input
          type="text"
          value={youtubeUrl}
          onChange={(e) => setYoutubeUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleYoutubeSubmit(); }}
          placeholder="Tempel link YouTube..."
          className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-purple-200 text-xs focus:outline-none focus:ring-1 focus:ring-purple-400"
        />
        <button
          onClick={handleYoutubeSubmit}
          className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium cursor-pointer"
        >
          Add
        </button>
      </div>

      {uploading && <p className="text-gray-400 text-[10px] mt-2">Uploading...</p>}
    </div>
  );
}
