import { create } from 'zustand';

// ZEP-style Room Editor — Potong 0 foundation state. Deliberately structured up
// front (layers, tools, viewport) so later potongan (Stamp/Eraser/Copy/Undo/
// tile effects) only FILL this in rather than reshape it. In Potong 0 only the
// viewport (Hand pan + zoom) is wired; the layer/tool fields already exist so
// the toolbar skeleton can bind to them.

// The 5 ZEP layers, in draw order (floor at the bottom, tile effects on top).
export type EditorLayer = 'floor' | 'wall' | 'objects' | 'top' | 'effects';
export const EDITOR_LAYERS: { id: EditorLayer; label: string }[] = [
  { id: 'floor', label: 'Floor' },
  { id: 'wall', label: 'Wall' },
  { id: 'objects', label: 'Objects' },
  { id: 'top', label: 'Top objects' },
  { id: 'effects', label: 'Tile effects' },
];

// Tools. 'hand' (pan) is the only one that does anything in Potong 0; the rest
// are placeholders the toolbar renders but that don't act yet.
export type EditorTool = 'select' | 'stamp' | 'eraser' | 'hand' | 'copy';
export const EDITOR_TOOLS: { id: EditorTool; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'stamp', label: 'Stamp' },
  { id: 'eraser', label: 'Eraser' },
  { id: 'hand', label: 'Hand' },
  { id: 'copy', label: 'Copy' },
];

export interface EditorViewport {
  // Pan is stored in SCREEN pixels (canvas translate); zoom is a scale factor.
  panX: number;
  panY: number;
  zoom: number;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

interface EditorState {
  activeLayer: EditorLayer;
  setActiveLayer: (layer: EditorLayer) => void;

  activeTool: EditorTool;
  setActiveTool: (tool: EditorTool) => void;

  viewport: EditorViewport;
  setPan: (panX: number, panY: number) => void;
  panBy: (dx: number, dy: number) => void;
  // Zoom toward a screen-space anchor (defaults to the current pan origin) so
  // the point under the cursor stays put — the usual map-editor feel.
  zoomBy: (factor: number, anchorX?: number, anchorY?: number) => void;
  setZoom: (zoom: number) => void;
  resetViewport: () => void;
}

const INITIAL_VIEWPORT: EditorViewport = { panX: 0, panY: 0, zoom: 1 };

export const useEditorStore = create<EditorState>((set) => ({
  activeLayer: 'floor',
  setActiveLayer: (activeLayer) => set({ activeLayer }),

  // Hand is the only functional tool in Potong 0, so it's the sensible default.
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
      // Keep the world point under the anchor fixed while scaling.
      const ax = anchorX ?? panX;
      const ay = anchorY ?? panY;
      const ratio = next / zoom;
      return { viewport: { zoom: next, panX: ax - (ax - panX) * ratio, panY: ay - (ay - panY) * ratio } };
    }),
  setZoom: (zoom) => set((s) => ({ viewport: { ...s.viewport, zoom: clampZoom(zoom) } })),
  resetViewport: () => set({ viewport: INITIAL_VIEWPORT }),
}));
