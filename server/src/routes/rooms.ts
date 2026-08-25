import { Router, Response } from 'express';
import { Server } from 'socket.io';
import multer from 'multer';
import fs from 'fs';
import { getPrisma } from '../lib/prisma';
import { SocketEvents, createRoomLayoutFromTemplate, findZoneEntryTile, hasFeatureAccess, LayerData, layerDataToLegacy, findSpawnPixel, TILE_SIZE, MediaType, MediaPayload, SoundboardSoundData, SOUNDBOARD_MAX_DURATION_MS, SOUNDBOARD_MAX_FILE_BYTES, AVATAR_SCALE_MIN, AVATAR_SCALE_MAX } from '@kaispace/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveRoomRole } from '../lib/roles';
import { findRoomInOrg } from '../lib/orgScope';
import { canEnterRoom } from '../lib/roomMembership';
import { convertLegacyRoom } from '../lib/convertLegacyRoom';
import { isValidMediaPayload, isUploadUrl } from '../socket/mediaHandler';
import { redactInteractiveSecrets, redactDoorPasswords, redactDoorAreaPasswords } from '../lib/redactFurniture';
import { deleteUploadedFile, storage as uploadStorage } from './uploads';
import { setCachedTiles, setCachedImpassableAreas, setCachedDoorAreaRects, setCachedZones, getPlayers, updatePlayerPosition } from '../store/roomStore';
import { zonesOfRoom } from './roomMembers';

// Client shape for a MapMediaObject row (mirrors mediaHandler.toClientShape).
function mediaShape(r: { id: string; roomId: string; type: string; x: number; y: number; createdBy: string; createdByName: string; createdAt: Date; expiresAt: Date | null; payload: unknown }) {
  return { id: r.id, roomId: r.roomId, type: r.type, x: r.x, y: r.y, createdBy: r.createdBy, createdByName: r.createdByName, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null, payload: (r.payload as MediaPayload) ?? {} };
}
import { validate, createRoomSchema, renameRoomSchema, avatarUpdateSchema, fullNameSchema } from '../middleware/validate';
import { ensureGroupConversation } from '../lib/conversations';

const rooms = Router();


// Set once from index.ts after the Socket.IO server is created, so the
// DELETE route below can notify/kick players currently in the room being
// deleted — deleting via this REST endpoint (used by the Lobby) previously
// left active sockets in a room whose DB row no longer existed until reload.
let ioRef: Server | null = null;
export function setIo(io: Server): void {
  ioRef = io;
}

// The Lobby's "X / 50 online" count used to be `_count.members` — a DB row
// count of everyone EVER granted membership (e.g. approved once), not who's
// actually connected right now. A brand-new room with one approved member
// and zero live players showed "1 online" and just sat there wrong until
// some unrelated join/leave elsewhere happened to fire broadcastRoomCount
// (roomHandler.ts) and overwrite it — "not real time" exactly as reported.
// This mirrors that same live source (io.sockets.adapter.rooms, the actual
// Socket.IO room membership) so the very first paint is already correct,
// not just eventually-consistent after the first live update lands.
function getLivePlayerCount(slug: string): number {
  return ioRef?.sockets.adapter.rooms.get(slug)?.size ?? 0;
}

function generateSlug(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) slug = 'room';
  return slug + '-' + Date.now().toString(36);
}

// GET /api/rooms — list public rooms
// Multi-tenant Fase 2 — this used to have NO auth middleware at all and
// listed every public room across the whole deployment; now requires a
// valid session and scopes the list to the caller's own org. The client
// (Lobby.tsx) only ever calls this once logged in and already sends the
// Bearer token on every request (see services/api.ts's request()), so this
// doesn't change anything for a real user — it closes an actual gap where
// an unauthenticated caller (or, once a second org exists, a member of a
// DIFFERENT org) could list rooms that were never theirs to see.
rooms.get('/rooms', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
    const prisma = getPrisma();
    const roomList = await prisma.room.findMany({
      where: { isPublic: true, organizationId: req.organizationId },
      include: {
        owner: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      // Higher cap so the Lobby's client-side search/sort covers effectively
      // all active rooms, not just the 50 most recent. Still bounded so a
      // runaway room count can't return an unbounded payload.
      take: 300,
    });

    return res.json({
      rooms: roomList.map((r: any) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        ownerId: r.ownerId,
        ownerDisplayName: r.owner?.displayName || 'Unknown',
        playerCount: getLivePlayerCount(r.slug),
        maxPlayers: r.maxPlayers,
        theme: r.theme,
        coverImage: r.coverImage,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error('[rooms] list error:', err);
    return res.status(500).json({ error: 'Failed to list rooms' });
  }
});

// GET /api/rooms/:slug — get room by slug
// Multi-tenant Fase 2 — same treatment as GET /rooms above: was fully
// unauthenticated, letting anyone enumerate/guess a slug and read another
// company's room details. `slug` is still globally unique today (composite
// per-org uniqueness is a separate, later decision — see the schema
// comment), so the lookup itself is unchanged; the org check happens AFTER
// the fetch and returns the identical 404 a truly-missing room would, so a
// wrong-org caller can't tell "doesn't exist" from "exists in another org".
rooms.get('/rooms/:slug', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({
      where: { slug: req.params.slug },
      include: {
        owner: { select: { displayName: true } },
      },
    });

    if (!room || room.organizationId !== req.organizationId) {
      return res.status(404).json({ error: 'Room not found' });
    }

    return res.json({
      id: room.id,
      name: room.name,
      slug: room.slug,
      ownerId: room.ownerId,
      ownerDisplayName: room.owner?.displayName || 'Unknown',
      playerCount: getLivePlayerCount(room.slug),
      maxPlayers: room.maxPlayers,
      isPublic: room.isPublic,
      theme: room.theme,
      coverImage: room.coverImage,
    });
  } catch (err) {
    console.error('[rooms] get error:', err);
    return res.status(500).json({ error: 'Failed to get room' });
  }
});

// GET /api/rooms/:slug/zones — lightweight, read-only list of this room's
// 'meeting'-type Zones, for the Calendar event form's Meeting Area picker.
// Deliberately NOT admin-gated like /rooms/:slug/editor-data (room:update) —
// any org member scheduling a meeting needs to read this, not just admins.
rooms.get('/rooms/:slug/zones', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({
      where: { slug: req.params.slug },
      select: { organizationId: true, zones: true, layerData: true },
    });
    if (!room || room.organizationId !== req.organizationId) {
      return res.status(404).json({ error: 'Room not found' });
    }
    const zones = zonesOfRoom(room);
    return res.json({
      zones: zones.filter((z) => z.type === 'meeting').map((z) => ({ id: z.id, name: z.name })),
    });
  } catch (err) {
    console.error('[rooms] zones error:', err);
    return res.status(500).json({ error: 'Failed to get zones' });
  }
});

// PATCH /api/rooms/:slug/cover — { coverImage } set the Lobby card cover.
// The actual file goes through the existing generic POST /api/uploads first
// (client: api.uploadMedia, same call Room Editor's reference-image feature
// already uses) — this route only ever stores the URL it returns, same
// same-origin allowlist as isUploadUrl (mediaHandler.ts) so a room can't
// point its cover at an arbitrary external URL. null clears it back to the
// Lobby's placeholder. Same room:update gate every other room-admin action
// in this file uses.
rooms.patch('/rooms/:slug/cover', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const coverImage = req.body?.coverImage;
    if (coverImage !== null && (typeof coverImage !== 'string' || !/^\/api\/(uploads|files)\//.test(coverImage))) {
      return res.status(400).json({ error: 'coverImage tidak valid' });
    }
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!hasFeatureAccess(role, 'room:update')) {
      return res.status(403).json({ error: 'Admin role required to change the cover' });
    }
    await prisma.room.update({ where: { id: room.id }, data: { coverImage } });
    return res.json({ ok: true, coverImage });
  } catch (err) {
    console.error('[rooms] set cover error:', err);
    return res.status(500).json({ error: 'Gagal menyimpan cover' });
  }
});

// PATCH /api/rooms/:slug/name — rename a room's display name. Same
// room:update gate + "..." menu placement as Ganti Cover above (a room's
// name/cover are both presentation details an admin can change any time,
// unlike Delete which stays owner-only). The slug itself is untouched —
// renaming never breaks existing bookmarks/invite links/guest links, which
// all key off the slug, not the display name.
rooms.patch('/rooms/:slug/name', authenticateToken, validate(renameRoomSchema), async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!hasFeatureAccess(role, 'room:update')) {
      return res.status(403).json({ error: 'Admin role required to rename this room' });
    }
    const name = req.body.name.trim();
    if (!name) return res.status(400).json({ error: 'Nama room tidak boleh kosong' });
    await prisma.room.update({ where: { id: room.id }, data: { name } });
    return res.json({ ok: true, name });
  } catch (err) {
    console.error('[rooms] rename error:', err);
    return res.status(500).json({ error: 'Gagal mengganti nama room' });
  }
});

// GET /api/rooms/:slug/editor-data — full map payload for the ZEP-style Room
// Editor (which opens in its own browser tab). Admin-gated at the SERVER, not
// just behind a hidden button: resolve the caller's per-room role and require
// room:update (admin+), so a non-admin hitting this URL directly is refused
// with 403. Read-only — returns the room's stored map exactly as saved; this
// endpoint never writes (Potong 0 is view-only).
rooms.get('/rooms/:slug/editor-data', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!hasFeatureAccess(role, 'room:update')) {
      return res.status(403).json({ error: 'Admin role required to edit this room' });
    }
    // Potong 1 — lazy migration: convert this room to the layered format on
    // first open (idempotent; a round-trip-verified no-op if already converted
    // or if conversion can't be proven lossless). layerData may be null if the
    // guard refused, in which case the editor falls back to the legacy fields.
    const conv = await convertLegacyRoom(room.id);
    const layerData = conv.layerData ?? (room.layerData as unknown) ?? null;
    return res.json({
      id: room.id,
      name: room.name,
      slug: room.slug,
      theme: room.theme ?? 'default',
      layerData,
      tilemapData: room.tilemapData ?? null,
      furniture: room.furniture ?? [],
      zones: room.zones ?? [],
    });
  } catch (err) {
    console.error('[rooms] editor-data error:', err);
    return res.status(500).json({ error: 'Failed to load editor data' });
  }
});

// PUT /api/rooms/:slug/editor/layers — Potong 2/3: write layered edits from the
// new Room Editor. Admin-gated (room:update). Applies floor + wall per-tile
// changes (per-tile last-write-wins) and, when present, replaces the objects /
// topObjects arrays. Persists, refreshes the collision cache (walls change it),
// and broadcasts ROOM_UPDATED so everyone in the room sees it live — no refresh.
rooms.put('/rooms/:slug/editor/layers', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!hasFeatureAccess(role, 'room:update')) {
      return res.status(403).json({ error: 'Admin role required to edit this room' });
    }
    if (!room.layerData) {
      // The editor converts on open, so this shouldn't happen — but never write
      // a layered edit onto an unconverted room (that would create a second
      // source of truth).
      return res.status(409).json({ error: 'Room not in layered format yet' });
    }

    const layerData = room.layerData as unknown as LayerData;
    const body = req.body ?? {};

    // Resize (Potong 5): full grid + dimension replace. A resize save carries
    // width/height/floor/wall instead of per-tile diffs.
    let resized = false;
    if (Number.isInteger(body.width) && Number.isInteger(body.height) && Array.isArray(body.floor) && Array.isArray(body.wall)
        && body.width >= 1 && body.width <= 200 && body.height >= 1 && body.height <= 200) {
      layerData.width = body.width;
      layerData.height = body.height;
      layerData.floor = body.floor;
      layerData.wall = body.wall;
      // Fitur 15 — optional; older clients/resizes that don't know about
      // custom wall skins simply omit it, and the wall grid still saves fine.
      if (Array.isArray(body.wallPaletteId)) layerData.wallPaletteId = body.wallPaletteId;
      resized = true;
    }

    for (const c of Array.isArray(body.floorChanges) ? body.floorChanges : []) {
      const x = Number(c?.x), y = Number(c?.y);
      if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
      const row = layerData.floor[y];
      if (!row || x < 0 || x >= row.length) continue;
      row[x] = c?.value == null ? null : String(c.value);
    }
    for (const c of Array.isArray(body.wallChanges) ? body.wallChanges : []) {
      const x = Number(c?.x), y = Number(c?.y);
      if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
      const row = layerData.wall[y];
      if (!row || x < 0 || x >= row.length) continue;
      row[x] = !!c?.value;
      // Fitur 15 — per-cell custom wall skin, carried alongside the boolean
      // wall change (same tile, same click). Lazily allocate the grid the
      // first time any room actually uses it, matching the room's current
      // dimensions — older rooms never touch this path at all.
      if ('paletteId' in (c ?? {})) {
        if (!layerData.wallPaletteId) {
          layerData.wallPaletteId = Array.from({ length: layerData.height }, () => Array.from({ length: layerData.width }, () => null));
        }
        const wpRow = layerData.wallPaletteId[y];
        if (wpRow && x >= 0 && x < wpRow.length) {
          const pid = (c as { paletteId?: unknown }).paletteId;
          wpRow[x] = typeof pid === 'string' ? pid : null;
        }
      }
    }
    // Objects / top objects: full-array replace (small entity lists). Lightly
    // sanitized so a bad payload can't corrupt the shape.
    const sanitizeObjs = (arr: unknown): LayerData['objects'] | null => {
      if (!Array.isArray(arr)) return null;
      return arr
        .filter((o) => o && typeof o === 'object' && typeof (o as { paletteId?: unknown }).paletteId === 'string'
          && Number.isInteger((o as { x?: unknown }).x) && Number.isInteger((o as { y?: unknown }).y))
        // Fitur 15B — image_popup's imageUrl must be a same-origin upload URL,
        // same rule as MapMediaObject payloads (isUploadUrl). Rather than
        // rejecting the whole piece over a bad/foreign URL, just drop the
        // image so the rest of its placement (position, other fields) still
        // saves — the editor's own upload flow never produces a URL that
        // would fail this anyway.
        .map((o) => {
          const obj = o as { interactiveType?: unknown; interactiveConfig?: { imageUrl?: unknown; url?: unknown; apiUrl?: unknown; spriteFile?: unknown } };
          if (obj.interactiveType === 'image_popup' && obj.interactiveConfig && !isUploadUrl(obj.interactiveConfig.imageUrl)) {
            return { ...obj, interactiveConfig: { ...obj.interactiveConfig, imageUrl: undefined } };
          }
          // animation's spriteFile — same upload-URL rule as image_popup.
          if (obj.interactiveType === 'animation' && obj.interactiveConfig && !isUploadUrl(obj.interactiveConfig.spriteFile)) {
            return { ...obj, interactiveConfig: { ...obj.interactiveConfig, spriteFile: undefined } };
          }
          // Fitur 15B — website's url must be https:// (same rule the
          // existing website MEDIA type enforces, mediaHandler.isValidMediaPayload)
          // — never javascript:/data:/http: etc. Drop rather than reject the
          // whole piece, same reasoning as image_popup above.
          if ((obj.interactiveType === 'website' || obj.interactiveType === 'website_tab') && obj.interactiveConfig && !(typeof obj.interactiveConfig.url === 'string' && /^https:\/\/\S+$/i.test(obj.interactiveConfig.url))) {
            return { ...obj, interactiveConfig: { ...obj.interactiveConfig, url: undefined } };
          }
          // api_call's apiUrl — same https:// rule, doubly important here
          // since it's the SERVER (not a browser tab) that ends up making
          // the request to it — see INTERACTIVE_API_CALL in roomHandler.ts.
          if (obj.interactiveType === 'api_call' && obj.interactiveConfig && !(typeof obj.interactiveConfig.apiUrl === 'string' && /^https:\/\/\S+$/i.test(obj.interactiveConfig.apiUrl))) {
            return { ...obj, interactiveConfig: { ...obj.interactiveConfig, apiUrl: undefined } };
          }
          return o;
        })
        // Banner tile-effect (Fitur: free-angle rotation) — bannerRotationDeg
        // is the one genuinely new field this feature adds; same fail-soft
        // posture as capacity below (drop the bad value, keep the rest of
        // the piece) rather than rejecting the whole object over it.
        .map((o) => {
          const obj = o as { bannerRotationDeg?: unknown };
          if (obj.bannerRotationDeg == null) return o;
          if (typeof obj.bannerRotationDeg !== 'number' || !Number.isFinite(obj.bannerRotationDeg)) {
            return { ...obj, bannerRotationDeg: undefined };
          }
          return { ...obj, bannerRotationDeg: ((Math.round(obj.bannerRotationDeg) % 360) + 360) % 360 };
        })
        .slice(0, 2000) as LayerData['objects'];
    };
    if ('objects' in body) { const o = sanitizeObjs(body.objects); if (o) layerData.objects = o; }
    if ('topObjects' in body) { const o = sanitizeObjs(body.topObjects); if (o) layerData.topObjects = o; }

    // Tile effects (Potong 4): per-tile effects + rectangular areas. Full-array
    // replace, lightly sanitized. tileEffects drive spawn/impassable via the
    // adaptor; areas drive labeled + private zones.
    if ('tileEffects' in body && Array.isArray(body.tileEffects)) {
      layerData.tileEffects = body.tileEffects
        .filter((e: unknown) => e && typeof e === 'object' && Number.isInteger((e as { x?: unknown }).x) && Number.isInteger((e as { y?: unknown }).y) && typeof (e as { kind?: unknown }).kind === 'string')
        .slice(0, 5000) as LayerData['tileEffects'];
    }
    if ('areas' in body && Array.isArray(body.areas)) {
      // Free-resize follow-up — was Number.isInteger; Impassable Area
      // rectangles (Item #9) are no longer grid-snapped, so their
      // width/height are legitimately fractional now. isFinite + positive
      // covers both that and the still-integer privateArea/mapLocation zones
      // (an integer is always finite and positive, so nothing there changes).
      const isPositiveFinite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
      layerData.areas = body.areas
        .filter((a: unknown) => a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string' && isPositiveFinite((a as { width?: unknown }).width) && isPositiveFinite((a as { height?: unknown }).height))
        .map((a: { capacity?: unknown }) => {
          // Item #14 — capacity is optional; strip anything that isn't a
          // positive integer instead of rejecting the whole area, same
          // fail-soft posture as the interactiveConfig sanitizers above.
          if (a.capacity == null) return a;
          if (Number.isInteger(a.capacity) && (a.capacity as number) > 0) return a;
          return { ...a, capacity: undefined };
        })
        .slice(0, 500) as LayerData['areas'];
    }

    // Fitur 15 — custom Floor/Wall/Object uploads. Full-array replace, like
    // areas/tileEffects above. `src` must be a same-origin upload URL (the
    // exact same check MapMediaObject payloads use) — never store/serve an
    // arbitrary external URL as if it were room art. createdBy/createdByName/
    // createdAt are never taken from the client: existing entries (matched by
    // id) keep their ORIGINAL stored attribution unconditionally (a client
    // can't rewrite who uploaded something by resending an edited copy), and
    // genuinely new ids get stamped from the authenticated request — same
    // convention POST /editor/media already uses for MapMediaObject.
    if ('customAssets' in body && Array.isArray(body.customAssets)) {
      const existingById = new Map((layerData.customAssets ?? []).map((a) => [a.id, a]));
      const valid = body.customAssets.filter((a: unknown) => a && typeof a === 'object'
        && typeof (a as { id?: unknown }).id === 'string'
        && typeof (a as { label?: unknown }).label === 'string'
        && ['floor', 'wall', 'object'].includes((a as { category?: unknown }).category as string)
        && isUploadUrl((a as { src?: unknown }).src)
        && Number.isInteger((a as { tilesW?: unknown }).tilesW) && (a as { tilesW: number }).tilesW >= 1
        && Number.isInteger((a as { tilesH?: unknown }).tilesH) && (a as { tilesH: number }).tilesH >= 1);
      const hasNew = valid.some((a: { id: string }) => !existingById.has(a.id));
      const actor = hasNew ? await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } }) : null;
      layerData.customAssets = valid.slice(0, 300).map((a: { id: string; label: string; category: 'floor' | 'wall' | 'object'; src: string; tilesW: number; tilesH: number }) => {
        const existing = existingById.get(a.id);
        if (existing) return existing;
        return { id: a.id, label: a.label, category: a.category, src: a.src, tilesW: a.tilesW, tilesH: a.tilesH, createdBy: req.userId!, createdByName: actor?.displayName ?? 'Admin', createdAt: Date.now() };
      });
    }

    // Floor-plan reference image underlay — editor-only by default, same
    // validation posture as customAssets above (same-origin upload URL
    // only). `null` explicitly clears it (the admin removed the image);
    // omitted from the body entirely leaves whatever's already stored
    // untouched. showInGame opts into also forwarding it to live game
    // clients via ROOM_STATE (see roomHandler.ts).
    if ('referenceImage' in body) {
      const ri = body.referenceImage;
      if (ri === null) {
        layerData.referenceImage = null;
      } else if (ri && typeof ri === 'object' && isUploadUrl((ri as { url?: unknown }).url)
          && Number.isFinite((ri as { x?: unknown }).x) && Number.isFinite((ri as { y?: unknown }).y)
          && Number.isFinite((ri as { width?: unknown }).width) && (ri as { width: number }).width > 0
          && Number.isFinite((ri as { height?: unknown }).height) && (ri as { height: number }).height > 0) {
        const r = ri as { url: string; x: number; y: number; width: number; height: number; opacity?: unknown; visible?: unknown; showInGame?: unknown };
        const opacity = Number.isFinite(r.opacity) ? Math.max(0, Math.min(1, r.opacity as number)) : 0.5;
        layerData.referenceImage = { url: r.url, x: r.x, y: r.y, width: r.width, height: r.height, opacity, visible: !!r.visible, showInGame: !!r.showInGame };
      }
    }

    // Room-wide avatar size — clamp to sane bounds rather than rejecting an
    // out-of-range value outright, since it only ever comes from the
    // editor's own slider (which already clamps) — a stray value is more
    // likely a stale client than an attack.
    if ('avatarScale' in body) {
      const sc = body.avatarScale;
      if (Number.isFinite(sc)) layerData.avatarScale = Math.max(AVATAR_SCALE_MIN, Math.min(AVATAR_SCALE_MAX, sc as number));
    }

    await prisma.room.update({ where: { id: room.id }, data: { layerData: layerData as unknown as object } });

    const derived = layerDataToLegacy(layerData);
    setCachedTiles(room.slug, derived.tiles);
    setCachedImpassableAreas(room.slug, derived.impassableAreaRects);
    setCachedDoorAreaRects(room.slug, derived.doorAreaRects);
    setCachedZones(room.slug, derived.zones);
    ioRef?.to(room.slug).emit(SocketEvents.ROOM_UPDATED, { tiles: redactDoorPasswords(derived.tiles), furniture: redactInteractiveSecrets(derived.furniture), zones: derived.zones, impassableAreaRects: derived.impassableAreaRects, wallAreaRects: derived.wallAreaRects, doorAreaRects: redactDoorAreaPasswords(derived.doorAreaRects) });

    // Focus area — the first time an admin saves a room with at least one
    // Focus-type zone (Room Editor's "Focus area" tile effect), lazily
    // create the room's "Fokus" text channel — same backfill-on-first-use
    // pattern GET /channels already uses for "general" — and broadcast it
    // live so already-connected clients pick it up without a reload.
    // App.tsx auto-opens this channel for anyone who walks into the zone.
    if (derived.zones.some((z) => z.type === 'focus')) {
      const existingFocusChannel = await prisma.channel.findFirst({ where: { roomId: room.id, name: 'Fokus' } });
      if (!existingFocusChannel) {
        const focusChannel = await prisma.channel.create({ data: { roomId: room.id, name: 'Fokus' } });
        await ensureGroupConversation(prisma, focusChannel);
        ioRef?.to(room.slug).emit(SocketEvents.CHANNEL_CREATED, {
          id: focusChannel.id, roomId: focusChannel.roomId, name: focusChannel.name,
          isDefault: focusChannel.isDefault, createdAt: focusChannel.createdAt.getTime(),
        });
      }
    }

    // On shrink, rescue any player now standing outside the new bounds to a
    // spawn tile so no avatar is stranded off-map (Potong 5).
    if (resized) {
      const maxX = layerData.width * TILE_SIZE, maxY = layerData.height * TILE_SIZE;
      const spawn = findSpawnPixel(derived.tiles) ?? { x: TILE_SIZE + TILE_SIZE / 2, y: TILE_SIZE + TILE_SIZE / 2 };
      const players = await getPlayers(room.slug);
      for (const p of players) {
        if (p.x < 0 || p.x >= maxX || p.y < 0 || p.y >= maxY) {
          updatePlayerPosition(room.slug, p.id, spawn.x, spawn.y, 'down');
          ioRef?.to(room.slug).emit(SocketEvents.PLAYER_TELEPORTED, { id: p.id, x: spawn.x, y: spawn.y, direction: 'down' });
        }
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[rooms] editor layers save error:', err);
    return res.status(500).json({ error: 'Failed to save layers' });
  }
});

// Potong 6 — media effects authored from the new editor (which has no socket),
// via the EXISTING MapMediaObject system. Admin-gated; broadcasts the same
// MEDIA_ADDED/MEDIA_REMOVED the game already handles, so placements appear live.
// Editor-placed media is permanent (no 24h TTL — it's intentional room decor).
const EDITOR_MEDIA_TYPES: MediaType[] = ['image', 'youtube', 'website', 'bgm'];

rooms.get('/rooms/:slug/editor/media', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!hasFeatureAccess(role, 'room:update')) return res.status(403).json({ error: 'Admin required' });
    const rows = await prisma.mapMediaObject.findMany({ where: { roomId: room.id } });
    return res.json({ mediaObjects: rows.map(mediaShape) });
  } catch (err) { console.error('[rooms] editor media list error:', err); return res.status(500).json({ error: 'Failed' }); }
});

rooms.post('/rooms/:slug/editor/media', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!hasFeatureAccess(role, 'room:update')) return res.status(403).json({ error: 'Admin required' });
    const { type, x, y, payload } = req.body ?? {};
    if (!EDITOR_MEDIA_TYPES.includes(type) || !Number.isInteger(x) || !Number.isInteger(y)) return res.status(400).json({ error: 'Bad media data' });
    if (!isValidMediaPayload(type, payload)) return res.status(400).json({ error: 'Invalid or unsafe media payload' });
    const actor = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
    // Bug media #1 — same shared-clock stamp as the socket MEDIA_ADD path
    // (server/src/socket/mediaHandler.ts) — this REST route is the OTHER
    // place a 'bgm' area gets created (via the Room Editor page), and both
    // need to agree on the same startedAt convention.
    const finalPayload = type === 'bgm' ? { ...(payload ?? {}), startedAt: Date.now() } : (payload ?? {});
    const row = await prisma.mapMediaObject.create({
      data: { roomId: room.id, type, x: Math.round(x), y: Math.round(y), createdBy: req.userId!, createdByName: actor?.displayName ?? 'Admin', expiresAt: null, payload: finalPayload as object },
    });
    ioRef?.to(room.slug).emit(SocketEvents.MEDIA_ADDED, mediaShape(row));
    return res.status(201).json(mediaShape(row));
  } catch (err) { console.error('[rooms] editor media add error:', err); return res.status(500).json({ error: 'Failed' }); }
});

rooms.delete('/rooms/:slug/editor/media/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!hasFeatureAccess(role, 'room:update')) return res.status(403).json({ error: 'Admin required' });
    const row = await prisma.mapMediaObject.findFirst({ where: { id: req.params.id, roomId: room.id } });
    if (!row) return res.json({ ok: true });
    await prisma.mapMediaObject.delete({ where: { id: row.id } });
    const p = row.payload as MediaPayload;
    if ((row.type === 'image' || row.type === 'file') && p?.url) deleteUploadedFile(p.url);
    if (row.type === 'bgm' && p?.audioUrl) deleteUploadedFile(p.audioUrl);
    ioRef?.to(room.slug).emit(SocketEvents.MEDIA_REMOVED, { id: row.id });
    return res.json({ ok: true });
  } catch (err) { console.error('[rooms] editor media delete error:', err); return res.status(500).json({ error: 'Failed' }); }
});

// Soundboard — LISTING is open to any approved member (canEnterRoom, same
// "may this user even be in this room" check the socket join path uses).
// UPLOADING a new custom sound is admin+ (see shared/permissions.ts's
// 'soundboard:upload') so the shared panel doesn't get polluted by anyone
// who merely walked in — playing an EXISTING sound (default or custom) has
// no gate at all, that's still every member (see roomHandler.ts's
// SOUNDBOARD_PLAY handler).
// Reuses uploads.ts's own disk storage (own multer instance here purely for
// the audio-only fileFilter + much smaller size cap) and its existing
// GET /uploads/:filename to serve the file back — no new serving route.
function soundShape(row: { id: string; name: string; url: string; durationMs: number; createdByName: string }): SoundboardSoundData {
  return { id: row.id, name: row.name, url: row.url, durationMs: row.durationMs, createdByName: row.createdByName };
}

const soundboardUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: SOUNDBOARD_MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase();
    const okMime = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave'].includes(file.mimetype);
    const okExt = ['.mp3', '.ogg', '.wav'].includes(ext);
    cb(null, okMime || okExt);
  },
});

rooms.get('/rooms/:slug/soundboard', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!(await canEnterRoom(prisma, room, req.userId!))) return res.status(403).json({ error: 'Not a member of this room' });
    const rows = await prisma.soundboardSound.findMany({ where: { roomId: room.id }, orderBy: { createdAt: 'asc' } });
    return res.json({ sounds: rows.map(soundShape) });
  } catch (err) { console.error('[rooms] soundboard list error:', err); return res.status(500).json({ error: 'Failed' }); }
});

rooms.post('/rooms/:slug/soundboard', authenticateToken, soundboardUpload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File tidak valid — hanya mp3/ogg/wav, maksimal beberapa ratus KB.' });
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'Room not found' }); }
    if (!(await canEnterRoom(prisma, room, req.userId!))) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Not a member of this room' });
    }
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!hasFeatureAccess(role, 'soundboard:upload')) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Hanya admin yang bisa menambah suara custom.' });
    }
    // durationMs is reported by the CLIENT (from the browser's own
    // HTMLAudioElement.duration, checked before upload even starts — see
    // SoundboardPanel.tsx's handleUpload). There is no audio-decoding
    // library in this project to independently verify it server-side; the
    // real, unspoofable backstop is the multer fileSize limit just above
    // (SOUNDBOARD_MAX_FILE_BYTES), which a genuinely-short clip can't
    // exceed regardless of what duration a modified client claims. This
    // check just rejects an honest client's too-long clip with a clear
    // reason instead of silently truncating or accepting it.
    const durationMs = Number(req.body?.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > SOUNDBOARD_MAX_DURATION_MS) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: `Maksimal ${SOUNDBOARD_MAX_DURATION_MS / 1000} detik.` });
    }
    const name = String(req.body?.name || '').trim().slice(0, 30) || req.file.originalname.slice(0, 30);
    const actor = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
    const row = await prisma.soundboardSound.create({
      data: {
        roomId: room.id, name, url: `/api/uploads/${req.file.filename}`,
        durationMs: Math.round(durationMs), createdBy: req.userId!, createdByName: actor?.displayName ?? 'Someone',
      },
    });
    const shaped = soundShape(row);
    ioRef?.to(room.slug).emit(SocketEvents.SOUNDBOARD_SOUND_ADDED, shaped);
    return res.status(201).json(shaped);
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    console.error('[rooms] soundboard upload error:', err);
    return res.status(500).json({ error: 'Failed' });
  }
});

// DELETE /api/rooms/:slug/soundboard/:soundId — remove a room's own custom
// upload. Same 'soundboard:upload' gate as adding one (whoever can add can
// also clean up) — default sounds aren't DB rows at all, so soundId here is
// always a custom upload's id; an unknown/already-deleted id just 404s.
rooms.delete('/rooms/:slug/soundboard/:soundId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!hasFeatureAccess(role, 'soundboard:upload')) {
      return res.status(403).json({ error: 'Hanya admin yang bisa menghapus suara custom.' });
    }
    const sound = await prisma.soundboardSound.findUnique({ where: { id: req.params.soundId } });
    if (!sound || sound.roomId !== room.id) return res.status(404).json({ error: 'Sound not found' });
    await prisma.soundboardSound.delete({ where: { id: sound.id } });
    deleteUploadedFile(sound.url);
    ioRef?.to(room.slug).emit(SocketEvents.SOUNDBOARD_SOUND_REMOVED, { id: sound.id });
    return res.json({ success: true });
  } catch (err) {
    console.error('[rooms] soundboard delete error:', err);
    return res.status(500).json({ error: 'Failed' });
  }
});

// POST /api/rooms — create room
rooms.post('/rooms', authenticateToken, validate(createRoomSchema), async (req: AuthRequest, res: Response) => {
  console.log('[rooms] POST create received — userId:', req.userId, 'body:', req.body);
  try {
    const prisma = getPrisma();

    // Room creation is the one account-wide gate for the global 'admin'
    // AccountRole (see shared/permissions.ts's doc comment) — everyone else
    // can only join rooms that already exist. A fresh DB lookup here (not
    // a JWT-embedded claim) so a just-demoted admin can't keep creating
    // rooms until their token happens to expire.
    const requester = await prisma.user.findUnique({ where: { id: req.userId! }, select: { accountRole: true, organizationId: true } });
    if (requester?.accountRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin accounts can create rooms' });
    }

    const { name, maxPlayers = 50, isPublic = true, theme = 'scifi-office', template } = req.body;
    const slug = generateSlug(name);

    // Seed with a real office layout (walls, desk clusters, a meeting room,
    // a lounge) instead of an empty floor — see shared/defaultRoomLayout.ts.
    // `template` picks WHICH layout (see ROOM_TEMPLATES); `theme` only
    // changes which art renders each tile type/palette id within whichever
    // layout that is (see client/src/data/themeAssets.ts) — the two are
    // independent choices, not the same knob.
    const layout = createRoomLayoutFromTemplate(template, theme);

    const room = await prisma.room.create({
      data: {
        name,
        slug,
        maxPlayers,
        isPublic,
        theme,
        template: template ?? null,
        ownerId: req.userId!,
        // Fase 1 — a new room belongs to its creator's org. No cross-org
        // filtering exists yet anywhere downstream (that's Fase 2), so this
        // is purely a required-field fill for now, not an isolation change.
        organizationId: requester.organizationId,
        tilemapData: layout.tiles as any,
        furniture: layout.furniture as any,
        zones: layout.zones as any,
      },
    });

    await prisma.roomMember.create({
      data: {
        userId: req.userId!,
        roomId: room.id,
        role: 'admin',
      },
    });

    // Every room gets a non-deletable "general" channel for persisted chat
    // (see routes/chat.ts) — rooms created before this existed get one
    // lazily backfilled on first GET /channels instead.
    const general = await prisma.channel.create({
      data: { roomId: room.id, name: 'general', isDefault: true },
    });
    // Mirror Conversation must exist before any message can point at it —
    // ChatMessage.conversationId2 is a real FK, so a channel without one
    // would make every send into it fail. See lib/conversations.ts.
    await ensureGroupConversation(prisma, general);

    // §4.1 — Pre-fill Team Locations with the room's own named zones (its
    // "denah") instead of leaving staff to walk to each one manually and
    // add it by hand. One row per Zone, in layout order; findZoneEntryTile
    // picks a walkable tile inside each (its center, or the nearest open
    // floor tile if the center happens to land on furniture).
    if (layout.zones.length > 0) {
      await prisma.teleportLocation.createMany({
        data: layout.zones.map((zone, index) => {
          // Templates are pre-authored with no admin-drawn Impassable Areas
          // yet (those only exist once someone edits the room afterward), so
          // [] is genuinely accurate here, not just a shortcut.
          const point = findZoneEntryTile(layout.tiles, zone, [], TILE_SIZE);
          return { roomId: room.id, name: zone.name, x: point.x, y: point.y, orderIndex: index, createdBy: req.userId! };
        }),
      });
    }

    return res.status(201).json({
      id: room.id,
      name: room.name,
      slug: room.slug,
      maxPlayers: room.maxPlayers,
      isPublic: room.isPublic,
    });
  } catch (err) {
    console.error('[rooms] create error:', err);
    return res.status(500).json({ error: 'Failed to create room' });
  }
});

// POST /api/rooms/:slug/duplicate — "Salin Room": copy an existing room's
// current layout (tiles/furniture/zones/layerData/theme, whichever format it
// actually uses — see convertLegacyRoom's own doc comment on layerData
// superseding the legacy columns) into a brand-new room the caller now owns.
// Same accountRole:'admin' gate as POST /rooms itself, deliberately NOT the
// weaker room:update check the Lobby's "..." menu shows itself behind —
// duplicating still creates a genuinely new room, so it needs the same
// account-wide "may create rooms" gate every other creation path requires.
// Only the MAP is copied; approval/restricted-access settings, membership,
// chat channels, and teleport locations all start fresh like any new room —
// "duplicate" means "same layout", not "same governance settings".
rooms.post('/rooms/:slug/duplicate', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const requester = await prisma.user.findUnique({ where: { id: req.userId! }, select: { accountRole: true, organizationId: true } });
    if (requester?.accountRole !== 'admin') {
      return res.status(403).json({ error: 'Only admin accounts can create rooms' });
    }

    const source = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!source) return res.status(404).json({ error: 'Room not found' });

    const nameInput = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const name = (nameInput || `${source.name} (Copy)`).slice(0, 50);
    if (!name) return res.status(400).json({ error: 'Nama room tidak boleh kosong' });
    const slug = generateSlug(name);

    const room = await prisma.room.create({
      data: {
        name,
        slug,
        maxPlayers: source.maxPlayers,
        isPublic: source.isPublic,
        theme: source.theme,
        template: source.template,
        ownerId: req.userId!,
        organizationId: requester.organizationId,
        tilemapData: source.tilemapData as any,
        furniture: source.furniture as any,
        zones: source.zones as any,
        layerData: source.layerData as any,
        mapFormatVersion: source.mapFormatVersion,
      },
    });

    await prisma.roomMember.create({ data: { userId: req.userId!, roomId: room.id, role: 'admin' } });

    const general = await prisma.channel.create({ data: { roomId: room.id, name: 'general', isDefault: true } });
    await ensureGroupConversation(prisma, general);

    // Same Team Locations pre-fill as POST /rooms — only meaningful when the
    // copied room actually has legacy-format zones/tiles to derive an entry
    // point from; a purely layerData-format source just skips this (no
    // crash), same as an empty-zones brand-new room would.
    const zones = (source.zones as unknown as { name: string }[] | null) ?? [];
    const tiles = (source.tilemapData as unknown as unknown[][] | null) ?? [];
    if (zones.length > 0 && tiles.length > 0) {
      await prisma.teleportLocation.createMany({
        data: zones.map((zone, index) => {
          // [] — this legacy-format-only path (see comment above) has no
          // derived Impassable Area rects available from `source` to check
          // against; a copied room whose source has admin-drawn ones could
          // still pre-fill a Team Location inside one, same as before this
          // function gained the parameter. Narrower/lower-stakes than the
          // live-teleport case this fix targets — not addressed here.
          const point = findZoneEntryTile(tiles as any, zone as any, [], TILE_SIZE);
          return { roomId: room.id, name: zone.name, x: point.x, y: point.y, orderIndex: index, createdBy: req.userId! };
        }),
      });
    }

    return res.status(201).json({ id: room.id, name: room.name, slug: room.slug });
  } catch (err) {
    console.error('[rooms] duplicate error:', err);
    return res.status(500).json({ error: 'Failed to duplicate room' });
  }
});

// DELETE /api/rooms/:slug — delete room (owner only)
rooms.delete('/rooms/:slug', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    if (room.ownerId !== req.userId) {
      return res.status(403).json({ error: 'Only the room creator can delete this room' });
    }
    await prisma.room.delete({ where: { slug: req.params.slug } });

    if (ioRef) {
      ioRef.to(room.slug).emit(SocketEvents.ROOM_DELETED, { roomId: room.slug });
      const roomSockets = await ioRef.in(room.slug).fetchSockets();
      for (const s of roomSockets) s.leave(room.slug);
      ioRef.emit('lobby:room_removed', { roomId: room.slug });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[rooms] delete error:', err);
    return res.status(500).json({ error: 'Failed to delete room' });
  }
});

// PUT /api/users/me/avatar — save avatar config
rooms.put('/users/me/avatar', authenticateToken, validate(avatarUpdateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    // Bug: chat (channelChatHandler.ts's `sender.displayName` join, and
    // /users/profile-photos) has always resolved a message's CURRENT sender
    // name from User.displayName — but this is the only rename UI in the
    // app (there is no separate account-settings name field), and it only
    // ever wrote avatarConfig. displayName never moved, so chat could never
    // reflect an in-room rename. Keep them in sync here.
    const newName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    await prisma.user.update({
      where: { id: req.userId },
      data: newName ? { avatarConfig: req.body, displayName: newName } : { avatarConfig: req.body },
    });
    return res.json({ success: true, avatarConfig: req.body });
  } catch (err) {
    console.error('[rooms] avatar save error:', err);
    return res.status(500).json({ error: 'Failed to save avatar' });
  }
});

// PUT /api/users/me/full-name — specs/2026-08-21-full-name-field-design.md.
// Deliberately its OWN route, not folded into PUT /users/me/avatar above:
// that route stores its ENTIRE request body as avatarConfig verbatim —
// reusing it here would nest fullName inside that JSON blob instead of
// writing the real User.fullName column. This route writes fullName and
// NOTHING else. An empty string clears it back to null (fullName is an
// optional, explicitly-clearable field, not a required one).
rooms.put('/users/me/full-name', authenticateToken, validate(fullNameSchema), async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const trimmed = req.body.name.trim();
    await prisma.user.update({
      where: { id: req.userId },
      data: { fullName: trimmed || null },
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[rooms] full name save error:', err);
    return res.status(500).json({ error: 'Failed to save full name' });
  }
});

export default rooms;
