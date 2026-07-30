import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { getPrisma } from '../lib/prisma';
import { SocketEvents, createRoomLayoutFromTemplate, findZoneEntryTile, hasFeatureAccess, LayerData, layerDataToLegacy, findSpawnPixel, TILE_SIZE, MediaType, MediaPayload } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveRoomRole } from '../lib/roles';
import { convertLegacyRoom } from '../lib/convertLegacyRoom';
import { isRoomLocked } from '../socket/roomHandler';
import { isValidMediaPayload } from '../socket/mediaHandler';
import { deleteUploadedFile } from './uploads';
import { setCachedTiles, getPlayers, updatePlayerPosition } from '../store/roomStore';

// Client shape for a MapMediaObject row (mirrors mediaHandler.toClientShape).
function mediaShape(r: { id: string; roomId: string; type: string; x: number; y: number; createdBy: string; createdByName: string; createdAt: Date; expiresAt: Date | null; payload: unknown }) {
  return { id: r.id, roomId: r.roomId, type: r.type, x: r.x, y: r.y, createdBy: r.createdBy, createdByName: r.createdByName, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null, payload: (r.payload as MediaPayload) ?? {} };
}
import { validate, createRoomSchema, avatarUpdateSchema } from '../middleware/validate';
import { ensureGroupConversation } from '../lib/conversations';
import { driveEnabled, ensureRoomFolder } from '../lib/larkDrive';

const rooms = Router();


// Set once from index.ts after the Socket.IO server is created, so the
// DELETE route below can notify/kick players currently in the room being
// deleted — deleting via this REST endpoint (used by the Lobby) previously
// left active sockets in a room whose DB row no longer existed until reload.
let ioRef: Server | null = null;
export function setIo(io: Server): void {
  ioRef = io;
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
rooms.get('/rooms', async (_req, res: Response) => {
  try {
    const prisma = getPrisma();
    const roomList = await prisma.room.findMany({
      where: { isPublic: true },
      include: {
        _count: { select: { members: true } },
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
        playerCount: r._count.members,
        maxPlayers: r.maxPlayers,
        theme: r.theme,
        createdAt: r.createdAt,
        locked: isRoomLocked(r.slug),
      })),
    });
  } catch (err) {
    console.error('[rooms] list error:', err);
    return res.status(500).json({ error: 'Failed to list rooms' });
  }
});

// GET /api/rooms/:slug — get room by slug
rooms.get('/rooms/:slug', async (req, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({
      where: { slug: req.params.slug },
      include: {
        _count: { select: { members: true } },
        owner: { select: { displayName: true } },
      },
    });

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    return res.json({
      id: room.id,
      name: room.name,
      slug: room.slug,
      ownerId: room.ownerId,
      ownerDisplayName: room.owner?.displayName || 'Unknown',
      playerCount: room._count.members,
      maxPlayers: room.maxPlayers,
      isPublic: room.isPublic,
      theme: room.theme,
      locked: isRoomLocked(room.slug),
    });
  } catch (err) {
    console.error('[rooms] get error:', err);
    return res.status(500).json({ error: 'Failed to get room' });
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
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId);
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
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId);
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
    }
    // Objects / top objects: full-array replace (small entity lists). Lightly
    // sanitized so a bad payload can't corrupt the shape.
    const sanitizeObjs = (arr: unknown): LayerData['objects'] | null => {
      if (!Array.isArray(arr)) return null;
      return arr
        .filter((o) => o && typeof o === 'object' && typeof (o as { paletteId?: unknown }).paletteId === 'string'
          && Number.isInteger((o as { x?: unknown }).x) && Number.isInteger((o as { y?: unknown }).y))
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
      layerData.areas = body.areas
        .filter((a: unknown) => a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string' && Number.isInteger((a as { width?: unknown }).width) && Number.isInteger((a as { height?: unknown }).height))
        .slice(0, 500) as LayerData['areas'];
    }

    await prisma.room.update({ where: { id: room.id }, data: { layerData: layerData as unknown as object } });

    const derived = layerDataToLegacy(layerData);
    setCachedTiles(room.slug, derived.tiles);
    ioRef?.to(room.slug).emit(SocketEvents.ROOM_UPDATED, { tiles: derived.tiles, furniture: derived.furniture, zones: derived.zones });

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
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId);
    if (!hasFeatureAccess(role, 'room:update')) return res.status(403).json({ error: 'Admin required' });
    const rows = await prisma.mapMediaObject.findMany({ where: { roomId: room.id } });
    return res.json({ mediaObjects: rows.map(mediaShape) });
  } catch (err) { console.error('[rooms] editor media list error:', err); return res.status(500).json({ error: 'Failed' }); }
});

rooms.post('/rooms/:slug/editor/media', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId);
    if (!hasFeatureAccess(role, 'room:update')) return res.status(403).json({ error: 'Admin required' });
    const { type, x, y, payload } = req.body ?? {};
    if (!EDITOR_MEDIA_TYPES.includes(type) || !Number.isInteger(x) || !Number.isInteger(y)) return res.status(400).json({ error: 'Bad media data' });
    if (!isValidMediaPayload(type, payload)) return res.status(400).json({ error: 'Invalid or unsafe media payload' });
    const actor = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
    const row = await prisma.mapMediaObject.create({
      data: { roomId: room.id, type, x: Math.round(x), y: Math.round(y), createdBy: req.userId!, createdByName: actor?.displayName ?? 'Admin', expiresAt: null, payload: (payload ?? {}) as object },
    });
    ioRef?.to(room.slug).emit(SocketEvents.MEDIA_ADDED, mediaShape(row));
    return res.status(201).json(mediaShape(row));
  } catch (err) { console.error('[rooms] editor media add error:', err); return res.status(500).json({ error: 'Failed' }); }
});

rooms.delete('/rooms/:slug/editor/media/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId);
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
    const requester = await prisma.user.findUnique({ where: { id: req.userId! }, select: { accountRole: true } });
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

    // A8 — best-effort: create this room's Lark Drive folder for attachments +
    // recordings. Must NEVER fail room creation — a Drive/network hiccup just
    // leaves larkFolderToken null, and ensureRoomFolder recreates it lazily on
    // the first upload. Fire-and-forget (ensureRoomFolder persists the token).
    if (driveEnabled()) {
      void ensureRoomFolder(room.id).catch((e) => console.error('[rooms] Lark folder create failed:', e));
    }

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
          const point = findZoneEntryTile(layout.tiles, zone);
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

// DELETE /api/rooms/:slug — delete room (owner only)
rooms.delete('/rooms/:slug', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
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
    await prisma.user.update({
      where: { id: req.userId },
      data: { avatarConfig: req.body },
    });
    return res.json({ success: true, avatarConfig: req.body });
  } catch (err) {
    console.error('[rooms] avatar save error:', err);
    return res.status(500).json({ error: 'Failed to save avatar' });
  }
});

export default rooms;
