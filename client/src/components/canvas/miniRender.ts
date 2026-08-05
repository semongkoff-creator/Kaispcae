import { RoomTile } from '@virtualmeet/shared';

// Shared flat-color "floor plan" palette — walls/doors/desks/chairs as plain
// blocks, no pixel-art sprites. Single source for both Minimap.tsx (the
// small corner panel) and GameCanvas.tsx's Overview mode (the full-screen
// zoomed-out view), so the two can never drift into looking like different
// renderers for the same room — the whole point of Overview mode matching
// the minimap the user already knows how to read.
export const MINI_WALL = 'rgba(76,29,149,0.85)';
export const MINI_DOOR = 'rgba(167,139,250,0.9)';
export const MINI_DESK_CHAIR = 'rgba(124,58,237,0.4)';
export const MINI_FURNITURE = 'rgba(124,58,237,0.35)';
export const MINI_WALL_AREA = 'rgba(55,65,81,0.85)';

export function drawMiniTileType(ctx: CanvasRenderingContext2D, type: RoomTile['type'], x: number, y: number, w: number, h: number) {
  switch (type) {
    case 'wall':
      ctx.fillStyle = MINI_WALL;
      ctx.fillRect(x, y, w, h);
      break;
    case 'door':
      ctx.fillStyle = MINI_DOOR;
      ctx.fillRect(x, y, w, h);
      break;
    case 'desk':
    case 'chair':
      ctx.fillStyle = MINI_DESK_CHAIR;
      ctx.fillRect(x, y, w, h);
      break;
    default:
      break; // floor/portal/spawn — just the background tint shows through
  }
}
