import { PaletteEntry } from './tilePaletteManifest';
import { PALETTE_BY_ID } from './themeAssets';

// LimeZu Modern Interiors — the FULL themed pack (~5.400 objects across the
// categories below), imported by scripts/importLimeZuFull.mjs into
// client/public/assets/limezu-interiors/<id>/ with a manifest.json per
// category. Deliberately NOT bundled the way tilePaletteManifest.ts /
// limezu-office-manifest.ts are: at 16x the size of the Office pack, baking
// every entry into the main bundle would tax every user's initial load —
// including players who never open the Room Editor at all. Instead each
// category's manifest is fetched on demand (a static file next to its PNGs)
// and its entries registered into the SAME PALETTE_BY_ID lookup everything
// already renders from, so once loaded they behave exactly like built-in
// palette entries.

// Matches the folders scripts/importLimeZuFull.mjs actually produced on disk
// (21 — some themes in the source zip were merged or absent, e.g.
// classroom_and_library). If the import script is re-run with more themes,
// add them here; a listed id with no folder just fails its fetch with a
// console warning and an empty palette, never a crash.
export const LIMEZU_CATEGORIES: { id: string; label: string }[] = [
  { id: 'art', label: 'Art' },
  { id: 'basement', label: 'Basement' },
  { id: 'bathroom', label: 'Bathroom' },
  { id: 'bedroom', label: 'Bedroom' },
  { id: 'birthday_party', label: 'Birthday Party' },
  { id: 'christmas', label: 'Christmas' },
  { id: 'classroom_and_library', label: 'Classroom & Library' },
  { id: 'clothing_store', label: 'Clothing Store' },
  { id: 'condominium', label: 'Condominium' },
  { id: 'conference_hall', label: 'Conference Hall' },
  { id: 'fishing', label: 'Fishing' },
  { id: 'grocery_store', label: 'Grocery Store' },
  { id: 'gym', label: 'Gym' },
  { id: 'halloween', label: 'Halloween' },
  { id: 'ice_cream_shop', label: 'Ice Cream Shop' },
  { id: 'jail', label: 'Jail' },
  { id: 'japanese_interiors', label: 'Japanese Interiors' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'living_room', label: 'Living Room' },
  { id: 'museum', label: 'Museum' },
  { id: 'shooting_range', label: 'Shooting Range' },
];

// Raw manifest.json entry shape (written by importLimeZuFull.mjs). category/
// footprintRows/defaultLayer exist in the files but aren't used here —
// category grouping is LIMEZU_CATEGORIES' job, and every entry renders
// through the same Furniture pipeline regardless.
interface ManifestEntry {
  id: string;
  label: string;
  src: string;
  srcX: number;
  srcY: number;
  tilesW: number;
  tilesH: number;
}

// PNG dimensions per file vary in this pack (the Office pack's fixed 64x96
// canvas convention doesn't hold), so srcW/srcH must be the piece's own
// crop box — PieceThumb's CSS/canvas crop math needs real source dimensions
// when they differ from the 64x96 default (see PaletteEntry.srcW's doc).
// srcX/srcY/tilesW/tilesH straight from the manifest; category is
// 'furniture' because PaletteCategory is a closed union used by the
// BUILT-IN tabs — LimeZu theme grouping lives in LIMEZU_CATEGORIES, not here.
function toPaletteEntry(m: ManifestEntry): PaletteEntry {
  return {
    id: m.id,
    label: m.label,
    category: 'furniture',
    src: m.src,
    srcX: m.srcX,
    srcY: m.srcY,
    tilesW: m.tilesW || 1,
    tilesH: m.tilesH || 1,
    srcW: m.srcX + (m.tilesW || 1) * 32,
    srcH: m.srcY + (m.tilesH || 1) * 32,
  };
}

const loaded = new Map<string, PaletteEntry[]>();
const inFlight = new Map<string, Promise<PaletteEntry[]>>();

// Fetch one category's manifest (once — repeat calls return the cache) and
// register its entries into PALETTE_BY_ID so every existing renderer
// (GameCanvas, mapRender, the editor's PieceThumb) resolves them with no
// changes at the lookup sites. Mutating an exported object is normally a
// smell; here it IS the design — PALETTE_BY_ID is already the one shared
// registry everything reads, and these entries are static data, only
// arriving late.
export function loadLimezuCategory(id: string): Promise<PaletteEntry[]> {
  const cached = loaded.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(id);
  if (pending) return pending;

  const p = fetch(`/assets/limezu-interiors/${id}/manifest.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<ManifestEntry[]>;
    })
    .then((rows) => {
      const entries = rows.map(toPaletteEntry);
      for (const e of entries) PALETTE_BY_ID[e.id] = e;
      loaded.set(id, entries);
      inFlight.delete(id);
      return entries;
    })
    .catch((e) => {
      console.warn(`[limezu] failed to load category "${id}":`, e);
      inFlight.delete(id);
      return [] as PaletteEntry[];
    });
  inFlight.set(id, p);
  return p;
}

// Game-view side: a room's furniture list can reference limezu-* paletteIds
// placed by an admin, and players who never open the editor still need the
// art. Called from mapRender's drawFurnitureLayer when it meets an id it
// can't resolve — parses the category back out of the id
// (limezu-<categoryId>-NNN, categoryId may itself contain underscores) and
// pulls that one manifest in. Idempotent and synchronous-fast after the
// first call; the canvas redraws every frame, so the piece simply appears
// on the first frame after its manifest (and then its PNG) arrives.
export function ensureLimezuEntry(paletteId: string): void {
  if (!paletteId.startsWith('limezu-') || PALETTE_BY_ID[paletteId]) return;
  const m = paletteId.match(/^limezu-(.+)-\d+$/);
  if (!m) return;
  void loadLimezuCategory(m[1]);
}
