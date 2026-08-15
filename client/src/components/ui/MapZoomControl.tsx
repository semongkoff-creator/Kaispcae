import { useGameStore, MIN_MAP_ZOOM, MAX_MAP_ZOOM } from '@/stores/gameStore';
import { hasFeatureAccess } from '@kaispace/shared';
import { Tooltip } from '@/components/ui/Tooltip';

// Camera zoom for the main game view (GameCanvas.tsx) — purely a local
// rendering preference, read/written via gameStore's mapZoom so GameCanvas
// picks up a change on the very next animation frame. Does not touch
// collision/movement math (still world/tile units regardless of zoom), so
// unlike TILE_SIZE this is safe to be a per-client-only preference.
export function MapZoomControl() {
  const zoom = useGameStore((s) => s.mapZoom);
  const stepMapZoom = useGameStore((s) => s.stepMapZoom);
  const setMapZoom = useGameStore((s) => s.setMapZoom);
  const localRole = useGameStore((s) => s.localRole);
  // QA (Batas hak full-view) — a non-admin's real floor is clamped one grid
  // step above MIN_MAP_ZOOM (see gameStore.ts's clampMapZoom) so they never
  // reach Overview mode. Mirrored here purely so the "-" button visibly
  // disables AT that real floor, instead of staying clickable-but-inert.
  const effectiveMinZoom = hasFeatureAccess(localRole, 'presence:full_view') ? MIN_MAP_ZOOM : MIN_MAP_ZOOM + 0.1;

  return (
    <div className="flex items-center gap-0.5 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-100 dark:border-gray-700 shadow-sm rounded-lg px-1.5 py-2">
      <Tooltip label="Perkecil Peta" detail="Atur seberapa dekat tampilan peta.">
        <button
          onClick={() => stepMapZoom(-1)}
          disabled={zoom <= effectiveMinZoom}
          className="w-4 h-4 flex items-center justify-center rounded hover:bg-purple-50 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed text-gray-600 dark:text-gray-300 text-xs font-bold leading-none cursor-pointer"
        >
          −
        </button>
      </Tooltip>
      <Tooltip label="Ukuran 100%" detail="Kembalikan tampilan peta ke ukuran normal.">
        <button
          onClick={() => setMapZoom(1)}
          className="text-[10px] text-gray-600 dark:text-gray-300 w-8 text-center tabular-nums cursor-pointer hover:underline"
        >
          {Math.round(zoom * 100)}%
        </button>
      </Tooltip>
      <Tooltip label="Perbesar Peta" detail="Atur seberapa dekat tampilan peta.">
        <button
          onClick={() => stepMapZoom(1)}
          disabled={zoom >= MAX_MAP_ZOOM}
          className="w-4 h-4 flex items-center justify-center rounded hover:bg-purple-50 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed text-gray-600 dark:text-gray-300 text-xs font-bold leading-none cursor-pointer"
        >
          +
        </button>
      </Tooltip>
    </div>
  );
}
