// One-off, idempotent creator/updater for the sample office room —
// requested to be built directly through the application's own data layer
// (not by clicking through the UI), following the exact same Prisma writes
// POST /api/rooms performs (see routes/rooms.ts) so this room ends up in
// identical shape to one created normally: same Room row shape, an owner
// RoomMember, a "general" Channel + mirror Conversation, and one
// TeleportLocation per zone.
//
// Idempotent by a FIXED slug ('office', not the app's own generateSlug()
// which always appends a random suffix — that would make two runs of this
// script produce two different rooms instead of updating the same one). A
// second run REPLACES the existing room's layout in place (tilemapData/
// furniture/zones/theme/template) rather than creating a duplicate; it does
// NOT touch membership/channels/teleport locations on a re-run, since those
// are one-time bootstrap state, not part of "the layout".
//
// Run with: npx tsx server/scripts/seedOfficeRoom.ts
// Optional: OWNER_EMAIL=someone@example.com npx tsx server/scripts/seedOfficeRoom.ts
//   (defaults to the first admin-role account found, with a warning, if unset)

import 'dotenv/config';
import { getPrisma } from '../src/lib/prisma';
import { ensureGroupConversation } from '../src/lib/conversations';
import { createCorporateOfficeLayout, findZoneEntryTile } from '@kaispace/shared';

const SLUG = 'office';
const ROOM_NAME = 'Kantor';
const TEMPLATE = 'corporate-office';
const THEME = 'modern-interiors';

async function main() {
  const prisma = getPrisma();

  const ownerEmail = process.env.OWNER_EMAIL;
  const owner = ownerEmail
    ? await prisma.user.findUnique({ where: { email: ownerEmail } })
    : await prisma.user.findFirst({ where: { accountRole: 'admin' } });

  if (!owner) {
    throw new Error(
      ownerEmail
        ? `No user found with email ${ownerEmail}`
        : 'No admin-role user found in the database — set OWNER_EMAIL to an existing user, or promote one to admin first.',
    );
  }
  if (!ownerEmail) {
    console.warn(`[seedOfficeRoom] OWNER_EMAIL not set — defaulting to first admin found: ${owner.email}`);
  }

  const layout = createCorporateOfficeLayout(THEME);

  const existing = await prisma.room.findUnique({ where: { slug: SLUG } });

  if (existing) {
    await prisma.room.update({
      where: { slug: SLUG },
      data: {
        name: ROOM_NAME,
        theme: THEME,
        template: TEMPLATE,
        tilemapData: layout.tiles as any,
        furniture: layout.furniture as any,
        zones: layout.zones as any,
        // Once a room has been opened in the ZEP Room Editor even once, it
        // gets lazily converted to layerData (see convertLegacyRoom.ts) —
        // and roomHandler.ts's JOIN_ROOM ALWAYS prefers layerData over the
        // legacy columns above once it exists (correct in general: layerData
        // is the one true source post-conversion), which means updating
        // tilemapData/furniture/zones here would otherwise be silently
        // ignored by both the live game and the Room Editor. Clearing it
        // forces a fresh reconversion from the columns just written above
        // the next time either is opened.
        layerData: null,
      },
    });
    console.log(`[seedOfficeRoom] Updated existing room '${SLUG}' (id=${existing.id}) in place — layout replaced (including a stale layerData conversion, if any), membership/channels/teleport locations untouched.`);
    await prisma.$disconnect();
    return;
  }

  const room = await prisma.room.create({
    data: {
      name: ROOM_NAME,
      slug: SLUG,
      maxPlayers: 50,
      isPublic: true,
      theme: THEME,
      template: TEMPLATE,
      ownerId: owner.id,
      tilemapData: layout.tiles as any,
      furniture: layout.furniture as any,
      zones: layout.zones as any,
    },
  });

  await prisma.roomMember.create({
    data: { userId: owner.id, roomId: room.id, role: 'admin' },
  });

  const general = await prisma.channel.create({
    data: { roomId: room.id, name: 'general', isDefault: true },
  });
  await ensureGroupConversation(prisma, general);

  if (layout.zones.length > 0) {
    await prisma.teleportLocation.createMany({
      data: layout.zones.map((zone, index) => {
        const point = findZoneEntryTile(layout.tiles, zone);
        return { roomId: room.id, name: zone.name, x: point.x, y: point.y, orderIndex: index, createdBy: owner.id };
      }),
    });
  }

  console.log(`[seedOfficeRoom] Created room '${SLUG}' (id=${room.id}), owner=${owner.email}, ${layout.zones.length} zones -> teleport locations, general channel ready.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[seedOfficeRoom] FAILED:', err);
  process.exit(1);
});
