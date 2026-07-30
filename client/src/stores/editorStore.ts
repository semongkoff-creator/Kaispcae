import { create } from 'zustand';
import type { LayerData, Furniture, TileEffect, AreaEffect } from '@virtualmeet/shared';

export type TileEffectKind = 'startingPoint' | 'impassable' | 'mapLocation' | 'privateArea' | 'portal';

// ZEP-style Room Editor state. Potong 0: layers/tools/viewport. Potong 2: floor
// editing + undo/redo + debounced save. Potong 3: Wall (tile, drives collision),
// Objects (below avatar) and Top objects (above avatar) editing. Tile-effects
// editing stays out (Potong 4).

export type EditorLayer = 'floor' | 'wall' | 'objects' | 'top' | 'effects';
export const EDITOR_LAYERS: { id: EditorLayer; label: string }[] = [
  { id: 'floor', label: 'Floor' },
  { id: 'wall', label: 'Wall' },
  { id: 'objects', label: 'Objects' },
  { id: 'top', label: 'Top objects' },
  { id: 'effects', label: 'Tile effects' },
];

export type EditorTool = 'select' | 'stamp' | 'eraser' | 'hand' | 'copy';
export const EDITOR_TOOLS: { id: EditorTool; label: string; key: string }[] = [
  { id: 'stamp', label: 'Stamp', key: 'Q' },
  { id: 'eraser', label: 'Eraser', key: 'W' },
  { id: 'select', label: 'Select', key: 'V' },
  { id: 'hand', label: 'Hand', key: 'H' },
  { id: 'copy', label: 'Copy', key: 'C' },
];

export interface EditorViewport { panX: number; panY: number; zoom: number; }
export interface Selection { x: number; y: number; w: number; h: number; }

// Copy tool (Potong 7): a captured region of EVERY layer, coordinates relative
// to the region origin so it can be stamped anywhere. Internal-portal targets
// stay ABSOLUTE on purpose — a pasted portal points at the same destination as
// the original (the page warns about this on paste). privateArea keeps its
// areaId, so the pasted copy joins the same audio group — intended (P4 rule:
// same areaId = one group even when the rectangles are apart).
export interface EditorClipboard {
  w: number; h: number;
  floor: (string | null)[][];
  wall: boolean[][];
  objects: Furniture[];
  topObjects: Furniture[];
  tileEffects: TileEffect[];
  areas: AreaEffect[];
}
export interface FloorChange { x: number; y: number; value: string | null; }
export interface WallChange { x: number; y: number; value: boolean; }
type FloorGrid = (string | null)[][];
type WallGrid = boolean[][];

const MIN_ZOOM = 0.25, MAX_ZOOM = 3;
const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
const HISTORY_LIMIT = 50;

const cloneFloor = (f: FloorGrid): FloorGrid => f.map((r) => r.slice());
const cloneWall = (w: WallGrid): WallGrid => w.map((r) => r.slice());
const cloneObjs = (o: Furniture[]): Furniture[] => o.map((x) => ({ ...x }));
const cloneEffects = (e: TileEffect[]): TileEffect[] => e.map((x) => ({ ...x }));
const cloneAreas = (a: AreaEffect[]): AreaEffect[] => a.map((x) => ({ ...x }));

interface Snapshot { width: number; height: number; floor: FloorGrid; wall: WallGrid; objects: Furniture[]; topObjects: Furniture[]; tileEffects: TileEffect[]; areas: AreaEffect[]; }

interface EditorState {
  activeLayer: EditorLayer;
  setActiveLayer: (layer: EditorLayer) => void;
  activeTool: EditorTool;
  setActiveTool: (tool: EditorTool) => void;

  viewport: EditorViewport;
  setPan: (panX: number, panY: number) => void;
  panBy: (dx: number, dy: number) => void;
  zoomBy: (factor: number, anchorX?: number, anchorY?: number) => void;
  setZoom: (zoom: number) => void;
  resetViewport: () => void;

  doc: LayerData | null;
  setDoc: (doc: LayerData) => void;

  selectedFloorPaletteId: string | null;
  setSelectedFloor: (id: string | null) => void;
  selectedObjectPaletteId: string | null;
  setSelectedObject: (id: string | null) => void;

  selection: Selection | null;
  setSelection: (sel: Selection | null) => void;
  selectedObjectId: string | null;

  revision: number;
  undoDepth: number;
  redoDepth: number;

  // Grid strokes (floor/wall) + object-move share begin/endStroke.
  beginStroke: () => void;
  endStroke: () => void;
  paintFloorAt: (x: number, y: number) => void;
  eraseFloorAt: (x: number, y: number) => void;
  stampWallAt: (x: number, y: number) => void;
  eraseWallAt: (x: number, y: number) => void;
  fillSelection: (mode: 'stamp' | 'erase') => void;

  // Objects (layer = 'objects' | 'top').
  objectAt: (x: number, y: number, layer: 'objects' | 'top') => Furniture | null;
  placeObject: (obj: Furniture, layer: 'objects' | 'top') => void;
  removeObject: (id: string, layer: 'objects' | 'top') => void;
  selectObjectAt: (x: number, y: number, layer: 'objects' | 'top') => void;
  moveSelectedTo: (x: number, y: number, layer: 'objects' | 'top') => void;
  deleteSelected: (layer: 'objects' | 'top') => void;

  // Tile effects (Potong 4).
  selectedEffect: TileEffectKind | null;
  setSelectedEffect: (k: TileEffectKind | null) => void;
  stampEffectAt: (x: number, y: number) => void; // startingPoint / impassable (per-tile stroke)
  eraseEffectAt: (x: number, y: number) => boolean; // removes a per-tile effect; true if one was there
  areaAt: (x: number, y: number) => AreaEffect | null;
  addArea: (effect: 'mapLocation' | 'privateArea', rect: Selection, name: string, areaId?: string) => void;
  removeAreaAt: (x: number, y: number) => void;

  // Copy tool (Potong 7). copyRegion captures the selection into the clipboard;
  // pasteAt stamps it with the clicked tile as the top-left corner. Out-of-map
  // parts are skipped (result.clipped tells the page to say so). One history
  // entry per paste.
  clipboard: EditorClipboard | null;
  copyRegion: (rect: Selection) => void;
  clearClipboard: () => void;
  pasteAt: (x: number, y: number) => { clipped: boolean; portals: number } | null;

  // Portal (Potong 5) — one per tile; replaces any effect already there.
  addPortal: (x: number, y: number, cfg: { targetSlug?: string; targetX?: number; targetY?: number; label?: string }) => void;
  // Resize the map (Potong 5). Grows with empty tiles / shrinks by culling
  // out-of-bounds content. Caller must have confirmed/validated first.
  resizeMap: (width: number, height: number) => void;

  undo: () => void;
  redo: () => void;

  takePending: () => SavePayload;
  requeuePending: (p: SavePayload) => void;
}

interface SavePayload {
  floorChanges?: FloorChange[];
  wallChanges?: WallChange[];
  // Set only on a resize: full grids + new dimensions (per-tile diffs can't
  // express a dimension change).
  width?: number;
  height?: number;
  floor?: FloorGrid;
  wall?: WallGrid;
  objects?: Furniture[];
  topObjects?: Furniture[];
  tileEffects?: TileEffect[];
  areas?: AreaEffect[];
}

const INITIAL_VIEWPORT: EditorViewport = { panX: 0, panY: 0, zoom: 1 };

// Non-reactive internals mutated in place; only committed edits bump `revision`.
const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];
const floorPending = new Map<string, FloorChange>();
const wallPending = new Map<string, WallChange>();
let objectsDirty = false;
let topDirty = false;
let effectsDirty = false;
let areasDirty = false;
let resizedDirty = false; // dims/grids changed → save full floor+wall+dims
let strokeSnap: Snapshot | null = null;
let strokeChanged = false;

export const useEditorStore = create<EditorState>((set, get) => {
  const snapshot = (): Snapshot | null => {
    const d = get().doc;
    if (!d) return null;
    return { width: d.width, height: d.height, floor: cloneFloor(d.floor), wall: cloneWall(d.wall), objects: cloneObjs(d.objects), topObjects: cloneObjs(d.topObjects), tileEffects: cloneEffects(d.tileEffects), areas: cloneAreas(d.areas) };
  };
  const pushHistory = (snap: Snapshot | null) => { if (!snap) return; undoStack.push(snap); if (undoStack.length > HISTORY_LIMIT) undoStack.shift(); redoStack.length = 0; };
  const commit = () => set((s) => ({ revision: s.revision + 1, undoDepth: undoStack.length, redoDepth: redoStack.length }));

  const applyFloorCell = (x: number, y: number, value: string | null): boolean => {
    const row = get().doc?.floor[y];
    if (!row || x < 0 || x >= row.length) return false;
    if (row[x] === value) return false;
    row[x] = value; floorPending.set(`${x},${y}`, { x, y, value }); return true;
  };
  const applyWallCell = (x: number, y: number, value: boolean): boolean => {
    const row = get().doc?.wall[y];
    if (!row || x < 0 || x >= row.length) return false;
    if (row[x] === value) return false;
    row[x] = value; wallPending.set(`${x},${y}`, { x, y, value }); return true;
  };
  // Replace entity arrays from a snapshot on undo/redo (mark for full save).
  const restoreObjects = (snap: Snapshot) => {
    const d = get().doc; if (!d) return;
    d.objects = cloneObjs(snap.objects); d.topObjects = cloneObjs(snap.topObjects);
    d.tileEffects = cloneEffects(snap.tileEffects); d.areas = cloneAreas(snap.areas);
    objectsDirty = true; topDirty = true; effectsDirty = true; areasDirty = true;
  };
  // Restore grids on undo/redo: cell-diff when dims match; full replace when a
  // resize changed the dimensions (cell-diff can't cross a dim change).
  const applyGridSnapshot = (target: Snapshot) => {
    const d = get().doc; if (!d) return;
    if (target.width !== d.width || target.height !== d.height) {
      d.width = target.width; d.height = target.height;
      d.floor = cloneFloor(target.floor); d.wall = cloneWall(target.wall);
      resizedDirty = true;
    } else {
      for (let y = 0; y < target.floor.length; y++) for (let x = 0; x < target.floor[y].length; x++) applyFloorCell(x, y, target.floor[y][x]);
      for (let y = 0; y < target.wall.length; y++) for (let x = 0; x < target.wall[y].length; x++) applyWallCell(x, y, target.wall[y][x]);
    }
  };

  return {
    activeLayer: 'floor',
    setActiveLayer: (activeLayer) => set({ activeLayer, selection: null, selectedObjectId: null }),
    activeTool: 'hand',
    setActiveTool: (activeTool) => set({ activeTool }),

    viewport: INITIAL_VIEWPORT,
    setPan: (panX, panY) => set((s) => ({ viewport: { ...s.viewport, panX, panY } })),
    panBy: (dx, dy) => set((s) => ({ viewport: { ...s.viewport, panX: s.viewport.panX + dx, panY: s.viewport.panY + dy } })),
    zoomBy: (factor, anchorX, anchorY) =>
      set((s) => {
        const { panX, panY, zoom } = s.viewport;
        const next = clampZoom(zoom * factor);
        if (next === zoom) return s;
        const ax = anchorX ?? panX, ay = anchorY ?? panY, ratio = next / zoom;
        return { viewport: { zoom: next, panX: ax - (ax - panX) * ratio, panY: ay - (ay - panY) * ratio } };
      }),
    setZoom: (zoom) => set((s) => ({ viewport: { ...s.viewport, zoom: clampZoom(zoom) } })),
    resetViewport: () => set({ viewport: INITIAL_VIEWPORT }),

    doc: null,
    setDoc: (doc) => {
      undoStack.length = 0; redoStack.length = 0; floorPending.clear(); wallPending.clear();
      objectsDirty = false; topDirty = false; effectsDirty = false; areasDirty = false; resizedDirty = false; strokeSnap = null; strokeChanged = false;
      set({ doc, revision: 0, undoDepth: 0, redoDepth: 0, selection: null, selectedObjectId: null, clipboard: null });
    },

    selectedFloorPaletteId: null,
    setSelectedFloor: (id) => set({ selectedFloorPaletteId: id }),
    selectedObjectPaletteId: null,
    setSelectedObject: (id) => set({ selectedObjectPaletteId: id }),
    selectedEffect: null,
    setSelectedEffect: (k) => set({ selectedEffect: k }),

    selection: null,
    setSelection: (selection) => set({ selection }),
    selectedObjectId: null,

    revision: 0, undoDepth: 0, redoDepth: 0,

    beginStroke: () => { strokeSnap = snapshot(); strokeChanged = false; },
    endStroke: () => { if (strokeChanged && strokeSnap) { pushHistory(strokeSnap); commit(); } strokeSnap = null; strokeChanged = false; },

    paintFloorAt: (x, y) => { const id = get().selectedFloorPaletteId; if (id == null) return; if (applyFloorCell(x, y, id)) strokeChanged = true; },
    eraseFloorAt: (x, y) => { if (applyFloorCell(x, y, null)) strokeChanged = true; },
    stampWallAt: (x, y) => { if (applyWallCell(x, y, true)) strokeChanged = true; },
    eraseWallAt: (x, y) => { if (applyWallCell(x, y, false)) strokeChanged = true; },

    fillSelection: (mode) => {
      const { doc, selection, selectedFloorPaletteId, activeLayer } = get();
      if (!doc || !selection || (activeLayer !== 'floor' && activeLayer !== 'wall')) return;
      const snap = snapshot();
      let changed = false;
      for (let y = selection.y; y < selection.y + selection.h; y++) {
        for (let x = selection.x; x < selection.x + selection.w; x++) {
          if (activeLayer === 'floor') { const v = mode === 'stamp' ? selectedFloorPaletteId : null; if (mode === 'stamp' && v == null) continue; if (applyFloorCell(x, y, v)) changed = true; }
          else { if (applyWallCell(x, y, mode === 'stamp')) changed = true; }
        }
      }
      if (changed) { pushHistory(snap); commit(); }
    },

    objectAt: (x, y, layer) => {
      const arr = get().doc?.[layer === 'top' ? 'topObjects' : 'objects'];
      if (!arr) return null;
      // Match anywhere within the piece's rendered box (spans upward from base).
      for (let i = arr.length - 1; i >= 0; i--) {
        const f = arr[i];
        if (x >= f.x && x < f.x + f.tilesW && y <= f.y && y > f.y - f.tilesH) return f;
      }
      return null;
    },
    placeObject: (obj, layer) => {
      const d = get().doc; if (!d) return;
      const snap = snapshot();
      if (layer === 'top') { d.topObjects.push(obj); topDirty = true; } else { d.objects.push(obj); objectsDirty = true; }
      pushHistory(snap); commit();
    },
    removeObject: (id, layer) => {
      const d = get().doc; if (!d) return;
      const key = layer === 'top' ? 'topObjects' : 'objects';
      const idx = d[key].findIndex((f) => f.id === id);
      if (idx < 0) return;
      const snap = snapshot();
      d[key].splice(idx, 1);
      if (layer === 'top') topDirty = true; else objectsDirty = true;
      set({ selectedObjectId: null });
      pushHistory(snap); commit();
    },
    selectObjectAt: (x, y, layer) => set({ selectedObjectId: get().objectAt(x, y, layer)?.id ?? null }),
    moveSelectedTo: (x, y, layer) => {
      const d = get().doc; const id = get().selectedObjectId; if (!d || !id) return;
      const arr = layer === 'top' ? d.topObjects : d.objects;
      const f = arr.find((o) => o.id === id); if (!f) return;
      if (f.x === x && f.y === y) return;
      f.x = x; f.y = y;
      if (layer === 'top') topDirty = true; else objectsDirty = true;
      strokeChanged = true;
    },
    deleteSelected: (layer) => { const id = get().selectedObjectId; if (id) get().removeObject(id, layer); },

    stampEffectAt: (x, y) => {
      const d = get().doc; const eff = get().selectedEffect;
      if (!d || (eff !== 'startingPoint' && eff !== 'impassable')) return;
      const existing = d.tileEffects.find((e) => e.x === x && e.y === y);
      if (existing && existing.kind === eff) return; // no change
      d.tileEffects = d.tileEffects.filter((e) => !(e.x === x && e.y === y));
      d.tileEffects.push(eff === 'impassable' ? { x, y, kind: 'impassable' } : { x, y, kind: 'startingPoint' });
      effectsDirty = true; strokeChanged = true;
    },
    eraseEffectAt: (x, y) => {
      const d = get().doc; if (!d) return false;
      if (!d.tileEffects.some((e) => e.x === x && e.y === y)) return false;
      d.tileEffects = d.tileEffects.filter((e) => !(e.x === x && e.y === y));
      effectsDirty = true; strokeChanged = true; return true;
    },
    areaAt: (x, y) => {
      const areas = get().doc?.areas; if (!areas) return null;
      for (let i = areas.length - 1; i >= 0; i--) { const a = areas[i]; if (x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height) return a; }
      return null;
    },
    addArea: (effect, rect, name, areaId) => {
      const d = get().doc; if (!d) return;
      const snap = snapshot();
      // zoneType 'desk' → the game shows a name PILL and groups/isolates audio,
      // WITHOUT the side effects of 'meeting' (mounts MeetingControl + sets
      // in_meeting) or 'focus' (makes occupants solo, which would break private
      // audio). label=name so the pill actually renders (game keys the pill off
      // zone.label).
      d.areas.push({ id: crypto.randomUUID(), effect, name, label: name, x: rect.x, y: rect.y, width: rect.w, height: rect.h, zoneType: 'desk', areaId });
      areasDirty = true; pushHistory(snap); commit();
    },
    removeAreaAt: (x, y) => {
      const d = get().doc; const a = get().areaAt(x, y); if (!d || !a) return;
      const snap = snapshot();
      d.areas = d.areas.filter((z) => z.id !== a.id);
      areasDirty = true; pushHistory(snap); commit();
    },

    clipboard: null,
    clearClipboard: () => set({ clipboard: null }),
    copyRegion: (rect) => {
      const d = get().doc; if (!d) return;
      // Clamp the marquee to the map so the clipboard never holds phantom cells.
      const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
      const x1 = Math.min(d.width, rect.x + rect.w), y1 = Math.min(d.height, rect.y + rect.h);
      const w = x1 - x0, h = y1 - y0;
      if (w <= 0 || h <= 0) return;
      const inRegion = (o: { x: number; y: number }) => o.x >= x0 && o.x < x1 && o.y >= y0 && o.y < y1;
      set({
        clipboard: {
          w, h,
          floor: Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => d.floor[y0 + y]?.[x0 + x] ?? null)),
          wall: Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => d.wall[y0 + y]?.[x0 + x] ?? false)),
          // Objects belong to the region by their BASE tile (same rule resize
          // uses); coordinates become region-relative.
          objects: d.objects.filter(inRegion).map((o) => ({ ...o, x: o.x - x0, y: o.y - y0 })),
          topObjects: d.topObjects.filter(inRegion).map((o) => ({ ...o, x: o.x - x0, y: o.y - y0 })),
          // Portal targetX/Y intentionally NOT rebased — see EditorClipboard.
          tileEffects: d.tileEffects.filter(inRegion).map((e) => ({ ...e, x: e.x - x0, y: e.y - y0 })),
          areas: d.areas
            .filter((a) => a.x < x1 && a.x + a.width > x0 && a.y < y1 && a.y + a.height > y0)
            .map((a) => { const ax = Math.max(a.x, x0), ay = Math.max(a.y, y0); return { ...a, x: ax - x0, y: ay - y0, width: Math.min(a.x + a.width, x1) - ax, height: Math.min(a.y + a.height, y1) - ay }; }),
        },
      });
    },
    pasteAt: (px, py) => {
      const d = get().doc; const cb = get().clipboard;
      if (!d || !cb) return null;
      const snap = snapshot();
      let changed = false;
      let clipped = px < 0 || py < 0 || px + cb.w > d.width || py + cb.h > d.height;
      // Grids: exact replication of the copied block (nulls/false included), so
      // pasting reproduces the source area rather than merging with the target.
      for (let y = 0; y < cb.h; y++) for (let x = 0; x < cb.w; x++) {
        const tx = px + x, ty = py + y;
        if (tx < 0 || tx >= d.width || ty < 0 || ty >= d.height) continue;
        if (applyFloorCell(tx, ty, cb.floor[y][x])) changed = true;
        if (applyWallCell(tx, ty, cb.wall[y][x])) changed = true;
      }
      const inMap = (o: { x: number; y: number }) => o.x >= 0 && o.x < d.width && o.y >= 0 && o.y < d.height;
      // Entities: fresh ids so the copies are independent; out-of-map ones are
      // dropped (reported via `clipped`). privateArea keeps areaId on purpose.
      for (const o of [...cb.objects, ...cb.topObjects]) {
        const isTop = cb.topObjects.includes(o);
        const placed = { ...o, id: crypto.randomUUID(), x: o.x + px, y: o.y + py };
        if (!inMap(placed)) { clipped = true; continue; }
        if (isTop) { d.topObjects.push(placed); topDirty = true; } else { d.objects.push(placed); objectsDirty = true; }
        changed = true;
      }
      let portals = 0;
      for (const e of cb.tileEffects) {
        const placed = { ...e, x: e.x + px, y: e.y + py };
        if (!inMap(placed)) { clipped = true; continue; }
        // One effect per tile (same rule as stampEffectAt/addPortal).
        d.tileEffects = d.tileEffects.filter((ex) => !(ex.x === placed.x && ex.y === placed.y));
        d.tileEffects.push(placed);
        if (placed.kind === 'portal') portals++;
        effectsDirty = true; changed = true;
      }
      for (const a of cb.areas) {
        const ax = a.x + px, ay = a.y + py;
        const nx = Math.max(0, ax), ny = Math.max(0, ay);
        const width = Math.min(ax + a.width, d.width) - nx, height = Math.min(ay + a.height, d.height) - ny;
        if (width <= 0 || height <= 0) { clipped = true; continue; }
        if (width !== a.width || height !== a.height) clipped = true;
        d.areas.push({ ...a, id: crypto.randomUUID(), x: nx, y: ny, width, height });
        areasDirty = true; changed = true;
      }
      if (changed) { pushHistory(snap); commit(); }
      return { clipped, portals };
    },

    addPortal: (x, y, cfg) => {
      const d = get().doc; if (!d) return;
      const snap = snapshot();
      d.tileEffects = d.tileEffects.filter((e) => !(e.x === x && e.y === y));
      d.tileEffects.push({ x, y, kind: 'portal', targetSlug: cfg.targetSlug, targetX: cfg.targetX, targetY: cfg.targetY, label: cfg.label });
      effectsDirty = true; pushHistory(snap); commit();
    },

    resizeMap: (width, height) => {
      const d = get().doc; if (!d || width < 1 || height < 1) return;
      const snap = snapshot();
      const oldFloor = d.floor, oldWall = d.wall;
      d.floor = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => (y < oldFloor.length && x < (oldFloor[y]?.length ?? 0)) ? oldFloor[y][x] : null));
      d.wall = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => (y < oldWall.length && x < (oldWall[y]?.length ?? 0)) ? oldWall[y][x] : false));
      d.width = width; d.height = height;
      const inB = (o: { x: number; y: number }) => o.x >= 0 && o.x < width && o.y >= 0 && o.y < height;
      d.objects = d.objects.filter(inB);
      d.topObjects = d.topObjects.filter(inB);
      d.tileEffects = d.tileEffects.filter(inB);
      d.areas = d.areas
        .map((a) => { const nx = Math.max(0, a.x), ny = Math.max(0, a.y); return { ...a, x: nx, y: ny, width: Math.min(a.x + a.width, width) - nx, height: Math.min(a.y + a.height, height) - ny }; })
        .filter((a) => a.width > 0 && a.height > 0);
      resizedDirty = true; objectsDirty = true; topDirty = true; effectsDirty = true; areasDirty = true;
      pushHistory(snap); set({ selection: null }); commit();
    },

    undo: () => {
      const cur = snapshot(); const target = undoStack.pop();
      if (!cur || !target) return;
      redoStack.push(cur); if (redoStack.length > HISTORY_LIMIT) redoStack.shift();
      applyGridSnapshot(target); restoreObjects(target);
      set({ selectedObjectId: null, selection: null }); commit();
    },
    redo: () => {
      const cur = snapshot(); const target = redoStack.pop();
      if (!cur || !target) return;
      undoStack.push(cur); if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      applyGridSnapshot(target); restoreObjects(target);
      set({ selectedObjectId: null, selection: null }); commit();
    },

    takePending: () => {
      const d = get().doc;
      const out: SavePayload = {
        objects: objectsDirty && d ? cloneObjs(d.objects) : undefined,
        topObjects: topDirty && d ? cloneObjs(d.topObjects) : undefined,
        tileEffects: effectsDirty && d ? cloneEffects(d.tileEffects) : undefined,
        areas: areasDirty && d ? cloneAreas(d.areas) : undefined,
      };
      if (resizedDirty && d) {
        // A resize replaces the whole grid + dims; per-tile diffs don't apply.
        out.width = d.width; out.height = d.height; out.floor = cloneFloor(d.floor); out.wall = cloneWall(d.wall);
        floorPending.clear(); wallPending.clear();
      } else {
        out.floorChanges = Array.from(floorPending.values());
        out.wallChanges = Array.from(wallPending.values());
      }
      floorPending.clear(); wallPending.clear(); objectsDirty = false; topDirty = false; effectsDirty = false; areasDirty = false; resizedDirty = false;
      return out;
    },
    requeuePending: (p) => {
      for (const c of p.floorChanges ?? []) { const k = `${c.x},${c.y}`; if (!floorPending.has(k)) floorPending.set(k, c); }
      for (const c of p.wallChanges ?? []) { const k = `${c.x},${c.y}`; if (!wallPending.has(k)) wallPending.set(k, c); }
      if (p.width != null) resizedDirty = true;
      if (p.objects) objectsDirty = true;
      if (p.topObjects) topDirty = true;
      if (p.tileEffects) effectsDirty = true;
      if (p.areas) areasDirty = true;
      set((s) => ({ revision: s.revision + 1 }));
    },
  };
});
