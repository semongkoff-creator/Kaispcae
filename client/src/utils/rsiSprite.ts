// Parses Space Station 14's per-file ".rsi" sprite format (used by the
// scifi-office tileset, client/public/assets/tilesets/scifi-office/) — see
// that folder's ASSETS_README.md. Unlike the LimeZu tilesets (one big
// spritesheet per file, see tilePaletteManifest.ts), each RSI folder is
// `xxx.rsi/meta.json` + one PNG per "state" (variant/pose name). A state's
// meta entry has `directions: 4` when its PNG packs the 4 facing directions
// (down/right/up/left, RSI's standard order) as separate frames, and/or
// `delays` when it's animated (one delay array per direction, each entry a
// per-frame duration in seconds).
//
// Whatever grid a state's frames are packed into (observed empirically: not
// always a simple 4-wide strip — a 4-frame state may be packed as a 2x2
// grid), frame index 0 is always first in reading order, i.e. the top-left
// `size.x` x `size.y` cell. Index 0 is also always the "down" direction
// (RSI's direction order starts at south) and the first frame of any
// animation. So a single fixed crop — (0, 0, size.x, size.y) — is always
// the state's static "down-facing, first frame" image, regardless of
// directions/delays. That's what every render call in this app wants
// (avatars are drawn top-down and placed furniture doesn't rotate), which is
// why nothing here needs to branch on `directions` to compute a crop.
//
// Full animation playback (cycling through `delays`) is intentionally out of
// scope for now — see ASSETS_README.md's "boleh di-defer" note.

export interface RsiStateMeta {
  name: string;
  directions?: number;
  delays?: number[][];
}

export interface RsiMeta {
  version: number;
  size: { x: number; y: number };
  states: RsiStateMeta[];
  license?: string;
  copyright?: string;
}

const metaCache = new Map<string, Promise<RsiMeta | null>>();

// Fetches and caches an .rsi folder's meta.json. `rsiFolderPath` is the
// public URL to the folder itself (e.g.
// "/assets/tilesets/scifi-office/Walls/solid.rsi"), no trailing slash.
export function loadRsiMeta(rsiFolderPath: string): Promise<RsiMeta | null> {
  let pending = metaCache.get(rsiFolderPath);
  if (!pending) {
    pending = fetch(`${rsiFolderPath}/meta.json`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    metaCache.set(rsiFolderPath, pending);
  }
  return pending;
}

export interface RsiStaticFrame {
  src: string;
  srcX: number;
  srcY: number;
  frameW: number;
  frameH: number;
  // True if the state has more than one frame in any direction — this app
  // still renders only the first frame (see module doc comment above), but
  // callers may want to know a piece is "really" animated (e.g. to label it
  // in a future richer asset browser).
  isAnimated: boolean;
}

// Looks up one state within an already-loaded RsiMeta and returns the crop
// for its static first frame. Returns null if the state doesn't exist.
export function rsiStaticFrame(rsiFolderPath: string, meta: RsiMeta, stateName: string): RsiStaticFrame | null {
  const state = meta.states.find((s) => s.name === stateName);
  if (!state) return null;
  return {
    src: `${rsiFolderPath}/${stateName}.png`,
    srcX: 0,
    srcY: 0,
    frameW: meta.size.x,
    frameH: meta.size.y,
    isAnimated: Array.isArray(state.delays) && state.delays.some((direction) => direction.length > 1),
  };
}

// Convenience one-shot: fetches meta.json then resolves the state's static
// frame. Prefer loadRsiMeta() + rsiStaticFrame() when looking up several
// states from the same folder, to only fetch meta.json once.
export async function loadRsiStaticFrame(rsiFolderPath: string, stateName: string): Promise<RsiStaticFrame | null> {
  const meta = await loadRsiMeta(rsiFolderPath);
  if (!meta) return null;
  return rsiStaticFrame(rsiFolderPath, meta, stateName);
}
