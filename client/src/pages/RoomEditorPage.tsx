import { useCallback, useEffect, useRef, useState } from 'react';
import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, RoomTile, Furniture, Zone, RoomTheme } from '@virtualmeet/shared';
import { api, ApiError } from '@/services/api';
import { useEditorStore, EDITOR_LAYERS, EDITOR_TOOLS } from '@/stores/editorStore';
import { drawTile, drawFloorTile, drawFurnitureLayer } from '@/components/canvas/mapRender';

// ZEP-style Room Editor — Potong 0 (foundation, view-only). Opened in its own
// browser tab via ?roomEditor=<slug>. Renders the room's saved map exactly as
// the game view does (reusing mapRender helpers) with the only interaction being
// Hand pan + zoom. Toolbar (layer tabs + tools) and the right panel are
// structural skeletons wired to editorStore, ready for later potongan to fill —
// they don't edit anything yet. Admin is enforced on the server (editor-data
// endpoint returns 403 for non-admins); this page surfaces that clearly.

interface MapData {
  name: string;
  theme: RoomTheme;
  tiles: RoomTile[][];
  furniture: Furniture[];
  zones: Zone[];
}

type LoadError = 'auth' | 'forbidden' | 'notfound' | 'generic';

function normalizeTiles(tilemapData: unknown[][] | null): RoomTile[][] {
  if (Array.isArray(tilemapData) && tilemapData.length > 0) {
    return tilemapData.map((row, y) =>
      (row as Record<string, unknown>[]).map((t, x) => ({ ...(t as object), x, y, type: (t as { type?: string }).type || 'floor' } as RoomTile)),
    );
  }
  // No saved map → a plain floor grid so the canvas isn't blank.
  return Array.from({ length: MAP_HEIGHT }, (_, y) =>
    Array.from({ length: MAP_WIDTH }, (_, x) => ({ x, y, type: 'floor' } as RoomTile)),
  );
}

export function RoomEditorPage({ slug }: { slug: string }) {
  const [data, setData] = useState<MapData | null>(null);
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
  const dataRef = useRef<MapData | null>(null);
  const spaceHeldRef = useRef(false);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => { dataRef.current = data; }, [data]);

  // ── Load (server-gated) ────────────────────────────────────────────
  useEffect(() => {
    if (!localStorage.getItem('vm_token')) { setError('auth'); return; }
    let alive = true;
    api.getRoomEditorData(slug)
      .then((r) => {
        if (!alive) return;
        setData({
          name: r.name,
          theme: (r.theme as RoomTheme) || 'modern-interiors',
          tiles: normalizeTiles(r.tilemapData),
          furniture: (r.furniture as Furniture[]) ?? [],
          zones: (r.zones as Zone[]) ?? [],
        });
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

  // ── Fit-to-screen once the map + container are known ────────────────
  useEffect(() => {
    if (!data || !wrapRef.current) return;
    const rows = data.tiles.length;
    const cols = data.tiles[0]?.length ?? MAP_WIDTH;
    const { clientWidth: w, clientHeight: h } = wrapRef.current;
    const mapW = cols * TILE_SIZE;
    const mapH = rows * TILE_SIZE;
    const fit = Math.min(w / mapW, h / mapH) * 0.9;
    setZoom(fit);
    setViewportPan((w - mapW * fit) / 2, (h - mapH * fit) / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ── Continuous redraw (so async-loaded sprites appear + pan/zoom is smooth) ──
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      const map = dataRef.current;
      if (canvas && wrap) {
        const dpr = window.devicePixelRatio || 1;
        const w = wrap.clientWidth;
        const h = wrap.clientHeight;
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
            const theme = map.theme;
            for (let row = 0; row < map.tiles.length; row++) {
              const tr = map.tiles[row];
              for (let col = 0; col < tr.length; col++) {
                const tile = tr[col];
                if (!tile) continue;
                const sx = col * TILE_SIZE;
                const sy = row * TILE_SIZE;
                drawFloorTile(ctx, tile, sx, sy, theme);
                if (tile.type !== 'floor' && tile.type !== 'portal' && tile.type !== 'spawn') {
                  drawTile(ctx, tile.type, sx, sy, theme);
                }
              }
            }
            // Furniture: object row, then overhead (matches the game's z-order).
            for (const item of map.furniture) {
              if ((item as { kind?: string }).kind === 'banner') continue;
              drawFurnitureLayer(ctx, item, 0, 0, 'object');
            }
            for (const item of map.furniture) {
              if ((item as { kind?: string }).kind === 'banner') continue;
              drawFurnitureLayer(ctx, item, 0, 0, 'overhead');
            }
            // Zones — translucent fill + dashed border + name (read-only view).
            for (const zone of map.zones) {
              const zx = zone.x * TILE_SIZE;
              const zy = zone.y * TILE_SIZE;
              const zw = zone.width * TILE_SIZE;
              const zh = zone.height * TILE_SIZE;
              ctx.fillStyle = 'rgba(124, 58, 237, 0.14)';
              ctx.fillRect(zx, zy, zw, zh);
              ctx.strokeStyle = zone.color || 'rgba(124, 58, 237, 0.8)';
              ctx.lineWidth = 1.5;
              ctx.setLineDash([5, 4]);
              ctx.strokeRect(zx, zy, zw, zh);
              ctx.setLineDash([]);
              if (zone.name) {
                ctx.fillStyle = 'rgba(255,255,255,0.85)';
                ctx.font = '11px sans-serif';
                ctx.fillText(zone.name, zx + 4, zy + 14);
              }
            }
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Space = temporary Hand (pan) regardless of active tool ───────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeldRef.current = true; };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeldRef.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  // ── Wheel zoom (native, passive:false so preventDefault stops page scroll) ──
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
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    useEditorStore.getState().panBy(dx, dy);
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
      {/* ── Top toolbar: layer tabs + tools (skeleton, bound to editorStore) ── */}
      <div className="shrink-0 flex items-center gap-4 px-4 h-12 border-b border-white/10 bg-gray-950/60">
        <span className="text-sm font-semibold text-white/90 truncate max-w-[220px]">
          {data ? data.name : 'Memuat…'}
        </span>
        <div className="flex items-center gap-1">
          {EDITOR_LAYERS.map((l) => (
            <button
              key={l.id}
              onClick={() => setActiveLayer(l.id)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                activeLayer === l.id ? 'bg-purple-600 text-white' : 'text-white/60 hover:bg-white/10'
              }`}
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
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                activeTool === t.id ? 'bg-purple-600 text-white' : 'text-white/60 hover:bg-white/10'
              } ${t.id !== 'hand' ? 'opacity-60' : ''}`}
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
        {/* ── Canvas ── */}
        <div
          ref={wrapRef}
          className="flex-1 min-w-0 relative overflow-hidden"
          style={{ cursor: canPan ? (dragRef.current ? 'grabbing' : 'grab') : 'default' }}
        >
          <canvas
            ref={canvasRef}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={endDrag}
            onMouseLeave={endDrag}
            className="block"
          />
          <div className="absolute bottom-3 left-3 text-[11px] text-white/40 pointer-events-none">
            Hand: drag untuk geser · scroll untuk zoom · view-only (Potong 0)
          </div>
        </div>

        {/* ── Right panel (skeleton — later potongan fill this) ── */}
        <div className="shrink-0 w-64 border-l border-white/10 bg-gray-950/60 p-4">
          <p className="text-xs uppercase tracking-wider text-white/40 mb-2">
            {EDITOR_LAYERS.find((l) => l.id === activeLayer)?.label}
          </p>
          <p className="text-white/50 text-sm">Panel properti/palette akan muncul di sini pada potongan berikutnya.</p>
        </div>
      </div>
    </div>
  );
}
