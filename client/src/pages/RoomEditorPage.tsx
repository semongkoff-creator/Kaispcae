import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowCounterclockwise, ArrowClockwise } from 'react-bootstrap-icons';
import {
  TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, RoomTile, Furniture, Zone, RoomTheme,
  LayerData, legacyToLayerData,
} from '@virtualmeet/shared';
import { api, ApiError } from '@/services/api';
import { useEditorStore, EDITOR_LAYERS, EDITOR_TOOLS, EditorLayer, EditorTool } from '@/stores/editorStore';
import { drawTile, drawFloorTile, drawFurnitureLayer } from '@/components/canvas/mapRender';
import { PALETTE_BY_THEME } from '@/data/themeAssets';

// ZEP-style Room Editor — Potong 2 (Floor-layer editing). Stamp/Eraser/Select
// operate on the floor layer only; Hand + zoom from Potong 0 stay. Edits go to
// editorStore.doc (undo/redo, per-tile change queue), auto-save is debounced to
// the server (admin-gated), and the server broadcasts ROOM_UPDATED so the game
// view + everyone in the room see the new floor live. Wall/Objects/Effects tabs
// are visible but not yet editable (Potong 3-4).

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

function drawLayer(ctx: CanvasRenderingContext2D, ld: LayerData, theme: RoomTheme, layer: EditorLayer) {
  if (layer === 'floor') {
    for (let y = 0; y < ld.height; y++)
      for (let x = 0; x < ld.width; x++)
        drawFloorTile(ctx, { x, y, type: 'floor', floorPaletteId: ld.floor[y]?.[x] ?? undefined }, x * TILE_SIZE, y * TILE_SIZE, theme);
  } else if (layer === 'wall') {
    for (let y = 0; y < ld.height; y++)
      for (let x = 0; x < ld.width; x++)
        if (ld.wall[y]?.[x]) drawTile(ctx, 'wall', x * TILE_SIZE, y * TILE_SIZE, theme);
  } else if (layer === 'objects') {
    for (const item of ld.objects) { drawFurnitureLayer(ctx, item, 0, 0, 'object'); drawFurnitureLayer(ctx, item, 0, 0, 'overhead'); }
  } else if (layer === 'top') {
    for (const item of ld.topObjects) { drawFurnitureLayer(ctx, item, 0, 0, 'object'); drawFurnitureLayer(ctx, item, 0, 0, 'overhead'); }
  } else if (layer === 'effects') {
    for (const a of ld.areas) {
      const zx = a.x * TILE_SIZE, zy = a.y * TILE_SIZE, zw = a.width * TILE_SIZE, zh = a.height * TILE_SIZE;
      ctx.fillStyle = 'rgba(59, 130, 246, 0.16)'; ctx.fillRect(zx, zy, zw, zh);
      ctx.strokeStyle = a.color || 'rgba(59, 130, 246, 0.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.strokeRect(zx, zy, zw, zh); ctx.setLineDash([]);
      if (a.name) { ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = '11px sans-serif'; ctx.fillText(a.name, zx + 4, zy + 14); }
    }
    for (const e of ld.tileEffects) {
      const sx = e.x * TILE_SIZE, sy = e.y * TILE_SIZE, c = TILE_SIZE / 2;
      if (e.kind === 'startingPoint') { ctx.fillStyle = 'rgba(16,185,129,0.85)'; ctx.beginPath(); ctx.arc(sx + c, sy + c, c - 3, 0, Math.PI * 2); ctx.fill(); }
      else if (e.kind === 'impassable') { ctx.strokeStyle = 'rgba(239,68,68,0.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx + 4, sy + 4); ctx.lineTo(sx + TILE_SIZE - 4, sy + TILE_SIZE - 4); ctx.moveTo(sx + TILE_SIZE - 4, sy + 4); ctx.lineTo(sx + 4, sy + TILE_SIZE - 4); ctx.stroke(); }
      else if (e.kind === 'portal') { ctx.strokeStyle = 'rgba(124,58,237,0.9)'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(sx + c, sy + c, c - 3, 0, Math.PI * 2); ctx.stroke(); }
      else if (e.kind === 'door') { ctx.fillStyle = 'rgba(212,160,86,0.8)'; ctx.fillRect(sx + 3, sy + 3, TILE_SIZE - 6, TILE_SIZE - 6); }
    }
  }
}

export function RoomEditorPage({ slug }: { slug: string }) {
  const [meta, setMeta] = useState<{ name: string; theme: RoomTheme } | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle');

  const activeLayer = useEditorStore((s) => s.activeLayer);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);
  const zoomBy = useEditorStore((s) => s.zoomBy);
  const setZoom = useEditorStore((s) => s.setZoom);
  const setViewportPan = useEditorStore((s) => s.setPan);
  const zoom = useEditorStore((s) => s.viewport.zoom);
  const setDoc = useEditorStore((s) => s.setDoc);
  const selectedFloor = useEditorStore((s) => s.selectedFloorPaletteId);
  const setSelectedFloor = useEditorStore((s) => s.setSelectedFloor);
  const selection = useEditorStore((s) => s.selection);
  const revision = useEditorStore((s) => s.revision);
  const undoDepth = useEditorStore((s) => s.undoDepth);
  const redoDepth = useEditorStore((s) => s.redoDepth);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const metaRef = useRef<{ name: string; theme: RoomTheme } | null>(null);
  const layerRef = useRef<EditorLayer>(activeLayer);
  const toolRef = useRef<EditorTool>(activeTool);
  const spaceHeldRef = useRef(false);
  const dragRef = useRef<{ mode: 'pan' | 'paint' | 'erase' | 'select'; last?: { x: number; y: number }; anchor?: { x: number; y: number } } | null>(null);

  useEffect(() => { metaRef.current = meta; }, [meta]);
  useEffect(() => { layerRef.current = activeLayer; }, [activeLayer]);
  useEffect(() => { toolRef.current = activeTool; }, [activeTool]);

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
        setMeta({ name: r.name, theme });
        setDoc(layer);
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) setError('auth');
        else if (e instanceof ApiError && e.status === 403) setError('forbidden');
        else if (e instanceof ApiError && e.status === 404) setError('notfound');
        else setError('generic');
      });
    return () => { alive = false; };
  }, [slug, setDoc]);

  useEffect(() => { document.title = meta ? `Editor — ${meta.name}` : 'Room Editor'; }, [meta]);

  // ── Fit-to-screen once loaded ───────────────────────────────────────
  useEffect(() => {
    if (!meta || !wrapRef.current) return;
    const doc = useEditorStore.getState().doc;
    if (!doc) return;
    const { clientWidth: w, clientHeight: h } = wrapRef.current;
    const mapW = doc.width * TILE_SIZE, mapH = doc.height * TILE_SIZE;
    const fit = Math.min(w / mapW, h / mapH) * 0.9;
    setZoom(fit);
    setViewportPan((w - mapW * fit) / 2, (h - mapH * fit) / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  // ── Debounced auto-save (per-tile diff) ─────────────────────────────
  useEffect(() => {
    if (revision === 0) return;
    const t = setTimeout(() => {
      const changes = useEditorStore.getState().takePendingFloorChanges();
      if (!changes.length) return;
      setSaveState('saving');
      api.saveRoomFloor(slug, changes)
        .then(() => setSaveState('idle'))
        .catch(() => { useEditorStore.getState().requeueFloorChanges(changes); setSaveState('error'); });
    }, 900);
    return () => clearTimeout(t);
  }, [revision, slug]);

  // Best-effort flush on tab close so the last (<900ms) edits aren't lost.
  useEffect(() => {
    const flush = () => {
      const changes = useEditorStore.getState().takePendingFloorChanges();
      if (changes.length) api.saveRoomFloor(slug, changes).catch(() => {});
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [slug]);

  // ── Continuous redraw ───────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current, wrap = wrapRef.current;
      const doc = useEditorStore.getState().doc;
      const m = metaRef.current;
      if (canvas && wrap) {
        const dpr = window.devicePixelRatio || 1;
        const w = wrap.clientWidth, h = wrap.clientHeight;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
          canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = '#12151c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          if (doc && m) {
            const { panX, panY, zoom: z } = useEditorStore.getState().viewport;
            ctx.imageSmoothingEnabled = false;
            ctx.setTransform(z * dpr, 0, 0, z * dpr, panX * dpr, panY * dpr);
            drawLayer(ctx, doc, m.theme, 'floor');
            drawLayer(ctx, doc, m.theme, 'wall');
            drawLayer(ctx, doc, m.theme, 'objects');
            drawLayer(ctx, doc, m.theme, 'top');
            drawLayer(ctx, doc, m.theme, 'effects');
            // Faint tile grid (helps aim the stamp).
            if (z >= 0.5) {
              ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1 / z;
              ctx.beginPath();
              for (let x = 0; x <= doc.width; x++) { ctx.moveTo(x * TILE_SIZE, 0); ctx.lineTo(x * TILE_SIZE, doc.height * TILE_SIZE); }
              for (let y = 0; y <= doc.height; y++) { ctx.moveTo(0, y * TILE_SIZE); ctx.lineTo(doc.width * TILE_SIZE, y * TILE_SIZE); }
              ctx.stroke();
            }
            // Selection rectangle.
            const sel = useEditorStore.getState().selection;
            if (sel) {
              ctx.fillStyle = 'rgba(124,58,237,0.18)';
              ctx.fillRect(sel.x * TILE_SIZE, sel.y * TILE_SIZE, sel.w * TILE_SIZE, sel.h * TILE_SIZE);
              ctx.strokeStyle = 'rgba(167,139,250,0.95)'; ctx.lineWidth = 2 / z; ctx.setLineDash([6 / z, 4 / z]);
              ctx.strokeRect(sel.x * TILE_SIZE, sel.y * TILE_SIZE, sel.w * TILE_SIZE, sel.h * TILE_SIZE);
              ctx.setLineDash([]);
            }
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Keyboard: tool shortcuts, undo/redo, selection delete/fill ──────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') { spaceHeldRef.current = true; return; }
      const s = useEditorStore.getState();
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) s.redo(); else s.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); s.redo(); return; }
      if (e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'q') s.setActiveTool('stamp');
      else if (k === 'w') s.setActiveTool('eraser');
      else if (k === 'v') s.setActiveTool('select');
      else if (k === 'h') s.setActiveTool('hand');
      else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selection) { e.preventDefault(); s.fillSelection('erase'); }
      else if (e.key === 'Enter' && s.selection) { e.preventDefault(); s.fillSelection('stamp'); }
    };
    const onUp = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeldRef.current = false; };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp); };
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

  // Screen (client) point → tile coords, accounting for pan/zoom.
  const tileAt = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    const { panX, panY, zoom: z } = useEditorStore.getState().viewport;
    return {
      x: Math.floor(((clientX - r.left) - panX) / (z * TILE_SIZE)),
      y: Math.floor(((clientY - r.top) - panY) / (z * TILE_SIZE)),
    };
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const s = useEditorStore.getState();
    const panning = toolRef.current === 'hand' || spaceHeldRef.current;
    if (panning) { dragRef.current = { mode: 'pan', last: { x: e.clientX, y: e.clientY } }; return; }
    const t = tileAt(e.clientX, e.clientY);
    if (toolRef.current === 'stamp') { s.beginStroke(); s.paintFloorAt(t.x, t.y); dragRef.current = { mode: 'paint' }; }
    else if (toolRef.current === 'eraser') { s.beginStroke(); s.eraseFloorAt(t.x, t.y); dragRef.current = { mode: 'erase' }; }
    else if (toolRef.current === 'select') { s.setSelection({ x: t.x, y: t.y, w: 1, h: 1 }); dragRef.current = { mode: 'select', anchor: { x: t.x, y: t.y } }; }
  }, [tileAt]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const s = useEditorStore.getState();
    if (d.mode === 'pan' && d.last) { s.panBy(e.clientX - d.last.x, e.clientY - d.last.y); d.last = { x: e.clientX, y: e.clientY }; return; }
    const t = tileAt(e.clientX, e.clientY);
    if (d.mode === 'paint') s.paintFloorAt(t.x, t.y);
    else if (d.mode === 'erase') s.eraseFloorAt(t.x, t.y);
    else if (d.mode === 'select' && d.anchor) {
      s.setSelection({ x: Math.min(d.anchor.x, t.x), y: Math.min(d.anchor.y, t.y), w: Math.abs(t.x - d.anchor.x) + 1, h: Math.abs(t.y - d.anchor.y) + 1 });
    }
  }, [tileAt]);

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    if (d && (d.mode === 'paint' || d.mode === 'erase')) useEditorStore.getState().endStroke();
    dragRef.current = null;
  }, []);

  const floorEntries = meta ? PALETTE_BY_THEME[meta.theme].filter((p) => p.category === 'floor') : [];
  const canPaint = activeTool === 'stamp' || activeTool === 'eraser';
  const cursor = (activeTool === 'hand' || spaceHeldRef.current) ? 'grab' : canPaint ? 'crosshair' : activeTool === 'select' ? 'cell' : 'default';

  if (error) {
    const msg =
      error === 'auth' ? 'Kamu harus login dulu untuk membuka editor.'
      : error === 'forbidden' ? 'Akses ditolak — hanya admin room ini yang boleh membuka editor.'
      : error === 'notfound' ? 'Room tidak ditemukan.' : 'Gagal memuat editor.';
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-gray-900 text-center px-6">
        <div><p className="text-white text-lg font-semibold mb-1">Room Editor</p><p className="text-white/60 text-sm">{msg}</p></div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-gray-900 text-gray-100 select-none">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-12 border-b border-white/10 bg-gray-950/60">
        <span className="text-sm font-semibold text-white/90 truncate max-w-[180px]">{meta ? meta.name : 'Memuat…'}</span>
        <div className="flex items-center gap-1">
          {EDITOR_LAYERS.map((l) => (
            <button key={l.id} onClick={() => setActiveLayer(l.id)}
              title={l.id === 'floor' ? 'Floor (bisa diedit)' : `${l.label} (belum bisa diedit)`}
              className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${activeLayer === l.id ? 'bg-purple-600 text-white' : 'text-white/60 hover:bg-white/10'} ${l.id !== 'floor' ? 'opacity-60' : ''}`}>
              {l.label}
            </button>
          ))}
        </div>
        <div className="w-px h-6 bg-white/10" />
        <div className="flex items-center gap-1">
          {EDITOR_TOOLS.map((t) => (
            <button key={t.id} onClick={() => setActiveTool(t.id)}
              title={t.id === 'copy' ? 'Copy (Potong 7)' : `${t.label} (${t.key})`}
              disabled={t.id === 'copy'}
              className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${activeTool === t.id ? 'bg-purple-600 text-white' : 'text-white/60 hover:bg-white/10'} ${t.id === 'copy' ? 'opacity-40 cursor-not-allowed' : ''}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="w-px h-6 bg-white/10" />
        <button onClick={() => useEditorStore.getState().undo()} disabled={undoDepth === 0} title="Undo (Ctrl+Z)"
          className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 inline-flex items-center justify-center cursor-pointer"><ArrowCounterclockwise size={14} /></button>
        <button onClick={() => useEditorStore.getState().redo()} disabled={redoDepth === 0} title="Redo (Ctrl+Y)"
          className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 inline-flex items-center justify-center cursor-pointer"><ArrowClockwise size={14} /></button>
        <span className="text-[11px] text-white/40 w-20">
          {saveState === 'saving' ? 'Menyimpan…' : saveState === 'error' ? 'Gagal simpan' : 'Tersimpan'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => zoomBy(1 / 1.2)} className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 cursor-pointer">−</button>
          <span className="text-xs text-white/60 w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button onClick={() => zoomBy(1.2)} className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 cursor-pointer">+</button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Canvas */}
        <div ref={wrapRef} className="flex-1 min-w-0 relative overflow-hidden" style={{ cursor }}>
          <canvas ref={canvasRef} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={endDrag} onMouseLeave={endDrag} className="block" />
          <div className="absolute bottom-3 left-3 text-[11px] text-white/40 pointer-events-none">
            {activeTool === 'select'
              ? 'Select: drag pilih area · Enter isi tekstur · Delete kosongkan'
              : 'Stamp (Q) cat · Eraser (W) hapus · Select (V) · Hand (H)/scroll navigasi'}
          </div>
        </div>

        {/* Right panel — Floor palette */}
        <div className="shrink-0 w-64 border-l border-white/10 bg-gray-950/60 p-3 overflow-y-auto">
          {activeLayer === 'floor' ? (
            <>
              <p className="text-xs uppercase tracking-wider text-white/40 mb-2">Tekstur Floor</p>
              <div className="grid grid-cols-4 gap-2">
                <button
                  onClick={() => setSelectedFloor(null)}
                  title="Kosong (default) — untuk stamp-isi jadi lantai dasar"
                  className={`h-10 rounded border text-[10px] text-white/60 flex items-center justify-center ${selectedFloor === null ? 'border-purple-400 bg-purple-500/20' : 'border-white/10 hover:border-white/30'}`}
                >—</button>
                {floorEntries.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedFloor(p.id)}
                    title={p.label}
                    className={`h-10 rounded border overflow-hidden ${selectedFloor === p.id ? 'border-purple-400 ring-2 ring-purple-400/50' : 'border-white/10 hover:border-white/30'}`}
                  >
                    <span
                      className="block w-full h-full"
                      style={{
                        backgroundImage: `url(${p.src})`,
                        backgroundPosition: `-${p.srcX}px -${p.srcY}px`,
                        imageRendering: 'pixelated',
                      }}
                    />
                  </button>
                ))}
              </div>
              {selection && (
                <div className="mt-4 space-y-1.5">
                  <p className="text-xs uppercase tracking-wider text-white/40">Area terpilih ({selection.w}×{selection.h})</p>
                  <button onClick={() => useEditorStore.getState().fillSelection('stamp')} disabled={selectedFloor === null}
                    className="w-full py-1.5 rounded bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white text-xs font-medium cursor-pointer">Isi dgn tekstur (Enter)</button>
                  <button onClick={() => useEditorStore.getState().fillSelection('erase')}
                    className="w-full py-1.5 rounded bg-white/10 hover:bg-white/20 text-white/80 text-xs cursor-pointer">Kosongkan area (Delete)</button>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="text-xs uppercase tracking-wider text-white/40 mb-2">{EDITOR_LAYERS.find((l) => l.id === activeLayer)?.label}</p>
              <p className="text-white/50 text-sm">Layer ini belum bisa diedit (menyusul di potongan berikutnya). Pindah ke <span className="text-white/80">Floor</span> untuk mengedit lantai.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
