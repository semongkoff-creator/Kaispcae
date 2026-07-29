import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { getPrisma } from '../lib/prisma';
import { SocketEvents, createRoomLayoutFromTemplate, findZoneEntryTile, hasFeatureAccess } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveRoomRole } from '../lib/roles';
import { convertLegacyRoom } from '../lib/convertLegacyRoom';
import { isRoomLocked } from '../socket/roomHandler';
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
