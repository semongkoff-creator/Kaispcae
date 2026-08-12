import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE } from './types/index';
import type { RoomTile, Furniture, Zone, TileType, RoomTheme } from './types/index';

// Scans a generated/loaded tile grid for the 'spawn'-type tile and returns
// its pixel center — the single source of truth for "where does a new
// player appear", used by both the client's optimistic local room
// (createDefaultRoom.ts, before the server round-trip completes) and,
// historically, the server's own copy of this same scan (roomHandler.ts,
// which operates on raw un-typed JSON from the DB so it keeps its own
// version rather than importing this one). Falls back to (3,3) — the old
// layout's spawn tile — if no 'spawn' tile is found at all, so a room
// created before spawn tiles existed doesn't put anyone at (0,0).
export function findSpawnPixel(tiles: RoomTile[][]): { x: number; y: number } {
  for (const row of tiles) {
    for (const tile of row) {
      if (tile.type === 'spawn') return { x: tile.x * TILE_SIZE + TILE_SIZE / 2, y: tile.y * TILE_SIZE + TILE_SIZE / 2 };
    }
  }
  return { x: 3 * TILE_SIZE + TILE_SIZE / 2, y: 3 * TILE_SIZE + TILE_SIZE / 2 };
}

// Default office layout used to seed a brand-new room's tilemapData/
// furniture/zones (see server/src/routes/rooms.ts) so a room looks like an
// actual office from the moment it's created, instead of an empty floor.
// Kept here (not client-only) so both the server (room creation) and the
// client (optimistic local room shown before the server round-trip
// completes, see client/src/utils/createDefaultRoom.ts) generate the exact
// same layout.
//
// Palette ids referenced below (desk-*, chair-office, meeting-table,
// sofa-set, wardrobe, plant-*) come from
// client/src/data/tilePaletteManifest.ts — this file only needs their id +
// footprint (tilesW/tilesH), not the actual sprite crop rects, so it stays
// free of any client-only rendering concerns.

// Every call below places furniture/floors by a stable ROLE name (a plain
// English "what is this" — e.g. 'chair-office', 'meeting-table') rather than
// a literal palette id, so the SAME layout code produces a themed room for
// either tileset. ROLE_TO_PALETTE_ID resolves a role to the actual palette
// id for the room's theme (client/src/data/tilePaletteManifest.ts for
// modern-interiors, client/src/data/scifiOfficePaletteManifest.ts for
// scifi-office) — this file only needs each role's footprint/sittability,
// not sprite crop rects, so it stays free of any client-only rendering
// concerns (same reasoning as the original FOOTPRINT comment below).
//
// The scifi-office curated set (10 items, see that manifest's own header
// comment) is much smaller than modern-interiors' — several distinct
// modern-interiors roles intentionally map to the same scifi item (e.g.
// every plant role maps to the one available potted-plant state); that's
// the curated set being deliberately small, not a bug.
const ROLE_TO_PALETTE_ID: Record<RoomTheme, Record<string, string>> = {
  'modern-interiors': {
    'chair-office': 'chair-office',
    'desk-basic': 'desk-basic',
    'desk-computer-a': 'desk-computer-a',
    'desk-computer-b': 'desk-computer-b',
    'desk-computer-c': 'desk-computer-c',
    'meeting-table': 'meeting-table',
    'wardrobe': 'wardrobe',
    'sofa-set': 'sofa-set',
    'sofa-blue': 'sofa-blue',
    'sofa-gray': 'sofa-gray',
    'plant-tall': 'plant-tall',
    'plant-small': 'plant-small',
    'plant-potted': 'plant-potted',
    'pinboard': 'pinboard',
    'desk-cluster-b': 'desk-cluster-b',
    // Purely decorative variety roles (see the "Final Polish" doc comment
    // near placeDeskIsland) — modern-interiors already has enough visually
    // distinct pieces cataloged in tilePaletteManifest.ts that these just
    // reuse existing entries rather than needing new sprite-crop discovery.
    'plant-accent': 'plant-small',
    'decor-a': 'wall-frame-a',
    'decor-b': 'picture-abstract',
    'decor-c': 'desk-lamp',
  },
  'scifi-office': {
    'chair-office': 'sf-chair-white',
    'desk-basic': 'sf-desk',
    'desk-computer-a': 'sf-desk',
    'desk-computer-b': 'sf-desk',
    'desk-computer-c': 'sf-computer',
    'meeting-table': 'sf-desk',
    'wardrobe': 'sf-server',
    'sofa-set': 'sf-arcade',
    'sofa-blue': 'sf-jukebox',
    'sofa-gray': 'sf-chair-dark',
    // Distinct plant states per role (see scifiOfficePaletteManifest.ts's
    // sf-plant-b/c/d) — previously all three plant roles resolved to the
    // exact same sf-plant (plant-01) state, so every plant in a
    // scifi-office room looked identical regardless of which role placed
    // it; this was the single biggest contributor to this theme's
    // "generated grid" look, more so than modern-interiors (which already
    // had 3 distinct plant sprites).
    'plant-tall': 'sf-plant',
    'plant-small': 'sf-plant-b',
    'plant-potted': 'sf-plant-c',
    'plant-accent': 'sf-plant-d',
    'pinboard': 'sf-computer',
    'desk-cluster-b': 'sf-computer',
    // No wall-hangable picture/frame equivalent is curated for this theme
    // (see scifiOfficePaletteManifest.ts's header — only 10 items) — these
    // reuse plant variants rather than an ill-fitting substitute, so a
    // scifi-office room still gets *some* visual variety at these spots
    // even though the specific "framed picture" idea doesn't translate.
    'decor-a': 'sf-plant-b',
    'decor-b': 'sf-plant-d',
    'decor-c': 'sf-plant-c',
  },
};

const FLOOR_ROLE_TO_ID: Record<RoomTheme, Record<string, string>> = {
  'modern-interiors': {
    'floor-maroon-carpet': 'floor-maroon-carpet',
    'floor-brown-weave': 'floor-brown-weave',
    'floor-tile-gray': 'floor-tile-gray',
    // Extra roles used for small accent-rug patches (under a desk cluster,
    // a seating area, etc.) rather than tinting a whole zone one flat
    // color — see the placeDeskIsland-area doc comment.
    'floor-olive-carpet': 'floor-olive-carpet',
    'floor-lavender': 'floor-lavender',
  },
  'scifi-office': {
    // Only two neutral floor swatches are curated for this theme (see
    // scifiOfficePaletteManifest.ts) — the meeting room/lounge/desk-zone-B
    // overrides below all use the carpet swatch so they still visibly
    // differ from the plain steel floor everywhere else (the theme's
    // default, unset-floorPaletteId sprite — see themeAssets.ts).
    'floor-maroon-carpet': 'sf-floor-carpet',
    'floor-brown-weave': 'sf-floor-carpet',
    'floor-tile-gray': 'sf-floor-carpet',
    // The accent-rug roles fall back to the plain steel floor here (no 3rd
    // swatch is curated for this theme) — that still reads as a deliberate
    // contrast against the carpet used elsewhere in the same zone, just not
    // a 3rd distinct texture.
    'floor-olive-carpet': 'sf-floor-steel',
    'floor-lavender': 'sf-floor-steel',
  },
};

// Mirrors the tilesW/tilesH of each role used below (see
// client/src/data/tilePaletteManifest.ts — kept in sync manually since this
// package has no dependency on the client's asset manifest). Footprints are
// intentionally theme-independent — the scifi-office set is single-tile
// (1x1) art, but keeping every role's *layout* footprint the same across
// themes means the desk-row/collision geometry never shifts when switching
// themes, only the art drawn over it.
const FOOTPRINT: Record<string, { w: number; h: number }> = {
  'chair-office': { w: 1, h: 2 },
  'desk-basic': { w: 1, h: 2 },
  'desk-computer-a': { w: 1, h: 2 },
  'desk-computer-b': { w: 1, h: 2 },
  'desk-computer-c': { w: 1, h: 2 },
  'desk-cluster-l': { w: 2, h: 2 },
  'meeting-table': { w: 2, h: 2 },
  'wardrobe': { w: 2, h: 3 },
  'sofa-set': { w: 2, h: 3 },
  'sofa-blue': { w: 1, h: 2 },
  'sofa-gray': { w: 1, h: 2 },
  'plant-tall': { w: 1, h: 3 },
  'plant-small': { w: 1, h: 2 },
  'plant-potted': { w: 1, h: 3 },
  'pinboard': { w: 2, h: 2 },
  'desk-cluster-b': { w: 2, h: 2 },
  'plant-accent': { w: 1, h: 2 },
  'decor-a': { w: 1, h: 2 },
  'decor-b': { w: 1, h: 1 },
  'decor-c': { w: 1, h: 1 },
};

// Roles a player can sit on (see Furniture.isInteractable / the sit feature
// in GameCanvas.tsx) — mirrors the `sittable: true` entries in
// client/src/data/tilePaletteManifest.ts, kept in sync manually since this
// package has no dependency on the client's asset manifest (same reasoning
// as FOOTPRINT above). Theme-independent for the same reason as FOOTPRINT —
// e.g. 'sofa-set' resolves to the arcade machine in scifi-office (no sofa
// asset exists there), so it's correctly NOT sittable there even though the
// role itself is in this set; see performSit's real gate, which is
// Furniture.isInteractable as set below, not this role name.
const SITTABLE_ROLES = new Set(['chair-office', 'sofa-blue', 'sofa-gray']);
// sofa-set alone is excluded per-theme: it's a real sittable sofa in
// modern-interiors, but resolves to a non-seat arcade machine in
// scifi-office — see SITTABLE_ROLES_BY_THEME below.
const SITTABLE_ROLES_BY_THEME: Record<RoomTheme, Set<string>> = {
  'modern-interiors': new Set([...SITTABLE_ROLES, 'sofa-set']),
  'scifi-office': new Set(SITTABLE_ROLES),
};

// Same convention as gameStore.addFurniture / client's createDefaultRoom
// placeFurniture: the piece's base row tiles are marked type 'desk' purely
// so the existing collision system (BLOCKED_TILES has 'wall'/'desk'/'chair')
// blocks it — visual identity comes from paletteId, not tile type.
function placeFurniture(tiles: RoomTile[][], furniture: Furniture[], role: string, x: number, y: number, theme: RoomTheme) {
  const size = FOOTPRINT[role];
  if (!size) return;
  const paletteId = ROLE_TO_PALETTE_ID[theme][role] ?? role;
  furniture.push({
    id: `${paletteId}-${x}-${y}`, paletteId, x, y, tilesW: size.w, tilesH: size.h,
    isInteractable: SITTABLE_ROLES_BY_THEME[theme].has(role) || undefined,
  });
  for (let dx = 0; dx < size.w; dx++) {
    const tx = x + dx;
    if (tiles[y]?.[tx]) tiles[y][tx].type = 'desk';
  }
}

// Places a full row of desks with a matching row of chairs two tiles below
// (leaving a walking gap in between), alternating desk variants for visual
// variety. Returns the number of desks placed.
function placeDeskRow(
  tiles: RoomTile[][],
  furniture: Furniture[],
  startX: number,
  deskY: number,
  chairY: number,
  count: number,
  theme: RoomTheme,
): number {
  const variants = ['desk-computer-a', 'desk-basic', 'desk-computer-c', 'desk-basic', 'desk-computer-b'];
  for (let i = 0; i < count; i++) {
    const x = startX + i;
    placeFurniture(tiles, furniture, variants[i % variants.length], x, deskY, theme);
    placeFurniture(tiles, furniture, 'chair-office', x, chairY, theme);
  }
  return count;
}

function setTile(tiles: RoomTile[][], x: number, y: number, type: TileType) {
  if (tiles[y]?.[x]) tiles[y][x].type = type;
}

function setFloor(tiles: RoomTile[][], x0: number, y0: number, x1: number, y1: number, floorRole: string, theme: RoomTheme) {
  const floorPaletteId = FLOOR_ROLE_TO_ID[theme][floorRole] ?? floorRole;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (tiles[y]?.[x]) tiles[y][x].floorPaletteId = floorPaletteId;
    }
  }
}

// Draws just the perimeter of a rectangle as walls (interior untouched) —
// used for every fully-enclosed room below (meeting rooms, Dev Team,
// External Meeting, each Focus Zone pod). Doors are cut in afterward by
// overwriting individual perimeter tiles with setTile(..., 'door').
function wallRect(tiles: RoomTile[][], x0: number, y0: number, x1: number, y1: number) {
  for (let x = x0; x <= x1; x++) {
    setTile(tiles, x, y0, 'wall');
    setTile(tiles, x, y1, 'wall');
  }
  for (let y = y0; y <= y1; y++) {
    setTile(tiles, x0, y, 'wall');
    setTile(tiles, x1, y, 'wall');
  }
}

// An "island" cluster of 4 desks, 2 wide x 6 tall (x, x+1) x (y..y+5): a pair
// of desks at the top, a pair at the bottom, and their four chairs facing
// each other across the middle two rows (y+2/y+3 sit directly adjacent) —
// the brief's "4 meja disusun 2x2 saling berhadapan". Used for the Main Desk
// Zone's 4 team clusters and Dev Team's 2 smaller clusters.
//
// `deskRoles` is the 4 desk-role variants for [top-left, top-right,
// bottom-left, bottom-right] — every cluster gets its own combination (see
// the call sites below) instead of all 6 clusters using the identical
// desk-computer-a/desk-basic/desk-computer-b/desk-basic pattern every
// time, which was the single most "obviously generated" thing about the
// original layout (every cluster in the whole map looked pixel-identical).
// All 4 desk roles share the same 1x2 footprint, so varying which one fills
// a given slot never moves or resizes anything — purely a visual swap.
function placeDeskIsland(
  tiles: RoomTile[][],
  furniture: Furniture[],
  x: number,
  y: number,
  theme: RoomTheme,
  deskRoles: [string, string, string, string],
) {
  placeFurniture(tiles, furniture, deskRoles[0], x, y, theme);
  placeFurniture(tiles, furniture, deskRoles[1], x + 1, y, theme);
  placeFurniture(tiles, furniture, 'chair-office', x, y + 2, theme);
  placeFurniture(tiles, furniture, 'chair-office', x + 1, y + 2, theme);
  placeFurniture(tiles, furniture, 'chair-office', x, y + 3, theme);
  placeFurniture(tiles, furniture, 'chair-office', x + 1, y + 3, theme);
  placeFurniture(tiles, furniture, deskRoles[2], x, y + 5, theme);
  placeFurniture(tiles, furniture, deskRoles[3], x + 1, y + 5, theme);
}

// Decorative signage (Furniture.kind === 'banner') placed directly by the
// layout generator, not through the Room Editor's banner-placement flow —
// same shape the editor itself produces (see RoomEditor.tsx's BannerForm),
// just authored here for the small floating labels (team names, zone
// names) called for throughout this layout.
function addBanner(furniture: Furniture[], x: number, y: number, tilesW: number, text: string, bgColor: string, textColor = '#ffffff') {
  furniture.push({ id: `banner-${x}-${y}`, paletteId: 'banner', kind: 'banner', x, y, tilesW, tilesH: 1, text, textColor, bgColor });
}

/**
 * Generates the 50x36 "Main Office" layout (ZEP-inspired) — 8 distinct
 * zones plus connecting corridors, sized for a real multi-team office
 * rather than a single open floor:
 *
 *   ┌─────────────────────┬┬────────────────────┬──────────┐
 *   │  MEETING ROOM A     ││                    │          │
 *   │  (2,2) 14x8         ││   MAIN DESK ZONE   │          │
 *   ├─────────────────────┤│   (19,2) 20x14     │  LOUNGE  │
 *   │  MEETING ROOM B     ││   4 team clusters  │ (40,2)   │
 *   │  (2,11) 14x8        ││                    │  10x30   │
 *   │                     │├─────────┬──────────┤          │
 *   │                     ││DEV TEAM │ EXT.     │          │
 *   │                     ││(19,17)  │ MEETING  │          │
 *   │                     ││10x8     │(30,17)6x6│          │
 *   │                     │├─────────┴──────────┤          │
 *   │                     ││ FOCUS ZONE (19,26)  │          │
 *   │                     ││ 20x6, 5 pods        │          │
 *   ├─────────────────────┴┴─────────────────────┤          │
 *   │        ENTRANCE / RECEPTION (2,32) 46x4     ...       │
 *   └──────────────────────────────────────────────────────┘
 *              ^ vertical corridor, cols 17-18
 *
 * Only Meeting Room A/B, Dev Team, and External Meeting become Zones:
 * zones give everyone inside them full proximity audio/video regardless of
 * distance (see useProximity.ts), which is exactly the "private meeting
 * room" semantic — but would be wrong for the open desk zone, focus pods, or
 * lounge, so those get plain decorative Furniture banners for their labels
 * instead (Team A-D, Focus Zone, LOUNGE, the entrance welcome banner).
 */
export function createDefaultOfficeLayout(theme: RoomTheme = 'scifi-office'): { tiles: RoomTile[][]; furniture: Furniture[]; zones: Zone[] } {
  const tiles: RoomTile[][] = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const row: RoomTile[] = [];
    for (let x = 0; x < MAP_WIDTH; x++) {
      row.push({ x, y, type: 'floor' });
    }
    tiles.push(row);
  }

  // Outer border walls — no door cut into it: the Entrance/Reception zone
  // along the bottom (see below) is the arrival area itself, not a portal
  // to an "outside", so the border stays solid all the way around.
  wallRect(tiles, 0, 0, MAP_WIDTH - 1, MAP_HEIGHT - 1);

  const furniture: Furniture[] = [];
  const zones: Zone[] = [];

  // ── 1. Meeting Room A — (2,2) 14x8, door bottom-center ──────────────
  wallRect(tiles, 2, 2, 15, 9);
  setTile(tiles, 8, 9, 'door');
  setFloor(tiles, 3, 3, 14, 8, 'floor-maroon-carpet', theme);
  // Threshold accent — a single contrasting tile just inside the door, the
  // kind of "welcome mat" focal point real offices actually have there.
  setFloor(tiles, 8, 8, 8, 8, 'floor-tile-gray', theme);
  // "Long" conference table: two meeting-table pieces side by side (a
  // single sprite can't be stretched — see FOOTPRINT's doc comment — so two
  // 2x2 tables placed adjacently read as one 4-wide table instead).
  placeFurniture(tiles, furniture, 'meeting-table', 7, 5, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 9, 5, theme);
  placeFurniture(tiles, furniture, 'chair-office', 7, 3, theme);
  placeFurniture(tiles, furniture, 'chair-office', 8, 3, theme);
  placeFurniture(tiles, furniture, 'chair-office', 10, 3, theme);
  placeFurniture(tiles, furniture, 'chair-office', 7, 7, theme);
  placeFurniture(tiles, furniture, 'chair-office', 8, 7, theme);
  placeFurniture(tiles, furniture, 'chair-office', 10, 7, theme);
  // Asymmetric decor — a plant on one side, a framed picture on the other,
  // instead of the same plant mirrored on both sides.
  placeFurniture(tiles, furniture, 'plant-potted', 3, 3, theme);
  placeFurniture(tiles, furniture, 'decor-a', 14, 3, theme);
  zones.push({
    id: 'meeting-room-a', name: 'Meeting Room A',
    x: 2, y: 2, width: 14, height: 8,
    label: 'MEETING ROOM A', color: '#6B2FBF', type: 'meeting',
  });

  // ── 2. Meeting Room B — (2,11) 14x8, door bottom-center ──────────────
  wallRect(tiles, 2, 11, 15, 18);
  setTile(tiles, 8, 18, 'door');
  setFloor(tiles, 3, 12, 14, 17, 'floor-tile-gray', theme);
  setFloor(tiles, 8, 17, 8, 17, 'floor-maroon-carpet', theme);
  placeFurniture(tiles, furniture, 'meeting-table', 7, 14, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 9, 14, theme);
  placeFurniture(tiles, furniture, 'chair-office', 7, 12, theme);
  placeFurniture(tiles, furniture, 'chair-office', 8, 12, theme);
  placeFurniture(tiles, furniture, 'chair-office', 10, 12, theme);
  placeFurniture(tiles, furniture, 'chair-office', 7, 16, theme);
  placeFurniture(tiles, furniture, 'chair-office', 8, 16, theme);
  placeFurniture(tiles, furniture, 'chair-office', 10, 16, theme);
  // A different decor pairing than Room A (picture-abstract, not
  // wall-frame-a) so the two rooms don't read as copy-pasted twins beyond
  // just their banner color.
  placeFurniture(tiles, furniture, 'plant-potted', 3, 12, theme);
  placeFurniture(tiles, furniture, 'decor-b', 14, 12, theme);
  zones.push({
    id: 'meeting-room-b', name: 'Meeting Room B',
    x: 2, y: 11, width: 14, height: 8,
    label: 'MEETING ROOM B', color: '#3b82f6', type: 'meeting',
  });

  // ── 3. Main Desk Zone — (19,2) 20x14, open (no enclosing walls) ──────
  // 4 team clusters (2x6 desk islands, see placeDeskIsland) at the anchors
  // given in the brief, with a small floating "Team X" banner above each.
  // The two cluster rows are offset to y=4/y=11 (not the brief's literal
  // y=4/y=10) so each 6-tall island (occupying y..y+5) leaves at least one
  // clear walking row before the next — y=10 would butt the two rows
  // directly against each other with zero gap between them.
  setFloor(tiles, 19, 2, 38, 16, 'floor-tile-gray', theme);
  // Accent rugs under each cluster instead of one flat color across the
  // whole zone — deliberately not 4 identical rugs: two sizes (with/
  // without a margin around the desks) and two colors, alternating, so the
  // zone reads as 4 distinct team areas rather than a repeated tile.
  setFloor(tiles, 20, 3, 23, 10, 'floor-olive-carpet', theme);
  setFloor(tiles, 29, 4, 30, 9, 'floor-lavender', theme);
  setFloor(tiles, 20, 10, 23, 16, 'floor-lavender', theme);
  setFloor(tiles, 29, 11, 30, 16, 'floor-olive-carpet', theme);
  // Each cluster gets its own desk-role combination — no two islands in
  // the whole map use the same 4-desk arrangement (see placeDeskIsland).
  placeDeskIsland(tiles, furniture, 21, 4, theme, ['desk-computer-a', 'desk-basic', 'desk-basic', 'desk-computer-b']);
  addBanner(furniture, 20, 3, 3, 'Team A', '#6B2FBF');
  placeDeskIsland(tiles, furniture, 29, 4, theme, ['desk-computer-c', 'desk-computer-a', 'desk-computer-b', 'desk-basic']);
  addBanner(furniture, 28, 3, 3, 'Team B', '#3b82f6');
  placeDeskIsland(tiles, furniture, 21, 11, theme, ['desk-basic', 'desk-computer-b', 'desk-computer-a', 'desk-computer-c']);
  addBanner(furniture, 20, 10, 3, 'Team C', '#10b981');
  placeDeskIsland(tiles, furniture, 29, 11, theme, ['desk-computer-b', 'desk-basic', 'desk-computer-c', 'desk-computer-a']);
  addBanner(furniture, 28, 10, 3, 'Team D', '#f59e0b');
  // Decor at the zone's two top corners is deliberately asymmetric — a
  // plant on one side, a pinboard (a real "team task board", and this
  // role's first actual use in the layout) on the other — plus a mixed
  // plant type between the two cluster rows instead of the same pot twice.
  placeFurniture(tiles, furniture, 'plant-tall', 19, 2, theme);
  placeFurniture(tiles, furniture, 'pinboard', 38, 2, theme);
  placeFurniture(tiles, furniture, 'plant-potted', 25, 9, theme);
  placeFurniture(tiles, furniture, 'plant-accent', 33, 9, theme);

  // ── 4. Dev Team — (19,17) 10x8, door on the left (facing the corridor) ─
  wallRect(tiles, 19, 17, 28, 24);
  setTile(tiles, 19, 20, 'door');
  setFloor(tiles, 20, 18, 27, 23, 'floor-tile-gray', theme);
  setFloor(tiles, 20, 20, 20, 20, 'floor-olive-carpet', theme);
  // Only the first cluster gets an accent rug, not both — another
  // deliberate asymmetry rather than mirroring everything.
  setFloor(tiles, 21, 18, 24, 23, 'floor-olive-carpet', theme);
  placeDeskIsland(tiles, furniture, 22, 18, theme, ['desk-computer-a', 'desk-computer-c', 'desk-basic', 'desk-basic']);
  placeDeskIsland(tiles, furniture, 25, 18, theme, ['desk-basic', 'desk-computer-b', 'desk-computer-c', 'desk-computer-a']);
  // A desk lamp near the door — a small tech-flavored accent unique to
  // this room, not reused anywhere else in the layout.
  placeFurniture(tiles, furniture, 'decor-c', 21, 18, theme);
  zones.push({
    id: 'dev-team', name: 'Dev Team',
    x: 19, y: 17, width: 10, height: 8,
    label: 'DEV TEAM', color: '#4c1d95', type: 'meeting',
  });

  // ── 5. External Meeting — (30,17) 6x6, door on the left ──────────────
  wallRect(tiles, 30, 17, 35, 22);
  setTile(tiles, 30, 19, 'door');
  setFloor(tiles, 31, 18, 34, 21, 'floor-maroon-carpet', theme);
  setFloor(tiles, 31, 19, 31, 19, 'floor-tile-gray', theme);
  placeFurniture(tiles, furniture, 'meeting-table', 32, 19, theme);
  placeFurniture(tiles, furniture, 'chair-office', 31, 18, theme);
  placeFurniture(tiles, furniture, 'chair-office', 34, 18, theme);
  placeFurniture(tiles, furniture, 'chair-office', 31, 21, theme);
  placeFurniture(tiles, furniture, 'chair-office', 34, 21, theme);
  placeFurniture(tiles, furniture, 'plant-accent', 33, 18, theme);
  zones.push({
    id: 'external-meeting', name: 'External Meeting',
    x: 30, y: 17, width: 6, height: 6,
    label: 'Ext. Meeting', color: '#64748b', type: 'desk',
  });

  // ── 6. Focus Zone — (19,26) 20x6, 5 individual 4x6 pods ──────────────
  // Each pod is its own fully-walled room (adjacent pods share a wall,
  // reading as one continuous partitioned strip) with a door on the top
  // wall and its desk pushed to the back wall, facing away from the
  // corridor — see placeFurniture's chair/desk placement below.
  addBanner(furniture, 26, 25, 6, 'Focus Zone', '#1f2937');
  // A single plant marks the zone's entrance corridor — not one per pod
  // (that reads as generated filler), just one focal-point touch near
  // pod0's side.
  placeFurniture(tiles, furniture, 'plant-tall', 20, 25, theme);
  // Each pod gets a different desk role and alternating floor — 5
  // identical cubicles in a row was the clearest "grid-generated" tell in
  // the whole map.
  const podDeskRoles = ['desk-computer-c', 'desk-basic', 'desk-computer-a', 'desk-computer-b', 'desk-computer-c'];
  const podFloorRoles = ['floor-tile-gray', 'floor-lavender', 'floor-tile-gray', 'floor-lavender', 'floor-tile-gray'];
  for (let i = 0; i < 5; i++) {
    const px = 19 + i * 4;
    wallRect(tiles, px, 26, px + 3, 31);
    setTile(tiles, px + 1, 26, 'door');
    setFloor(tiles, px + 1, 27, px + 2, 30, podFloorRoles[i], theme);
    placeFurniture(tiles, furniture, podDeskRoles[i], px + 1, 30, theme);
    placeFurniture(tiles, furniture, 'chair-office', px + 1, 28, theme);
  }

  // ── 7. Lounge — (40,2) 10x30, open along its left edge ───────────────
  // Soft boundary instead of a wall: potted plants along column 39 with
  // gaps every few tiles, so it reads as a marked-off area without
  // blocking movement between it and the Desk Zone/Focus Zone next to it.
  // Irregular spacing (7/9/8 tiles apart, not a uniform 8) and mixed plant
  // roles — an evenly-spaced row of identical plants was one of the more
  // obviously "generated" details in the original pass.
  setFloor(tiles, 40, 2, 49, 31, 'floor-brown-weave', theme);
  placeFurniture(tiles, furniture, 'plant-potted', 39, 3, theme);
  placeFurniture(tiles, furniture, 'plant-accent', 39, 10, theme);
  placeFurniture(tiles, furniture, 'plant-tall', 39, 19, theme);
  placeFurniture(tiles, furniture, 'plant-potted', 39, 27, theme);
  // Bar/counter near the entrance to the lounge
  placeFurniture(tiles, furniture, 'desk-cluster-b', 43, 4, theme);
  placeFurniture(tiles, furniture, 'plant-small', 47, 3, theme);
  // Sofa group + coffee table, on its own accent rug (distinct from the
  // brown-weave base — a seating area with a different carpet under it is
  // a real, common office detail, not just a texture swap for variety's sake)
  setFloor(tiles, 41, 11, 47, 14, 'floor-maroon-carpet', theme);
  placeFurniture(tiles, furniture, 'sofa-set', 42, 12, theme);
  placeFurniture(tiles, furniture, 'sofa-blue', 46, 13, theme);
  // Round dining table + 4 chairs
  placeFurniture(tiles, furniture, 'meeting-table', 43, 22, theme);
  placeFurniture(tiles, furniture, 'chair-office', 42, 20, theme);
  placeFurniture(tiles, furniture, 'chair-office', 45, 20, theme);
  placeFurniture(tiles, furniture, 'chair-office', 42, 25, theme);
  placeFurniture(tiles, furniture, 'chair-office', 45, 25, theme);
  placeFurniture(tiles, furniture, 'plant-tall', 41, 29, theme);
  placeFurniture(tiles, furniture, 'plant-accent', 47, 29, theme);
  addBanner(furniture, 43, 30, 5, 'LOUNGE', '#7c3aed');

  // ── 8. Entrance / Reception — (2,32) 46x4, spans the bottom ──────────
  // Default spawn point for every new player, and the only zone connected
  // to every other one via the vertical corridor above it.
  setTile(tiles, 24, 34, 'spawn');
  addBanner(furniture, 20, 32, 10, 'Welcome', '#6B2FBF');
  // Offset from directly above the spawn tile (24,34) — placing it at x=24
  // would completely block the only path out of the entrance, since a
  // fresh spawn's immediate north neighbor is the one tile every new
  // player's first step depends on.
  placeFurniture(tiles, furniture, 'desk-basic', 22, 33, theme);
  placeFurniture(tiles, furniture, 'plant-tall', 4, 33, theme);
  placeFurniture(tiles, furniture, 'plant-accent', 45, 33, theme);

  // ── Corridors ─────────────────────────────────────────────────────────
  // Vertical corridor (cols 17-18) connecting Meeting Rooms A/B to the Main
  // Desk Zone and down to the Entrance — no walls are ever drawn in this
  // column range above, so it's open by construction; tinted here purely
  // so it visually reads as a deliberate corridor, not leftover floor.
  setFloor(tiles, 17, 2, 18, 31, 'floor-tile-gray', theme);

  return { tiles, furniture, zones };
}

/**
 * "Small Team" template — one private meeting room, two desk clusters
 * (8 desks total, half of Main Office's 4-cluster/16-desk zone), and a small
 * lounge corner, sized for a handful of people rather than a full multi-team
 * office. Reuses the exact same helpers/role system as createDefaultOfficeLayout
 * so it re-themes (modern-interiors/scifi-office) for free.
 *
 *   ┌───────────────────┬┬─────────────────────────┐
 *   │  MEETING ROOM      ││                          │
 *   │  (2,2) 16x10       ││   DESK AREA (21,2) 27x14 │
 *   ├───────────────────┤│   2 clusters             │
 *   │  LOUNGE            ││                          │
 *   │  (2,14) 16x18      │└──────────────────────────┘
 *   │                     │
 *   ├───────────────────┴─────────────────────────────┤
 *   │        ENTRANCE / RECEPTION (2,33) 46x2          │
 *   └───────────────────────────────────────────────────┘
 */
export function createSmallTeamLayout(theme: RoomTheme = 'scifi-office'): { tiles: RoomTile[][]; furniture: Furniture[]; zones: Zone[] } {
  const tiles: RoomTile[][] = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const row: RoomTile[] = [];
    for (let x = 0; x < MAP_WIDTH; x++) {
      row.push({ x, y, type: 'floor' });
    }
    tiles.push(row);
  }
  wallRect(tiles, 0, 0, MAP_WIDTH - 1, MAP_HEIGHT - 1);

  const furniture: Furniture[] = [];
  const zones: Zone[] = [];

  // ── Meeting Room — (2,2) 16x10, door bottom-center ───────────────────
  wallRect(tiles, 2, 2, 17, 11);
  setTile(tiles, 9, 11, 'door');
  setFloor(tiles, 3, 3, 16, 10, 'floor-maroon-carpet', theme);
  placeFurniture(tiles, furniture, 'meeting-table', 8, 6, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 10, 6, theme);
  placeFurniture(tiles, furniture, 'chair-office', 8, 4, theme);
  placeFurniture(tiles, furniture, 'chair-office', 9, 4, theme);
  placeFurniture(tiles, furniture, 'chair-office', 11, 4, theme);
  placeFurniture(tiles, furniture, 'chair-office', 8, 8, theme);
  placeFurniture(tiles, furniture, 'chair-office', 9, 8, theme);
  placeFurniture(tiles, furniture, 'chair-office', 11, 8, theme);
  placeFurniture(tiles, furniture, 'plant-potted', 3, 3, theme);
  placeFurniture(tiles, furniture, 'decor-a', 16, 3, theme);
  zones.push({
    id: 'meeting-room', name: 'Meeting Room',
    x: 2, y: 2, width: 16, height: 10,
    label: 'MEETING ROOM', color: '#6B2FBF', type: 'meeting',
  });

  // ── Desk Area — (21,2) 27x14, open, 2 clusters ───────────────────────
  setFloor(tiles, 21, 2, 47, 15, 'floor-tile-gray', theme);
  setFloor(tiles, 22, 3, 25, 10, 'floor-olive-carpet', theme);
  setFloor(tiles, 36, 3, 39, 10, 'floor-lavender', theme);
  placeDeskIsland(tiles, furniture, 23, 4, theme, ['desk-computer-a', 'desk-basic', 'desk-basic', 'desk-computer-b']);
  addBanner(furniture, 22, 3, 3, 'Team A', '#6B2FBF');
  placeDeskIsland(tiles, furniture, 37, 4, theme, ['desk-computer-c', 'desk-computer-a', 'desk-computer-b', 'desk-basic']);
  addBanner(furniture, 36, 3, 3, 'Team B', '#3b82f6');
  placeFurniture(tiles, furniture, 'plant-tall', 21, 2, theme);
  placeFurniture(tiles, furniture, 'pinboard', 46, 2, theme);

  // ── Lounge — (2,14) 16x18, open along its top edge ───────────────────
  setFloor(tiles, 2, 14, 17, 31, 'floor-brown-weave', theme);
  setFloor(tiles, 4, 17, 10, 20, 'floor-maroon-carpet', theme);
  placeFurniture(tiles, furniture, 'sofa-set', 4, 18, theme);
  placeFurniture(tiles, furniture, 'sofa-blue', 8, 19, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 12, 24, theme);
  placeFurniture(tiles, furniture, 'chair-office', 11, 22, theme);
  placeFurniture(tiles, furniture, 'chair-office', 14, 22, theme);
  placeFurniture(tiles, furniture, 'chair-office', 11, 27, theme);
  placeFurniture(tiles, furniture, 'chair-office', 14, 27, theme);
  placeFurniture(tiles, furniture, 'plant-tall', 3, 15, theme);
  placeFurniture(tiles, furniture, 'plant-accent', 15, 30, theme);
  addBanner(furniture, 6, 30, 5, 'LOUNGE', '#7c3aed');

  // ── Entrance / Reception — (2,33) 46x2, spans the bottom ─────────────
  setTile(tiles, 25, 34, 'spawn');
  addBanner(furniture, 20, 32, 10, 'Welcome', '#6B2FBF');
  placeFurniture(tiles, furniture, 'plant-tall', 4, 33, theme);
  placeFurniture(tiles, furniture, 'plant-accent', 45, 33, theme);

  // ── Corridor — cols 19-20, connecting everything to the entrance ────
  setFloor(tiles, 19, 2, 20, 31, 'floor-tile-gray', theme);

  return { tiles, furniture, zones };
}

/**
 * "Open Lounge" template — mostly casual/social space (three sofa groups,
 * a couple of round tables) with a small desk nook and one private meeting
 * room tucked in the corner, for teams that mostly hang out/co-work rather
 * than sit at assigned desks all day.
 *
 *   ┌─────────────────────────────────────────────────┐
 *   │             LOUNGE (2,2) 46x19                    │
 *   │      3 sofa groups + 2 round tables               │
 *   ├──────────────────┬┬───────────────────────────────┤
 *   │  DESK NOOK        ││   MEETING ROOM (28,22) 19x10  │
 *   │  (2,22) 15x10     ││                               │
 *   ├──────────────────┴┴───────────────────────────────┤
 *   │        ENTRANCE / RECEPTION (2,33) 46x2            │
 *   └─────────────────────────────────────────────────────┘
 */
export function createLoungeLayout(theme: RoomTheme = 'scifi-office'): { tiles: RoomTile[][]; furniture: Furniture[]; zones: Zone[] } {
  const tiles: RoomTile[][] = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const row: RoomTile[] = [];
    for (let x = 0; x < MAP_WIDTH; x++) {
      row.push({ x, y, type: 'floor' });
    }
    tiles.push(row);
  }
  wallRect(tiles, 0, 0, MAP_WIDTH - 1, MAP_HEIGHT - 1);

  const furniture: Furniture[] = [];
  const zones: Zone[] = [];

  // ── Lounge — (2,2) 46x19, open, spans nearly the whole top ───────────
  setFloor(tiles, 2, 2, 47, 20, 'floor-brown-weave', theme);
  setFloor(tiles, 4, 4, 12, 8, 'floor-maroon-carpet', theme);
  placeFurniture(tiles, furniture, 'sofa-set', 5, 5, theme);
  placeFurniture(tiles, furniture, 'sofa-blue', 9, 6, theme);
  setFloor(tiles, 20, 4, 28, 8, 'floor-lavender', theme);
  placeFurniture(tiles, furniture, 'sofa-gray', 21, 5, theme);
  placeFurniture(tiles, furniture, 'sofa-set', 24, 5, theme);
  setFloor(tiles, 36, 4, 44, 8, 'floor-olive-carpet', theme);
  placeFurniture(tiles, furniture, 'sofa-blue', 37, 5, theme);
  placeFurniture(tiles, furniture, 'sofa-gray', 40, 6, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 12, 14, theme);
  placeFurniture(tiles, furniture, 'chair-office', 11, 12, theme);
  placeFurniture(tiles, furniture, 'chair-office', 14, 12, theme);
  placeFurniture(tiles, furniture, 'chair-office', 11, 17, theme);
  placeFurniture(tiles, furniture, 'chair-office', 14, 17, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 34, 14, theme);
  placeFurniture(tiles, furniture, 'chair-office', 33, 12, theme);
  placeFurniture(tiles, furniture, 'chair-office', 36, 12, theme);
  placeFurniture(tiles, furniture, 'chair-office', 33, 17, theme);
  placeFurniture(tiles, furniture, 'chair-office', 36, 17, theme);
  placeFurniture(tiles, furniture, 'plant-tall', 2, 2, theme);
  placeFurniture(tiles, furniture, 'plant-tall', 46, 2, theme);
  placeFurniture(tiles, furniture, 'plant-potted', 24, 18, theme);
  addBanner(furniture, 21, 19, 5, 'LOUNGE', '#7c3aed');

  // ── Desk Nook — (2,22) 15x10, open ────────────────────────────────────
  setFloor(tiles, 2, 22, 16, 31, 'floor-tile-gray', theme);
  // chairY=27, not 26 — both desk and chair footprints are 2 tiles tall
  // (see FOOTPRINT), so a desk at row 24 occupies 24-25; chairY needs to be
  // deskY+3 to actually leave row 26 open as the walking gap placeDeskRow's
  // own doc comment promises, not deskY+2 which puts them flush together.
  placeDeskRow(tiles, furniture, 4, 24, 27, 4, theme);
  placeFurniture(tiles, furniture, 'plant-small', 15, 23, theme);
  addBanner(furniture, 3, 23, 4, 'Desk Nook', '#3b82f6');

  // ── Meeting Room — (28,22) 19x10, door on the left ───────────────────
  wallRect(tiles, 28, 22, 46, 31);
  setTile(tiles, 28, 26, 'door');
  setFloor(tiles, 29, 23, 45, 30, 'floor-maroon-carpet', theme);
  placeFurniture(tiles, furniture, 'meeting-table', 35, 26, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 37, 26, theme);
  placeFurniture(tiles, furniture, 'chair-office', 35, 24, theme);
  placeFurniture(tiles, furniture, 'chair-office', 36, 24, theme);
  placeFurniture(tiles, furniture, 'chair-office', 38, 24, theme);
  placeFurniture(tiles, furniture, 'chair-office', 35, 28, theme);
  placeFurniture(tiles, furniture, 'chair-office', 36, 28, theme);
  placeFurniture(tiles, furniture, 'chair-office', 38, 28, theme);
  placeFurniture(tiles, furniture, 'plant-potted', 29, 23, theme);
  zones.push({
    id: 'meeting-room', name: 'Meeting Room',
    x: 28, y: 22, width: 19, height: 10,
    label: 'MEETING ROOM', color: '#6B2FBF', type: 'meeting',
  });

  // ── Entrance / Reception — (2,33) 46x2, spans the bottom ─────────────
  setTile(tiles, 25, 34, 'spawn');
  addBanner(furniture, 20, 32, 10, 'Welcome', '#6B2FBF');
  placeFurniture(tiles, furniture, 'plant-tall', 4, 33, theme);
  placeFurniture(tiles, furniture, 'plant-accent', 45, 33, theme);

  return { tiles, furniture, zones };
}

/**
 * Corporate-office template — v2, built against a real reference floor-plan
 * IMAGE (the first version was built from a text description alone, before
 * the image was available — see git history for that version's own notes on
 * substitutions, still mostly true here too). Three building clusters:
 * left = the main building (CEO office, AI Team + Dev Team open-plan
 * areas, ground-floor entrance plaza); right = a Consulting building (4
 * separate small consulting rooms around a central glass hallway) with a
 * Lounge below it (bar counter + dining); bottom = a small annex building
 * with 3 breakout meeting rooms (AI Team's own, a general one, Dev Team's
 * own) — the image reuses the team names here for a SEPARATE small meeting
 * room each, distinct from their open-plan desk area upstairs, not a
 * duplicate of it.
 *
 *   ┌──────────────────────────┐  ┌────────────────────────┐
 *   │ CEO  │                   │  │ CONSULT │ CONSULT       │
 *   │(1,1) │   ODOO TEAM       │  │   TL    │   TR          │
 *   │12x9  │   (14,1) 13x24    │  ├─────glass hallway───────┤
 *   ├──────┤   (open, desk     │  │ CONSULT │ CONSULT       │
 *   │AI    │    islands)       │  │   BL    │   BR          │
 *   │TEAM  │                   │  ├────────────────────────┤
 *   │(1,10)│                   │  │       LOUNGE            │
 *   │13x15 │                   │  │  (29,19) 20x12          │
 *   ├──────┴───────────────────┤  └────────────────────────┘
 *   │   ENTRANCE PLAZA (spawn)  │
 *   ├──────────┬────────┬───────┤
 *   │ AI TEAM  │MEETING │ ODOO  │
 *   │ (meeting)│ ROOM   │ TEAM  │
 *   │ (1,27)   │(10,27) │(meet.)│
 *   └──────────┴────────┴───────┘
 *          ^ corridor cols 27-28 connects left building, right building,
 *            and the annex vertically/horizontally
 *
 * Asset substitutions unchanged from v1 (no new assets became available —
 * see the room-creation report for the full list): reception/bar counter →
 * desk-basic, bookshelf/shelving → wardrobe, round/coffee table → reused
 * meeting-table, wall-mounted screen → tv-monitor, water cooler and vending
 * machines → omitted (no matching asset at all), glass hallway → left
 * un-walled entirely rather than a solid-wall stand-in.
 */
export function createCorporateOfficeLayout(theme: RoomTheme = 'modern-interiors'): { tiles: RoomTile[][]; furniture: Furniture[]; zones: Zone[] } {
  const tiles: RoomTile[][] = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const row: RoomTile[] = [];
    for (let x = 0; x < MAP_WIDTH; x++) {
      row.push({ x, y, type: 'floor' });
    }
    tiles.push(row);
  }
  wallRect(tiles, 0, 0, MAP_WIDTH - 1, MAP_HEIGHT - 1);

  const furniture: Furniture[] = [];
  const zones: Zone[] = [];

  // ══ LEFT BUILDING (x:1-26) ══════════════════════════════════════════════

  // ── CEO office — (1,1) 12x9, door on the bottom (into AI Team) ──────────
  wallRect(tiles, 1, 1, 12, 9);
  setTile(tiles, 6, 9, 'door');
  setFloor(tiles, 2, 2, 11, 8, 'floor-maroon-carpet', theme);
  placeFurniture(tiles, furniture, 'desk-computer-a', 4, 4, theme);
  placeFurniture(tiles, furniture, 'chair-office', 4, 6, theme);
  // Bookshelf substitute — no distinct shelving asset exists (see this
  // template's own header comment).
  placeFurniture(tiles, furniture, 'wardrobe', 2, 4, theme);
  placeFurniture(tiles, furniture, 'sofa-set', 9, 4, theme);
  // Coffee table — meeting-table reused, same convention used throughout
  // this file for every round/coffee table.
  placeFurniture(tiles, furniture, 'meeting-table', 9, 7, theme);
  placeFurniture(tiles, furniture, 'plant-potted', 11, 2, theme);
  zones.push({
    id: 'ceo-office', name: 'CEO Office',
    x: 1, y: 1, width: 12, height: 9,
    label: 'CEO', color: '#1e293b', type: 'desk',
  });

  // ── AI Team — (1,10) 13x15, open-plan desk area ─────────────────────────
  setFloor(tiles, 1, 10, 13, 24, 'floor-tile-gray', theme);
  placeDeskIsland(tiles, furniture, 3, 13, theme, ['desk-computer-a', 'desk-basic', 'desk-basic', 'desk-computer-b']);
  placeDeskIsland(tiles, furniture, 8, 13, theme, ['desk-computer-c', 'desk-computer-a', 'desk-basic', 'desk-computer-b']);
  placeDeskIsland(tiles, furniture, 3, 19, theme, ['desk-basic', 'desk-computer-b', 'desk-computer-a', 'desk-computer-c']);
  addBanner(furniture, 2, 11, 5, 'AI TEAM', '#0ea5e9');
  placeFurniture(tiles, furniture, 'plant-tall', 1, 10, theme);
  zones.push({
    id: 'ai-team', name: 'AI Team',
    x: 1, y: 10, width: 13, height: 15,
    label: 'AI TEAM', color: '#0ea5e9', type: 'desk',
  });

  // ── Odoo Team — (14,1) 13x24, open-plan desk area (bigger, matches the ──
  // reference image's larger team) ────────────────────────────────────────
  setFloor(tiles, 14, 1, 26, 24, 'floor-lavender', theme);
  placeDeskIsland(tiles, furniture, 16, 4, theme, ['desk-computer-b', 'desk-basic', 'desk-computer-a', 'desk-computer-c']);
  placeDeskIsland(tiles, furniture, 21, 4, theme, ['desk-computer-a', 'desk-computer-c', 'desk-basic', 'desk-computer-b']);
  placeDeskIsland(tiles, furniture, 16, 11, theme, ['desk-computer-c', 'desk-basic', 'desk-computer-b', 'desk-computer-a']);
  placeDeskIsland(tiles, furniture, 21, 11, theme, ['desk-basic', 'desk-computer-a', 'desk-computer-c', 'desk-basic']);
  placeDeskIsland(tiles, furniture, 16, 18, theme, ['desk-computer-a', 'desk-computer-b', 'desk-basic', 'desk-computer-c']);
  placeDeskIsland(tiles, furniture, 21, 18, theme, ['desk-computer-b', 'desk-basic', 'desk-computer-c', 'desk-computer-a']);
  addBanner(furniture, 15, 1, 6, 'DEV TEAM', '#8b5cf6');
  placeFurniture(tiles, furniture, 'plant-tall', 26, 1, theme);
  placeFurniture(tiles, furniture, 'pinboard', 14, 23, theme);
  zones.push({
    id: 'dev-team', name: 'Dev Team',
    x: 14, y: 1, width: 13, height: 24,
    label: 'DEV TEAM', color: '#8b5cf6', type: 'desk',
  });

  // ── Entrance plaza — (1,25) 26x2, spans the bottom of the left building ─
  setFloor(tiles, 1, 25, 26, 26, 'floor-tile-gray', theme);
  setTile(tiles, 13, 25, 'spawn');
  addBanner(furniture, 4, 25, 4, 'OFFICE', '#1e3a8a');
  addBanner(furniture, 19, 25, 4, 'OFFICE', '#1e3a8a');
  placeFurniture(tiles, furniture, 'meeting-table', 8, 26, theme);
  placeFurniture(tiles, furniture, 'chair-office', 7, 26, theme);
  placeFurniture(tiles, furniture, 'chair-office', 10, 26, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 17, 26, theme);
  placeFurniture(tiles, furniture, 'chair-office', 16, 26, theme);
  placeFurniture(tiles, furniture, 'chair-office', 19, 26, theme);

  // ── Annex building (bottom, x:1-26, y:27-34) — 3 breakout meeting rooms,
  // each with a door on its own top wall opening onto the plaza above ─────
  wallRect(tiles, 1, 27, 9, 34);
  setTile(tiles, 5, 27, 'door');
  setFloor(tiles, 2, 28, 8, 33, 'floor-tile-gray', theme);
  placeFurniture(tiles, furniture, 'meeting-table', 4, 30, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 6, 30, theme);
  placeFurniture(tiles, furniture, 'chair-office', 4, 28, theme);
  placeFurniture(tiles, furniture, 'chair-office', 6, 28, theme);
  placeFurniture(tiles, furniture, 'chair-office', 4, 32, theme);
  placeFurniture(tiles, furniture, 'chair-office', 6, 32, theme);
  zones.push({
    id: 'ai-team-meeting', name: 'AI Team Meeting Room',
    x: 1, y: 27, width: 9, height: 8,
    label: 'AI TEAM', color: '#0ea5e9', type: 'meeting',
  });

  wallRect(tiles, 10, 27, 17, 34);
  setTile(tiles, 13, 27, 'door');
  setFloor(tiles, 11, 28, 16, 33, 'floor-maroon-carpet', theme);
  placeFurniture(tiles, furniture, 'meeting-table', 12, 30, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 14, 30, theme);
  placeFurniture(tiles, furniture, 'chair-office', 12, 28, theme);
  placeFurniture(tiles, furniture, 'chair-office', 14, 28, theme);
  placeFurniture(tiles, furniture, 'chair-office', 12, 32, theme);
  placeFurniture(tiles, furniture, 'chair-office', 14, 32, theme);
  placeFurniture(tiles, furniture, 'plant-potted', 11, 28, theme);
  zones.push({
    id: 'meeting-room', name: 'Meeting Room',
    x: 10, y: 27, width: 8, height: 8,
    label: 'MEETING ROOM', color: '#6B2FBF', type: 'meeting',
  });

  wallRect(tiles, 18, 27, 26, 34);
  setTile(tiles, 22, 27, 'door');
  setFloor(tiles, 19, 28, 25, 33, 'floor-tile-gray', theme);
  placeFurniture(tiles, furniture, 'meeting-table', 20, 30, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 22, 30, theme);
  placeFurniture(tiles, furniture, 'chair-office', 20, 28, theme);
  placeFurniture(tiles, furniture, 'chair-office', 22, 28, theme);
  placeFurniture(tiles, furniture, 'chair-office', 20, 32, theme);
  placeFurniture(tiles, furniture, 'chair-office', 22, 32, theme);
  zones.push({
    id: 'dev-team-meeting', name: 'Dev Team Meeting Room',
    x: 18, y: 27, width: 9, height: 8,
    label: 'DEV TEAM', color: '#8b5cf6', type: 'meeting',
  });

  // ══ Corridor — cols 27-28, connects left building, right building, and ══
  // the annex vertically/horizontally. ════════════════════════════════════
  setFloor(tiles, 27, 1, 28, 34, 'floor-tile-gray', theme);

  // ══ RIGHT BUILDING (x:29-48) — 4 Consulting rooms + Lounge ══════════════

  // ── Consulting TL — (29,1) 10x8, door on the bottom (into the hallway) ──
  wallRect(tiles, 29, 1, 38, 8);
  setTile(tiles, 33, 8, 'door');
  setFloor(tiles, 30, 2, 37, 7, 'floor-tile-gray', theme);
  placeFurniture(tiles, furniture, 'meeting-table', 33, 5, theme);
  placeFurniture(tiles, furniture, 'chair-office', 32, 3, theme);
  placeFurniture(tiles, furniture, 'chair-office', 34, 3, theme);
  placeFurniture(tiles, furniture, 'chair-office', 32, 7, theme);
  placeFurniture(tiles, furniture, 'chair-office', 34, 7, theme);
  placeFurniture(tiles, furniture, 'tv-monitor', 30, 2, theme);
  zones.push({
    id: 'consulting-tl', name: 'Consulting (TL)',
    x: 29, y: 1, width: 10, height: 8,
    label: 'CONSULTING', color: '#0891b2', type: 'desk',
  });

  // ── Consulting TR — (39,1) 10x8, door on the bottom ──────────────────────
  wallRect(tiles, 39, 1, 48, 8);
  setTile(tiles, 43, 8, 'door');
  setFloor(tiles, 40, 2, 47, 7, 'floor-tile-gray', theme);
  placeFurniture(tiles, furniture, 'meeting-table', 43, 5, theme);
  placeFurniture(tiles, furniture, 'chair-office', 42, 3, theme);
  placeFurniture(tiles, furniture, 'chair-office', 44, 3, theme);
  placeFurniture(tiles, furniture, 'chair-office', 42, 7, theme);
  placeFurniture(tiles, furniture, 'chair-office', 44, 7, theme);
  placeFurniture(tiles, furniture, 'tv-monitor', 46, 2, theme);
  zones.push({
    id: 'consulting-tr', name: 'Consulting (TR)',
    x: 39, y: 1, width: 10, height: 8,
    label: 'CONSULTING', color: '#0891b2', type: 'desk',
  });

  // ── Glass hallway — (29,9) 20x2, deliberately un-walled (see header) ────
  setFloor(tiles, 29, 9, 48, 10, 'floor-lavender', theme);

  // ── Consulting BL — (29,11) 10x8, door on the top (into the hallway) ────
  wallRect(tiles, 29, 11, 38, 18);
  setTile(tiles, 33, 11, 'door');
  setFloor(tiles, 30, 12, 37, 17, 'floor-tile-gray', theme);
  placeFurniture(tiles, furniture, 'meeting-table', 33, 15, theme);
  placeFurniture(tiles, furniture, 'chair-office', 32, 13, theme);
  placeFurniture(tiles, furniture, 'chair-office', 34, 13, theme);
  placeFurniture(tiles, furniture, 'chair-office', 32, 17, theme);
  placeFurniture(tiles, furniture, 'chair-office', 34, 17, theme);
  placeFurniture(tiles, furniture, 'tv-monitor', 30, 17, theme);
  zones.push({
    id: 'consulting-bl', name: 'Consulting (BL)',
    x: 29, y: 11, width: 10, height: 8,
    label: 'CONSULTING', color: '#0891b2', type: 'desk',
  });

  // ── Consulting BR — (39,11) 10x8, door on the top ───────────────────────
  wallRect(tiles, 39, 11, 48, 18);
  setTile(tiles, 43, 11, 'door');
  setFloor(tiles, 40, 12, 47, 17, 'floor-tile-gray', theme);
  placeFurniture(tiles, furniture, 'meeting-table', 43, 15, theme);
  placeFurniture(tiles, furniture, 'chair-office', 42, 13, theme);
  placeFurniture(tiles, furniture, 'chair-office', 44, 13, theme);
  placeFurniture(tiles, furniture, 'chair-office', 42, 17, theme);
  placeFurniture(tiles, furniture, 'chair-office', 44, 17, theme);
  placeFurniture(tiles, furniture, 'tv-monitor', 46, 17, theme);
  zones.push({
    id: 'consulting-br', name: 'Consulting (BR)',
    x: 39, y: 11, width: 10, height: 8,
    label: 'CONSULTING', color: '#0891b2', type: 'desk',
  });

  // ── Lounge — (29,19) 20x12, open (bar counter + dining) ─────────────────
  setFloor(tiles, 29, 19, 48, 30, 'floor-brown-weave', theme);
  // Bar counter substitute — no distinct counter asset exists (see header);
  // a row of plain desks against the back wall reads reasonably as one.
  placeFurniture(tiles, furniture, 'desk-basic', 30, 21, theme);
  placeFurniture(tiles, furniture, 'desk-basic', 31, 21, theme);
  placeFurniture(tiles, furniture, 'desk-basic', 32, 21, theme);
  placeFurniture(tiles, furniture, 'wardrobe', 34, 21, theme);
  setFloor(tiles, 36, 22, 47, 29, 'floor-maroon-carpet', theme);
  placeFurniture(tiles, furniture, 'meeting-table', 38, 24, theme);
  placeFurniture(tiles, furniture, 'chair-office', 37, 24, theme);
  placeFurniture(tiles, furniture, 'chair-office', 39, 24, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 43, 24, theme);
  placeFurniture(tiles, furniture, 'chair-office', 42, 24, theme);
  placeFurniture(tiles, furniture, 'chair-office', 44, 24, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 38, 28, theme);
  placeFurniture(tiles, furniture, 'chair-office', 37, 28, theme);
  placeFurniture(tiles, furniture, 'chair-office', 39, 28, theme);
  placeFurniture(tiles, furniture, 'meeting-table', 43, 28, theme);
  placeFurniture(tiles, furniture, 'chair-office', 42, 28, theme);
  placeFurniture(tiles, furniture, 'chair-office', 44, 28, theme);
  placeFurniture(tiles, furniture, 'plant-tall', 29, 19, theme);
  placeFurniture(tiles, furniture, 'plant-potted', 47, 29, theme);
  addBanner(furniture, 36, 19, 5, 'LOUNGE', '#7c3aed');

  return { tiles, furniture, zones };
}


// §2 — Office Templates. Picked once at room-creation time (see Lobby.tsx);
// unlike RoomTheme (a reskin applied to whichever layout is already there),
// a template is a completely different tile/furniture/zone layout — the
// room's floor plan itself, not just the art drawn over it.
export type RoomTemplateId = 'main-office' | 'small-team' | 'open-lounge' | 'corporate-office';

export const ROOM_TEMPLATES: { id: RoomTemplateId; name: string; description: string }[] = [
  { id: 'main-office', name: 'Main Office', description: '8 zones, 4 team clusters — a full multi-team office' },
  { id: 'small-team', name: 'Small Team', description: 'One meeting room, 2 desk clusters, and a lounge corner' },
  { id: 'open-lounge', name: 'Open Lounge', description: 'Mostly social space, a small desk nook, one meeting room' },
  { id: 'corporate-office', name: 'Kantor Perusahaan', description: 'Denah kantor lengkap — ruang CEO, dua area tim open-plan, 4 ruang konsultasi, lounge, dan ruang meeting breakout' },
];

export function createRoomLayoutFromTemplate(
  templateId: RoomTemplateId | undefined,
  theme: RoomTheme = 'scifi-office',
): { tiles: RoomTile[][]; furniture: Furniture[]; zones: Zone[] } {
  switch (templateId) {
    case 'small-team': return createSmallTeamLayout(theme);
    case 'open-lounge': return createLoungeLayout(theme);
    case 'corporate-office': return createCorporateOfficeLayout(theme);
    case 'main-office':
    default: return createDefaultOfficeLayout(theme);
  }
}
