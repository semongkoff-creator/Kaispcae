import { create } from 'zustand';
import type { LayerData, Furniture } from '@virtualmeet/shared';

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

interface Snapshot { floor: FloorGrid; wall: WallGrid; objects: Furniture[]; topObjects: Furniture[]; }

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

  undo: () => void;
  redo: () => void;

  takePending: () => { floorChanges: FloorChange[]; wallChanges: WallChange[]; objects?: Furniture[]; topObjects?: Furniture[] };
  requeuePending: (p: { floorChanges: FloorChange[]; wallChanges: WallChange[]; objects?: Furniture[]; topObjects?: Furniture[] }) => void;
}

const INITIAL_VIEWPORT: EditorViewport = { panX: 0, panY: 0, zoom: 1 };

// Non-reactive internals mutated in place; only committed edits bump `revision`.
const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];
const floorPending = new Map<string, FloorChange>();
const wallPending = new Map<string, WallChange>();
let objectsDirty = false;
let topDirty = false;
let strokeSnap: Snapshot | null = null;
let strokeChanged = false;

export const useEditorStore = create<EditorState>((set, get) => {
  const snapshot = (): Snapshot | null => {
    const d = get().doc;
    if (!d) return null;
    return { floor: cloneFloor(d.floor), wall: cloneWall(d.wall), objects: cloneObjs(d.objects), topObjects: cloneObjs(d.topObjects) };
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
  // Replace object arrays from a snapshot on undo/redo (mark for full save).
  const restoreObjects = (snap: Snapshot) => {
    const d = get().doc; if (!d) return;
    d.objects = cloneObjs(snap.objects); d.topObjects = cloneObjs(snap.topObjects);
    objectsDirty = true; topDirty = true;
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
      objectsDirty = false; topDirty = false; strokeSnap = null; strokeChanged = false;
      set({ doc, revision: 0, undoDepth: 0, redoDepth: 0, selection: null, selectedObjectId: null });
    },

    selectedFloorPaletteId: null,
    setSelectedFloor: (id) => set({ selectedFloorPaletteId: id }),
    selectedObjectPaletteId: null,
    setSelectedObject: (id) => set({ selectedObjectPaletteId: id }),

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

    undo: () => {
      const cur = snapshot(); const target = undoStack.pop();
      if (!cur || !target) return;
      redoStack.push(cur); if (redoStack.length > HISTORY_LIMIT) redoStack.shift();
      for (let y = 0; y < target.floor.length; y++) for (let x = 0; x < target.floor[y].length; x++) applyFloorCell(x, y, target.floor[y][x]);
      for (let y = 0; y < target.wall.length; y++) for (let x = 0; x < target.wall[y].length; x++) applyWallCell(x, y, target.wall[y][x]);
      restoreObjects(target);
      set({ selectedObjectId: null, selection: null }); commit();
    },
    redo: () => {
      const cur = snapshot(); const target = redoStack.pop();
      if (!cur || !target) return;
      undoStack.push(cur); if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      for (let y = 0; y < target.floor.length; y++) for (let x = 0; x < target.floor[y].length; x++) applyFloorCell(x, y, target.floor[y][x]);
      for (let y = 0; y < target.wall.length; y++) for (let x = 0; x < target.wall[y].length; x++) applyWallCell(x, y, target.wall[y][x]);
      restoreObjects(target);
      set({ selectedObjectId: null, selection: null }); commit();
    },

    takePending: () => {
      const d = get().doc;
      const out = {
        floorChanges: Array.from(floorPending.values()),
        wallChanges: Array.from(wallPending.values()),
        objects: objectsDirty && d ? cloneObjs(d.objects) : undefined,
        topObjects: topDirty && d ? cloneObjs(d.topObjects) : undefined,
      };
      floorPending.clear(); wallPending.clear(); objectsDirty = false; topDirty = false;
      return out;
    },
    requeuePending: (p) => {
      for (const c of p.floorChanges) { const k = `${c.x},${c.y}`; if (!floorPending.has(k)) floorPending.set(k, c); }
      for (const c of p.wallChanges) { const k = `${c.x},${c.y}`; if (!wallPending.has(k)) wallPending.set(k, c); }
      if (p.objects) objectsDirty = true;
      if (p.topObjects) topDirty = true;
      set((s) => ({ revision: s.revision + 1 }));
    },
  };
});
