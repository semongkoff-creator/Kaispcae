import { useCallback } from 'react';
import { TileType } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { createDefaultRoom } from '@/utils/createDefaultRoom';
import { TILE_PALETTE, PaletteEntry } from '@/data/tilePaletteManifest';

const BASIC_TYPES: { type: TileType; label: string; color: string }[] = [
  { type: 'floor', label: 'Floor', color: '#e8d5b0' },
  { type: 'wall', label: 'Wall', color: '#4a3728' },
  { type: 'desk', label: 'Desk', color: '#8B6914' },
  { type: 'chair', label: 'Chair', color: '#5b8dd9' },
  { type: 'door', label: 'Door', color: '#d4a056' },
  { type: 'spawn', label: 'Spawn Point', color: '#10b981' },
  { type: 'portal', label: 'Portal (asks for target room)', color: '#7c3aed' },
];

// Modern_Office_Singles files are always exported on a fixed 64x96 canvas
// (see tilePaletteManifest.ts) — used to scale the CSS background crop.
const SOURCE_W = 64;
const SOURCE_H = 96;
const TILE_PX = 32;
const THUMB_BOX = 40;

function PaletteThumb({ entry }: { entry: PaletteEntry }) {
  const cropW = entry.tilesW * TILE_PX;
  const cropH = entry.tilesH * TILE_PX;
  const scale = Math.min(THUMB_BOX / cropW, THUMB_BOX / cropH);
  return (
    <div
      style={{
        width: cropW * scale,
        height: cropH * scale,
        backgroundImage: `url(${entry.src})`,
        backgroundSize: `${SOURCE_W * scale}px ${SOURCE_H * scale}px`,
        backgroundPosition: `-${entry.srcX * scale}px -${entry.srcY * scale}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
      }}
    />
  );
}

interface RoomEditorProps {
  onSave: () => void;
}

export function RoomEditor({ onSave }: RoomEditorProps) {
  const selected = useGameStore((s) => s.selectedTileType);
  const setSelected = useGameStore((s) => s.setSelectedTileType);
  const selectedPaletteId = useGameStore((s) => s.selectedPaletteId);
  const setSelectedPaletteId = useGameStore((s) => s.setSelectedPaletteId);
  const undo = useGameStore((s) => s.undo);
  const redo = useGameStore((s) => s.redo);
  const tileHistoryIndex = useGameStore((s) => s.tileHistoryIndex);
  const tileHistory = useGameStore((s) => s.tileHistory);
  const zones = useGameStore((s) => s.zones);
  const removeZone = useGameStore((s) => s.removeZone);
  const zoneDrawMode = useGameStore((s) => s.zoneDrawMode);
  const toggleZoneDrawMode = useGameStore((s) => s.toggleZoneDrawMode);

  const handleReset = useCallback(() => {
    const room = createDefaultRoom('main-office', 'Main Office');
    const state = useGameStore.getState();
    const tileTypes = room.tiles.map((row) => row.map((t) => t.type));
    state.pushTileHistory(tileTypes);
    state.setTiles(room.tiles);
    state.setFurniture(room.furniture);
    state.setZones([]);
  }, []);

  const floorEntries = TILE_PALETTE.filter((e) => e.category === 'floor');
  const furnitureEntries = TILE_PALETTE.filter((e) => e.category === 'furniture');

  return (
    <div className="absolute top-0 right-0 z-50 w-56 h-full bg-white/95 backdrop-blur-md border-l border-purple-100 shadow-2xl p-4 pointer-events-auto overflow-y-auto"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <h3 className="text-gray-900 text-sm font-bold mb-3">Room Editor</h3>

      {/* Visual palette — floor textures */}
      <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-2">Floor Textures</p>
      <div className="grid grid-cols-5 gap-1.5 mb-4">
        {floorEntries.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setSelectedPaletteId(entry.id)}
            title={entry.label}
            className={`flex items-center justify-center p-1 rounded-lg cursor-pointer transition-all ${
              selectedPaletteId === entry.id ? 'bg-purple-100 ring-2 ring-purple-400' : 'bg-gray-50 hover:bg-purple-50'
            }`}
          >
            <PaletteThumb entry={entry} />
          </button>
        ))}
      </div>

      {/* Visual palette — furniture */}
      <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-2">Furniture</p>
      <div className="grid grid-cols-4 gap-1.5 mb-4">
        {furnitureEntries.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setSelectedPaletteId(entry.id)}
            title={`${entry.label} (${entry.tilesW}x${entry.tilesH})`}
            className={`flex items-center justify-center p-1 rounded-lg cursor-pointer transition-all ${
              selectedPaletteId === entry.id ? 'bg-purple-100 ring-2 ring-purple-400' : 'bg-gray-50 hover:bg-purple-50'
            }`}
          >
            <PaletteThumb entry={entry} />
          </button>
        ))}
      </div>

      <p className="text-gray-400 text-[10px] mb-3 leading-relaxed">
        Click to place • Right-click to erase. Furniture is stamped in one click at the tile you click (its base), taller pieces extend upward and let you walk behind them.
      </p>

      <hr className="border-purple-100 my-3" />

      {/* Basic collision types */}
      <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-2">Basic Types (collision only)</p>
      <div className="space-y-1 mb-4">
        {BASIC_TYPES.map((t) => (
          <button
            key={t.type}
            onClick={() => setSelected(t.type)}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              !selectedPaletteId && selected === t.type
                ? 'bg-purple-100 text-purple-700 border border-purple-300'
                : 'bg-gray-50 text-gray-500 hover:bg-gray-100 border border-transparent'
            }`}
          >
            <span className="w-4 h-4 rounded" style={{ backgroundColor: t.color }} />
            {t.label}
          </button>
        ))}
      </div>

      <hr className="border-purple-100 my-3" />

      {/* Private zones */}
      <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-2">Private Zones</p>
      <button
        onClick={toggleZoneDrawMode}
        className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer mb-2 ${
          zoneDrawMode ? 'bg-purple-600 text-white' : 'bg-purple-50 text-purple-700 hover:bg-purple-100'
        }`}
      >
        🔒 {zoneDrawMode ? 'Drag on map to draw…' : 'Draw Zone'}
      </button>
      {zones.length > 0 && (
        <div className="space-y-1 mb-3">
          {zones.map((z) => (
            <div key={z.id} className="flex items-center justify-between px-2 py-1.5 rounded bg-gray-50 text-xs">
              <span className="text-gray-600 truncate">{z.name}</span>
              <button onClick={() => removeZone(z.id)} className="text-red-500/70 hover:text-red-500 cursor-pointer ml-2">✕</button>
            </div>
          ))}
        </div>
      )}
      <p className="text-gray-400 text-[10px] mb-3 leading-relaxed">
        Players inside a zone only hear/see each other, regardless of distance — great for meeting rooms.
      </p>

      <hr className="border-purple-100 my-4" />

      {/* Undo / Redo */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={undo}
          disabled={tileHistoryIndex <= 0}
          className="flex-1 py-1.5 rounded bg-gray-100 text-gray-600 text-xs disabled:opacity-30 hover:bg-gray-200 cursor-pointer"
        >
          ↩ Undo
        </button>
        <button
          onClick={redo}
          disabled={tileHistoryIndex >= tileHistory.length - 1}
          className="flex-1 py-1.5 rounded bg-gray-100 text-gray-600 text-xs disabled:opacity-30 hover:bg-gray-200 cursor-pointer"
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
        className="w-full py-2 rounded-lg bg-red-100 hover:bg-red-200 text-red-600 text-sm transition-colors cursor-pointer"
      >
        🔄 Reset to Default
      </button>
    </div>
  );
}
