import { useCallback, useState } from 'react';
import { LockFill, X, SaveFill, ArrowClockwise, MegaphoneFill } from 'react-bootstrap-icons';
import { TileType, Zone, ZoneType, Furniture } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { createDefaultRoom } from '@/utils/createDefaultRoom';
import { PaletteEntry } from '@/data/tilePaletteManifest';
import { PALETTE_BY_THEME } from '@/data/themeAssets';

const ZONE_COLORS = ['#7c3aed', '#4d96ff', '#10b981', '#f59e0b', '#ef4444', '#64748b'];
const BANNER_COLORS = ['#7c3aed', '#4d96ff', '#10b981', '#f59e0b', '#ef4444', '#1f2937'];
const ZONE_TYPES: { value: ZoneType; label: string }[] = [
  { value: 'meeting', label: 'Meeting (big banner)' },
  { value: 'desk', label: 'Desk (small label)' },
  { value: 'focus', label: 'Focus (small label)' },
  { value: 'general', label: 'General (no banner)' },
];

function ZoneForm({ rect, onCancel }: { rect: { x: number; y: number; width: number; height: number }; onCancel: () => void }) {
  const [name, setName] = useState('Meeting Room');
  const [label, setLabel] = useState('MEETING ROOM');
  const [color, setColor] = useState(ZONE_COLORS[0]);
  const [type, setType] = useState<ZoneType>('meeting');

  const handleCreate = () => {
    const zone: Zone = {
      id: crypto.randomUUID(),
      name: name.trim().slice(0, 30) || 'Zone',
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      type,
      color,
      label: type === 'general' ? undefined : (label.trim().slice(0, 24) || undefined),
    };
    useGameStore.getState().addZone(zone);
    onCancel();
  };

  return (
    <div className="mb-3 p-3 rounded-lg bg-purple-50 dark:bg-gray-700 border border-purple-200 dark:border-gray-600">
      <p className="text-purple-700 dark:text-purple-300 text-xs font-semibold mb-2">New Zone</p>
      <label className="text-gray-500 dark:text-gray-400 text-[10px] block mb-1">Internal name</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={30}
        className="w-full bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs rounded px-2 py-1.5 mb-2 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500"
      />

      <label className="text-gray-500 dark:text-gray-400 text-[10px] block mb-1">Type</label>
      <select
        value={type}
        onChange={(e) => setType(e.target.value as ZoneType)}
        className="w-full bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs rounded px-2 py-1.5 mb-2 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500 cursor-pointer"
      >
        {ZONE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>

      {type !== 'general' && (
        <>
          <label className="text-gray-500 dark:text-gray-400 text-[10px] block mb-1">Banner label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value.toUpperCase())}
            maxLength={24}
            placeholder="e.g. AI TEAM"
            className="w-full bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs rounded px-2 py-1.5 mb-2 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500"
          />

          <label className="text-gray-500 dark:text-gray-400 text-[10px] block mb-1">Color</label>
          <div className="flex gap-1.5 mb-3">
            {ZONE_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className="w-6 h-6 rounded-full border-2 cursor-pointer"
                style={{ backgroundColor: c, borderColor: color === c ? '#1f2937' : 'transparent' }}
              />
            ))}
          </div>
        </>
      )}

      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 py-1.5 rounded bg-gray-100 text-gray-600 text-xs hover:bg-gray-200 cursor-pointer">Cancel</button>
        <button onClick={handleCreate} className="flex-1 py-1.5 rounded bg-purple-600 text-white text-xs font-medium hover:bg-purple-700 cursor-pointer">Create</button>
      </div>
    </div>
  );
}

function BannerForm({ pos, onCancel }: { pos: { x: number; y: number }; onCancel: () => void }) {
  const [text, setText] = useState('Welcome to our office!');
  const [bgColor, setBgColor] = useState(BANNER_COLORS[0]);
  const [textColor, setTextColor] = useState('#ffffff');
  const [width, setWidth] = useState(4);
  const [imageUrl, setImageUrl] = useState('');

  const handleCreate = () => {
    const trimmedUrl = imageUrl.trim();
    const banner: Furniture = {
      id: crypto.randomUUID(),
      paletteId: 'banner',
      kind: 'banner',
      x: pos.x, y: pos.y,
      tilesW: Math.min(10, Math.max(1, width)),
      tilesH: 1,
      imageUrl: trimmedUrl || undefined,
      text: trimmedUrl ? undefined : (text.trim().slice(0, 60) || 'Banner'),
      textColor,
      bgColor,
    };
    useGameStore.getState().addFurniture(banner);
    onCancel();
  };

  return (
    <div className="mb-3 p-3 rounded-lg bg-purple-50 dark:bg-gray-700 border border-purple-200 dark:border-gray-600">
      <p className="text-purple-700 dark:text-purple-300 text-xs font-semibold mb-2">New Banner</p>

      <label className="text-gray-500 dark:text-gray-400 text-[10px] block mb-1">Image URL (optional — skips text below if set)</label>
      <input
        value={imageUrl}
        onChange={(e) => setImageUrl(e.target.value)}
        placeholder="https://..."
        className="w-full bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs rounded px-2 py-1.5 mb-2 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500"
      />

      {!imageUrl.trim() && (
        <>
          <label className="text-gray-500 dark:text-gray-400 text-[10px] block mb-1">Text</label>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={60}
            placeholder="e.g. team name, tagline, announcement"
            className="w-full bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs rounded px-2 py-1.5 mb-2 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500"
          />

          <label className="text-gray-500 dark:text-gray-400 text-[10px] block mb-1">Background color</label>
          <div className="flex gap-1.5 mb-2">
            {BANNER_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setBgColor(c)}
                className="w-6 h-6 rounded-full border-2 cursor-pointer"
                style={{ backgroundColor: c, borderColor: bgColor === c ? '#1f2937' : 'transparent' }}
              />
            ))}
          </div>

          <label className="text-gray-500 dark:text-gray-400 text-[10px] block mb-1">Text color</label>
          <div className="flex gap-1.5 mb-2">
            {['#ffffff', '#1f2937'].map((c) => (
              <button
                key={c}
                onClick={() => setTextColor(c)}
                className="w-6 h-6 rounded-full border-2 cursor-pointer"
                style={{ backgroundColor: c, borderColor: textColor === c ? '#7c3aed' : '#d1d5db' }}
              />
            ))}
          </div>
        </>
      )}

      <label className="text-gray-500 dark:text-gray-400 text-[10px] block mb-1">Width (tiles)</label>
      <input
        type="number"
        min={1}
        max={10}
        value={width}
        onChange={(e) => setWidth(Number(e.target.value) || 1)}
        className="w-full bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs rounded px-2 py-1.5 mb-3 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500"
      />

      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 py-1.5 rounded bg-gray-100 text-gray-600 text-xs hover:bg-gray-200 cursor-pointer">Cancel</button>
        <button onClick={handleCreate} className="flex-1 py-1.5 rounded bg-purple-600 text-white text-xs font-medium hover:bg-purple-700 cursor-pointer">Create</button>
      </div>
    </div>
  );
}

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
// scifi-office entries set their own srcW/srcH instead (each RSI state's PNG
// has its own real dimensions — see scifiOfficePaletteManifest.ts), since
// they don't share that one fixed canvas size.
const SOURCE_W = 64;
const SOURCE_H = 96;
const TILE_PX = 32;
const THUMB_BOX = 40;

function PaletteThumb({ entry }: { entry: PaletteEntry }) {
  const fullW = entry.srcW ?? SOURCE_W;
  const fullH = entry.srcH ?? SOURCE_H;
  const cropW = entry.tilesW * TILE_PX;
  const cropH = entry.tilesH * TILE_PX;
  const scale = Math.min(THUMB_BOX / cropW, THUMB_BOX / cropH);
  return (
    <div
      style={{
        width: cropW * scale,
        height: cropH * scale,
        backgroundImage: `url(${entry.src})`,
        backgroundSize: `${fullW * scale}px ${fullH * scale}px`,
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
  const pendingZoneRect = useGameStore((s) => s.pendingZoneRect);
  const setPendingZoneRect = useGameStore((s) => s.setPendingZoneRect);
  const furniture = useGameStore((s) => s.furniture);
  const removeFurnitureAt = useGameStore((s) => s.removeFurnitureAt);
  const activeTableId = useGameStore((s) => s.activeTableId);
  const setActiveTableId = useGameStore((s) => s.setActiveTableId);
  const bannerPlaceMode = useGameStore((s) => s.bannerPlaceMode);
  const toggleBannerPlaceMode = useGameStore((s) => s.toggleBannerPlaceMode);
  const pendingBannerPos = useGameStore((s) => s.pendingBannerPos);
  const setPendingBannerPos = useGameStore((s) => s.setPendingBannerPos);
  const banners = furniture.filter((f) => f.kind === 'banner');
  // Distinct tables already placed, with how many chairs each has — its
  // capacity (no separate maxSeats field; a table just IS its chairs).
  const tableCounts = furniture.reduce<Record<string, number>>((acc, f) => {
    if (f.isInteractable && f.tableId) acc[f.tableId] = (acc[f.tableId] ?? 0) + 1;
    return acc;
  }, {});

  const handleReset = useCallback(() => {
    const state = useGameStore.getState();
    // Rebuild the room's OWN template (roomTemplate, set from room:state's
    // `template` field — see gameStore.ts) rather than always reverting to
    // Main Office regardless of what the room was actually created with.
    // Falls back to 'main-office' for rooms created before templates
    // existed, same as createRoomLayoutFromTemplate's own default.
    const room = createDefaultRoom(state.roomTemplate ?? 'main-office', 'Main Office', state.theme);
    const tileTypes = room.tiles.map((row) => row.map((t) => t.type));
    state.pushTileHistory(tileTypes);
    state.setTiles(room.tiles);
    state.setFurniture(room.furniture);
    state.setZones(room.zones);
  }, []);

  // Palette shown here always matches the room's own theme (set at creation
  // — see Lobby.tsx) — the scifi-office palette never mixes with the
  // modern-interiors one, they're two entirely separate arrays keyed by
  // theme (see themeAssets.ts).
  const theme = useGameStore((s) => s.theme);
  const activePalette = PALETTE_BY_THEME[theme];
  const floorEntries = activePalette.filter((e) => e.category === 'floor');
  const [objectTab, setObjectTab] = useState<'furniture' | 'decor' | 'electronics'>('furniture');
  const objectEntries = activePalette.filter((e) => e.category === objectTab);

  return (
    <div className="absolute top-0 right-0 z-50 w-56 h-full bg-white/95 dark:bg-gray-900/95 backdrop-blur-md border-l border-purple-100 dark:border-gray-700 shadow-2xl p-4 pointer-events-auto overflow-y-auto"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <h3 className="text-gray-900 dark:text-gray-100 text-sm font-bold mb-3">Room Editor</h3>

      {/* Visual palette — floor textures */}
      <p className="text-gray-500 dark:text-gray-400 text-[10px] uppercase tracking-wider mb-2">Floor Textures</p>
      <div className="grid grid-cols-5 gap-1.5 mb-4">
        {floorEntries.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setSelectedPaletteId(entry.id)}
            title={entry.label}
            className={`flex items-center justify-center p-1 rounded-lg cursor-pointer transition-all ${
              selectedPaletteId === entry.id ? 'bg-purple-100 ring-2 ring-purple-400' : 'bg-gray-50 dark:bg-gray-800 hover:bg-purple-50 dark:hover:bg-gray-700'
            }`}
          >
            <PaletteThumb entry={entry} />
          </button>
        ))}
      </div>

      {/* Visual palette — furniture/decor/electronics, split into tabs so
          the growing list of curated pieces doesn't become one long
          undifferentiated scroll. */}
      <p className="text-gray-500 dark:text-gray-400 text-[10px] uppercase tracking-wider mb-2">Objects</p>
      <div className="flex gap-1 mb-2">
        {(['furniture', 'decor', 'electronics'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setObjectTab(tab)}
            className={`flex-1 py-1 rounded-md text-[10px] font-medium capitalize transition-all cursor-pointer ${
              objectTab === tab ? 'bg-purple-600 text-white' : 'bg-purple-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-purple-100 dark:hover:bg-gray-600'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-1.5 mb-4">
        {objectEntries.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setSelectedPaletteId(entry.id)}
            title={`${entry.label} (${entry.tilesW}x${entry.tilesH})`}
            className={`flex items-center justify-center p-1 rounded-lg cursor-pointer transition-all ${
              selectedPaletteId === entry.id ? 'bg-purple-100 ring-2 ring-purple-400' : 'bg-gray-50 dark:bg-gray-800 hover:bg-purple-50 dark:hover:bg-gray-700'
            }`}
          >
            <PaletteThumb entry={entry} />
          </button>
        ))}
      </div>

      <p className="text-gray-400 dark:text-gray-500 text-[10px] mb-3 leading-relaxed">
        Click to place • Right-click to erase. Objects are stamped in one click at the tile you click (its base), taller pieces extend upward and let you walk behind them. Chairs can be sat in (SPACE) once placed.
      </p>

      {/* Table grouping — chairs placed while a table is active share its id and
          become one private audio/video group once 2+ people sit (like a zone). */}
      <div className="mb-3 rounded-lg bg-purple-50/60 dark:bg-gray-800 p-2">
        <p className="text-gray-500 dark:text-gray-400 text-[10px] uppercase tracking-wider mb-1.5">Meja (grup kursi)</p>
        <input
          value={activeTableId ?? ''}
          onChange={(e) => setActiveTableId(e.target.value.trim() || undefined)}
          placeholder="mis. meja-1  (kosong = tanpa meja)"
          maxLength={40}
          className="w-full bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-xs rounded px-2 py-1 outline-none border border-purple-100 dark:border-gray-600 focus:border-purple-500"
        />
        {Object.keys(tableCounts).length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {Object.entries(tableCounts).map(([id, n]) => (
              <button
                key={id}
                onClick={() => setActiveTableId(id)}
                title={`${n} kursi — klik untuk lanjut menaruh kursi di meja ini`}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium cursor-pointer ${
                  activeTableId === id ? 'bg-purple-600 text-white' : 'bg-purple-100 dark:bg-gray-700 text-purple-700 dark:text-purple-300 hover:bg-purple-200 dark:hover:bg-gray-600'
                }`}
              >
                {id} · {n}
              </button>
            ))}
          </div>
        )}
        <p className="text-gray-400 dark:text-gray-500 text-[10px] mt-1.5 leading-relaxed">
          Kursi yang ditaruh saat kolom ini terisi masuk meja yang sama → jadi grup audio/video privat begitu 2+ orang duduk. Kosongkan untuk kursi biasa.
        </p>
      </div>

      <hr className="border-purple-100 dark:border-gray-700 my-3" />

      {/* Basic collision types */}
      <p className="text-gray-500 dark:text-gray-400 text-[10px] uppercase tracking-wider mb-2">Basic Types (collision only)</p>
      <div className="space-y-1 mb-4">
        {BASIC_TYPES.map((t) => (
          <button
            key={t.type}
            onClick={() => setSelected(t.type)}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              !selectedPaletteId && selected === t.type
                ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 border border-purple-300 dark:border-purple-700'
                : 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 border border-transparent'
            }`}
          >
            <span className="w-4 h-4 rounded" style={{ backgroundColor: t.color }} />
            {t.label}
          </button>
        ))}
      </div>

      <hr className="border-purple-100 dark:border-gray-700 my-3" />

      {/* Private zones */}
      <p className="text-gray-500 dark:text-gray-400 text-[10px] uppercase tracking-wider mb-2">Private Zones</p>
      <button
        onClick={toggleZoneDrawMode}
        className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer mb-2 ${
          zoneDrawMode ? 'bg-purple-600 text-white' : 'bg-purple-50 dark:bg-gray-700 text-purple-700 hover:bg-purple-100 dark:hover:bg-gray-600'
        }`}
      >
        <LockFill size={12} /> {zoneDrawMode ? 'Drag on map to draw…' : 'Draw Zone'}
      </button>
      {pendingZoneRect && (
        <ZoneForm rect={pendingZoneRect} onCancel={() => setPendingZoneRect(null)} />
      )}
      {zones.length > 0 && (
        <div className="space-y-1 mb-3">
          {zones.map((z) => (
            <div key={z.id} className="flex items-center justify-between px-2 py-1.5 rounded bg-gray-50 dark:bg-gray-800 text-xs">
              <span className="text-gray-600 dark:text-gray-300 truncate">{z.name}</span>
              <button onClick={() => removeZone(z.id)} className="text-red-500/70 hover:text-red-500 cursor-pointer ml-2"><X size={14} /></button>
            </div>
          ))}
        </div>
      )}
      <p className="text-gray-400 dark:text-gray-500 text-[10px] mb-3 leading-relaxed">
        Players inside a zone only hear/see each other, regardless of distance — great for meeting rooms.
      </p>

      <hr className="border-purple-100 dark:border-gray-700 my-3" />

      {/* Decorative banners/signage */}
      <p className="text-gray-500 dark:text-gray-400 text-[10px] uppercase tracking-wider mb-2">Banners</p>
      <button
        onClick={toggleBannerPlaceMode}
        className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer mb-2 ${
          bannerPlaceMode ? 'bg-purple-600 text-white' : 'bg-purple-50 dark:bg-gray-700 text-purple-700 hover:bg-purple-100 dark:hover:bg-gray-600'
        }`}
      >
        <MegaphoneFill size={12} /> {bannerPlaceMode ? 'Click on map to place…' : 'Add Banner'}
      </button>
      {pendingBannerPos && (
        <BannerForm pos={pendingBannerPos} onCancel={() => setPendingBannerPos(null)} />
      )}
      {banners.length > 0 && (
        <div className="space-y-1 mb-3">
          {banners.map((b) => (
            <div key={b.id} className="flex items-center justify-between px-2 py-1.5 rounded bg-gray-50 dark:bg-gray-800 text-xs">
              <span className="text-gray-600 dark:text-gray-300 truncate">{b.text || b.imageUrl || 'Banner'}</span>
              <button onClick={() => removeFurnitureAt(b.x, b.y)} className="text-red-500/70 hover:text-red-500 cursor-pointer ml-2"><X size={14} /></button>
            </div>
          ))}
        </div>
      )}
      <p className="text-gray-400 dark:text-gray-500 text-[10px] mb-3 leading-relaxed">
        Decorative signage — team name, tagline, announcements. Purely visual, doesn't block movement.
      </p>

      <hr className="border-purple-100 dark:border-gray-700 my-4" />

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
        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-sm transition-colors mb-2 cursor-pointer"
      >
        <SaveFill size={14} /> Save Room
      </button>

      {/* Reset */}
      <button
        onClick={handleReset}
        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-red-100 hover:bg-red-200 text-red-600 text-sm transition-colors cursor-pointer"
      >
        <ArrowClockwise size={14} /> Reset to Default
      </button>
    </div>
  );
}
