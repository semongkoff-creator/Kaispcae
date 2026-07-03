import { useCallback } from 'react';
import { TileType } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { createDefaultRoom } from '@/utils/createDefaultRoom';

const TILE_PALETTE: { type: TileType; label: string; color: string }[] = [
  { type: 'floor', label: 'Floor', color: '#e8d5b0' },
  { type: 'wall', label: 'Wall', color: '#4a3728' },
  { type: 'desk', label: 'Desk', color: '#8B6914' },
  { type: 'chair', label: 'Chair', color: '#5b8dd9' },
  { type: 'door', label: 'Door', color: '#d4a056' },
];

interface RoomEditorProps {
  onSave: () => void;
}

export function RoomEditor({ onSave }: RoomEditorProps) {
  const selected = useGameStore((s) => s.selectedTileType);
  const setSelected = useGameStore((s) => s.setSelectedTileType);
  const undo = useGameStore((s) => s.undo);
  const redo = useGameStore((s) => s.redo);
  const tileHistoryIndex = useGameStore((s) => s.tileHistoryIndex);
  const tileHistory = useGameStore((s) => s.tileHistory);

  const handleReset = useCallback(() => {
    const room = createDefaultRoom('main-office', 'Main Office');
    const state = useGameStore.getState();
    const tileTypes = room.tiles.map((row) => row.map((t) => t.type));
    state.pushTileHistory(tileTypes);
    state.setTiles(room.tiles);
  }, []);

  return (
    <div className="absolute top-0 right-0 z-50 w-56 h-full bg-gray-800/95 backdrop-blur-md border-l border-white/10 shadow-2xl p-4 pointer-events-auto overflow-y-auto"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <h3 className="text-white text-sm font-bold mb-3">Room Editor</h3>

      {/* Tile palette */}
      <p className="text-white/50 text-[10px] uppercase tracking-wider mb-2">Tile Palette</p>
      <div className="space-y-1 mb-4">
        {TILE_PALETTE.map((t) => (
          <button
            key={t.type}
            onClick={() => setSelected(t.type)}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              selected === t.type
                ? 'bg-white/15 text-white border border-white/30'
                : 'bg-gray-700/50 text-white/60 hover:bg-gray-700 border border-transparent'
            }`}
          >
            <span className="w-4 h-4 rounded" style={{ backgroundColor: t.color }} />
            {t.label}
          </button>
        ))}
      </div>

      <p className="text-white/40 text-[10px] mb-2 leading-relaxed">Click to paint • Right-click to erase</p>

      <hr className="border-white/10 my-4" />

      {/* Undo / Redo */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={undo}
          disabled={tileHistoryIndex <= 0}
          className="flex-1 py-1.5 rounded bg-gray-700 text-white/60 text-xs disabled:opacity-30 hover:bg-gray-600 cursor-pointer"
        >
          ↩ Undo
        </button>
        <button
          onClick={redo}
          disabled={tileHistoryIndex >= tileHistory.length - 1}
          className="flex-1 py-1.5 rounded bg-gray-700 text-white/60 text-xs disabled:opacity-30 hover:bg-gray-600 cursor-pointer"
        >
          ↪ Redo
        </button>
      </div>

      {/* Save */}
      <button
        onClick={onSave}
        className="w-full py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-sm transition-colors mb-2 cursor-pointer"
      >
        💾 Save Room
      </button>

      {/* Reset */}
      <button
        onClick={handleReset}
        className="w-full py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 text-sm transition-colors cursor-pointer"
      >
        🔄 Reset to Default
      </button>
    </div>
  );
}
