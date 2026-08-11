import { Router, Response } from 'express';
import { roleAtLeast } from '@virtualmeet/shared';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveRoomRole } from '../lib/roles';
import { listBotChats } from '../lib/larkIm';
import { findRoomInOrg } from '../lib/orgScope';

// Bagian 4 — admin mapping API. Lets a room admin bind THIS room to a Lark
// group the bot is already a member of. Room-admin gated (same bar as
// channel:create). No live broadcast needed — a mapping change only affects
// message routing from that point on, not any open UI.
const router = Router();

// GET /api/rooms/:slug/lark-map → { map, chats }
//   map:   the room's current mapping (chatId/chatName) or null
//   chats: every group the bot belongs to, for the picker dropdown
router.get('/rooms/:slug/lark-map', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!roleAtLeast(role, 'admin')) {
      return res.status(403).json({ error: 'Only room admins can configure Lark sync' });
    }

    const [map, chats] = await Promise.all([
      prisma.roomChatMap.findUnique({ where: { roomId: room.id } }),
      listBotChats(),
    ]);
    return res.json({
      map: map ? { chatId: map.chatId, chatName: map.chatName } : null,
      chats,
    });
  } catch (err) {
    console.error('[larkChatMap] get error:', err);
    return res.status(500).json({ error: 'Failed to load Lark mapping' });
  }
});

// PUT /api/rooms/:slug/lark-map  body: { chatId, chatName? } | { chatId: null }
// Sets or clears the mapping. A null/empty chatId clears it.
router.put('/rooms/:slug/lark-map', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const role = await resolveRoomRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!roleAtLeast(role, 'admin')) {
      return res.status(403).json({ error: 'Only room admins can configure Lark sync' });
    }

    const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId.trim() : '';
    const chatName = typeof req.body?.chatName === 'string' ? req.body.chatName.slice(0, 200) : null;

    if (!chatId) {
      await prisma.roomChatMap.deleteMany({ where: { roomId: room.id } });
      return res.json({ map: null });
    }

    const map = await prisma.roomChatMap.upsert({
      where: { roomId: room.id },
      create: { roomId: room.id, chatId, chatName, roomName: room.name },
      update: { chatId, chatName, roomName: room.name },
    });
    return res.json({ map: { chatId: map.chatId, chatName: map.chatName } });
  } catch (err: any) {
    // chatId is unique — a group already bound to another room trips this.
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'Grup Lark ini sudah dipetakan ke room lain' });
    }
    console.error('[larkChatMap] put error:', err);
    return res.status(500).json({ error: 'Failed to save Lark mapping' });
  }
});

export default router;
