import { Server, Socket } from 'socket.io';
import { SocketEvents, hasFeatureAccess, expandOccurrences } from '@kaispace/shared';
import { mayEnterZone, isZoneLocked, isSealedIn } from './zoneLock';
import { sendMusicStateToSocket } from './musicHandler';
import { getCachedZones, getCachedZoneRestriction } from '../store/roomStore';
import { getConnectedAdminSocketIds, getRoleInRoom, isCeoInRoom, getPlayerName, updateRosterZone, broadcastZoneQueueSessionCleared } from './roomHandler';
import { getPrisma } from '../lib/prisma';
import { admitCalledEntry, advanceQueue } from '../lib/roomQueue';
import { isZonePasswordUnlocked, unlockZonePassword } from './doorLock';
import { socketRateLimit } from '../middleware/rateLimit';

// Throttle brute-force guessing of a meeting Zone's password — same guard,
// same budget, every other password-check handler in this codebase already
// uses (roomHandler.ts's canCheckInteractive).
const canSubmitZonePassword = socketRateLimit(3);

// Actual A/V zone restriction is computed client-side (see useProximity.ts —
// every client already knows every player's position and the room's zones,
// so it derives membership locally with no round trip). This handler relays
// enter/exit so other clients in the SAME room can react (e.g. a "so-and-so
// joined the meeting room" indicator), and tracks who's in which zone so
// zone-scoped chat (see chatHandler.ts) can be routed to only those sockets.
const socketZone = new Map<string, { room: string; zoneId: string }>();

export function getSocketIdsInZone(room: string, zoneId: string): string[] {
  const ids: string[] = [];
  for (const [socketId, loc] of socketZone) {
    if (loc.room === room && loc.zoneId === zoneId) ids.push(socketId);
  }
  return ids;
}

// Used by chatHandler.ts to reject a zone-scoped CHAT_MESSAGE from a socket
// that isn't actually tracked as being inside that zone — previously any
// socket could attach any zoneId to a message and it would be routed to
// that zone's chat regardless of whether the sender was really there,
// since only the RECIPIENTS were computed from real zone membership, never
// the sender's own claim (see §1.3's "reject send_chat kalau
// player.currentAreaId tidak sesuai" rule).
// The zone a socket is currently tracked in (null when it's in none).
export function zoneIdOfSocket(socketId: string): string | null {
  return socketZone.get(socketId)?.zoneId ?? null;
}

export function isSocketInZone(room: string, socketId: string, zoneId: string): boolean {
  const loc = socketZone.get(socketId);
  return !!loc && loc.room === room && loc.zoneId === zoneId;
}

// QA #8 — Zone.memberOnly guest-approval bookkeeping. Two maps, same
// "room → keyed by X" nesting zoneLock.ts's own locks/pendingKnocks use:
// pendingZoneApprovals is one in-flight request per guest (a guest can only
// ever be waiting on one thing at a time, mirrors roomHandler.ts's
// pendingGuests); approvedGuestZones is the durable-for-the-session grant,
// keyed by `${zoneId}:${guestId}` so one guest can be approved into several
// different member-only zones independently. Neither is cleared on the
// GUEST's disconnect except the pending one (see the DISCONNECT handler
// below) — an approval should survive a reconnect, a pending request
// shouldn't leave a stale card on some admin's screen forever.
interface PendingZoneApproval {
  zoneId: string;
  zoneName: string;
  guestId: string;
  socketId: string;
  guestName: string;
  notifiedAdminSocketIds: string[];
}
const pendingZoneApprovals = new Map<string, Map<string, PendingZoneApproval>>();
const approvedGuestZones = new Map<string, Set<string>>();

function roomPendingApprovals(room: string): Map<string, PendingZoneApproval> {
  let m = pendingZoneApprovals.get(room);
  if (!m) { m = new Map(); pendingZoneApprovals.set(room, m); }
  return m;
}

function isGuestApprovedForZone(room: string, zoneId: string, guestId: string): boolean {
  return !!approvedGuestZones.get(room)?.has(`${zoneId}:${guestId}`);
}

// "Ngobrol dengan CEO" queue, zone-level — see ZONE_EXIT/DISCONNECT's own
// call sites. Mirrors roomHandler.ts's completeActiveQueueEntryOnLeave.
async function completeActiveZoneQueueEntry(io: Server, roomSlug: string, zoneId: string, userId: string): Promise<void> {
  const prisma = getPrisma();
  const dbRoom = await prisma.room.findUnique({ where: { slug: roomSlug }, select: { id: true } });
  if (!dbRoom) return;
  const entry = await prisma.roomQueueEntry.findFirst({ where: { roomId: dbRoom.id, zoneId, userId, status: 'active' } });
  if (!entry) return;
  await prisma.roomQueueEntry.update({ where: { id: entry.id }, data: { status: 'done', completedAt: new Date() } });
  broadcastZoneQueueSessionCleared(io, roomSlug, zoneId);
  await advanceQueue(prisma, dbRoom.id, zoneId);
}

// The single source of truth for "is a password-protected meeting running in
// this zone right now" — used by BOTH the ZONE_ENTER gate and
// ZONE_PASSWORD_SUBMIT, so the two can never disagree about which event (if
// any) is currently in force.
//
// Recurrence-aware: CalendarEvent.start/end are the fixed FIRST-occurrence
// template for a recurring series (see RecurringMaster's doc comment in
// shared/recurrence.ts) and never advance — a naive `start <= now <= end`
// check against the row directly would only ever match occurrence #1, then
// silently stop gating forever after (the same trap meetingAutoJoinSweep.ts's
// own query already avoids — see its comment). So this narrows in SQL to
// "recurring, or not yet finished", then expands occurrences in a window
// around now instead of trusting the template dates directly.
async function findActiveGatedMeeting(
  room: string,
  zoneId: string,
): Promise<{ title: string; organizerId: string; meetkaiPassword: string; attendees: { userId: string }[] } | null> {
  const now = new Date();
  const candidates = await getPrisma().calendarEvent.findMany({
    where: {
      meetkaiRoomSlug: room, meetkaiZoneId: zoneId, meetkaiPassword: { not: null },
      OR: [{ rrule: { not: null } }, { end: { gte: now } }],
    },
    select: {
      title: true, organizerId: true, meetkaiPassword: true,
      start: true, end: true, timezone: true, rrule: true, exdates: true,
      attendees: { select: { userId: true } },
    },
  });
  for (const ev of candidates) {
    const occs = expandOccurrences(
      { start: ev.start, end: ev.end, timezone: ev.timezone, rrule: ev.rrule, exdates: ev.exdates },
      new Date(now.getTime() - 24 * 3600000),
      new Date(now.getTime() + 24 * 3600000),
    );
    if (occs.some((occ) => occ.start <= now && occ.end >= now)) {
      return { title: ev.title, organizerId: ev.organizerId, meetkaiPassword: ev.meetkaiPassword!, attendees: ev.attendees };
    }
  }
  return null;
}

export function registerZoneHandlers(io: Server, socket: Socket) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string) => {
    const slug = roomId || 'main-office';
    // Multi-tenant Fase 3 — this module registers its own independent
    // JOIN_ROOM listener (see mediaHandler.ts's comment on why roomHandler.ts
    // rejecting a cross-org join doesn't stop this one from also running).
    try {
      const room = await getPrisma().room.findUnique({ where: { slug }, select: { organizationId: true } });
      if (!room || room.organizationId !== (socket.data as { organizationId?: string }).organizationId) { currentRoom = null; return; }
    } catch (e) {
      console.error('[zone] org check failed:', e);
      currentRoom = null;
      return;
    }
    currentRoom = slug;
  });

  socket.on(SocketEvents.ZONE_ENTER, async (zoneId: string) => {
    if (!currentRoom) return;
    const room = currentRoom;
    // A locked zone is enforced HERE, not just drawn in the UI. Without this
    // the padlock would be decoration: zone membership drives zone-scoped
    // chat and A/V, so an uninvited socket could still join the meeting's
    // audio by claiming ZONE_ENTER.
    const uid = socket.data.userId as string | undefined;
    if (isZoneLocked(room, zoneId) && !mayEnterZone(room, zoneId, uid)) {
      socket.emit(SocketEvents.ZONE_LOCKED_DENIED, { zoneId, reason: 'locked' });
      return;
    }
    const zone = getCachedZones(room).find((z) => z.id === zoneId);
    // QA #8 — "ODOO/AI TEAM hanya anggota; terkunci bagi guest." A guest
    // (never a member/staff/admin/owner — those have no guestId at all, see
    // index.ts's io.use()) needs an admin's approval, tracked separately
    // from the manual lock above (this zone was never locked by anyone —
    // there's no keyholder to check against).
    const guestId = (socket.data as { guestId?: string }).guestId;
    if (guestId && zone?.memberOnly && !isGuestApprovedForZone(room, zoneId, guestId)) {
      socket.emit(SocketEvents.ZONE_LOCKED_DENIED, { zoneId, reason: 'member_only' });
      return;
    }
    // Item #14 — optional max-occupant cap (Room Editor's "Private area"
    // tool, Zone.capacity). Excludes this socket from the count so a
    // redundant ZONE_ENTER re-fired while already inside (e.g. walking
    // around within the same zone) never locks someone out of a zone
    // they're already standing in.
    if (zone?.capacity) {
      const others = getSocketIdsInZone(room, zoneId).filter((id) => id !== socket.id);
      if (others.length >= zone.capacity) {
        socket.emit(SocketEvents.ZONE_LOCKED_DENIED, { zoneId, reason: 'zone_full' });
        return;
      }
    }

    // "Ngobrol dengan CEO" queue, zone-level (see schema.prisma's
    // ZoneRestriction) — "ruang CEO" turned out to be a zone, not a separate
    // Room, so this is the zone-scoped sibling of Room.restrictedAccess.
    // Fast synchronous cache check first: this handler fires on essentially
    // every zone crossing for every player, all day, and the overwhelming
    // majority of zones have no restriction row at all.
    const restriction = getCachedZoneRestriction(room, zoneId);
    if (restriction && !restriction.bookingMode) {
      if (!uid) {
        // Unauthenticated (guest) — the queue requires a real account, so
        // there is no self-service path regardless of queueEnabled.
        socket.emit(SocketEvents.ZONE_LOCKED_DENIED, { zoneId, reason: 'restricted' });
        return;
      }
      // Deliberately NOT role-based (see RoomAdminState.ceoUserIds' doc
      // comment) — an ordinary room admin must queue here like anyone
      // else; only the room owner and whoever's been granted CEO access
      // bypass.
      if (getRoleInRoom(room, uid) !== 'owner' && !isCeoInRoom(room, uid)) {
        try {
          const prisma = getPrisma();
          const dbRoom = await prisma.room.findUnique({ where: { slug: room }, select: { id: true } });
          if (!dbRoom) throw new Error('room not found');
          const ticket = await prisma.roomQueueEntry.findFirst({
            where: { roomId: dbRoom.id, zoneId, userId: uid, status: { in: ['called', 'active'] } },
          });
          const admitted = ticket?.status === 'called' || (ticket?.status === 'active' && !!ticket.endsAt && ticket.endsAt > new Date());
          if (!admitted) {
            socket.emit(SocketEvents.ZONE_LOCKED_DENIED, { zoneId, reason: restriction.queueEnabled ? 'queue' : 'restricted' });
            return;
          }
          // Their turn — this is the actual moment they walk in, so it's
          // the right place (not the poll that got them here) to start the
          // session clock. No-ops (returns null) if already 'active' (a
          // reconnect) — nothing new to broadcast in that case, everyone in
          // the room already got the original ZONE_QUEUE_SESSION_ACTIVE.
          const endsAt = await admitCalledEntry(prisma, dbRoom.id, zoneId, uid);
          if (endsAt) {
            io.to(room).emit(SocketEvents.ZONE_QUEUE_SESSION_ACTIVE, {
              zoneId, userId: uid, playerName: getPlayerName(socket.id), endsAt: endsAt.getTime(),
            });
          }
        } catch (e) {
          console.error('[zone] restriction check failed:', e);
          socket.emit(SocketEvents.ZONE_LOCKED_DENIED, { zoneId, reason: 'restricted' });
          return;
        }
      }
    }

    // Meeting Zone password (CalendarEvent.meetkaiPassword) — a DIFFERENT
    // gate from the lock/member-only/capacity checks above: automated
    // (no live keyholder), scoped to a specific OCCURRENCE's own [start, end]
    // window, and never applied to the meeting's own people.
    const activeMeeting = await findActiveGatedMeeting(room, zoneId);
    if (activeMeeting) {
      // The organizer counts too — EventAttendee deliberately excludes them
      // (calendar.ts's create route filters `id !== req.userId`), so checking
      // attendees alone would prompt the organizer of their OWN meeting for
      // their own password.
      const isParticipant = !!uid && (activeMeeting.organizerId === uid || activeMeeting.attendees.some((a) => a.userId === uid));
      if (!isParticipant && !isZonePasswordUnlocked(socket.id, room, zoneId)) {
        socket.emit(SocketEvents.ZONE_PASSWORD_REQUIRED, { zoneId, eventTitle: activeMeeting.title });
        return;
      }
    }

    socketZone.set(socket.id, { room, zoneId });
    socket.to(room).emit(SocketEvents.ZONE_ENTER, { playerId: socket.id, zoneId });
    // Bug follow-up — the member list's live location, see
    // roomHandler.ts's updateRosterZone doc comment.
    updateRosterZone(io, socket.id, zone?.name ?? zoneId);
    // Fitur 2 correction — a Music Bot track already playing in this zone
    // must start for the joining socket right away, with no click/popup.
    sendMusicStateToSocket(socket, room, zoneId);
  });

  socket.on(SocketEvents.ZONE_PASSWORD_SUBMIT, async (data: { zoneId: string; password: string }) => {
    if (!canSubmitZonePassword(socket.id)) return;
    if (!currentRoom || typeof data?.zoneId !== 'string' || typeof data?.password !== 'string') return;
    const room = currentRoom;
    // Same recurrence-aware lookup ZONE_ENTER's own gate uses, so a series
    // whose occurrence is genuinely running can actually be unlocked.
    const activeMeeting = await findActiveGatedMeeting(room, data.zoneId);
    if (!activeMeeting) return; // nothing active to unlock — a stale prompt from before the meeting ended
    const correct = activeMeeting.meetkaiPassword === data.password;
    if (correct) unlockZonePassword(socket.id, room, data.zoneId);
    socket.emit(SocketEvents.ZONE_PASSWORD_RESULT, { zoneId: data.zoneId, correct });
  });

  socket.on(SocketEvents.ZONE_EXIT, async (zoneId: string) => {
    if (!currentRoom) return;
    const room = currentRoom;
    // Locked zones hold everyone in, keyholder included — unlock first, then
    // walk out. The client also blocks the walk, but membership is what
    // drives zone chat and A/V — so it must be refused HERE too, or someone
    // could leave the meeting's audio while still standing in it.
    if (isSealedIn(room, zoneId)) {
      socket.emit(SocketEvents.ZONE_LOCKED_DENIED, { zoneId, reason: 'sealed_in' });
      return;
    }
    socketZone.delete(socket.id);
    socket.to(room).emit(SocketEvents.ZONE_EXIT, { playerId: socket.id, zoneId });
    updateRosterZone(io, socket.id, null);

    // "Ngobrol dengan CEO" queue, zone-level — leaving early (voluntarily,
    // for ANY reason) completes an active ticket immediately and advances
    // the queue, same product decision as the room-level version (see
    // roomHandler.ts's completeActiveQueueEntryOnLeave). Guarded by the
    // cache check so an ordinary zone-exit never pays a DB round trip.
    const uid = socket.data.userId as string | undefined;
    if (uid && getCachedZoneRestriction(room, zoneId)) {
      completeActiveZoneQueueEntry(io, room, zoneId, uid).catch((e) => console.error('[zone] queue leave-complete error:', e));
    }
  });

  // QA #8 — the guest asking for admin approval after being bounced by
  // ZONE_ENTER's member_only denial above. Fans out to EVERY connected
  // admin (getConnectedAdminSocketIds — same pattern roomHandler.ts's Guest
  // Link waiting room already uses), not a single keyholder: a member-only
  // zone was never locked by anyone, so there's no one person to ask.
  socket.on(SocketEvents.ZONE_APPROVAL_REQUEST, (data: { zoneId: string }) => {
    if (!currentRoom) return;
    const guestId = (socket.data as { guestId?: string }).guestId;
    if (!guestId) return; // members never need approval — nothing to request
    const zoneId = data?.zoneId;
    if (typeof zoneId !== 'string') return;
    const zone = getCachedZones(currentRoom).find((z) => z.id === zoneId);
    if (!zone?.memberOnly) return; // not (or no longer) a member-only zone
    if (isGuestApprovedForZone(currentRoom, zoneId, guestId)) return; // already approved — client should just retry ZONE_ENTER
    const guestName = (socket.data as { guestName?: string }).guestName || 'Guest';
    const notifiedAdminSocketIds = getConnectedAdminSocketIds(currentRoom);
    for (const sid of notifiedAdminSocketIds) {
      io.to(sid).emit(SocketEvents.ZONE_APPROVAL_REQUESTED, { zoneId, zoneName: zone.name, guestId, playerId: socket.id, guestName });
    }
    roomPendingApprovals(currentRoom).set(guestId, { zoneId, zoneName: zone.name, guestId, socketId: socket.id, guestName, notifiedAdminSocketIds });
  });

  // Any admin who was notified may decide — re-verified server-side
  // ('zone:approve_guest', shared/permissions.ts), never trusting that only
  // admins received the ZONE_APPROVAL_REQUESTED broadcast in the first place.
  socket.on(SocketEvents.ZONE_APPROVAL_DECIDE, (data: { zoneId: string; guestId: string; admit: boolean }) => {
    if (!currentRoom) return;
    const uid = socket.data.userId as string | undefined;
    if (!hasFeatureAccess(getRoleInRoom(currentRoom, uid), 'zone:approve_guest')) {
      socket.emit('admin:error', { message: 'Only admins can decide zone entry requests' });
      return;
    }
    const guestId = data?.guestId;
    if (typeof guestId !== 'string') return;
    const pending = roomPendingApprovals(currentRoom).get(guestId);
    if (!pending || pending.zoneId !== data?.zoneId) return;
    roomPendingApprovals(currentRoom).delete(guestId);
    if (data.admit) {
      let set = approvedGuestZones.get(currentRoom);
      if (!set) { set = new Set(); approvedGuestZones.set(currentRoom, set); }
      set.add(`${pending.zoneId}:${guestId}`);
    }
    const guestSocket = io.sockets.sockets.get(pending.socketId);
    guestSocket?.emit(SocketEvents.ZONE_APPROVAL_DECIDED, { zoneId: pending.zoneId, admitted: !!data.admit, byName: getPlayerName(socket.id) });
  });

  // The guest's own way out of a pending request before any admin decides —
  // same shape as ZONE_KNOCK_CANCEL. No "notify every admin their card is
  // gone" step needed beyond this broadcast: unlike a single-keyholder
  // knock, several admins may have independently seen the request card, so
  // ZONE_APPROVAL_CANCELLED reaches all of them via notifiedAdminSocketIds.
  socket.on(SocketEvents.ZONE_APPROVAL_CANCEL, (data: { zoneId: string }) => {
    if (!currentRoom) return;
    const guestId = (socket.data as { guestId?: string }).guestId;
    if (!guestId) return;
    const pending = roomPendingApprovals(currentRoom).get(guestId);
    if (!pending || pending.zoneId !== data?.zoneId) return;
    roomPendingApprovals(currentRoom).delete(guestId);
    for (const sid of pending.notifiedAdminSocketIds) {
      io.to(sid).emit(SocketEvents.ZONE_APPROVAL_CANCELLED, { zoneId: pending.zoneId, guestId });
    }
  });

  socket.on(SocketEvents.DISCONNECT, () => {
    // "Ngobrol dengan CEO" queue, zone-level — a hard disconnect counts as
    // leaving early too (same as the ZONE_EXIT branch above), so grab the
    // zone BEFORE deleting it from socketZone just below.
    const lastZone = socketZone.get(socket.id);
    const uid = socket.data.userId as string | undefined;
    if (uid && lastZone && getCachedZoneRestriction(lastZone.room, lastZone.zoneId)) {
      completeActiveZoneQueueEntry(io, lastZone.room, lastZone.zoneId, uid).catch((e) =>
        console.error('[zone] queue disconnect-complete error:', e),
      );
    }
    socketZone.delete(socket.id);
    // A guest who disconnects while waiting shouldn't leave a stale request
    // card on every admin's screen forever — approvedGuestZones is
    // deliberately left untouched here (see its own doc comment above): an
    // already-granted approval should survive a reconnect.
    if (currentRoom) {
      const guestId = (socket.data as { guestId?: string }).guestId;
      if (guestId) {
        const pending = roomPendingApprovals(currentRoom).get(guestId);
        if (pending) {
          roomPendingApprovals(currentRoom).delete(guestId);
          for (const sid of pending.notifiedAdminSocketIds) {
            io.to(sid).emit(SocketEvents.ZONE_APPROVAL_CANCELLED, { zoneId: pending.zoneId, guestId });
          }
        }
      }
    }
  });
}
