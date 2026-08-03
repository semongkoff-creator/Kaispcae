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

// Fitur 15 — a room-uploaded image (PNG/JPG, via the existing /api/uploads
// service) registered as a placeable Floor/Wall/Object palette entry, scoped
// to THIS room only (see RoomEditorPage.tsx's report for why: every other
// per-admin-placed-thing in this schema — MapMediaObject, TeleportLocation —
// is roomId-scoped with no cross-room reuse, and layerData already IS the
// room-scoped JSON blob, so storing it here needs no new table/migration).
// `category` picks which palette the entry shows up in; 'wall' entries are
// keyed onto LayerData.wallPaletteId, not the `wall` boolean grid.
export interface CustomAssetEntry {
  id: string; // `custom-<uuid>` — lets renderers recognize it as a Fitur-15 entry
  label: string;
  category: 'floor' | 'wall' | 'object';
  src: string; // must be a same-origin /api/uploads or /api/files URL
  tilesW: number;
  tilesH: number;
  createdBy: string;
  createdByName: string;
  createdAt: number;
}

// A floor-plan photo/reference image the admin uploads to trace over while
// building out a room by hand — a translucent overlay drawn ON TOP of every
// other layer (see RoomEditorPage.tsx's draw loop; floor tiles are fully
// opaque and cover every tile, so drawing this underneath would always be
// hidden). By default it's editor-only — GameCanvas.tsx never reads
// LayerData directly, only the layerDataToLegacy-derived tiles/furniture/
// zones — but when showInGame is true, roomHandler.ts also forwards it to
// every live player via ROOM_STATE, so the photo itself becomes the visible
// map background (with collision handled separately via 'impassable' tile
// effects stamped on top). x/y/width/height are world PIXELS (not tile
// units), so it can be freely positioned/scaled independent of the grid —
// a real photographed floor plan rarely lines up with any tile size.
export interface ReferenceImageData {
  url: string; // must be a same-origin /api/uploads or /api/files URL
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number; // 0-1
  visible: boolean;
  showInGame?: boolean; // when true, also rendered in GameCanvas.tsx for every player
}

// Per-coordinate effect (sparse). 'impassable' carries the original blocked
// tile type so collision + rendering reconstruct exactly; 'portal' carries its
// destination room slug. 'startingPoint' = spawn; 'door' = the walkable door
// tile type (kept distinct so it round-trips).
export interface TileEffect {
  x: number;
  y: number;
  kind: 'startingPoint' | 'impassable' | 'portal' | 'door';
  tileType?: TileType; // for 'impassable' — original type ('desk' | 'chair' | …)
  // Portal destination: targetSlug = another room (cross-room), or targetX/Y =
  // a tile in THIS room (internal). label = optional portal name.
  targetSlug?: string;
  targetX?: number;
  targetY?: number;
  label?: string;
  // ZEP-style door password — only meaningful for kind === 'door'. Reuses the
  // Interactive Object password prompt's field-naming/behavior (see
  // InteractiveObjectConfig's own password fields) but is stored per-tile
  // instead of per-furniture, since a door is a TileEffect, not a Furniture
  // piece. doorPassword must NEVER reach a normal player's client — see
  // redactDoorPasswords (server/src/lib/redactFurniture.ts), mirroring
  // redactInteractiveSecrets for furniture passwords.
  doorPasswordEnabled?: boolean;
  doorPassword?: string;
  doorPasswordDescription?: string;
  doorFailureMessage?: string;
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
  // ZEP-style Area ID (Potong 4) — private areas sharing the same areaId form
  // ONE audio group even when physically separate (the adaptor gives them the
  // same zone.id). Absent on converted areas (each is its own group by its id).
  areaId?: string;
  // See Zone.audioIsolated. Left unset lets layerDataToLegacy infer a default
  // from `effect` (privateArea → isolates, mapLocation → doesn't) so every
  // area authored before this field existed gets the right behavior without
  // needing to be re-drawn.
  audioIsolated?: boolean;
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
  // Fitur 15 — custom wall skin per tile (CustomAssetEntry.id), sparse/absent
  // grid. Purely cosmetic: `wall` alone still decides collision, so a room
  // saved before this field existed (or a tile that's just a plain wall)
  // renders exactly as before. Only present where an admin painted a custom
  // wall texture.
  wallPaletteId?: (string | null)[][];
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
  // Fitur 15 — this room's uploaded custom Floor/Wall/Object assets. Absent on
  // every room converted before this field existed — treated as `[]`
  // everywhere it's read, never populated retroactively.
  customAssets?: CustomAssetEntry[];
  // Floor-plan reference image underlay (see ReferenceImageData above).
  // Absent/null = none set. Editor-only, like customAssets — no legacy
  // equivalent, never touched by legacyToLayerData/layerDataToLegacy.
  referenceImage?: ReferenceImageData | null;
  // Room-wide avatar sprite scale multiplier — lets an admin make every
  // player's character bigger or smaller in THIS room (e.g. a tighter room
  // may want smaller avatars, a showcase room bigger ones). Absent/undefined
  // = 1 (unchanged size). Purely cosmetic: collision/hitboxes are unaffected,
  // only the rendered sprite (see AvatarSprite.ts's `scale` param). Forwarded
  // to every player via ROOM_STATE (no opt-in gate needed, unlike
  // referenceImage.showInGame — this has no privacy/content-review concern).
  avatarScale?: number;
}

// Sane bounds for LayerData.avatarScale — small enough that a character
// doesn't shrink to an unreadable dot, large enough it doesn't dwarf the
// tile grid. Enforced server-side (rooms.ts) and clamped by the editor's
// slider (RoomEditorPage.tsx).
export const AVATAR_SCALE_MIN = 0.5;
export const AVATAR_SCALE_MAX = 2;

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
      else if (type === 'portal') tileEffects.push({ x, y, kind: 'portal', targetSlug: t?.portalTarget, targetX: t?.portalTargetX, targetY: t?.portalTargetY, label: t?.portalLabel });
      else if (type === 'door') tileEffects.push({
        x, y, kind: 'door',
        doorPasswordEnabled: t?.doorPasswordEnabled,
        doorPassword: t?.doorPassword,
        doorPasswordDescription: t?.doorPasswordDescription,
        doorFailureMessage: t?.doorFailureMessage,
      });
      else if (type === 'desk' || type === 'chair' || type === 'blocked') tileEffects.push({ x, y, kind: 'impassable', tileType: type });
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
      let portalEff: TileEffect | undefined;
      if (wall[y]?.[x]) type = 'wall';
      else if (eff?.kind === 'startingPoint') type = 'spawn';
      else if (eff?.kind === 'portal') { type = 'portal'; portalEff = eff; }
      else if (eff?.kind === 'door') type = 'door';
      // Impassable keeps its original blocked type for converted rooms (desk/
      // chair) and uses the invisible 'blocked' type for effects painted in the
      // editor (no tileType) — both are in BLOCKED_TILES, so collision is
      // identical; only the render differs (blocked draws nothing).
      else if (eff?.kind === 'impassable') type = eff.tileType ?? 'blocked';

      const tile: RoomTile = { x, y, type };
      const fp = floor[y]?.[x];
      if (fp != null) tile.floorPaletteId = fp;
      const wp = ld.wallPaletteId?.[y]?.[x];
      if (type === 'wall' && wp != null) tile.wallPaletteId = wp;
      if (portalEff) {
        if (portalEff.targetSlug != null) tile.portalTarget = portalEff.targetSlug;
        if (portalEff.targetX != null) tile.portalTargetX = portalEff.targetX;
        if (portalEff.targetY != null) tile.portalTargetY = portalEff.targetY;
        if (portalEff.label != null) tile.portalLabel = portalEff.label;
      }
      if (eff?.kind === 'door') {
        if (eff.doorPasswordEnabled != null) tile.doorPasswordEnabled = eff.doorPasswordEnabled;
        if (eff.doorPassword != null) tile.doorPassword = eff.doorPassword;
        if (eff.doorPasswordDescription != null) tile.doorPasswordDescription = eff.doorPasswordDescription;
        if (eff.doorFailureMessage != null) tile.doorFailureMessage = eff.doorFailureMessage;
      }
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
    // ZEP areaId → shared zone.id so same-areaId private areas are ONE audio
    // group (useProximity compares zone.id). Converted areas have no areaId, so
    // their id is unchanged — the Potong-1 round-trip stays byte-identical.
    const id = a.areaId ? `parea:${a.areaId}` : a.id;
    const z: Zone = { id, name: a.name, x: a.x, y: a.y, width: a.width, height: a.height };
    if (a.color != null) z.color = a.color;
    if (a.label != null) z.label = a.label;
    if (a.zoneType != null) z.type = a.zoneType;
    // Only ever explicitly set to `false` (mapLocation's default) — leaving
    // it unset for everything else means "isolates" (Zone.audioIsolated's own
    // documented default), which is what every legacy-converted zone already
    // is (legacyToLayerData always emits effect:'privateArea', never
    // 'mapLocation' — that type didn't exist pre-editor), so this can't add a
    // key the round-trip guard in convertLegacyRoom.ts doesn't expect. This IS
    // computed at read time rather than stored, so it applies retroactively
    // to every 'Map location' ever drawn, not just ones drawn after this field
    // existed.
    if (a.audioIsolated != null) z.audioIsolated = a.audioIsolated;
    else if (a.effect === 'mapLocation') z.audioIsolated = false;
    return z;
  });

  return { tiles, furniture, zones };
}
