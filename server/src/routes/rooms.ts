import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { SocketEvents, createDefaultOfficeLayout, findZoneEntryTile } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { validate, createRoomSchema, avatarUpdateSchema } from '../middleware/validate';

const rooms = Router();

function getPrisma(): PrismaClient {
  return new PrismaClient();
}

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
      take: 50,
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
    });
  } catch (err) {
    console.error('[rooms] get error:', err);
    return res.status(500).json({ error: 'Failed to get room' });
  }
});

// POST /api/rooms — create room
rooms.post('/rooms', authenticateToken, validate(createRoomSchema), async (req: AuthRequest, res: Response) => {
  console.log('[rooms] POST create received — userId:', req.userId, 'body:', req.body);
  try {
    const prisma = getPrisma();
    const { name, maxPlayers = 50, isPublic = true, theme = 'modern-interiors' } = req.body;
    const slug = generateSlug(name);

    // Seed with a real office layout (walls, desk clusters, a meeting room,
    // a lounge) instead of an empty floor — see shared/defaultRoomLayout.ts.
    // The layout itself (tile grid, furniture footprints) is the same
    // regardless of theme — theme only changes which art renders each tile
    // type/palette id (see client/src/data/themeAssets.ts), not the layout.
    const layout = createDefaultOfficeLayout(theme);

    const room = await prisma.room.create({
      data: {
        name,
        slug,
        maxPlayers,
        isPublic,
        theme,
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
