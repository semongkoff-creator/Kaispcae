import { useGameStore, MIN_MAP_ZOOM, MAX_MAP_ZOOM } from '@/stores/gameStore';

// Camera zoom for the main game view (GameCanvas.tsx) — purely a local
// rendering preference, read/written via gameStore's mapZoom so GameCanvas
// picks up a change on the very next animation frame. Does not touch
// collision/movement math (still world/tile units regardless of zoom), so
// unlike TILE_SIZE this is safe to be a per-client-only preference.
export function MapZoomControl() {
  const zoom = useGameStore((s) => s.mapZoom);
  const zoomMapBy = useGameStore((s) => s.zoomMapBy);
  const setMapZoom = useGameStore((s) => s.setMapZoom);

  return (
    <div className="flex items-center gap-1 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-100 dark:border-gray-700 shadow-sm rounded-lg px-1.5 py-2">
      <button
        onClick={() => zoomMapBy(1 / 1.2)}
        disabled={zoom <= MIN_MAP_ZOOM}
        title="Zoom out"
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-purple-50 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed text-gray-600 dark:text-gray-300 text-sm font-bold cursor-pointer"
      >
        −
      </button>
      <button
        onClick={() => setMapZoom(1)}
        title="Reset zoom to 100%"
        className="text-[11px] text-gray-600 dark:text-gray-300 w-10 text-center tabular-nums cursor-pointer hover:underline"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        onClick={() => zoomMapBy(1.2)}
        disabled={zoom >= MAX_MAP_ZOOM}
        title="Zoom in"
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-purple-50 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed text-gray-600 dark:text-gray-300 text-sm font-bold cursor-pointer"
      >
        +
      </button>
    </div>
  );
}
