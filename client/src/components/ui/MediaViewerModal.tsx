import { useCallback, useEffect, useRef, useState } from 'react';
import { X, TrashFill, Download, EraserFill } from 'react-bootstrap-icons';
import { MapMediaObject, WhiteboardStroke, WHITEBOARD_SIZE } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';

interface MediaViewerModalProps {
  media: MapMediaObject;
  canDelete: boolean;
  onDelete: () => void;
  onClose: () => void;
  emitWhiteboardStroke: (mediaId: string, stroke: WhiteboardStroke) => void;
  emitWhiteboardClear: (mediaId: string) => void;
}

const WHITEBOARD_COLORS = ['#1f2937', '#ef4444', '#3b82f6', '#22c55e', '#f59e0b'];

export function MediaViewerModal({ media, canDelete, onDelete, onClose, emitWhiteboardStroke, emitWhiteboardClear }: MediaViewerModalProps) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-4 max-w-lg w-full mx-4 max-h-[85vh] overflow-y-auto"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-gray-400 dark:text-gray-500 text-xs">Added by {media.createdByName}</span>
          <div className="flex items-center gap-2">
            {canDelete && (
              <button onClick={onDelete} title="Remove" className="text-red-400 hover:text-red-600 cursor-pointer">
                <TrashFill size={14} />
              </button>
            )}
            <button onClick={onClose} title="Close" className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 cursor-pointer">
              <X size={18} />
            </button>
          </div>
        </div>

        {media.type === 'image' && (
          <img src={media.payload.url} alt="" className="w-full max-h-[70vh] object-contain rounded-lg" />
        )}

        {media.type === 'youtube' && (
          <div className="aspect-video w-full">
            <iframe
              src={`https://www.youtube.com/embed/${media.payload.videoId}`}
              className="w-full h-full rounded-lg"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        )}

        {media.type === 'file' && (
          <a
            href={media.payload.url}
            download={media.payload.fileName}
            className="flex items-center justify-center gap-2 py-6 rounded-lg bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-gray-600 text-sm font-medium"
          >
            <Download size={16} /> Download {media.payload.fileName || 'file'}
          </a>
        )}

        {media.type === 'whiteboard' && (
          <WhiteboardCanvas
            media={media}
            canClear={canDelete}
            onStroke={(stroke) => {
              useGameStore.getState().appendWhiteboardStroke(media.id, stroke);
              emitWhiteboardStroke(media.id, stroke);
            }}
            onClear={() => emitWhiteboardClear(media.id)}
          />
        )}
      </div>
    </div>
  );
}

function WhiteboardCanvas({
  media,
  canClear,
  onStroke,
  onClear,
}: {
  media: MapMediaObject;
  canClear: boolean;
  onStroke: (stroke: WhiteboardStroke) => void;
  onClear: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const currentPointsRef = useRef<{ x: number; y: number }[]>([]);
  const [color, setColor] = useState(WHITEBOARD_COLORS[0]);

  const paintStroke = (ctx: CanvasRenderingContext2D, stroke: { points: { x: number; y: number }[]; color: string; width: number }) => {
    if (stroke.points.length < 2) return;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    ctx.stroke();
  };

  const redraw = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, WHITEBOARD_SIZE, WHITEBOARD_SIZE);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WHITEBOARD_SIZE, WHITEBOARD_SIZE);
    for (const stroke of media.payload.strokes ?? []) paintStroke(ctx, stroke);
    // Repaint my own in-progress (uncommitted) stroke on top — otherwise an
    // incoming stroke from someone else drawing at the same time would wipe
    // it, since redraw() only knows about strokes already in the array.
    if (drawingRef.current && currentPointsRef.current.length >= 2) {
      paintStroke(ctx, { points: currentPointsRef.current, color, width: 3 });
    }
  }, [media.payload.strokes, color]);

  useEffect(() => { redraw(); }, [redraw]);

  const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (WHITEBOARD_SIZE / rect.width),
      y: (e.clientY - rect.top) * (WHITEBOARD_SIZE / rect.height),
    };
  };

  const handleDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    drawingRef.current = true;
    currentPointsRef.current = [getPos(e)];
  };

  const handleMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    currentPointsRef.current.push(getPos(e));
    const ctx = canvasRef.current?.getContext('2d');
    const pts = currentPointsRef.current;
    if (ctx && pts.length >= 2) {
      paintStroke(ctx, { points: pts.slice(-2), color, width: 3 });
    }
  };

  const handleUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (currentPointsRef.current.length >= 2) {
      onStroke({ points: currentPointsRef.current, color, width: 3 });
    }
    currentPointsRef.current = [];
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        id="whiteboard-canvas"
        width={WHITEBOARD_SIZE}
        height={WHITEBOARD_SIZE}
        onMouseDown={handleDown}
        onMouseMove={handleMove}
        onMouseUp={handleUp}
        onMouseLeave={handleUp}
        className="border border-gray-200 dark:border-gray-600 rounded-lg cursor-crosshair touch-none w-full"
        style={{ aspectRatio: '1 / 1' }}
      />
      <div className="flex items-center gap-2 mt-2">
        {WHITEBOARD_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            style={{ backgroundColor: c }}
            className={`w-6 h-6 rounded-full border-2 cursor-pointer ${color === c ? 'border-purple-600' : 'border-white shadow'}`}
          />
        ))}
        {canClear && (
          <button onClick={onClear} className="ml-auto flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-red-500 cursor-pointer">
            <EraserFill size={12} /> Clear
          </button>
        )}
      </div>
    </div>
  );
}
