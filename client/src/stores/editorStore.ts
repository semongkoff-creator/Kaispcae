import { create } from 'zustand';
import type { LayerData, Furniture, TileEffect, AreaEffect, CustomAssetEntry, ReferenceImageData, Direction } from '@virtualmeet/shared';
import { AVATAR_SCALE_MIN, AVATAR_SCALE_MAX } from '@virtualmeet/shared';

// 'impassableArea' — Item #9's draggable/resizable collision RECTANGLE tool,
// distinct from the older per-tile 'impassable' above (same distinction as
// 'mapLocation'/'privateArea' being rectangles vs. e.g. 'door' being a point).
// Maps to AreaEffect.effect: 'impassable' (see mapLayers.ts).
export type TileEffectKind = 'startingPoint' | 'impassable' | 'mapLocation' | 'privateArea' | 'impassableArea' | 'focusArea' | 'meetingArea' | 'wallArea' | 'portal' | 'door' | 'sittable' | 'claimableSeat';

// Follow-up — a "Kursi Diklaim" marker used to be stamped wherever the admin
// clicked, completely independent of any Furniture piece, so it could
// easily land on a chair's tall visual/overhead rows instead of its actual
// collision tile (Furniture.tilesH > 1 pieces only collide on their BOTTOM
// row — see Furniture's own doc comment; anything above is purely
// overhead art). Snapping to the nearest matching chair's real base row
// here means the marker can never drift from where the chair actually
// blocks movement, without needing a settings panel or any new per-marker
// data. A no-op (returns x,y unchanged) when no chair's footprint covers
// the clicked tile, or when the matching chair has tilesH === 1 (base row
// IS the visual row already).
function snapToNearestChair(doc: LayerData, x: number, y: number): { x: number; y: number } {
  for (const f of [...doc.objects, ...doc.topObjects]) {
    if (!f.isInteractable) continue;
    const top = f.y - (f.tilesH - 1);
    if (x >= f.x && x < f.x + f.tilesW && y >= top && y <= f.y) {
      return { x: Math.min(Math.max(x, f.x), f.x + f.tilesW - 1), y: f.y };
    }
  }
  return { x, y };
}

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
  // Fitur 15 — custom wall skin travels with the copied region, same as
  // floor's paletteId grid.
  wallPaletteId: WallPaletteGrid;
  objects: Furniture[];
  topObjects: Furniture[];
  tileEffects: TileEffect[];
  areas: AreaEffect[];
}
export interface FloorChange { x: number; y: number; value: string | null; }
// paletteId only set on a stamp (never on an erase — see applyWallCell):
// null/absent means "plain wall, no custom skin", not "leave whatever skin
// was there before".
export interface WallChange { x: number; y: number; value: boolean; paletteId?: string | null; }
type FloorGrid = (string | null)[][];
type WallGrid = boolean[][];
type WallPaletteGrid = (string | null)[][];
const emptyWallPaletteGrid = (w: number, h: number): WallPaletteGrid => Array.from({ length: h }, () => Array.from({ length: w }, () => null));

const MIN_ZOOM = 0.25, MAX_ZOOM = 3;
const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
const HISTORY_LIMIT = 50;

const cloneFloor = (f: FloorGrid): FloorGrid => f.map((r) => r.slice());
const cloneWall = (w: WallGrid): WallGrid => w.map((r) => r.slice());
const cloneWallPaletteId = (w: WallPaletteGrid): WallPaletteGrid => w.map((r) => r.slice());
const cloneObjs = (o: Furniture[]): Furniture[] => o.map((x) => ({ ...x }));
const cloneEffects = (e: TileEffect[]): TileEffect[] => e.map((x) => ({ ...x }));
const cloneAreas = (a: AreaEffect[]): AreaEffect[] => a.map((x) => ({ ...x }));

interface Snapshot { width: number; height: number; floor: FloorGrid; wall: WallGrid; wallPaletteId: WallPaletteGrid; objects: Furniture[]; topObjects: Furniture[]; tileEffects: TileEffect[]; areas: AreaEffect[]; }

interface EditorState {
  activeLayer: EditorLayer;
  setActiveLayer: (layer: EditorLayer) => void;
  activeTool: EditorTool;
  setActiveTool: (tool: EditorTool) => void;
  // Stamp/eraser brush size (in tiles, width × height — centered on the
  // clicked tile, need not be square) for Floor, Wall, and the position-only
  // Tile Effects (startingPoint, impassable, door, sittable, claimableSeat).
  // Only used in stampMode 'click'; doesn't apply to Objects/Top (each
  // already has its own tilesW/tilesH), Portal (two-click dialog flow), or
  // mapLocation/privateArea (their "size" is the dragged rectangle).
  brushW: number;
  brushH: number;
  setBrushSize: (w: number, h: number) => void;
  // Two ways to apply Floor/Wall/point-effect stamps: 'click' paints a
  // brushW×brushH area per click (or per tile while dragging); 'block' drags
  // out an arbitrary rectangle (reusing the Select tool's own rubber-band —
  // see `selection`) and applies the current stamp/eraser to the WHOLE
  // rectangle only once the mouse is released (see fillSelection below).
  stampMode: 'click' | 'block';
  setStampMode: (mode: 'click' | 'block') => void;

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
  // Fitur 15 — a custom Wall asset selected for stamping. null = plain wall
  // (the theme's default look, same as before this existed).
  selectedWallPaletteId: string | null;
  setSelectedWall: (id: string | null) => void;
  // This room's uploaded custom Floor/Wall/Object assets (Fitur 15). Not
  // undo/redo-tracked like the grids/entities above — an upload isn't a
  // paint stroke to step back through, it's a one-way "this asset now
  // exists for this room" registration (removing one is out of scope here).
  addCustomAsset: (entry: CustomAssetEntry) => void;

  // Floor-plan reference image underlay — same "one-way registration, not
  // undo/redo-tracked" posture as addCustomAsset above (adjusting opacity/
  // position while tracing isn't a paint stroke to step back through).
  // `null` clears it entirely (removes the image).
  setReferenceImage: (data: ReferenceImageData | null) => void;
  updateReferenceImage: (patch: Partial<ReferenceImageData>) => void;

  // Room-wide avatar sprite scale (see mapLayers.ts's LayerData.avatarScale)
  // — same "one-way registration, not undo/redo-tracked" posture as
  // setReferenceImage above; a slider drag isn't a paint stroke.
  setAvatarScale: (scale: number) => void;

  selection: Selection | null;
  setSelection: (sel: Selection | null) => void;
  selectedObjectId: string | null;
  // Item #9 — the currently-selected Impassable Area (see areaAt/selectAreaAt
  // below), for showing its drag/resize handles. Same "local selection, not
  // undo/redo tracked itself" posture as selectedObjectId.
  selectedAreaId: string | null;

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
  clearSelectedObject: () => void;
  moveSelectedTo: (x: number, y: number, layer: 'objects' | 'top') => void;
  deleteSelected: (layer: 'objects' | 'top') => void;
  // Fitur 15B — patches Rotate&Flip/Size/Reposition + Interactive Object
  // fields on the currently-selected piece (the "Object Settings" panel).
  // One history entry per call — the panel's number inputs already only
  // commit on blur/change, not on every keystroke.
  updateSelectedObject: (patch: Partial<Furniture>, layer: 'objects' | 'top') => void;

  // Tile effects (Potong 4).
  selectedEffect: TileEffectKind | null;
  setSelectedEffect: (k: TileEffectKind | null) => void;
  stampEffectAt: (x: number, y: number) => void; // startingPoint / impassable / door (per-tile stroke)
  eraseEffectAt: (x: number, y: number) => boolean; // removes a per-tile effect; true if one was there
  // Clears EVERY stamped tile effect in the room at once — impassable,
  // door, portal, sittable, startingPoint, all of it — back to none. One
  // history entry (undoable), same as any other mutating action here.
  resetAllTileEffects: () => void;
  // `effect` filter (Item #9) — without it, an Impassable Area rectangle
  // overlapping a zone would make hit-testing ambiguous (topmost-by-array-
  // order could resolve to either kind); every call site now scopes to the
  // effect it actually means, same principle as zones already not being
  // hit-testable by the point-effect tools.
  areaAt: (x: number, y: number, effect?: AreaEffect['effect']) => AreaEffect | null;
  addArea: (effect: 'mapLocation' | 'privateArea' | 'impassable' | 'focusArea' | 'meetingArea' | 'wallArea', rect: Selection, name: string, areaId?: string, audioIsolated?: boolean, capacity?: number) => string;
  removeAreaAt: (x: number, y: number, effect?: AreaEffect['effect']) => void;
  // Item #9 — select/move/resize/delete an EXISTING Impassable Area rectangle
  // (RoomEditorPage.tsx's drag-body / drag-handle / Delete-key interactions).
  // Mirrors the objects layer's selectedObjectId/moveSelectedTo/removeObject
  // trio, but for areas: moveAreaBy/resizeArea are called every mousemove
  // while dragging (like moveSelectedTo) and rely on the caller's own
  // beginStroke/endStroke to batch the whole drag into ONE undo step —
  // neither pushes history itself.
  selectAreaAt: (x: number, y: number, effect?: AreaEffect['effect']) => void;
  clearSelectedArea: () => void;
  moveAreaBy: (id: string, dx: number, dy: number) => void;
  resizeArea: (id: string, rect: Selection) => void;
  removeArea: (id: string) => void;
  // ZEP-style door password — patches the password fields on an EXISTING
  // door TileEffect (the Door Settings panel, shown while the door effect is
  // selected and the Select tool clicks an existing door tile). One history
  // entry per call, same as updateSelectedObject for furniture.
  doorEffectAt: (x: number, y: number) => TileEffect | null;
  updateDoorTileEffect: (x: number, y: number, patch: Partial<Pick<TileEffect, 'doorPasswordEnabled' | 'doorPassword' | 'doorPasswordDescription' | 'doorFailureMessage'>>) => void;
  // Same "settings panel for an EXISTING stamped tile" pattern as door above
  // — the Sittable Settings panel (Select tool + an existing sittable tile)
  // patches its one field, the direction the avatar faces once seated there.
  sittableEffectAt: (x: number, y: number) => TileEffect | null;
  updateSittableTileEffect: (x: number, y: number, direction: Direction) => void;

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
  wallPaletteId?: WallPaletteGrid;
  objects?: Furniture[];
  topObjects?: Furniture[];
  tileEffects?: TileEffect[];
  areas?: AreaEffect[];
  customAssets?: CustomAssetEntry[];
  referenceImage?: ReferenceImageData | null;
  avatarScale?: number;
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
let customAssetsDirty = false; // Fitur 15 — a custom asset was registered this session
let referenceImageDirty = false;
let avatarScaleDirty = false;
let resizedDirty = false; // dims/grids changed → save full floor+wall+dims
let strokeSnap: Snapshot | null = null;
let strokeChanged = false;

export const useEditorStore = create<EditorState>((set, get) => {
  const snapshot = (): Snapshot | null => {
    const d = get().doc;
    if (!d) return null;
    return {
      width: d.width, height: d.height,
      floor: cloneFloor(d.floor), wall: cloneWall(d.wall),
      wallPaletteId: cloneWallPaletteId(d.wallPaletteId ?? emptyWallPaletteGrid(d.width, d.height)),
      objects: cloneObjs(d.objects), topObjects: cloneObjs(d.topObjects), tileEffects: cloneEffects(d.tileEffects), areas: cloneAreas(d.areas),
    };
  };
  const pushHistory = (snap: Snapshot | null) => { if (!snap) return; undoStack.push(snap); if (undoStack.length > HISTORY_LIMIT) undoStack.shift(); redoStack.length = 0; };
  const commit = () => set((s) => ({ revision: s.revision + 1, undoDepth: undoStack.length, redoDepth: redoStack.length }));

  const applyFloorCell = (x: number, y: number, value: string | null): boolean => {
    const row = get().doc?.floor[y];
    if (!row || x < 0 || x >= row.length) return false;
    if (row[x] === value) return false;
    row[x] = value; floorPending.set(`${x},${y}`, { x, y, value }); return true;
  };
  // Fitur 15 — `paletteId` is only ever meaningful when `value` is true (a
  // stamp); an erase always clears any custom skin the tile had, so callers
  // never need to pass it there. Lazily allocates doc.wallPaletteId on first
  // use — older rooms/sessions that never touch a custom wall skin never pay
  // for this grid at all.
  const applyWallCell = (x: number, y: number, value: boolean, paletteId?: string | null): boolean => {
    const d = get().doc;
    const row = d?.wall[y];
    if (!d || !row || x < 0 || x >= row.length) return false;
    if (!d.wallPaletteId) d.wallPaletteId = emptyWallPaletteGrid(d.width, d.height);
    const wpRow = d.wallPaletteId[y];
    const wpId: string | null = value ? (paletteId ?? null) : null;
    const wpChanged = !!wpRow && wpRow[x] !== wpId;
    if (row[x] === value && !wpChanged) return false;
    row[x] = value;
    if (wpRow) wpRow[x] = wpId;
    wallPending.set(`${x},${y}`, { x, y, value, paletteId: wpId });
    return true;
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
      d.wallPaletteId = cloneWallPaletteId(target.wallPaletteId);
      resizedDirty = true;
    } else {
      for (let y = 0; y < target.floor.length; y++) for (let x = 0; x < target.floor[y].length; x++) applyFloorCell(x, y, target.floor[y][x]);
      for (let y = 0; y < target.wall.length; y++) for (let x = 0; x < target.wall[y].length; x++) applyWallCell(x, y, target.wall[y][x], target.wallPaletteId[y]?.[x] ?? null);
    }
  };

  return {
    activeLayer: 'floor',
    setActiveLayer: (activeLayer) => set({ activeLayer, selection: null, selectedObjectId: null, selectedAreaId: null }),
    activeTool: 'hand',
    setActiveTool: (activeTool) => set({ activeTool }),
    brushW: 1,
    brushH: 1,
    setBrushSize: (w, h) => set({ brushW: Math.max(1, Math.min(30, Math.round(w))), brushH: Math.max(1, Math.min(30, Math.round(h))) }),
    stampMode: 'click',
    setStampMode: (stampMode) => set({ stampMode, selection: null }),

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
      objectsDirty = false; topDirty = false; effectsDirty = false; areasDirty = false; customAssetsDirty = false; referenceImageDirty = false; avatarScaleDirty = false; resizedDirty = false; strokeSnap = null; strokeChanged = false;
      set({ doc, revision: 0, undoDepth: 0, redoDepth: 0, selection: null, selectedObjectId: null, selectedAreaId: null, clipboard: null });
    },

    selectedFloorPaletteId: null,
    setSelectedFloor: (id) => set({ selectedFloorPaletteId: id }),
    selectedObjectPaletteId: null,
    setSelectedObject: (id) => set({ selectedObjectPaletteId: id }),
    selectedWallPaletteId: null,
    setSelectedWall: (id) => set({ selectedWallPaletteId: id }),
    addCustomAsset: (entry) => {
      const d = get().doc; if (!d) return;
      d.customAssets = [...(d.customAssets ?? []), entry];
      customAssetsDirty = true;
      commit();
    },
    setReferenceImage: (data) => {
      const d = get().doc; if (!d) return;
      d.referenceImage = data;
      referenceImageDirty = true;
      commit();
    },
    updateReferenceImage: (patch) => {
      const d = get().doc; if (!d || !d.referenceImage) return;
      d.referenceImage = { ...d.referenceImage, ...patch };
      referenceImageDirty = true;
      commit();
    },
    setAvatarScale: (scale) => {
      const d = get().doc; if (!d) return;
      d.avatarScale = Math.max(AVATAR_SCALE_MIN, Math.min(AVATAR_SCALE_MAX, scale));
      avatarScaleDirty = true;
      commit();
    },
    selectedEffect: null,
    setSelectedEffect: (k) => set({ selectedEffect: k }),

    selection: null,
    setSelection: (selection) => set({ selection }),
    selectedObjectId: null,
    selectedAreaId: null,

    revision: 0, undoDepth: 0, redoDepth: 0,

    beginStroke: () => { strokeSnap = snapshot(); strokeChanged = false; },
    endStroke: () => { if (strokeChanged && strokeSnap) { pushHistory(strokeSnap); commit(); } strokeSnap = null; strokeChanged = false; },

    paintFloorAt: (x, y) => { const id = get().selectedFloorPaletteId; if (id == null) return; if (applyFloorCell(x, y, id)) strokeChanged = true; },
    eraseFloorAt: (x, y) => { if (applyFloorCell(x, y, null)) strokeChanged = true; },
    stampWallAt: (x, y) => { if (applyWallCell(x, y, true, get().selectedWallPaletteId)) strokeChanged = true; },
    eraseWallAt: (x, y) => { if (applyWallCell(x, y, false)) strokeChanged = true; },

    fillSelection: (mode) => {
      const { doc, selection, selectedFloorPaletteId, selectedWallPaletteId, activeLayer, selectedEffect } = get();
      if (!doc || !selection || (activeLayer !== 'floor' && activeLayer !== 'wall' && activeLayer !== 'effects')) return;
      // Block-drag apply (stampMode 'block', see RoomEditorPage's endDrag) —
      // the click-brush's stampEffectAt/eraseEffectAt aren't reused here since
      // those rely on the caller's own beginStroke/endStroke for undo
      // batching; this is a single self-contained action with its own
      // snapshot, same shape as the floor/wall branches below already had.
      if (activeLayer === 'effects') {
        const eff = selectedEffect;
        if (!eff || (eff !== 'startingPoint' && eff !== 'impassable' && eff !== 'door' && eff !== 'sittable' && eff !== 'claimableSeat')) return;
        const snap = snapshot();
        let changed = false;
        for (let y = selection.y; y < selection.y + selection.h; y++) {
          for (let x = selection.x; x < selection.x + selection.w; x++) {
            if (mode === 'erase') {
              if (!doc.tileEffects.some((e) => e.x === x && e.y === y)) continue;
              doc.tileEffects = doc.tileEffects.filter((e) => !(e.x === x && e.y === y));
              changed = true;
            } else {
              // Follow-up — same chair-snap as stampEffectAt; if two tiles in
              // this rectangle both snap to the same chair, the second
              // iteration's `existing.kind === eff` below naturally no-ops
              // instead of stamping a duplicate on top.
              const target: { x: number; y: number } = eff === 'claimableSeat' ? snapToNearestChair(doc, x, y) : { x, y };
              const existing: TileEffect | undefined = doc.tileEffects.find((e) => e.x === target.x && e.y === target.y);
              if (existing && existing.kind === eff) continue;
              doc.tileEffects = doc.tileEffects.filter((e) => !(e.x === target.x && e.y === target.y));
              doc.tileEffects.push(
                eff === 'impassable' ? { x: target.x, y: target.y, kind: 'impassable' }
                : eff === 'door' ? { x: target.x, y: target.y, kind: 'door' }
                : eff === 'sittable' ? { x: target.x, y: target.y, kind: 'sittable', sitDirection: 'down' }
                : eff === 'claimableSeat' ? { x: target.x, y: target.y, kind: 'claimableSeat', id: crypto.randomUUID() }
                : { x: target.x, y: target.y, kind: 'startingPoint' },
              );
              changed = true;
            }
          }
        }
        if (changed) { effectsDirty = true; pushHistory(snap); commit(); }
        return;
      }
      const snap = snapshot();
      let changed = false;
      for (let y = selection.y; y < selection.y + selection.h; y++) {
        for (let x = selection.x; x < selection.x + selection.w; x++) {
          if (activeLayer === 'floor') { const v = mode === 'stamp' ? selectedFloorPaletteId : null; if (mode === 'stamp' && v == null) continue; if (applyFloorCell(x, y, v)) changed = true; }
          else { if (applyWallCell(x, y, mode === 'stamp', selectedWallPaletteId)) changed = true; }
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
    clearSelectedObject: () => set({ selectedObjectId: null }),
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
    updateSelectedObject: (patch, layer) => {
      const d = get().doc; const id = get().selectedObjectId; if (!d || !id) return;
      const arr = layer === 'top' ? d.topObjects : d.objects;
      const idx = arr.findIndex((o) => o.id === id); if (idx < 0) return;
      const snap = snapshot();
      arr[idx] = { ...arr[idx], ...patch };
      if (layer === 'top') topDirty = true; else objectsDirty = true;
      pushHistory(snap); commit();
    },

    stampEffectAt: (x, y) => {
      const d = get().doc; const eff = get().selectedEffect;
      if (!d || (eff !== 'startingPoint' && eff !== 'impassable' && eff !== 'door' && eff !== 'sittable' && eff !== 'claimableSeat')) return;
      // Follow-up — snap to the nearest chair's real (collision) tile BEFORE
      // the existing-effect/no-op check below, so clicking anywhere on a
      // tall chair's visual footprint always resolves to the SAME base tile.
      const target = eff === 'claimableSeat' ? snapToNearestChair(d, x, y) : { x, y };
      const existing = d.tileEffects.find((e) => e.x === target.x && e.y === target.y);
      if (existing && existing.kind === eff) return; // no change
      d.tileEffects = d.tileEffects.filter((e) => !(e.x === target.x && e.y === target.y));
      d.tileEffects.push(
        eff === 'impassable' ? { x: target.x, y: target.y, kind: 'impassable' }
        : eff === 'door' ? { x: target.x, y: target.y, kind: 'door' }
        : eff === 'sittable' ? { x: target.x, y: target.y, kind: 'sittable', sitDirection: 'down' }
        // A fresh id every stamp — even re-stamping the exact same tile is
        // treated as a brand-new marker (matches "erase then re-stamp = a
        // new marker" being this editor's only way to move one).
        : eff === 'claimableSeat' ? { x: target.x, y: target.y, kind: 'claimableSeat', id: crypto.randomUUID() }
        : { x: target.x, y: target.y, kind: 'startingPoint' },
      );
      effectsDirty = true; strokeChanged = true;
    },
    eraseEffectAt: (x, y) => {
      const d = get().doc; if (!d) return false;
      if (!d.tileEffects.some((e) => e.x === x && e.y === y)) return false;
      d.tileEffects = d.tileEffects.filter((e) => !(e.x === x && e.y === y));
      effectsDirty = true; strokeChanged = true; return true;
    },
    resetAllTileEffects: () => {
      // Effects palette items aren't all stored the same way — point stamps
      // (impassable/door/sittable/portal/startingPoint/claimableSeat) live in
      // tileEffects, but the drag-drawn rectangle effects (impassableArea/
      // privateArea/mapLocation) live in areas instead. The confirm dialog
      // promises to clear "SEMUA tile effect", so both need wiping — a
      // room's Impassable Area used to survive this button entirely.
      const d = get().doc; if (!d || (d.tileEffects.length === 0 && d.areas.length === 0)) return;
      const snap = snapshot();
      d.tileEffects = [];
      d.areas = [];
      effectsDirty = true; areasDirty = true; pushHistory(snap); commit();
    },
    doorEffectAt: (x, y) => {
      const d = get().doc; if (!d) return null;
      return d.tileEffects.find((e) => e.x === x && e.y === y && e.kind === 'door') ?? null;
    },
    updateDoorTileEffect: (x, y, patch) => {
      const d = get().doc; if (!d) return;
      const idx = d.tileEffects.findIndex((e) => e.x === x && e.y === y && e.kind === 'door');
      if (idx < 0) return;
      const snap = snapshot();
      d.tileEffects[idx] = { ...d.tileEffects[idx], ...patch };
      effectsDirty = true;
      pushHistory(snap); commit();
    },
    sittableEffectAt: (x, y) => {
      const d = get().doc; if (!d) return null;
      return d.tileEffects.find((e) => e.x === x && e.y === y && e.kind === 'sittable') ?? null;
    },
    updateSittableTileEffect: (x, y, direction) => {
      const d = get().doc; if (!d) return;
      const idx = d.tileEffects.findIndex((e) => e.x === x && e.y === y && e.kind === 'sittable');
      if (idx < 0) return;
      const snap = snapshot();
      d.tileEffects[idx] = { ...d.tileEffects[idx], sitDirection: direction };
      effectsDirty = true;
      pushHistory(snap); commit();
    },
    areaAt: (x, y, effect) => {
      const areas = get().doc?.areas; if (!areas) return null;
      for (let i = areas.length - 1; i >= 0; i--) {
        const a = areas[i];
        if (effect && a.effect !== effect) continue;
        if (x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height) return a;
      }
      return null;
    },
    addArea: (effect, rect, name, areaId, audioIsolated, capacity) => {
      const d = get().doc; if (!d) return '';
      const snap = snapshot();
      // zoneType 'desk' → the game shows a name PILL and (when audioIsolated)
      // groups/isolates audio, WITHOUT the side effects of 'meeting' (mounts
      // MeetingControl + sets in_meeting) or the OLD meaning of 'focus' (used
      // to make occupants solo/isolated, which would've broken shared
      // private audio) — 'focusArea' and 'meetingArea' are the deliberate
      // exceptions: 'focusArea' WANTS 'focus' zoneType (App.tsx auto-sets
      // workMode to 'focus'/DND for anyone standing inside), 'meetingArea'
      // WANTS 'meeting' zoneType (App.tsx auto-sets workMode to 'in_meeting'
      // + mounts MeetingControl's "Start Meeting → Lark" button — see
      // MeetingControl.tsx). Before this, there was no editor tool that ever
      // produced zoneType 'meeting' at all — a room built from scratch had
      // no way to get a working meeting area, only a room whose zones were
      // seeded directly in the database could have one. label=name so the
      // pill actually renders (game keys the pill off zone.label).
      // audioIsolated left unset defaults to isolating for privateArea and
      // NOT isolating for mapLocation — see layerDataToLegacy's inferred
      // default; irrelevant for 'focusArea' (proximity is already blocked by
      // workMode==='focus' in useProximity, independent of any zone flag) and
      // for 'impassable' (Item #9, excluded from the zones list entirely).
      const id = crypto.randomUUID();
      const zoneType = effect === 'focusArea' ? 'focus' : effect === 'meetingArea' ? 'meeting' : 'desk';
      // GameCanvas.tsx's in-game banner falls back to purple (#7c3aed) when
      // a zone has no color — fine for every other area type (they've always
      // been purple), but a meeting area gets its own teal so it reads as
      // visually distinct in-game too, not just in the editor's overlay.
      const color = effect === 'meetingArea' ? '#14b8a6' : undefined;
      d.areas.push({ id, effect, name, label: name, x: rect.x, y: rect.y, width: rect.w, height: rect.h, color, zoneType, areaId, audioIsolated, capacity });
      areasDirty = true; pushHistory(snap); commit();
      return id;
    },
    removeAreaAt: (x, y, effect) => {
      const d = get().doc; const a = get().areaAt(x, y, effect); if (!d || !a) return;
      const snap = snapshot();
      d.areas = d.areas.filter((z) => z.id !== a.id);
      areasDirty = true;
      if (get().selectedAreaId === a.id) set({ selectedAreaId: null });
      pushHistory(snap); commit();
    },
    selectAreaAt: (x, y, effect) => set({ selectedAreaId: get().areaAt(x, y, effect)?.id ?? null }),
    clearSelectedArea: () => set({ selectedAreaId: null }),
    moveAreaBy: (id, dx, dy) => {
      const d = get().doc; if (!d) return;
      const idx = d.areas.findIndex((a) => a.id === id); if (idx < 0) return;
      const a = d.areas[idx];
      const nx = Math.max(0, Math.min(d.width - a.width, a.x + dx));
      const ny = Math.max(0, Math.min(d.height - a.height, a.y + dy));
      if (nx === a.x && ny === a.y) return;
      d.areas[idx] = { ...a, x: nx, y: ny };
      areasDirty = true; strokeChanged = true;
    },
    resizeArea: (id, rect) => {
      const d = get().doc; if (!d) return;
      const idx = d.areas.findIndex((a) => a.id === id); if (idx < 0) return;
      // Free-resize follow-up — Impassable Area isn't grid-snapped (see
      // RoomEditorPage.tsx's areaResize handler), so its minimum is a small
      // FRACTION of a tile, not a whole tile like this used to enforce.
      const width = Math.max(0.2, Math.min(d.width, rect.w));
      const height = Math.max(0.2, Math.min(d.height, rect.h));
      const x = Math.max(0, Math.min(d.width - width, rect.x));
      const y = Math.max(0, Math.min(d.height - height, rect.y));
      const a = d.areas[idx];
      if (a.x === x && a.y === y && a.width === width && a.height === height) return;
      d.areas[idx] = { ...a, x, y, width, height };
      areasDirty = true; strokeChanged = true;
    },
    removeArea: (id) => {
      const d = get().doc; if (!d) return;
      const idx = d.areas.findIndex((a) => a.id === id); if (idx < 0) return;
      const snap = snapshot();
      d.areas.splice(idx, 1);
      areasDirty = true;
      set({ selectedAreaId: null });
      pushHistory(snap); commit();
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
          wallPaletteId: Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => d.wallPaletteId?.[y0 + y]?.[x0 + x] ?? null)),
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
        if (applyWallCell(tx, ty, cb.wall[y][x], cb.wallPaletteId[y][x])) changed = true;
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
      const oldFloor = d.floor, oldWall = d.wall, oldWallPaletteId = d.wallPaletteId ?? emptyWallPaletteGrid(d.width, d.height);
      d.floor = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => (y < oldFloor.length && x < (oldFloor[y]?.length ?? 0)) ? oldFloor[y][x] : null));
      d.wall = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => (y < oldWall.length && x < (oldWall[y]?.length ?? 0)) ? oldWall[y][x] : false));
      d.wallPaletteId = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => (y < oldWallPaletteId.length && x < (oldWallPaletteId[y]?.length ?? 0)) ? oldWallPaletteId[y][x] : null));
      d.width = width; d.height = height;
      const inB = (o: { x: number; y: number }) => o.x >= 0 && o.x < width && o.y >= 0 && o.y < height;
      d.objects = d.objects.filter(inB);
      d.topObjects = d.topObjects.filter(inB);
      d.tileEffects = d.tileEffects.filter(inB);
      d.areas = d.areas
        .map((a) => { const nx = Math.max(0, a.x), ny = Math.max(0, a.y); return { ...a, x: nx, y: ny, width: Math.min(a.x + a.width, width) - nx, height: Math.min(a.y + a.height, height) - ny }; })
        .filter((a) => a.width > 0 && a.height > 0);
      resizedDirty = true; objectsDirty = true; topDirty = true; effectsDirty = true; areasDirty = true;
      pushHistory(snap); set({ selection: null, selectedAreaId: null }); commit();
    },

    undo: () => {
      const cur = snapshot(); const target = undoStack.pop();
      if (!cur || !target) return;
      redoStack.push(cur); if (redoStack.length > HISTORY_LIMIT) redoStack.shift();
      applyGridSnapshot(target); restoreObjects(target);
      set({ selectedObjectId: null, selectedAreaId: null, selection: null }); commit();
    },
    redo: () => {
      const cur = snapshot(); const target = redoStack.pop();
      if (!cur || !target) return;
      undoStack.push(cur); if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      applyGridSnapshot(target); restoreObjects(target);
      set({ selectedObjectId: null, selectedAreaId: null, selection: null }); commit();
    },

    takePending: () => {
      const d = get().doc;
      const out: SavePayload = {
        objects: objectsDirty && d ? cloneObjs(d.objects) : undefined,
        topObjects: topDirty && d ? cloneObjs(d.topObjects) : undefined,
        tileEffects: effectsDirty && d ? cloneEffects(d.tileEffects) : undefined,
        areas: areasDirty && d ? cloneAreas(d.areas) : undefined,
        customAssets: customAssetsDirty && d ? [...(d.customAssets ?? [])] : undefined,
        referenceImage: referenceImageDirty && d ? (d.referenceImage ?? null) : undefined,
        avatarScale: avatarScaleDirty && d ? d.avatarScale : undefined,
      };
      if (resizedDirty && d) {
        // A resize replaces the whole grid + dims; per-tile diffs don't apply.
        out.width = d.width; out.height = d.height; out.floor = cloneFloor(d.floor); out.wall = cloneWall(d.wall);
        out.wallPaletteId = cloneWallPaletteId(d.wallPaletteId ?? emptyWallPaletteGrid(d.width, d.height));
        floorPending.clear(); wallPending.clear();
      } else {
        out.floorChanges = Array.from(floorPending.values());
        out.wallChanges = Array.from(wallPending.values());
      }
      floorPending.clear(); wallPending.clear(); objectsDirty = false; topDirty = false; effectsDirty = false; areasDirty = false; customAssetsDirty = false; referenceImageDirty = false; avatarScaleDirty = false; resizedDirty = false;
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
      if (p.customAssets) customAssetsDirty = true;
      if ('referenceImage' in p) referenceImageDirty = true;
      if (p.avatarScale != null) avatarScaleDirty = true;
      set((s) => ({ revision: s.revision + 1 }));
    },
  };
});
