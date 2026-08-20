import { useRef, useEffect, useState } from 'react';
import { Avatar, TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, roleAtLeast } from '@kaispace/shared';
import { useGameStore } from '@/stores/gameStore';
import { drawMiniTileType, drawMiniZoneBackground, MINI_FURNITURE, MINI_WALL_AREA } from '@/components/canvas/miniRender';

interface MinimapProps {
  players: Avatar[];
  localPlayerId: string;
  onTeleport: (x: number, y: number) => void;
  visible: boolean;
}

const MM_W = 150;
const MM_H = 100;

export function Minimap({ players, localPlayerId, onTeleport, visible }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The floor plan, rendered ONCE per map change into an offscreen canvas.
  //
  // This all used to live in a single effect whose deps included `players` —
  // and `players` arrives from App as Object.values(allPlayers), a brand-new
  // array on every App render. App re-renders up to five times a second from
  // the proximity tick alone (anyone moving near you changes it), so the
  // ENTIRE minimap was being rebuilt at that rate: the canvas backing store
  // reallocated, every zone filled, every furniture piece filled, and a nested
  // loop over EVERY TILE IN THE ROOM — tens of thousands of fills in a large
  // office. Redrawing player dots must not cost the floor plan they sit on.
  const staticLayerRef = useRef<HTMLCanvasElement | null>(null);
  // Bumped when the floor plan is rebuilt, purely so the dot pass below runs
  // again against the new layer instead of blitting a stale one.
  const [staticVersion, setStaticVersion] = useState(0);
  const tiles = useGameStore((s) => s.tiles);
  const furniture = useGameStore((s) => s.furniture);
  const wallAreaRects = useGameStore((s) => s.wallAreaRects);
  const zones = useGameStore((s) => s.zones);
  const localRole = useGameStore((s) => s.localRole);
  // QA follow-up — MAP_WIDTH/MAP_HEIGHT are only the default grid size; a
  // resized room (Room Editor's Resize tool, up to 200x200) is bigger than
  // that. These used to be MODULE-level constants derived from the fixed
  // default, so a resized room's floor plan drew at the wrong scale
  // (overflowing this fixed 150x100 canvas) AND click-to-teleport could
  // never target anywhere past the old default edge — same root cause as
  // GameCanvas.tsx's Overview/pathfinding fixes. Now derived per-render from
  // the actually-loaded `tiles` array, the same source of truth used there.
  const mapCols = tiles[0]?.length || MAP_WIDTH;
  const mapRows = tiles.length || MAP_HEIGHT;
  const scaleX = MM_W / (mapCols * TILE_SIZE);
  const scaleY = MM_H / (mapRows * TILE_SIZE);
  // Faded out (just a subtle presence) until hovered, then fades in to full
  // opacity — a permanently-opaque floor plan sitting over the game world
  // reads as visual clutter once you're not actively using it to navigate.
  const [isHovered, setIsHovered] = useState(false);

  // ── Floor plan: rebuilt only when the ROOM changes ────────────────────
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const off = staticLayerRef.current ?? document.createElement('canvas');
    staticLayerRef.current = off;
    off.width = MM_W * dpr;
    off.height = MM_H * dpr;
    const ctx = off.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // A near-white 0.85-alpha fill reads as "blank/broken box" rather than
    // "a minimap" at a glance, especially with 0-1 player dots on it and a
    // border faint enough (0.25 alpha) to disappear against the white HUD
    // elements around it — give it a light purple tint and a firmer border
    // so it reads as its own distinct panel instead of fusing visually with
    // whatever white UI happens to sit next to it.
    ctx.fillStyle = 'rgba(237,233,254,0.9)';
    ctx.fillRect(0, 0, MM_W, MM_H);

    const cellW = MM_W / mapCols;
    const cellH = MM_H / mapRows;

    // Per-zone background tint, drawn first so rooms read as visually
    // distinct areas (Gather.town-style) instead of one flat color —
    // same reasoning as GameCanvas.tsx's Overview mode, which mirrors this.
    for (const zone of zones) {
      drawMiniZoneBackground(ctx, zone, zone.x * cellW, zone.y * cellH, zone.width * cellW, zone.height * cellH);
    }

    // Actual floor plan — walls/doors/desks/chairs, scaled down from the
    // room's real tile grid. This was missing entirely before: the minimap
    // only ever drew the background tint + player dots, so it always read
    // as a blank panel no matter which room you were in.
    for (let ty = 0; ty < tiles.length; ty++) {
      const row = tiles[ty];
      if (!row) continue;
      for (let tx = 0; tx < row.length; tx++) {
        const tile = row[tx];
        if (!tile) continue;
        drawMiniTileType(ctx, tile.type, tx * cellW, ty * cellH, cellW, cellH);
      }
    }

    // Furniture — any piece (desks, chairs, custom Object walls/partitions),
    // not just the legacy TILE-type desk/chair drawn above. Anchored at its
    // bottom-left tile per Furniture's own doc comment, so the block spans
    // upward `tilesH` rows from `y`.
    for (const item of furniture) {
      if (item.kind === 'banner') continue;
      ctx.fillStyle = MINI_FURNITURE;
      ctx.fillRect(item.x * cellW, (item.y - item.tilesH + 1) * cellH, item.tilesW * cellW, item.tilesH * cellH);
    }

    // Room Editor's "Wall Area" tool — pixel-space rects, scaled with the
    // same scaleX/scaleY the player dots below already use.
    for (const rect of wallAreaRects) {
      ctx.fillStyle = MINI_WALL_AREA;
      ctx.fillRect(rect.x * scaleX, rect.y * scaleY, rect.w * scaleX, rect.h * scaleY);
    }

    ctx.strokeStyle = 'rgba(124,58,237,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(1, 1, MM_W - 2, MM_H - 2);

    setStaticVersion((v) => v + 1);
    // Deliberately NOT depending on `players` (or anything derived from an App
    // render) — see staticLayerRef's comment.
  }, [tiles, furniture, wallAreaRects, zones, mapCols, mapRows, scaleX, scaleY]);

  // ── Player dots: the only thing that redraws when people move ─────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    // Assigning canvas.width reallocates the backing store and clears it, so
    // it must only happen when the size actually changed — this pass runs
    // every time anyone moves.
    if (canvas.width !== MM_W * dpr || canvas.height !== MM_H * dpr) {
      canvas.width = MM_W * dpr;
      canvas.height = MM_H * dpr;
      canvas.style.width = `${MM_W}px`;
      canvas.style.height = `${MM_H}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const floorPlan = staticLayerRef.current;
    if (floorPlan) ctx.drawImage(floorPlan, 0, 0, MM_W, MM_H);
    else ctx.clearRect(0, 0, MM_W, MM_H);

    // "Hide myself" (Avatar.hidden) — same rule as GameCanvas.tsx's own
    // avatar draw loop: admin+ still sees the dot, everyone else doesn't.
    const canSeeHidden = roleAtLeast(localRole, 'admin');
    for (const p of players) {
      if (p.hidden && p.id !== localPlayerId && !canSeeHidden) continue;
      const mx = p.x * scaleX;
      const my = p.y * scaleY;
      const isLocal = p.id === localPlayerId;

      ctx.beginPath();
      ctx.arc(mx, my, isLocal ? 3 : 2, 0, Math.PI * 2);
      ctx.fillStyle = isLocal ? '#7c3aed' : p.color;
      ctx.fill();
      if (isLocal) {
        ctx.strokeStyle = 'rgba(76,29,149,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    // A blit plus one arc per player — the floor plan underneath is reused.
  }, [players, localPlayerId, localRole, scaleX, scaleY, staticVersion]);

  const handleClick = (e: React.MouseEvent) => {
    // Belt-and-suspenders — you can't actually click this without the mouse
    // having entered it first (which already set isHovered), but guarding
    // here too means the "must hover before it's interactive" rule holds
    // even if a click somehow fires without a prior mouseenter.
    if (!isHovered) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const clickX = (e.clientX - rect.left) / rect.width * MM_W;
    const clickY = (e.clientY - rect.top) / rect.height * MM_H;
    onTeleport(clickX / scaleX, clickY / scaleY);
  };

  if (!visible) return null;

  return (
    // Stacked directly above the collapsed Chat button (bottom-4 right-4),
    // right-aligned with it and with a clear gap — not beside it, where its
    // near-white background used to visually fuse with the button into what
    // looked like one big blank panel.
    <div
      className="absolute bottom-16 right-4 z-30"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        className={`rounded-lg border border-purple-200 dark:border-gray-600 shadow-sm transition-opacity duration-200 ${
          isHovered ? 'opacity-100 cursor-crosshair' : 'opacity-30 cursor-default'
        }`}
      />
    </div>
  );
}
