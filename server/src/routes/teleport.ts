import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { hasFeatureAccess } from '@kaispace/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveRoomRole as resolveRole } from '../lib/roles';
import { findRoomInOrg } from '../lib/orgScope';

const teleport = Router();


const MAX_TELEPORT_LOCATIONS = 20;

// Multi-tenant Fase 3 — teleport.ts was never touched in Fase 2's route
// sweep; fixed once here so every route below (teleport locations AND
// owner bookmarks) inherits it.
async function loadRoomBySlug(prisma: PrismaClient, slug: string, organizationId: string | undefined) {
  return findRoomInOrg(prisma, slug, organizationId);
}

// ─── §4.1 Teleport (Admin) — shared, staff+ ────────────────────────────

teleport.get('/rooms/:slug/teleport-locations', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await loadRoomBySlug(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    // Listing is a USE action (needed to pick a destination), so it's open to
    // every member — not gated behind 'teleport:admin' like create/delete/
    // reorder below. (Bug 4: members may use saved locations, not manage them.)
    if (!hasFeatureAccess(role, 'teleport:use')) {
      return res.status(403).json({ error: 'Room access required' });
    }
    const locations = await prisma.teleportLocation.findMany({ where: { roomId: room.id }, orderBy: { orderIndex: 'asc' } });
    return res.json({ locations });
  } catch (err) {
    console.error('[teleport] list error:', err);
    return res.status(500).json({ error: 'Failed to list teleport locations' });
  }
});

teleport.post('/rooms/:slug/teleport-locations', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await loadRoomBySlug(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!hasFeatureAccess(role, 'teleport:admin')) {
      return res.status(403).json({ error: 'Staff role or higher required' });
    }

    const { name, x, y, icon } = req.body;
    if (typeof name !== 'string' || !name.trim() || typeof x !== 'number' || typeof y !== 'number') {
      return res.status(400).json({ error: 'name, x, y are required' });
    }

    // Capped at 20 per room (§4.1's explicit limit) — checked here, not in
    // the schema, since Prisma has no conditional-count constraint.
    const count = await prisma.teleportLocation.count({ where: { roomId: room.id } });
    if (count >= MAX_TELEPORT_LOCATIONS) {
      return res.status(400).json({ error: `Maksimal ${MAX_TELEPORT_LOCATIONS} lokasi`, code: 'TELEPORT_LIMIT_REACHED' });
    }

    const location = await prisma.teleportLocation.create({
      data: {
        roomId: room.id,
        name: name.trim().slice(0, 50),
        x: Math.round(x),
        y: Math.round(y),
        icon: typeof icon === 'string' ? icon.slice(0, 10) : null,
        orderIndex: count,
        createdBy: req.userId!,
      },
    });
    return res.status(201).json({ location });
  } catch (err) {
    console.error('[teleport] create error:', err);
    return res.status(500).json({ error: 'Failed to create teleport location' });
  }
});

teleport.delete('/rooms/:slug/teleport-locations/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await loadRoomBySlug(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!hasFeatureAccess(role, 'teleport:admin')) {
      return res.status(403).json({ error: 'Staff role or higher required' });
    }
    await prisma.teleportLocation.deleteMany({ where: { id: req.params.id, roomId: room.id } });
    return res.json({ success: true });
  } catch (err) {
    console.error('[teleport] delete error:', err);
    return res.status(500).json({ error: 'Failed to delete teleport location' });
  }
});

// Body: { orderedIds: string[] } — full new order, reassigns orderIndex 0..n
// to match. Drag-and-drop on the client sends the whole list every time
// rather than a single from/to index pair, which keeps this endpoint (and
// the client state update) simple regardless of how the reorder UI works.
teleport.put('/rooms/:slug/teleport-locations/reorder', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await loadRoomBySlug(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRole(prisma, req.userId!, room.id, room.ownerId, room.organizationId);
    if (!hasFeatureAccess(role, 'teleport:admin')) {
      return res.status(403).json({ error: 'Staff role or higher required' });
    }
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });

    await prisma.$transaction(
      orderedIds.map((id: string, index: number) =>
        prisma.teleportLocation.updateMany({ where: { id, roomId: room.id }, data: { orderIndex: index } }),
      ),
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[teleport] reorder error:', err);
    return res.status(500).json({ error: 'Failed to reorder teleport locations' });
  }
});

// ─── §4.2 Teleport (Owner) — personal bookmarks ─────────────────────────

teleport.get('/rooms/:slug/bookmarks', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await loadRoomBySlug(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.ownerId !== req.userId) return res.status(403).json({ error: 'Owner only' });
    // Scoped to (ownerId, roomId) — deliberately never copied from other
    // rooms, see the Prisma model's doc comment.
    const bookmarks = await prisma.ownerBookmark.findMany({ where: { ownerId: req.userId, roomId: room.id }, orderBy: { orderIndex: 'asc' } });
    return res.json({ bookmarks });
  } catch (err) {
    console.error('[teleport] bookmarks list error:', err);
    return res.status(500).json({ error: 'Failed to list bookmarks' });
  }
});

teleport.post('/rooms/:slug/bookmarks', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await loadRoomBySlug(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.ownerId !== req.userId) return res.status(403).json({ error: 'Owner only' });

    const { label, x, y } = req.body;
    if (typeof label !== 'string' || !label.trim() || typeof x !== 'number' || typeof y !== 'number') {
      return res.status(400).json({ error: 'label, x, y are required' });
    }
    const count = await prisma.ownerBookmark.count({ where: { ownerId: req.userId, roomId: room.id } });
    const bookmark = await prisma.ownerBookmark.create({
      data: { ownerId: req.userId, roomId: room.id, label: label.trim().slice(0, 50), x: Math.round(x), y: Math.round(y), orderIndex: count },
    });
    return res.status(201).json({ bookmark });
  } catch (err) {
    console.error('[teleport] bookmark create error:', err);
    return res.status(500).json({ error: 'Failed to create bookmark' });
  }
});

teleport.delete('/rooms/:slug/bookmarks/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await loadRoomBySlug(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.ownerId !== req.userId) return res.status(403).json({ error: 'Owner only' });
    await prisma.ownerBookmark.deleteMany({ where: { id: req.params.id, ownerId: req.userId, roomId: room.id } });
    return res.json({ success: true });
  } catch (err) {
    console.error('[teleport] bookmark delete error:', err);
    return res.status(500).json({ error: 'Failed to delete bookmark' });
  }
});

teleport.put('/rooms/:slug/bookmarks/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await loadRoomBySlug(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.ownerId !== req.userId) return res.status(403).json({ error: 'Owner only' });
    const { label } = req.body;
    if (typeof label !== 'string' || !label.trim()) return res.status(400).json({ error: 'label is required' });
    await prisma.ownerBookmark.updateMany({ where: { id: req.params.id, ownerId: req.userId, roomId: room.id }, data: { label: label.trim().slice(0, 50) } });
    return res.json({ success: true });
  } catch (err) {
    console.error('[teleport] bookmark rename error:', err);
    return res.status(500).json({ error: 'Failed to rename bookmark' });
  }
});

teleport.put('/rooms/:slug/bookmarks/reorder', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await loadRoomBySlug(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.ownerId !== req.userId) return res.status(403).json({ error: 'Owner only' });
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });

    await prisma.$transaction(
      orderedIds.map((id: string, index: number) =>
        prisma.ownerBookmark.updateMany({ where: { id, ownerId: req.userId!, roomId: room.id }, data: { orderIndex: index } }),
      ),
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[teleport] bookmark reorder error:', err);
    return res.status(500).json({ error: 'Failed to reorder bookmarks' });
  }
});

export default teleport;
