import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowCounterclockwise, ArrowClockwise } from 'react-bootstrap-icons';
import {
  TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, RoomTile, Furniture, Zone, RoomTheme,
  LayerData, legacyToLayerData,
} from '@virtualmeet/shared';
import { api, ApiError } from '@/services/api';
import { useEditorStore, EDITOR_LAYERS, EDITOR_TOOLS, EditorLayer, EditorTool } from '@/stores/editorStore';
import { drawTile, drawFloorTile, drawFurnitureLayer } from '@/components/canvas/mapRender';
import { drawSpriteFrame } from '@/utils/spriteLoader';
import { PALETTE_BY_THEME, PALETTE_BY_ID } from '@/data/themeAssets';

// ZEP-style Room Editor — Potong 3. Adds Wall (tile → collision), Objects
// (below avatar) and Top objects (above avatar) editing to the Potong 2 floor
// tools. Wall stamps become impassable live via the Potong-1 adaptor. Objects
// carry their catalog interactivity (sittable → isInteractable). Edits save +
// broadcast through the same path as Potong 2. Tile effects stay Potong 4.

type LoadError = 'auth' | 'forbidden' | 'notfound' | 'generic';
const OBJ_CATEGORIES: { key: 'furniture' | 'decor' | 'electronics'; label: string }[] = [
  { key: 'furniture', label: 'Furniture' }, { key: 'decor', label: 'Decor' }, { key: 'electronics', label: 'Electronics' },
];
const EFFECTS: { id: 'startingPoint' | 'impassable' | 'mapLocation' | 'privateArea' | 'portal'; label: string; color: string; hint: string }[] = [
  { id: 'startingPoint', label: 'Starting point', color: 'rgba(16,185,129,0.9)', hint: 'Stamp per tile = titik spawn (bisa banyak; pemain muncul di salah satunya).' },
  { id: 'impassable', label: 'Impassable', color: 'rgba(239,68,68,0.85)', hint: 'Stamp per tile = penghalang tak terlihat (memblok gerak, tanpa tekstur).' },
  { id: 'mapLocation', label: 'Map location', color: 'rgba(192,132,252,0.95)', hint: 'Stamp: drag area lalu beri nama → pill label muncul di game.' },
  { id: 'privateArea', label: 'Private area', color: 'rgba(96,165,250,0.95)', hint: 'Stamp: drag area + Area ID. Area ber-ID sama = satu grup audio (walau terpisah).' },
  { id: 'portal', label: 'Portal', color: 'rgba(124,58,237,0.95)', hint: 'Stamp klik tile portal → pilih tujuan room lain, atau klik titik tujuan di room ini. Pemain tekan F untuk pindah.' },
];

interface MediaObj { id: string; type: string; x: number; y: number; payload: { url?: string; videoId?: string; websiteUrl?: string; audioUrl?: string; areaW?: number; areaH?: number; name?: string } }
function parseYouTubeId(raw: string): string | null {
  const m = raw.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/) || raw.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}
function pickFile(accept: string): Promise<File | null> {
  return new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files?.[0] ?? null); i.click(); });
}

type SavePayload = ReturnType<ReturnType<typeof useEditorStore.getState>['takePending']>;
function hasChanges(p: SavePayload): boolean {
  return !!(p.floorChanges?.length || p.wallChanges?.length || p.objects || p.topObjects || p.tileEffects || p.areas || p.width != null);
}

function normalizeTiles(tilemapData: unknown[][] | null): RoomTile[][] {
  if (Array.isArray(tilemapData) && tilemapData.length > 0) {
    return tilemapData.map((row, y) =>
      (row as Record<string, unknown>[]).map((t, x) => ({ ...(t as object), x, y, type: (t as { type?: string }).type || 'floor' } as RoomTile)),
    );
  }
  return Array.from({ length: MAP_HEIGHT }, (_, y) => Array.from({ length: MAP_WIDTH }, (_, x) => ({ x, y, type: 'floor' } as RoomTile)));
}

// Small canvas thumbnail of a palette piece (handles multi-tile furniture),
// retrying briefly until the sprite sheet has loaded.
function PieceThumb({ paletteId, size = 40 }: { paletteId: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const entry = PALETTE_BY_ID[paletteId];
    if (!entry) return;
    let n = 0, raf = 0;
    const draw = () => {
      const c = ref.current; const ctx = c?.getContext('2d');
      if (!c || !ctx) return;
      const wPx = (entry.tilesW || 1) * 32, hPx = (entry.tilesH || 1) * 32;
      const scale = Math.min(size / wPx, size / hPx);
      const dw = wPx * scale, dh = hPx * scale;
      ctx.clearRect(0, 0, size, size); ctx.imageSmoothingEnabled = false;
      const drew = drawSpriteFrame(ctx, entry.src, { srcX: entry.srcX, srcY: entry.srcY, cellWidth: wPx, cellHeight: hPx, dx: (size - dw) / 2, dy: (size - dh) / 2, dWidth: dw, dHeight: dh });
      if (!drew && n++ < 60) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [paletteId, size]);
  return <canvas ref={ref} width={size} height={size} className="block" />;
}

function drawLayer(ctx: CanvasRenderingContext2D, ld: LayerData, theme: RoomTheme, layer: EditorLayer) {
  if (layer === 'floor') {
    for (let y = 0; y < ld.height; y++) for (let x = 0; x < ld.width; x++)
      drawFloorTile(ctx, { x, y, type: 'floor', floorPaletteId: ld.floor[y]?.[x] ?? undefined }, x * TILE_SIZE, y * TILE_SIZE, theme);
  } else if (layer === 'wall') {
    for (let y = 0; y < ld.height; y++) for (let x = 0; x < ld.width; x++)
      if (ld.wall[y]?.[x]) drawTile(ctx, 'wall', x * TILE_SIZE, y * TILE_SIZE, theme);
  } else if (layer === 'objects') {
    for (const item of ld.objects) { drawFurnitureLayer(ctx, item, 0, 0, 'object'); drawFurnitureLayer(ctx, item, 0, 0, 'overhead'); }
  } else if (layer === 'top') {
    for (const item of ld.topObjects) { drawFurnitureLayer(ctx, item, 0, 0, 'object'); drawFurnitureLayer(ctx, item, 0, 0, 'overhead'); }
  } else if (layer === 'effects') {
    for (const a of ld.areas) {
      const zx = a.x * TILE_SIZE, zy = a.y * TILE_SIZE, zw = a.width * TILE_SIZE, zh = a.height * TILE_SIZE;
      const isPriv = a.effect === 'privateArea';
      ctx.fillStyle = isPriv ? 'rgba(59,130,246,0.16)' : 'rgba(168,85,247,0.16)'; // blue=private, purple=map location
      ctx.fillRect(zx, zy, zw, zh);
      ctx.strokeStyle = isPriv ? 'rgba(96,165,250,0.95)' : 'rgba(192,132,252,0.95)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.strokeRect(zx, zy, zw, zh); ctx.setLineDash([]);
      const label = isPriv ? `${a.name || 'Private'}${a.areaId ? ` #${a.areaId}` : ''}` : (a.name || 'Lokasi');
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.font = '11px sans-serif'; ctx.fillText(label, zx + 4, zy + 14);
    }
    for (const e of ld.tileEffects) {
      const sx = e.x * TILE_SIZE, sy = e.y * TILE_SIZE, c = TILE_SIZE / 2;
      if (e.kind === 'startingPoint') { ctx.fillStyle = 'rgba(16,185,129,0.85)'; ctx.beginPath(); ctx.arc(sx + c, sy + c, c - 3, 0, Math.PI * 2); ctx.fill(); }
      else if (e.kind === 'impassable') { ctx.strokeStyle = 'rgba(239,68,68,0.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx + 4, sy + 4); ctx.lineTo(sx + TILE_SIZE - 4, sy + TILE_SIZE - 4); ctx.moveTo(sx + TILE_SIZE - 4, sy + 4); ctx.lineTo(sx + 4, sy + TILE_SIZE - 4); ctx.stroke(); }
      else if (e.kind === 'portal') {
        ctx.strokeStyle = 'rgba(124,58,237,0.95)'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(sx + c, sy + c, c - 3, 0, Math.PI * 2); ctx.stroke();
        if (e.targetX != null && e.targetY != null) {
          const tx = e.targetX * TILE_SIZE + c, ty = e.targetY * TILE_SIZE + c;
          ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(sx + c, sy + c); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(124,58,237,0.45)'; ctx.beginPath(); ctx.arc(tx, ty, c - 6, 0, Math.PI * 2); ctx.fill();
        }
        const plabel = e.label || (e.targetSlug ? `→ ${e.targetSlug}` : '→ dalam room');
        ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(plabel, sx + c, sy - 2); ctx.textAlign = 'left';
      }
      else if (e.kind === 'door') { ctx.fillStyle = 'rgba(212,160,86,0.8)'; ctx.fillRect(sx + 3, sy + 3, TILE_SIZE - 6, TILE_SIZE - 6); }
    }
  }
}

export function RoomEditorPage({ slug }: { slug: string }) {
  const [meta, setMeta] = useState<{ name: string; theme: RoomTheme } | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  // 'dirty' = edits exist that the debounce hasn't flushed yet — the admin must
  // never read "Tersimpan" while changes are only in memory (Potong 7).
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const saveStateRef = useRef(saveState); useEffect(() => { saveStateRef.current = saveState; }, [saveState]);
  const [objTab, setObjTab] = useState<'furniture' | 'decor' | 'electronics'>('furniture');
  const [objSearch, setObjSearch] = useState('');
  // Transient notice (paste clipped / pasted portals keep their destination).
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 4000);
  }, []);
  const [resizeOpen, setResizeOpen] = useState(false);
  const [resizeW, setResizeW] = useState(0);
  const [resizeH, setResizeH] = useState(0);
  const [portalHint, setPortalHint] = useState(false); // awaiting internal-portal destination click
  const portalOriginRef = useRef<{ x: number; y: number } | null>(null);
  // Potong 6 — media effects (reuse MapMediaObject via REST). Not part of
  // layerData; fetched separately and drawn as editor markers.
  const [mediaMode, setMediaMode] = useState<'image' | 'youtube' | 'website' | 'bgm' | null>(null);
  const mediaModeRef = useRef(mediaMode); useEffect(() => { mediaModeRef.current = mediaMode; }, [mediaMode]);
  const [media, setMedia] = useState<MediaObj[]>([]);
  const mediaRef = useRef<MediaObj[]>([]);
  useEffect(() => { mediaRef.current = media; }, [media]);
  const refetchMedia = useCallback(() => { api.getRoomMedia(slug).then((r) => setMedia(r.mediaObjects as MediaObj[])).catch(() => {}); }, [slug]);

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
  const selectedObject = useEditorStore((s) => s.selectedObjectPaletteId);
  const setSelectedObject = useEditorStore((s) => s.setSelectedObject);
  const selectedEffect = useEditorStore((s) => s.selectedEffect);
  const setSelectedEffect = useEditorStore((s) => s.setSelectedEffect);
  const selection = useEditorStore((s) => s.selection);
  const clipboard = useEditorStore((s) => s.clipboard);
  const revision = useEditorStore((s) => s.revision);
  const undoDepth = useEditorStore((s) => s.undoDepth);
  const redoDepth = useEditorStore((s) => s.redoDepth);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const metaRef = useRef<{ name: string; theme: RoomTheme } | null>(null);
  const spaceHeldRef = useRef(false);
  const dragRef = useRef<{ mode: string; last?: { x: number; y: number }; anchor?: { x: number; y: number } } | null>(null);
  const hoverTileRef = useRef<{ x: number; y: number } | null>(null); // paste ghost anchor

  useEffect(() => { metaRef.current = meta; }, [meta]);

  useEffect(() => {
    if (!localStorage.getItem('vm_token')) { setError('auth'); return; }
    let alive = true;
    api.getRoomEditorData(slug)
      .then((r) => {
        if (!alive) return;
        const theme = ((r.theme as RoomTheme) || 'modern-interiors') as RoomTheme;
        const layer = r.layerData ?? legacyToLayerData(normalizeTiles(r.tilemapData), (r.furniture as Furniture[]) ?? [], (r.zones as Zone[]) ?? []);
        setMeta({ name: r.name, theme });
        setDoc(layer);
        refetchMedia();
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof ApiError && e.status === 401 ? 'auth' : e instanceof ApiError && e.status === 403 ? 'forbidden' : e instanceof ApiError && e.status === 404 ? 'notfound' : 'generic');
      });
    return () => { alive = false; };
  }, [slug, setDoc]);

  useEffect(() => { document.title = meta ? `Editor — ${meta.name}` : 'Room Editor'; }, [meta]);

  useEffect(() => {
    if (!meta || !wrapRef.current) return;
    const doc = useEditorStore.getState().doc; if (!doc) return;
    const { clientWidth: w, clientHeight: h } = wrapRef.current;
    const mapW = doc.width * TILE_SIZE, mapH = doc.height * TILE_SIZE;
    const fit = Math.min(w / mapW, h / mapH) * 0.9;
    setZoom(fit); setViewportPan((w - mapW * fit) / 2, (h - mapH * fit) / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  // Debounced save. The indicator goes 'dirty' the moment an edit commits, so
  // "Tersimpan" is only ever shown when the server truly has everything.
  useEffect(() => {
    if (revision === 0) return;
    setSaveState('dirty');
    const rev = revision;
    const t = setTimeout(() => {
      const p = useEditorStore.getState().takePending();
      if (!hasChanges(p)) { if (useEditorStore.getState().revision === rev) setSaveState('saved'); return; }
      setSaveState('saving');
      api.saveRoomLayers(slug, p)
        // Only report saved if nothing new landed while this save was in
        // flight — otherwise the rerun of this effect owns the state.
        .then(() => { if (useEditorStore.getState().revision === rev) setSaveState('saved'); })
        .catch(() => { useEditorStore.getState().requeuePending(p); setSaveState('error'); });
    }, 900);
    return () => clearTimeout(t);
  }, [revision, slug]);

  useEffect(() => {
    const flush = () => { const p = useEditorStore.getState().takePending(); if (hasChanges(p)) api.saveRoomLayers(slug, p).catch(() => {}); };
    // Closing the tab with unflushed changes: ask first (the pagehide flush is
    // best-effort only — the request can be cut off mid-flight).
    const confirmClose = (e: BeforeUnloadEvent) => { if (saveStateRef.current !== 'saved') { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', confirmClose);
    return () => { window.removeEventListener('pagehide', flush); window.removeEventListener('beforeunload', confirmClose); };
  }, [slug]);

  // Continuous redraw.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current, wrap = wrapRef.current, doc = useEditorStore.getState().doc, m = metaRef.current;
      if (canvas && wrap) {
        const dpr = window.devicePixelRatio || 1, w = wrap.clientWidth, h = wrap.clientHeight;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#12151c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          if (doc && m) {
            const st = useEditorStore.getState();
            const { panX, panY, zoom: z } = st.viewport;
            ctx.imageSmoothingEnabled = false; ctx.setTransform(z * dpr, 0, 0, z * dpr, panX * dpr, panY * dpr);
            drawLayer(ctx, doc, m.theme, 'floor'); drawLayer(ctx, doc, m.theme, 'wall');
            drawLayer(ctx, doc, m.theme, 'objects'); drawLayer(ctx, doc, m.theme, 'top'); drawLayer(ctx, doc, m.theme, 'effects');
            if (z >= 0.5) {
              ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1 / z; ctx.beginPath();
              for (let x = 0; x <= doc.width; x++) { ctx.moveTo(x * TILE_SIZE, 0); ctx.lineTo(x * TILE_SIZE, doc.height * TILE_SIZE); }
              for (let y = 0; y <= doc.height; y++) { ctx.moveTo(0, y * TILE_SIZE); ctx.lineTo(doc.width * TILE_SIZE, y * TILE_SIZE); }
              ctx.stroke();
            }
            const sel = st.selection;
            if (sel) { ctx.fillStyle = 'rgba(124,58,237,0.18)'; ctx.fillRect(sel.x * TILE_SIZE, sel.y * TILE_SIZE, sel.w * TILE_SIZE, sel.h * TILE_SIZE); ctx.strokeStyle = 'rgba(167,139,250,0.95)'; ctx.lineWidth = 2 / z; ctx.setLineDash([6 / z, 4 / z]); ctx.strokeRect(sel.x * TILE_SIZE, sel.y * TILE_SIZE, sel.w * TILE_SIZE, sel.h * TILE_SIZE); ctx.setLineDash([]); }
            // Paste ghost: the clipboard's footprint follows the cursor so the
            // admin sees exactly where the block will land (green = paste).
            const hov = hoverTileRef.current;
            if (st.activeTool === 'copy' && st.clipboard && hov) {
              const gw = st.clipboard.w * TILE_SIZE, gh = st.clipboard.h * TILE_SIZE;
              ctx.fillStyle = 'rgba(34,197,94,0.12)'; ctx.fillRect(hov.x * TILE_SIZE, hov.y * TILE_SIZE, gw, gh);
              ctx.strokeStyle = 'rgba(74,222,128,0.95)'; ctx.lineWidth = 2 / z; ctx.setLineDash([6 / z, 4 / z]);
              ctx.strokeRect(hov.x * TILE_SIZE, hov.y * TILE_SIZE, gw, gh); ctx.setLineDash([]);
            }
            // Selected object outline (Objects/Top layers).
            if (st.selectedObjectId && (st.activeLayer === 'objects' || st.activeLayer === 'top')) {
              const arr = st.activeLayer === 'top' ? doc.topObjects : doc.objects;
              const f = arr.find((o) => o.id === st.selectedObjectId);
              if (f) { const bx = f.x * TILE_SIZE, by = (f.y - (f.tilesH - 1)) * TILE_SIZE; ctx.strokeStyle = 'rgba(250,204,21,0.95)'; ctx.lineWidth = 2 / z; ctx.strokeRect(bx, by, f.tilesW * TILE_SIZE, f.tilesH * TILE_SIZE); }
            }
            // Media markers (Potong 6, editor-only).
            for (const mm of mediaRef.current) {
              const mx = mm.x * TILE_SIZE, my = mm.y * TILE_SIZE;
              if (mm.type === 'bgm') {
                const w = (mm.payload.areaW ?? 1) * TILE_SIZE, h = (mm.payload.areaH ?? 1) * TILE_SIZE;
                ctx.fillStyle = 'rgba(34,197,94,0.14)'; ctx.fillRect(mx, my, w, h);
                ctx.strokeStyle = 'rgba(34,197,94,0.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.strokeRect(mx, my, w, h); ctx.setLineDash([]);
                ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = '11px sans-serif'; ctx.fillText(`🎵 ${mm.payload.name ?? ''}`, mx + 4, my + 14);
              } else {
                const icon = mm.type === 'image' ? '🖼️' : mm.type === 'youtube' ? '▶️' : mm.type === 'website' ? '🔗' : '📌';
                ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(mx + 3, my + 3, TILE_SIZE - 6, TILE_SIZE - 6);
                ctx.font = '14px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.fillText(icon, mx + TILE_SIZE / 2, my + TILE_SIZE / 2 + 5); ctx.textAlign = 'left';
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

  // Keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') { spaceHeldRef.current = true; return; }
      const s = useEditorStore.getState();
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? s.redo() : s.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); s.redo(); return; }
      if (e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'q') s.setActiveTool('stamp');
      else if (k === 'w') s.setActiveTool('eraser');
      else if (k === 'v') s.setActiveTool('select');
      else if (k === 'h') s.setActiveTool('hand');
      else if (k === 'c') s.setActiveTool('copy');
      else if (e.key === 'Escape') { s.clearClipboard(); s.setSelection(null); portalOriginRef.current = null; setPortalHint(false); }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if ((s.activeLayer === 'floor' || s.activeLayer === 'wall') && s.selection) { e.preventDefault(); s.fillSelection('erase'); }
        else if ((s.activeLayer === 'objects' || s.activeLayer === 'top') && s.selectedObjectId) { e.preventDefault(); s.deleteSelected(s.activeLayer === 'top' ? 'top' : 'objects'); }
      } else if (e.key === 'Enter' && (s.activeLayer === 'floor' || s.activeLayer === 'wall') && s.selection) { e.preventDefault(); s.fillSelection('stamp'); }
    };
    const onUp = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeldRef.current = false; };
    window.addEventListener('keydown', onKey); window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp); };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top); };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const tileAt = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current; if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    const { panX, panY, zoom: z } = useEditorStore.getState().viewport;
    return { x: Math.floor(((clientX - r.left) - panX) / (z * TILE_SIZE)), y: Math.floor(((clientY - r.top) - panY) / (z * TILE_SIZE)) };
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const s = useEditorStore.getState();
    if (s.activeTool === 'hand' || spaceHeldRef.current) { dragRef.current = { mode: 'pan', last: { x: e.clientX, y: e.clientY } }; return; }
    const t = tileAt(e.clientX, e.clientY);
    // Copy tool (Potong 7) works across ALL layers: no clipboard yet → drag a
    // marquee to capture; clipboard armed → every click stamps a paste.
    if (s.activeTool === 'copy') {
      if (s.clipboard) {
        const r = s.pasteAt(t.x, t.y);
        if (r) {
          const msgs: string[] = [];
          if (r.clipped) msgs.push('Bagian di luar batas map tidak ditempel.');
          if (r.portals > 0) msgs.push(`${r.portals} portal tersalin menunjuk tujuan yang SAMA dengan aslinya.`);
          if (msgs.length) showNotice(msgs.join(' '));
        }
      } else {
        s.setSelection({ x: t.x, y: t.y, w: 1, h: 1 });
        dragRef.current = { mode: 'copyRect', anchor: { x: t.x, y: t.y } };
      }
      return;
    }
    const layer = s.activeLayer;
    if (layer === 'floor' || layer === 'wall') {
      if (s.activeTool === 'stamp') { s.beginStroke(); layer === 'floor' ? s.paintFloorAt(t.x, t.y) : s.stampWallAt(t.x, t.y); dragRef.current = { mode: layer === 'floor' ? 'floorPaint' : 'wallPaint' }; }
      else if (s.activeTool === 'eraser') { s.beginStroke(); layer === 'floor' ? s.eraseFloorAt(t.x, t.y) : s.eraseWallAt(t.x, t.y); dragRef.current = { mode: layer === 'floor' ? 'floorErase' : 'wallErase' }; }
      else if (s.activeTool === 'select') { s.setSelection({ x: t.x, y: t.y, w: 1, h: 1 }); dragRef.current = { mode: 'selectRect', anchor: { x: t.x, y: t.y } }; }
    } else if (layer === 'objects' || layer === 'top') {
      const ol = layer === 'top' ? 'top' : 'objects';
      if (s.activeTool === 'stamp') {
        const entry = s.selectedObjectPaletteId ? PALETTE_BY_ID[s.selectedObjectPaletteId] : null;
        if (entry) s.placeObject({ id: crypto.randomUUID(), paletteId: entry.id, x: t.x, y: t.y, tilesW: entry.tilesW || 1, tilesH: entry.tilesH || 1, isInteractable: !!entry.sittable }, ol);
      } else if (s.activeTool === 'eraser') { const o = s.objectAt(t.x, t.y, ol); if (o) s.removeObject(o.id, ol); }
      else if (s.activeTool === 'select') { s.selectObjectAt(t.x, t.y, ol); if (useEditorStore.getState().selectedObjectId) { s.beginStroke(); dragRef.current = { mode: 'objMove' }; } }
    } else if (layer === 'effects') {
      // Media effects (MapMediaObject) take precedence when a media mode is armed.
      if (mediaModeRef.current) {
        if (s.activeTool === 'stamp') void placeMedia(mediaModeRef.current, t.x, t.y);
        else if (s.activeTool === 'eraser') { const m = mediaAt(t.x, t.y); if (m) api.deleteRoomMedia(slug, m.id).then(refetchMedia).catch(() => {}); }
        return;
      }
      const eff = s.selectedEffect; if (!eff) return;
      if (eff === 'startingPoint' || eff === 'impassable') {
        if (s.activeTool === 'stamp') { s.beginStroke(); s.stampEffectAt(t.x, t.y); dragRef.current = { mode: 'effPaint' }; }
        else if (s.activeTool === 'eraser') { s.beginStroke(); s.eraseEffectAt(t.x, t.y); dragRef.current = { mode: 'effErase' }; }
      } else if (eff === 'portal') {
        if (s.activeTool === 'eraser') { s.eraseEffectAt(t.x, t.y); return; }
        if (s.activeTool !== 'stamp') return;
        // Second click of an internal portal = pick the destination tile.
        if (portalOriginRef.current) {
          const origin = portalOriginRef.current; portalOriginRef.current = null; setPortalHint(false);
          const label = (window.prompt('Nama portal (opsional):', '') ?? '').trim();
          s.addPortal(origin.x, origin.y, { targetX: t.x, targetY: t.y, label: label || undefined });
          return;
        }
        // First click: choose cross-room vs internal.
        if (window.confirm('Portal ke ROOM LAIN?\n\nOK = pilih room lain · Batal = titik dalam room ini')) {
          const target = (window.prompt('Kode room tujuan (slug dari URL/share):', '') ?? '').trim();
          if (!target) return;
          const label = (window.prompt('Nama portal (opsional):', '') ?? '').trim();
          s.addPortal(t.x, t.y, { targetSlug: target, label: label || undefined });
        } else {
          portalOriginRef.current = { x: t.x, y: t.y }; setPortalHint(true);
        }
      } else { // mapLocation | privateArea — rectangular
        if (s.activeTool === 'eraser') { s.removeAreaAt(t.x, t.y); }
        else { s.setSelection({ x: t.x, y: t.y, w: 1, h: 1 }); dragRef.current = { mode: 'areaRect', anchor: { x: t.x, y: t.y } }; }
      }
    }
  }, [tileAt]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    hoverTileRef.current = tileAt(e.clientX, e.clientY); // paste-ghost anchor
    const d = dragRef.current; if (!d) return;
    const s = useEditorStore.getState();
    if (d.mode === 'pan' && d.last) { s.panBy(e.clientX - d.last.x, e.clientY - d.last.y); d.last = { x: e.clientX, y: e.clientY }; return; }
    const t = tileAt(e.clientX, e.clientY);
    if (d.mode === 'floorPaint') s.paintFloorAt(t.x, t.y);
    else if (d.mode === 'floorErase') s.eraseFloorAt(t.x, t.y);
    else if (d.mode === 'wallPaint') s.stampWallAt(t.x, t.y);
    else if (d.mode === 'wallErase') s.eraseWallAt(t.x, t.y);
    else if (d.mode === 'objMove') s.moveSelectedTo(t.x, t.y, s.activeLayer === 'top' ? 'top' : 'objects');
    else if (d.mode === 'effPaint') s.stampEffectAt(t.x, t.y);
    else if (d.mode === 'effErase') s.eraseEffectAt(t.x, t.y);
    else if ((d.mode === 'selectRect' || d.mode === 'areaRect' || d.mode === 'copyRect') && d.anchor) s.setSelection({ x: Math.min(d.anchor.x, t.x), y: Math.min(d.anchor.y, t.y), w: Math.abs(t.x - d.anchor.x) + 1, h: Math.abs(t.y - d.anchor.y) + 1 });
  }, [tileAt]);

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    if (d && ['floorPaint', 'floorErase', 'wallPaint', 'wallErase', 'objMove', 'effPaint', 'effErase'].includes(d.mode)) useEditorStore.getState().endStroke();
    if (d && d.mode === 'copyRect') {
      const s = useEditorStore.getState();
      if (s.selection) s.copyRegion(s.selection);
      s.setSelection(null);
    }
    if (d && d.mode === 'areaRect') {
      const s = useEditorStore.getState();
      const sel = s.selection; s.setSelection(null);
      if (sel) {
        if (s.selectedEffect === 'privateArea') {
          const name = (window.prompt('Nama private area:', 'Private') ?? '').trim();
          const areaId = (window.prompt('Area ID (samakan untuk menggabung area terpisah jadi satu grup):', '1') ?? '').trim();
          s.addArea('privateArea', sel, name || 'Private', areaId || undefined);
        } else if (s.selectedEffect === 'mapLocation') {
          const name = (window.prompt('Nama lokasi:', '') ?? '').trim();
          s.addArea('mapLocation', sel, name || 'Lokasi');
        }
      }
    }
    dragRef.current = null;
  }, []);

  const openResize = () => { const d = useEditorStore.getState().doc; if (d) { setResizeW(d.width); setResizeH(d.height); } setResizeOpen(true); };
  const applyResize = () => {
    const d = useEditorStore.getState().doc; if (!d) return;
    const w = Math.max(1, Math.min(200, Math.floor(resizeW))), h = Math.max(1, Math.min(200, Math.floor(resizeH)));
    if (w === d.width && h === d.height) { setResizeOpen(false); return; }
    const oob = (o: { x: number; y: number }) => o.x >= w || o.y >= h;
    const outObj = d.objects.filter(oob).length + d.topObjects.filter(oob).length;
    let outWall = 0;
    for (let y = 0; y < d.wall.length; y++) for (let x = 0; x < (d.wall[y]?.length ?? 0); x++) if ((x >= w || y >= h) && d.wall[y][x]) outWall++;
    const outEff = d.tileEffects.filter(oob).length;
    const outAreas = d.areas.filter((a) => a.x + a.width > w || a.y + a.height > h).length;
    // Block: can't remove every starting point.
    const sp = d.tileEffects.filter((e) => e.kind === 'startingPoint');
    if (sp.length > 0 && sp.every((e) => e.x >= w || e.y >= h)) {
      window.alert('Resize diblokir: semua starting point akan terpotong. Pindahkan minimal satu ke dalam batas baru dulu.');
      return;
    }
    // Block: an internal portal's destination would be cut.
    if (d.tileEffects.some((e) => e.kind === 'portal' && e.targetX != null && e.targetY != null && (e.targetX >= w || e.targetY >= h))) {
      window.alert('Resize diblokir: ada tujuan portal internal yang akan terpotong. Pindahkan/hapus portal itu dulu.');
      return;
    }
    const shrinking = w < d.width || h < d.height;
    const losses = outObj + outWall + outEff + outAreas;
    if (shrinking && losses > 0 && !window.confirm(`Mengecilkan map akan MENGHAPUS konten di luar batas baru:\n\n• ${outObj} objek\n• ${outWall} tile wall\n• ${outEff} tile efek\n• ${outAreas} area\n\nLanjutkan?`)) return;
    useEditorStore.getState().resizeMap(w, h);
    setResizeOpen(false);
  };

  const mediaAt = (x: number, y: number): MediaObj | null => {
    for (let i = mediaRef.current.length - 1; i >= 0; i--) {
      const m = mediaRef.current[i];
      const w = m.type === 'bgm' ? (m.payload.areaW ?? 1) : 1, h = m.type === 'bgm' ? (m.payload.areaH ?? 1) : 1;
      if (x >= m.x && x < m.x + w && y >= m.y && y < m.y + h) return m;
    }
    return null;
  };
  const placeMedia = async (kind: 'image' | 'youtube' | 'website' | 'bgm', x: number, y: number) => {
    try {
      if (kind === 'image') {
        const f = await pickFile('image/*'); if (!f) return;
        if (f.size > 10 * 1024 * 1024) { window.alert('Gambar maksimal 10MB.'); return; }
        const { url } = await api.uploadMedia(f, slug);
        await api.addRoomMedia(slug, { type: 'image', x, y, payload: { url } });
      } else if (kind === 'youtube') {
        const raw = (window.prompt('URL YouTube:', '') ?? '').trim(); if (!raw) return;
        const id = parseYouTubeId(raw); if (!id) { window.alert('URL YouTube tidak valid.'); return; }
        await api.addRoomMedia(slug, { type: 'youtube', x, y, payload: { videoId: id } });
      } else if (kind === 'website') {
        const u = (window.prompt('URL website (harus https://):', 'https://') ?? '').trim();
        if (!/^https:\/\/\S+/i.test(u)) { window.alert('Hanya URL https:// yang diperbolehkan.'); return; }
        await api.addRoomMedia(slug, { type: 'website', x, y, payload: { websiteUrl: u } });
      } else {
        const f = await pickFile('audio/mpeg,audio/ogg,audio/*'); if (!f) return;
        if (f.size > 10 * 1024 * 1024) { window.alert('Audio maksimal 10MB.'); return; }
        const name = (window.prompt('Nama area musik:', 'Musik') ?? 'Musik').trim();
        const w = Math.max(1, parseInt(window.prompt('Lebar area (tile):', '4') || '4', 10) || 4);
        const h = Math.max(1, parseInt(window.prompt('Tinggi area (tile):', '4') || '4', 10) || 4);
        const { url } = await api.uploadMedia(f, slug);
        await api.addRoomMedia(slug, { type: 'bgm', x, y, payload: { audioUrl: url, areaW: w, areaH: h, name, volume: 0.3 } });
      }
      refetchMedia();
    } catch { window.alert('Gagal menambah media.'); }
  };

  const floorEntries = meta ? PALETTE_BY_THEME[meta.theme].filter((p) => p.category === 'floor') : [];
  // Searching looks across ALL object categories (ignoring the active tab) —
  // the admin types a name because they don't know which tab it lives in.
  const objQuery = objSearch.trim().toLowerCase();
  const objEntries = meta
    ? PALETTE_BY_THEME[meta.theme].filter((p) => objQuery ? p.category !== 'floor' && p.label.toLowerCase().includes(objQuery) : p.category === objTab)
    : [];
  const canPaint = activeTool === 'stamp' || activeTool === 'eraser';
  const cursor = (activeTool === 'hand' || spaceHeldRef.current) ? 'grab' : canPaint ? 'crosshair' : activeTool === 'select' ? 'cell' : activeTool === 'copy' ? (clipboard ? 'copy' : 'cell') : 'default';

  if (error) {
    const msg = error === 'auth' ? 'Kamu harus login dulu untuk membuka editor.' : error === 'forbidden' ? 'Akses ditolak — hanya admin room ini yang boleh membuka editor.' : error === 'notfound' ? 'Room tidak ditemukan.' : 'Gagal memuat editor.';
    return <div className="fixed inset-0 flex items-center justify-center bg-gray-900 text-center px-6"><div><p className="text-white text-lg font-semibold mb-1">Room Editor</p><p className="text-white/60 text-sm">{msg}</p></div></div>;
  }

  const isObjLayer = activeLayer === 'objects' || activeLayer === 'top';

  return (
    <div className="fixed inset-0 flex flex-col bg-gray-900 text-gray-100 select-none">
      <div className="shrink-0 flex items-center gap-3 px-4 h-12 border-b border-white/10 bg-gray-950/60">
        <span className="text-sm font-semibold text-white/90 truncate max-w-[160px]">{meta ? meta.name : 'Memuat…'}</span>
        <div className="flex items-center gap-1">
          {EDITOR_LAYERS.map((l) => (
            <button key={l.id} onClick={() => setActiveLayer(l.id)} title={l.label}
              className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${activeLayer === l.id ? 'bg-purple-600 text-white' : 'text-white/60 hover:bg-white/10'}`}>{l.label}</button>
          ))}
        </div>
        <div className="w-px h-6 bg-white/10" />
        <div className="flex items-center gap-1">
          {EDITOR_TOOLS.map((t) => (
            <button key={t.id} onClick={() => setActiveTool(t.id)} title={`${t.label} (${t.key})`}
              className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${activeTool === t.id ? 'bg-purple-600 text-white' : 'text-white/60 hover:bg-white/10'}`}>{t.label}</button>
          ))}
        </div>
        <div className="w-px h-6 bg-white/10" />
        <button onClick={() => useEditorStore.getState().undo()} disabled={undoDepth === 0} title="Undo (Ctrl+Z)" className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 inline-flex items-center justify-center cursor-pointer"><ArrowCounterclockwise size={14} /></button>
        <button onClick={() => useEditorStore.getState().redo()} disabled={redoDepth === 0} title="Redo (Ctrl+Y)" className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 inline-flex items-center justify-center cursor-pointer"><ArrowClockwise size={14} /></button>
        <span className={`text-[11px] w-32 inline-flex items-center gap-1 ${saveState === 'error' ? 'text-red-400' : saveState === 'saved' ? 'text-emerald-400/90' : 'text-amber-300/90'}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${saveState === 'error' ? 'bg-red-400' : saveState === 'saved' ? 'bg-emerald-400' : 'bg-amber-300 animate-pulse'}`} />
          {saveState === 'saving' ? 'Menyimpan…' : saveState === 'dirty' ? 'Belum tersimpan…' : saveState === 'error' ? 'Gagal — mencoba lagi' : 'Tersimpan otomatis ✓'}
        </span>
        <button onClick={openResize} title="Resize map" className="px-2.5 py-1 rounded text-xs font-medium text-white/70 bg-white/10 hover:bg-white/20 cursor-pointer">Resize</button>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => zoomBy(1 / 1.2)} className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 cursor-pointer">−</button>
          <span className="text-xs text-white/60 w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button onClick={() => zoomBy(1.2)} className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 cursor-pointer">+</button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div ref={wrapRef} className="flex-1 min-w-0 relative overflow-hidden" style={{ cursor }}>
          <canvas ref={canvasRef} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={endDrag} onMouseLeave={endDrag} className="block" />
          <div className="absolute bottom-3 left-3 text-[11px] text-white/40 pointer-events-none">
            {activeTool === 'copy' ? (clipboard ? 'Copy (C): klik untuk MENEMPEL blok tersalin · Esc untuk memilih area baru' : 'Copy (C): drag area untuk menyalin SEMUA layer (floor, wall, objek, efek)')
              : isObjLayer ? 'Stamp (Q) taruh · Eraser (W) hapus · Select (V) klik+geser pindah, Delete hapus · Copy (C)'
              : activeLayer === 'wall' ? 'Wall: Stamp (Q) pasang (impassable) · Eraser (W) hapus · Select area + Enter/Delete'
              : activeLayer === 'effects' ? 'Tile effects: pilih efek di panel · Stamp gambar · Eraser hapus'
              : 'Stamp (Q) · Eraser (W) · Select (V) + Enter/Delete · Hand (H)/scroll · Copy (C) · Ctrl+Z/Y undo-redo'}
          </div>
        </div>

        <div className="shrink-0 w-64 border-l border-white/10 bg-gray-950/60 p-3 overflow-y-auto">
          {activeLayer === 'floor' && (
            <>
              <p className="text-xs uppercase tracking-wider text-white/40 mb-2">Tekstur Floor</p>
              <div className="grid grid-cols-4 gap-2">
                <button onClick={() => setSelectedFloor(null)} title="Kosong (default)" className={`h-10 rounded border text-[10px] text-white/60 flex items-center justify-center ${selectedFloor === null ? 'border-purple-400 bg-purple-500/20' : 'border-white/10 hover:border-white/30'}`}>—</button>
                {floorEntries.map((p) => (
                  <button key={p.id} onClick={() => setSelectedFloor(p.id)} title={p.label} className={`h-10 rounded border overflow-hidden ${selectedFloor === p.id ? 'border-purple-400 ring-2 ring-purple-400/50' : 'border-white/10 hover:border-white/30'}`}>
                    <span className="block w-full h-full" style={{ backgroundImage: `url(${p.src})`, backgroundPosition: `-${p.srcX}px -${p.srcY}px`, imageRendering: 'pixelated' }} />
                  </button>
                ))}
              </div>
            </>
          )}

          {activeLayer === 'wall' && (
            <>
              <p className="text-xs uppercase tracking-wider text-white/40 mb-2">Wall</p>
              <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/70">
                Gunakan <span className="text-white/90">Stamp (Q)</span> untuk memasang dinding (otomatis <span className="text-red-300">impassable</span> di game) dan <span className="text-white/90">Eraser (W)</span> untuk menghapus. Select + Enter/Delete untuk area.
              </div>
            </>
          )}

          {isObjLayer && (
            <>
              <p className="text-xs uppercase tracking-wider text-white/40 mb-2">{activeLayer === 'top' ? 'Top objects (di atas avatar)' : 'Objects (di bawah avatar)'}</p>
              <input
                type="text" value={objSearch} onChange={(e) => setObjSearch(e.target.value)} placeholder="Cari objek…"
                className="w-full mb-2 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 focus:border-purple-400 outline-none"
              />
              <div className={`flex gap-1 mb-2 ${objQuery ? 'opacity-40 pointer-events-none' : ''}`}>
                {OBJ_CATEGORIES.map((c) => (
                  <button key={c.key} onClick={() => setObjTab(c.key)} className={`flex-1 py-1 rounded text-[10px] font-medium cursor-pointer ${objTab === c.key ? 'bg-purple-600 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>{c.label}</button>
                ))}
              </div>
              {objQuery && objEntries.length === 0 && <p className="text-[11px] text-white/40 mb-2">Tidak ada objek bernama “{objSearch.trim()}”.</p>}
              <div className="grid grid-cols-3 gap-2">
                {objEntries.map((p) => (
                  <button key={p.id} onClick={() => setSelectedObject(p.id)} title={p.label} className={`rounded border p-1 flex items-center justify-center bg-black/20 ${selectedObject === p.id ? 'border-purple-400 ring-2 ring-purple-400/50' : 'border-white/10 hover:border-white/30'}`}>
                    <PieceThumb paletteId={p.id} />
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-white/40 mt-3">Kursi ({'>'} bertanda sittable) tetap bisa diduduki di game. Pilih objek lalu Stamp untuk menaruh.</p>
            </>
          )}

          {activeLayer === 'effects' && (
            <>
              <p className="text-xs uppercase tracking-wider text-white/40 mb-2">Tile Effects</p>
              <div className="space-y-1.5">
                {EFFECTS.map((e) => (
                  <button key={e.id} onClick={() => { setSelectedEffect(e.id); setMediaMode(null); }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm cursor-pointer ${!mediaMode && selectedEffect === e.id ? 'bg-purple-600/30 border border-purple-400 text-white' : 'border border-white/10 text-white/70 hover:bg-white/5'}`}>
                    <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: e.color }} /> {e.label}
                  </button>
                ))}
              </div>

              <p className="text-xs uppercase tracking-wider text-white/40 mt-4 mb-2">Media</p>
              <div className="space-y-1.5">
                {([['image', '🖼️ Insert image'], ['youtube', '▶️ YouTube'], ['website', '🔗 Open website'], ['bgm', '🎵 Background music']] as const).map(([id, label]) => (
                  <button key={id} onClick={() => { setMediaMode(id); setSelectedEffect(null); }}
                    className={`w-full px-2 py-1.5 rounded text-left text-sm cursor-pointer ${mediaMode === id ? 'bg-purple-600/30 border border-purple-400 text-white' : 'border border-white/10 text-white/70 hover:bg-white/5'}`}>
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-white/50 mt-3 leading-relaxed">
                {mediaMode
                  ? 'Stamp: klik tile untuk menaruh (image/BGM → upload; YouTube/Website → tempel URL). Eraser: klik untuk hapus. File → Lark Drive room ini.'
                  : (EFFECTS.find((e) => e.id === selectedEffect)?.hint ?? 'Pilih efek/media lalu gambar di kanvas. Overlay ini hanya tampil di editor.')}
              </p>
            </>
          )}
        </div>
      </div>

      {/* Copy tool: clipboard armed → paste mode */}
      {activeTool === 'copy' && clipboard && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 bg-emerald-600 text-white text-xs px-3 py-1.5 rounded-full shadow-lg">
          Tersalin {clipboard.w}×{clipboard.h} — klik untuk menempel
          <button onClick={() => useEditorStore.getState().clearClipboard()} className="ml-2 underline cursor-pointer">pilih ulang (Esc)</button>
        </div>
      )}

      {/* Transient notice (paste clipped / portal caveat) */}
      {notice && (
        <div className="absolute bottom-14 left-1/2 -translate-x-1/2 max-w-md bg-amber-500/95 text-gray-900 text-xs font-medium px-3 py-1.5 rounded-lg shadow-lg pointer-events-none">
          {notice}
        </div>
      )}

      {/* Portal internal-destination hint */}
      {portalHint && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 bg-purple-600 text-white text-xs px-3 py-1.5 rounded-full shadow-lg">
          Klik titik TUJUAN portal di dalam room ini…
          <button onClick={() => { portalOriginRef.current = null; setPortalHint(false); }} className="ml-2 underline cursor-pointer">batal</button>
        </div>
      )}

      {/* Resize modal */}
      {resizeOpen && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60" onMouseDown={() => setResizeOpen(false)}>
          <div className="bg-gray-800 border border-white/10 rounded-xl p-5 w-80" onMouseDown={(e) => e.stopPropagation()}>
            <p className="text-white font-semibold mb-1">Resize map</p>
            <p className="text-white/50 text-xs mb-3">Ukuran dalam tile. Mengecilkan akan memotong konten di luar batas (dikonfirmasi dulu).</p>
            <div className="flex items-center gap-3 mb-4">
              <label className="text-xs text-white/60">Lebar<input type="number" min={1} max={200} value={resizeW} onChange={(e) => setResizeW(Number(e.target.value))} className="mt-1 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-sm text-white" /></label>
              <span className="text-white/40 mt-4">×</span>
              <label className="text-xs text-white/60">Tinggi<input type="number" min={1} max={200} value={resizeH} onChange={(e) => setResizeH(Number(e.target.value))} className="mt-1 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-sm text-white" /></label>
            </div>
            <div className="flex gap-2">
              <button onClick={applyResize} className="flex-1 py-1.5 rounded bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium cursor-pointer">Terapkan</button>
              <button onClick={() => setResizeOpen(false)} className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-white/80 text-sm cursor-pointer">Batal</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
