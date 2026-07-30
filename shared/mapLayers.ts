import type { Furniture, RoomTile, Zone, TileType } from './types/index';

// ZEP-style Room Editor — Potong 1 data model. `LayerData` is the NEW per-room
// map format (5 layers). It lives BESIDE the legacy tilemapData/furniture/zones
// columns (see Room.layerData, nullable). The two adaptors below are the whole
// compatibility strategy:
//   legacyToLayerData()  — one-time conversion (see convertLegacyRoom.ts)
//   layerDataToLegacy()  — read-time adaptor: reconstructs the EXACT runtime
//                          shape the game/server already consume, so every
//                          existing consumer (render, collision, zones, sit,
//                          teleport) keeps working unchanged once a room is
//                          converted. The round-trip legacy→layer→legacy is
//                          designed to be LOSSLESS and is verified per-room
//                          before conversion is committed.

export const MAP_FORMAT_VERSION = 1;

// Per-coordinate effect (sparse). 'impassable' carries the original blocked
// tile type so collision + rendering reconstruct exactly; 'portal' carries its
// destination room slug. 'startingPoint' = spawn; 'door' = the walkable door
// tile type (kept distinct so it round-trips).
export interface TileEffect {
  x: number;
  y: number;
  kind: 'startingPoint' | 'impassable' | 'portal' | 'door';
  tileType?: TileType; // for 'impassable' — original type ('desk' | 'chair' | …)
  targetSlug?: string; // for 'portal'
}

// A rectangular region effect. Legacy zones convert to 'privateArea' (the audio
// grouping they actually drive); 'mapLocation' is reserved for named teleport
// spots authored in a later potong. Stores every Zone field so zones round-trip.
export interface AreaEffect {
  id: string;
  effect: 'privateArea' | 'mapLocation';
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  label?: string;
  zoneType?: Zone['type'];
}

export interface LayerData {
  version: number;
  width: number;
  height: number;
  // Floor texture per tile (floorPaletteId), null = default floor. Stored for
  // EVERY tile regardless of its type, so a textured floor under furniture/wall
  // survives.
  floor: (string | null)[][];
  // Wall tiles (visual wall + impassable). Kept as its own grid — it's the
  // densest layer and the primary structural collision source.
  wall: boolean[][];
  // Furniture below the avatar. On conversion ALL legacy furniture lands here.
  objects: Furniture[];
  // Furniture above the avatar. Empty on conversion (the current renderer
  // already draws a tall piece's overhead rows above avatars from `objects`);
  // populated by explicit top-layer placement in a later potong.
  topObjects: Furniture[];
  // Rectangular region effects (from legacy zones).
  areas: AreaEffect[];
  // Sparse per-tile effects (spawn / impassable / portal / door).
  tileEffects: TileEffect[];
}

// Convert the legacy runtime shape (already-normalized RoomTile[][], furniture,
// zones) into LayerData. Pure and deterministic.
export function legacyToLayerData(tiles: RoomTile[][], furniture: Furniture[], zones: Zone[]): LayerData {
  const height = tiles.length;
  const width = tiles[0]?.length ?? 0;
  const floor: (string | null)[][] = [];
  const wall: boolean[][] = [];
  const tileEffects: TileEffect[] = [];

  for (let y = 0; y < height; y++) {
    const fr: (string | null)[] = [];
    const wr: boolean[] = [];
    for (let x = 0; x < width; x++) {
      const t = tiles[y]?.[x];
      const type: TileType = (t?.type ?? 'floor') as TileType;
      fr.push(t?.floorPaletteId ?? null);
      wr.push(type === 'wall');
      if (type === 'spawn') tileEffects.push({ x, y, kind: 'startingPoint' });
      else if (type === 'portal') tileEffects.push({ x, y, kind: 'portal', targetSlug: t?.portalTarget });
      else if (type === 'door') tileEffects.push({ x, y, kind: 'door' });
      else if (type === 'desk' || type === 'chair') tileEffects.push({ x, y, kind: 'impassable', tileType: type });
      // 'wall' → wall grid; 'floor' → nothing extra.
    }
    floor.push(fr);
    wall.push(wr);
  }

  const areas: AreaEffect[] = zones.map((z) => ({
    id: z.id,
    effect: 'privateArea',
    name: z.name,
    x: z.x,
    y: z.y,
    width: z.width,
    height: z.height,
    color: z.color,
    label: z.label,
    zoneType: z.type,
  }));

  // Split by the topLayer flag so a round-trip is lossless even after the
  // editor has authored top-layer pieces. Legacy furniture has no flag → all
  // land in `objects`, topObjects empty (exactly what conversion expects).
  const objects: Furniture[] = [];
  const topObjects: Furniture[] = [];
  for (const f of furniture) {
    if (f.topLayer) { const { topLayer: _drop, ...rest } = f; topObjects.push(rest as Furniture); }
    else objects.push(f);
  }
  return { version: MAP_FORMAT_VERSION, width, height, floor, wall, objects, topObjects, areas, tileEffects };
}

// Read-time adaptor: reconstruct the exact runtime shape from LayerData.
export function layerDataToLegacy(ld: LayerData): { tiles: RoomTile[][]; furniture: Furniture[]; zones: Zone[] } {
  const { width, height, floor, wall } = ld;
  const effAt = new Map<string, TileEffect>();
  for (const e of ld.tileEffects) effAt.set(`${e.x},${e.y}`, e);

  const tiles: RoomTile[][] = [];
  for (let y = 0; y < height; y++) {
    const row: RoomTile[] = [];
    for (let x = 0; x < width; x++) {
      const eff = effAt.get(`${x},${y}`);
      let type: TileType = 'floor';
      let portalTarget: string | undefined;
      if (wall[y]?.[x]) type = 'wall';
      else if (eff?.kind === 'startingPoint') type = 'spawn';
      else if (eff?.kind === 'portal') { type = 'portal'; portalTarget = eff.targetSlug; }
      else if (eff?.kind === 'door') type = 'door';
      else if (eff?.kind === 'impassable') type = eff.tileType ?? 'desk';

      const tile: RoomTile = { x, y, type };
      const fp = floor[y]?.[x];
      if (fp != null) tile.floorPaletteId = fp;
      if (portalTarget != null) tile.portalTarget = portalTarget;
      row.push(tile);
    }
    tiles.push(row);
  }

  // Tag top-layer pieces so the game renders them above the avatar. objects
  // stay untagged. (For a freshly-converted room topObjects is empty, so this
  // reproduces the original furniture list exactly — the round-trip guard in
  // convertLegacyRoom relies on that.)
  const furniture: Furniture[] = [
    ...ld.objects,
    ...ld.topObjects.map((o) => ({ ...o, topLayer: true as const })),
  ];

  const zones: Zone[] = ld.areas.map((a) => {
    const z: Zone = { id: a.id, name: a.name, x: a.x, y: a.y, width: a.width, height: a.height };
    if (a.color != null) z.color = a.color;
    if (a.label != null) z.label = a.label;
    if (a.zoneType != null) z.type = a.zoneType;
    return z;
  });

  return { tiles, furniture, zones };
}
