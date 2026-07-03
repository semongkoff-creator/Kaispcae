import { useRef, useEffect } from 'react';
import { Avatar, TILE_SIZE, MAP_WIDTH, MAP_HEIGHT } from '@virtualmeet/shared';

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

export function Minimap({ players, localPlayerId, onTeleport, visible }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, MM_W, MM_H);

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(1, 1, MM_W - 2, MM_H - 2);

    for (const p of players) {
      const mx = p.x * SCALE_X;
      const my = p.y * SCALE_Y;
      const isLocal = p.id === localPlayerId;

      ctx.beginPath();
      ctx.arc(mx, my, isLocal ? 3 : 2, 0, Math.PI * 2);
      ctx.fillStyle = isLocal ? '#fff' : p.color;
      ctx.fill();
      if (isLocal) {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }, [players, localPlayerId]);

  const handleClick = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const clickX = (e.clientX - rect.left) / rect.width * MM_W;
    const clickY = (e.clientY - rect.top) / rect.height * MM_H;
    onTeleport(clickX / SCALE_X, clickY / SCALE_Y);
  };

  if (!visible) return null;

  return (
    <div className="absolute bottom-4 right-20 z-30">
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        className="rounded-lg border border-white/10 cursor-crosshair"
      />
    </div>
  );
}
