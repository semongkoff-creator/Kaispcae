import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, RoomTile, Furniture, Zone, RoomTheme,
  LayerData, legacyToLayerData,
} from '@virtualmeet/shared';
import { api, ApiError } from '@/services/api';
import { useEditorStore, EDITOR_LAYERS, EDITOR_TOOLS, EditorLayer } from '@/stores/editorStore';
import { drawTile, drawFloorTile, drawFurnitureLayer } from '@/components/canvas/mapRender';

// ZEP-style Room Editor — Potong 1 (data-model, view-only). Opened in its own
// tab via ?roomEditor=<slug>. On open, the room is lazily converted to the
// layered format on the server (idempotent + round-trip-verified); this page
// then renders FROM layerData, per layer. Switching the layer tab focuses that
// layer (the rest dims), proving the mapping — still no editing (that's Potong
// 2). Admin is enforced on the server; a 403 shows a clear denial.

type LoadError = 'auth' | 'forbidden' | 'notfound' | 'generic';

function normalizeTiles(tilemapData: unknown[][] | null): RoomTile[][] {
  if (Array.isArray(tilemapData) && tilemapData.length > 0) {
    return tilemapData.map((row, y) =>
      (row as Record<string, unknown>[]).map((t, x) => ({ ...(t as object), x, y, type: (t as { type?: string }).type || 'floor' } as RoomTile)),
    );
  }
  return Array.from({ length: MAP_HEIGHT }, (_, y) =>
    Array.from({ length: MAP_WIDTH }, (_, x) => ({ x, y, type: 'floor' } as RoomTile)),
  );
}

interface EditorData {
  name: string;
  theme: RoomTheme;
  layer: LayerData;
}

// Draw one layer's content in world coordinates (the caller has already applied
// the pan/zoom transform). Used both for the full base pass and to re-draw the
// active layer at full opacity over the dimming veil.
function drawLayer(ctx: CanvasRenderingContext2D, ld: LayerData, theme: RoomTheme, layer: EditorLayer) {
  if (layer === 'floor') {
    for (let y = 0; y < ld.height; y++) {
      for (let x = 0; x < ld.width; x++) {
        drawFloorTile(ctx, { x, y, type: 'floor', floorPaletteId: ld.floor[y]?.[x] ?? undefined }, x * TILE_SIZE, y * TILE_SIZE, theme);
      }
    }
  } else if (layer === 'wall') {
    for (let y = 0; y < ld.height; y++) {
      for (let x = 0; x < ld.width; x++) {
        if (ld.wall[y]?.[x]) drawTile(ctx, 'wall', x * TILE_SIZE, y * TILE_SIZE, theme);
      }
    }
  } else if (layer === 'objects') {
    for (const item of ld.objects) { drawFurnitureLayer(ctx, item, 0, 0, 'object'); drawFurnitureLayer(ctx, item, 0, 0, 'overhead'); }
  } else if (layer === 'top') {
    for (const item of ld.topObjects) { drawFurnitureLayer(ctx, item, 0, 0, 'object'); drawFurnitureLayer(ctx, item, 0, 0, 'overhead'); }
  } else if (layer === 'effects') {
    for (const a of ld.areas) {
      const zx = a.x * TILE_SIZE, zy = a.y * TILE_SIZE, zw = a.width * TILE_SIZE, zh = a.height * TILE_SIZE;
      ctx.fillStyle = 'rgba(59, 130, 246, 0.16)';
      ctx.fillRect(zx, zy, zw, zh);
      ctx.strokeStyle = a.color || 'rgba(59, 130, 246, 0.9)';
      ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.strokeRect(zx, zy, zw, zh); ctx.setLineDash([]);
      if (a.name) { ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = '11px sans-serif'; ctx.fillText(a.name, zx + 4, zy + 14); }
    }
    for (const e of ld.tileEffects) {
      const sx = e.x * TILE_SIZE, sy = e.y * TILE_SIZE, c = TILE_SIZE / 2;
      if (e.kind === 'startingPoint') {
        ctx.fillStyle = 'rgba(16,185,129,0.85)'; ctx.beginPath(); ctx.arc(sx + c, sy + c, c - 3, 0, Math.PI * 2); ctx.fill();
      } else if (e.kind === 'impassable') {
        ctx.strokeStyle = 'rgba(239,68,68,0.8)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx + 4, sy + 4); ctx.lineTo(sx + TILE_SIZE - 4, sy + TILE_SIZE - 4);
        ctx.moveTo(sx + TILE_SIZE - 4, sy + 4); ctx.lineTo(sx + 4, sy + TILE_SIZE - 4); ctx.stroke();
      } else if (e.kind === 'portal') {
        ctx.strokeStyle = 'rgba(124,58,237,0.9)'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(sx + c, sy + c, c - 3, 0, Math.PI * 2); ctx.stroke();
      } else if (e.kind === 'door') {
        ctx.fillStyle = 'rgba(212,160,86,0.8)'; ctx.fillRect(sx + 3, sy + 3, TILE_SIZE - 6, TILE_SIZE - 6);
      }
    }
  }
}

export function RoomEditorPage({ slug }: { slug: string }) {
  const [data, setData] = useState<EditorData | null>(null);
  const [error, setError] = useState<LoadError | null>(null);

  const activeLayer = useEditorStore((s) => s.activeLayer);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);
  const zoomBy = useEditorStore((s) => s.zoomBy);
  const setViewportPan = useEditorStore((s) => s.setPan);
  const setZoom = useEditorStore((s) => s.setZoom);
  const zoom = useEditorStore((s) => s.viewport.zoom);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<EditorData | null>(null);
  const layerRef = useRef<EditorLayer>(activeLayer);
  const spaceHeldRef = useRef(false);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { layerRef.current = activeLayer; }, [activeLayer]);

  // ── Load (server-gated + lazy-converted) ────────────────────────────
  useEffect(() => {
    if (!localStorage.getItem('vm_token')) { setError('auth'); return; }
    let alive = true;
    api.getRoomEditorData(slug)
      .then((r) => {
        if (!alive) return;
        const theme = ((r.theme as RoomTheme) || 'modern-interiors') as RoomTheme;
        const layer = r.layerData
          ?? legacyToLayerData(normalizeTiles(r.tilemapData), (r.furniture as Furniture[]) ?? [], (r.zones as Zone[]) ?? []);
        setData({ name: r.name, theme, layer });
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) setError('auth');
        else if (e instanceof ApiError && e.status === 403) setError('forbidden');
        else if (e instanceof ApiError && e.status === 404) setError('notfound');
        else setError('generic');
      });
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => { document.title = data ? `Editor — ${data.name}` : 'Room Editor'; }, [data]);

  // ── Fit-to-screen once map + container are known ────────────────────
  useEffect(() => {
    if (!data || !wrapRef.current) return;
    const { clientWidth: w, clientHeight: h } = wrapRef.current;
    const mapW = data.layer.width * TILE_SIZE;
    const mapH = data.layer.height * TILE_SIZE;
    const fit = Math.min(w / mapW, h / mapH) * 0.9;
    setZoom(fit);
    setViewportPan((w - mapW * fit) / 2, (h - mapH * fit) / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ── Continuous redraw ───────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      const map = dataRef.current;
      if (canvas && wrap) {
        const dpr = window.devicePixelRatio || 1;
        const w = wrap.clientWidth, h = wrap.clientHeight;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
          canvas.width = w * dpr; canvas.height = h * dpr;
          canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = '#12151c';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          if (map) {
            const { panX, panY, zoom: z } = useEditorStore.getState().viewport;
            ctx.imageSmoothingEnabled = false;
            ctx.setTransform(z * dpr, 0, 0, z * dpr, panX * dpr, panY * dpr);
            const ld = map.layer;
            const theme = map.theme;
            // Full base pass (all layers, natural order).
            drawLayer(ctx, ld, theme, 'floor');
            drawLayer(ctx, ld, theme, 'wall');
            drawLayer(ctx, ld, theme, 'objects');
            drawLayer(ctx, ld, theme, 'top');
            drawLayer(ctx, ld, theme, 'effects');
            // Dim everything, then re-draw ONLY the active layer on top so it
            // "pops" — this is how switching layer tabs reads as focusing a
            // layer (view-only in Potong 1).
            ctx.fillStyle = 'rgba(10, 12, 18, 0.55)';
            ctx.fillRect(0, 0, ld.width * TILE_SIZE, ld.height * TILE_SIZE);
            drawLayer(ctx, ld, theme, layerRef.current);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Space = temporary Hand (pan) ─────────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeldRef.current = true; };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeldRef.current = false; };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  // ── Wheel zoom ───────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const canPan = activeTool === 'hand' || spaceHeldRef.current;
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (activeTool !== 'hand' && !spaceHeldRef.current) return;
    dragRef.current = { x: e.clientX, y: e.clientY };
  }, [activeTool]);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const start = dragRef.current;
    if (!start) return;
    useEditorStore.getState().panBy(e.clientX - start.x, e.clientY - start.y);
    dragRef.current = { x: e.clientX, y: e.clientY };
  }, []);
  const endDrag = useCallback(() => { dragRef.current = null; }, []);

  if (error) {
    const msg =
      error === 'auth' ? 'Kamu harus login dulu untuk membuka editor.'
      : error === 'forbidden' ? 'Akses ditolak — hanya admin room ini yang boleh membuka editor.'
      : error === 'notfound' ? 'Room tidak ditemukan.'
      : 'Gagal memuat editor.';
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-gray-900 text-center px-6">
        <div>
          <p className="text-white text-lg font-semibold mb-1">Room Editor</p>
          <p className="text-white/60 text-sm">{msg}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-gray-900 text-gray-100 select-none">
      <div className="shrink-0 flex items-center gap-4 px-4 h-12 border-b border-white/10 bg-gray-950/60">
        <span className="text-sm font-semibold text-white/90 truncate max-w-[220px]">{data ? data.name : 'Memuat…'}</span>
        <div className="flex items-center gap-1">
          {EDITOR_LAYERS.map((l) => (
            <button
              key={l.id}
              onClick={() => setActiveLayer(l.id)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${activeLayer === l.id ? 'bg-purple-600 text-white' : 'text-white/60 hover:bg-white/10'}`}
            >
              {l.label}
            </button>
          ))}
        </div>
        <div className="w-px h-6 bg-white/10" />
        <div className="flex items-center gap-1">
          {EDITOR_TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTool(t.id)}
              title={t.id === 'hand' ? 'Hand — geser pandangan (aktif)' : `${t.label} (segera)`}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${activeTool === t.id ? 'bg-purple-600 text-white' : 'text-white/60 hover:bg-white/10'} ${t.id !== 'hand' ? 'opacity-60' : ''}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => zoomBy(1 / 1.2)} className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 cursor-pointer">−</button>
          <span className="text-xs text-white/60 w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button onClick={() => zoomBy(1.2)} className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 cursor-pointer">+</button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div
          ref={wrapRef}
          className="flex-1 min-w-0 relative overflow-hidden"
          style={{ cursor: canPan ? (dragRef.current ? 'grabbing' : 'grab') : 'default' }}
        >
          <canvas ref={canvasRef} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={endDrag} onMouseLeave={endDrag} className="block" />
          <div className="absolute bottom-3 left-3 text-[11px] text-white/40 pointer-events-none">
            Layer aktif: <span className="text-white/70">{EDITOR_LAYERS.find((l) => l.id === activeLayer)?.label}</span> · Hand: drag/scroll · view-only (Potong 1)
          </div>
        </div>

        <div className="shrink-0 w-64 border-l border-white/10 bg-gray-950/60 p-4">
          <p className="text-xs uppercase tracking-wider text-white/40 mb-2">{EDITOR_LAYERS.find((l) => l.id === activeLayer)?.label}</p>
          <p className="text-white/50 text-sm">Panel properti/palette akan muncul di sini pada potongan berikutnya.</p>
        </div>
      </div>
    </div>
  );
}
