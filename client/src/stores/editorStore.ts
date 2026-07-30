import { create } from 'zustand';
import type { LayerData } from '@virtualmeet/shared';

// ZEP-style Room Editor state. Potong 0 laid down layers/tools/viewport; Potong
// 2 adds the actual editing document (`doc`), the FLOOR-layer tools (stamp /
// eraser / select-fill), a per-session undo/redo history, and a per-tile
// change queue for debounced saving. Only the floor layer is editable here;
// wall/objects/effects come in later potongan.

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
  // Copy arrives in Potong 7 — shown disabled so the row's shape is stable.
  { id: 'copy', label: 'Copy', key: 'C' },
];

export interface EditorViewport { panX: number; panY: number; zoom: number; }
export interface Selection { x: number; y: number; w: number; h: number; }
export interface FloorChange { x: number; y: number; value: string | null; }
type FloorGrid = (string | null)[][];

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
const HISTORY_LIMIT = 50;

const cloneFloor = (f: FloorGrid): FloorGrid => f.map((row) => row.slice());

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

  // ── Editing document (Potong 2) ────────────────────────────────────
  doc: LayerData | null;
  setDoc: (doc: LayerData) => void;

  selectedFloorPaletteId: string | null;
  setSelectedFloor: (id: string | null) => void;

  selection: Selection | null;
  setSelection: (sel: Selection | null) => void;

  // Bumped on every committed edit — the page watches it to debounce-save.
  revision: number;
  undoDepth: number;
  redoDepth: number;

  // Floor-tool actions. paint/erase are grouped into one undo step per stroke
  // via beginStroke/endStroke.
  beginStroke: () => void;
  paintFloorAt: (x: number, y: number) => void;
  eraseFloorAt: (x: number, y: number) => void;
  endStroke: () => void;
  fillSelection: (mode: 'stamp' | 'erase') => void;
  undo: () => void;
  redo: () => void;

  // Per-tile change queue drained by the debounced save (per-tile last-write-
  // wins on the server, so two admins never clobber each other's whole grid).
  takePendingFloorChanges: () => FloorChange[];
  // Put changes back if a save failed (a newer edit to the same tile wins).
  requeueFloorChanges: (changes: FloorChange[]) => void;
}

const INITIAL_VIEWPORT: EditorViewport = { panX: 0, panY: 0, zoom: 1 };

// Non-reactive internals — mutated in place. The canvas reads `doc` every rAF
// frame, so per-tile paints don't need a React re-render; only committed edits
// bump `revision` (which drives save + undo/redo button state).
const undoStack: FloorGrid[] = [];
const redoStack: FloorGrid[] = [];
const pending = new Map<string, FloorChange>();
let strokeSnapshot: FloorGrid | null = null;
let strokeChanged = false;

export const useEditorStore = create<EditorState>((set, get) => {
  // Mutates one floor cell in place + queues it for save. Returns whether it
  // actually changed. Does NOT bump revision (callers commit in batches).
  const applyCell = (x: number, y: number, value: string | null): boolean => {
    const doc = get().doc;
    const row = doc?.floor[y];
    if (!row || x < 0 || x >= row.length) return false;
    if (row[x] === value) return false;
    row[x] = value;
    pending.set(`${x},${y}`, { x, y, value });
    return true;
  };

  const commit = () => set((s) => ({ revision: s.revision + 1, undoDepth: undoStack.length, redoDepth: redoStack.length }));

  return {
    activeLayer: 'floor',
    setActiveLayer: (activeLayer) => set({ activeLayer }),
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
        const ax = anchorX ?? panX;
        const ay = anchorY ?? panY;
        const ratio = next / zoom;
        return { viewport: { zoom: next, panX: ax - (ax - panX) * ratio, panY: ay - (ay - panY) * ratio } };
      }),
    setZoom: (zoom) => set((s) => ({ viewport: { ...s.viewport, zoom: clampZoom(zoom) } })),
    resetViewport: () => set({ viewport: INITIAL_VIEWPORT }),

    doc: null,
    setDoc: (doc) => {
      undoStack.length = 0; redoStack.length = 0; pending.clear();
      strokeSnapshot = null; strokeChanged = false;
      set({ doc, revision: 0, undoDepth: 0, redoDepth: 0, selection: null });
    },

    selectedFloorPaletteId: null,
    setSelectedFloor: (id) => set({ selectedFloorPaletteId: id }),

    selection: null,
    setSelection: (selection) => set({ selection }),

    revision: 0,
    undoDepth: 0,
    redoDepth: 0,

    beginStroke: () => {
      const doc = get().doc;
      if (!doc) return;
      strokeSnapshot = cloneFloor(doc.floor);
      strokeChanged = false;
    },
    paintFloorAt: (x, y) => {
      const id = get().selectedFloorPaletteId;
      if (id == null) return;
      if (applyCell(x, y, id)) strokeChanged = true;
    },
    eraseFloorAt: (x, y) => {
      if (applyCell(x, y, null)) strokeChanged = true;
    },
    endStroke: () => {
      if (strokeChanged && strokeSnapshot) {
        undoStack.push(strokeSnapshot);
        if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
        redoStack.length = 0;
        commit();
      }
      strokeSnapshot = null;
      strokeChanged = false;
    },
    fillSelection: (mode) => {
      const { doc, selection, selectedFloorPaletteId } = get();
      if (!doc || !selection) return;
      const value = mode === 'stamp' ? selectedFloorPaletteId : null;
      if (mode === 'stamp' && value == null) return; // nothing selected to stamp
      const snap = cloneFloor(doc.floor);
      let changed = false;
      for (let y = selection.y; y < selection.y + selection.h; y++) {
        for (let x = selection.x; x < selection.x + selection.w; x++) {
          if (applyCell(x, y, value)) changed = true;
        }
      }
      if (changed) {
        undoStack.push(snap);
        if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
        redoStack.length = 0;
        commit();
      }
    },
    undo: () => {
      const doc = get().doc;
      const target = undoStack.pop();
      if (!doc || !target) return;
      redoStack.push(cloneFloor(doc.floor));
      if (redoStack.length > HISTORY_LIMIT) redoStack.shift();
      for (let y = 0; y < target.length; y++) {
        for (let x = 0; x < target[y].length; x++) applyCell(x, y, target[y][x]);
      }
      commit();
    },
    redo: () => {
      const doc = get().doc;
      const target = redoStack.pop();
      if (!doc || !target) return;
      undoStack.push(cloneFloor(doc.floor));
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      for (let y = 0; y < target.length; y++) {
        for (let x = 0; x < target[y].length; x++) applyCell(x, y, target[y][x]);
      }
      commit();
    },

    takePendingFloorChanges: () => {
      const out = Array.from(pending.values());
      pending.clear();
      return out;
    },
    requeueFloorChanges: (changes) => {
      for (const c of changes) {
        const k = `${c.x},${c.y}`;
        if (!pending.has(k)) pending.set(k, c); // a newer edit to this tile wins
      }
      set((s) => ({ revision: s.revision + 1 }));
    },
  };
});
