import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { SocketEvents } from '@virtualmeet/shared';
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
    const { name, maxPlayers = 50, isPublic = true } = req.body;
    const slug = generateSlug(name);

    const room = await prisma.room.create({
      data: {
        name,
        slug,
        maxPlayers,
        isPublic,
        ownerId: req.userId!,
        tilemapData: [],
      },
    });

    await prisma.roomMember.create({
      data: {
        userId: req.userId!,
        roomId: room.id,
        role: 'admin',
      },
    });

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
