import { useRef, useEffect, useCallback } from 'react';
import {
  TILE_SIZE,
  MAP_WIDTH,
  MAP_HEIGHT,
  Avatar,
  TileType,
  RoomTile,
} from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { useMovement } from '@/hooks/useMovement';

// Tile type → fill color
const TILE_COLORS: Record<TileType, string> = {
  floor: '#e8d5b0',
  wall: '#4a3728',
  door: '#d4a056',
  desk: '#8B6914',
  chair: '#5b8dd9',
};

// Tiles the player cannot walk on
const BLOCKED_TILES: Set<TileType> = new Set(['wall', 'desk', 'chair']);

const AVATAR_RADIUS = 14;
const GLOW_RADIUS = AVATAR_RADIUS + 4;

/**
 * The main canvas component that renders the 2D virtual space.
 * Owns the requestAnimationFrame game loop, camera/viewport,
 * tile grid, avatar sprites, and local-player input handling.
 */
export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const prevTimeRef = useRef<number>(0);

  const tiles = useGameStore((s) => s.tiles);
  const players = useGameStore((s) => s.players);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const setLocalPlayer = useGameStore((s) => s.setLocalPlayer);

  const isBlocked = useCallback(
    (tileX: number, tileY: number) => {
      if (tileX < 0 || tileX >= MAP_WIDTH || tileY < 0 || tileY >= MAP_HEIGHT) return true;
      if (tiles.length === 0) return false;
      return BLOCKED_TILES.has(tiles[tileY]?.[tileX]?.type);
    },
    [tiles],
  );

  const { update, setPosition } = useMovement({
    isBlocked,
    onMove: (x, y, direction) => {
      setLocalPlayer({ x, y, direction, isMoving: true });
    },
  });

  // Sync the hook's internal position with the store
  useEffect(() => {
    setPosition(localPlayer.x, localPlayer.y);
  }, [localPlayer.x, localPlayer.y, setPosition]);

  // Resize canvas to fill the container
  const resizeCanvas = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  // Draw everything
  const draw = useCallback(
    (timestamp: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Delta time in seconds, capped to avoid spiral-of-death after tab switch
      if (prevTimeRef.current === 0) prevTimeRef.current = timestamp;
      const rawDt = (timestamp - prevTimeRef.current) / 1000;
      const dt = Math.min(rawDt, 0.05); // cap at 50ms
      prevTimeRef.current = timestamp;

      const logicalW = canvas.width / (window.devicePixelRatio || 1);
      const logicalH = canvas.height / (window.devicePixelRatio || 1);

      // --- Update player position from input ---
      const moveResult = update(dt);

      // --- Compute camera offset so local player is centered ---
      const playerX = moveResult.x;
      const playerY = moveResult.y;
      const cameraX = playerX - logicalW / 2;
      const cameraY = playerY - logicalH / 2;

      // --- Clear ---
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, logicalW, logicalH);

      if (tiles.length === 0) {
        ctx.fillStyle = '#888';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Loading room…', logicalW / 2, logicalH / 2);
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // --- Draw tiles (only visible tiles for perf) ---
      const startCol = Math.max(0, Math.floor(cameraX / TILE_SIZE));
      const endCol = Math.min(MAP_WIDTH, Math.ceil((cameraX + logicalW) / TILE_SIZE) + 1);
      const startRow = Math.max(0, Math.floor(cameraY / TILE_SIZE));
      const endRow = Math.min(MAP_HEIGHT, Math.ceil((cameraY + logicalH) / TILE_SIZE) + 1);

      for (let row = startRow; row < endRow; row++) {
        for (let col = startCol; col < endCol; col++) {
          const tile = tiles[row]?.[col];
          if (!tile) continue;

          const screenX = col * TILE_SIZE - cameraX;
          const screenY = row * TILE_SIZE - cameraY;

          ctx.fillStyle = TILE_COLORS[tile.type] || '#e8d5b0';
          ctx.fillRect(screenX, screenY, TILE_SIZE, TILE_SIZE);

          // Subtle grid lines for floor tiles
          if (tile.type === 'floor') {
            ctx.strokeStyle = 'rgba(0,0,0,0.05)';
            ctx.lineWidth = 0.5;
            ctx.strokeRect(screenX, screenY, TILE_SIZE, TILE_SIZE);
          }
        }
      }

      // --- Draw all avatars ---
      const allAvatars: Avatar[] = [
        { ...localPlayer, x: playerX, y: playerY, isMoving: moveResult.isMoving, direction: moveResult.direction },
        ...players,
      ];

      for (const avatar of allAvatars) {
        const screenX = avatar.x - cameraX;
        const screenY = avatar.y - cameraY;

        // Cull off-screen avatars
        if (
          screenX < -AVATAR_RADIUS || screenX > logicalW + AVATAR_RADIUS ||
          screenY < -AVATAR_RADIUS || screenY > logicalH + AVATAR_RADIUS
        ) continue;

        const isLocal = avatar.id === 'local';

        // White glow ring for local player
        if (isLocal) {
          ctx.beginPath();
          ctx.arc(screenX, screenY, GLOW_RADIUS, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
          ctx.fill();

          ctx.beginPath();
          ctx.arc(screenX, screenY, GLOW_RADIUS, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Direction indicator (a small triangle pointing forward)
        const eyeOffset = 6;
        let eyeX = 0, eyeY = 0;
        switch (avatar.direction) {
          case 'up': eyeY = -eyeOffset; break;
          case 'down': eyeY = eyeOffset; break;
          case 'left': eyeX = -eyeOffset; break;
          case 'right': eyeX = eyeOffset; break;
        }

        // Body circle
        ctx.beginPath();
        ctx.arc(screenX, screenY, AVATAR_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = avatar.color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Direction dot
        ctx.beginPath();
        ctx.arc(screenX + eyeX, screenY + eyeY, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();

        // Name label
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        const labelY = screenY - AVATAR_RADIUS - 6;

        // Label background
        const textWidth = ctx.measureText(avatar.name).width;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(screenX - textWidth / 2 - 4, labelY - 12, textWidth + 8, 16);

        // Label text
        ctx.fillStyle = isLocal ? '#ffdd57' : '#ffffff';
        ctx.fillText(avatar.name, screenX, labelY);
      }

      rafRef.current = requestAnimationFrame(draw);
    },
    [tiles, players, localPlayer, update],
  );

  // Set up resize observer and start the game loop
  useEffect(() => {
    resizeCanvas();

    const observer = new ResizeObserver(() => {
      resizeCanvas();
    });

    const container = containerRef.current;
    if (container) observer.observe(container);

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
    };
  }, [draw, resizeCanvas]);

  return (
    <div ref={containerRef} className="w-full h-full absolute inset-0">
      <canvas
        ref={canvasRef}
        className="block"
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  );
}
