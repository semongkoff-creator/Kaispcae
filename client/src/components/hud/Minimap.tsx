import { useRef, useEffect, useState } from 'react';
import { Avatar, RoomTile, TILE_SIZE, MAP_WIDTH, MAP_HEIGHT } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';

interface MinimapProps {
  players: Avatar[];
  localPlayerId: string;
  onTeleport: (x: number, y: number) => void;
  visible: boolean;
}

const MM_W = 150;
const MM_H = 100;
const SCALE_X = MM_W / (MAP_WIDTH * TILE_SIZE);
const SCALE_Y = MM_H / (MAP_HEIGHT * TILE_SIZE);

// Minimap tile colors — only the shapes that make the room readable as a
// floor plan at this scale (walls/doors); everything else just shows the
// floor tint underneath, same as the real room editor's collision model
// (BLOCKED_TILES) but simplified to what's visible at 5px/tile.
const MM_WALL = 'rgba(76,29,149,0.85)';
const MM_DOOR = 'rgba(167,139,250,0.9)';
const MM_DESK_CHAIR = 'rgba(124,58,237,0.4)';

function drawTileType(ctx: CanvasRenderingContext2D, type: RoomTile['type'], x: number, y: number, w: number, h: number) {
  switch (type) {
    case 'wall':
      ctx.fillStyle = MM_WALL;
      ctx.fillRect(x, y, w, h);
      break;
    case 'door':
      ctx.fillStyle = MM_DOOR;
      ctx.fillRect(x, y, w, h);
      break;
    case 'desk':
    case 'chair':
      ctx.fillStyle = MM_DESK_CHAIR;
      ctx.fillRect(x, y, w, h);
      break;
    default:
      break; // floor/portal/spawn — just the background tint shows through
  }
}

export function Minimap({ players, localPlayerId, onTeleport, visible }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tiles = useGameStore((s) => s.tiles);
  // Faded out (just a subtle presence) until hovered, then fades in to full
  // opacity — a permanently-opaque floor plan sitting over the game world
  // reads as visual clutter once you're not actively using it to navigate.
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = MM_W * dpr;
    canvas.height = MM_H * dpr;
    canvas.style.width = `${MM_W}px`;
    canvas.style.height = `${MM_H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // A near-white 0.85-alpha fill reads as "blank/broken box" rather than
    // "a minimap" at a glance, especially with 0-1 player dots on it and a
    // border faint enough (0.25 alpha) to disappear against the white HUD
    // elements around it — give it a light purple tint and a firmer border
    // so it reads as its own distinct panel instead of fusing visually with
    // whatever white UI happens to sit next to it.
    ctx.fillStyle = 'rgba(237,233,254,0.9)';
    ctx.fillRect(0, 0, MM_W, MM_H);

    // Actual floor plan — walls/doors/desks/chairs, scaled down from the
    // room's real tile grid. This was missing entirely before: the minimap
    // only ever drew the background tint + player dots, so it always read
    // as a blank panel no matter which room you were in.
    const cellW = MM_W / MAP_WIDTH;
    const cellH = MM_H / MAP_HEIGHT;
    for (let ty = 0; ty < tiles.length; ty++) {
      const row = tiles[ty];
      if (!row) continue;
      for (let tx = 0; tx < row.length; tx++) {
        const tile = row[tx];
        if (!tile) continue;
        drawTileType(ctx, tile.type, tx * cellW, ty * cellH, cellW, cellH);
      }
    }

    ctx.strokeStyle = 'rgba(124,58,237,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(1, 1, MM_W - 2, MM_H - 2);

    for (const p of players) {
      const mx = p.x * SCALE_X;
      const my = p.y * SCALE_Y;
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
  }, [players, localPlayerId]);

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
    onTeleport(clickX / SCALE_X, clickY / SCALE_Y);
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
