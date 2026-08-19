import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { TILE_SIZE, WorkMode } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { livePos } from '@/stores/livePosition';
import { findZoneAt } from '@/hooks/useProximity';
import type { useZoneLock } from '@/hooks/useZoneLock';

// Watches the local avatar's position and turns it into zone events.
//
// This lives in its own component for one reason: it is the ONLY thing in the
// app that needs the local position at movement rate. While it sat in App,
// App subscribed to localPlayer — so every throttled position write (10/sec
// while walking) re-rendered App's entire tree: 46 callbacks reallocated, 74
// child elements recreated, and heavyweights like Sidebar reconciled, all to
// serve three effects that render nothing at all.
//
// Split out, this component re-renders at that same rate and it costs
// essentially nothing, because it returns null. App now only hears about the
// results — which zone you are in, which meeting zone — and those change when
// you cross a boundary, not when you take a step.
//
// The logic below is moved verbatim; the only change is where it lives.
interface ZoneWatcherProps {
  zoneLock: ReturnType<typeof useZoneLock>;
  // Owned by App because two OTHER effects there (the ZONE_ENTER re-sync and
  // the queue's forced exit) also write it. Passed as a ref rather than
  // lifted into state precisely so those writes don't re-render anything.
  currentZoneIdRef: MutableRefObject<string | null>;
  onZoneChange: (zone: { id: string; name: string } | null) => void;
  onMeetingZoneChange: (zoneId: string | null) => void;
  emitZoneEnter: (zoneId: string) => void;
  emitZoneExit: (zoneId: string) => void;
  emitWorkMode: (mode: WorkMode, zoneId?: string, awayReason?: string) => void;
}

export function ZoneWatcher({
  zoneLock,
  currentZoneIdRef,
  onZoneChange,
  onMeetingZoneChange,
  emitZoneEnter,
  emitZoneExit,
  emitWorkMode,
}: ZoneWatcherProps) {
  const localPlayer = useGameStore((s) => s.localPlayer);
  const zones = useGameStore((s) => s.zones);
  const localRole = useGameStore((s) => s.localRole);
  const localIsCeo = useGameStore((s) => s.localIsCeo);

  // Put the player back on the nearest tile inside the zone they may not leave.
  const pushBackInside = (zoneId: string) => {
    const z = zones.find((x) => x.id === zoneId);
    if (!z) return;
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    const setLocal = useGameStore.getState().setLocalPlayer;
    const p = useGameStore.getState().localPlayer;
    setLocal({
      ...p,
      // Clamp the LIVE position — clamping the throttled copy would also
      // rewind the avatar to it, which is a visible snap backwards.
      x: clamp(livePos.x, (z.x + 0.5) * TILE_SIZE, (z.x + z.width - 0.5) * TILE_SIZE),
      y: clamp(livePos.y, (z.y + 0.5) * TILE_SIZE, (z.y + z.height - 0.5) * TILE_SIZE),
      isMoving: false,
    });
  };

  // A5 — Meeting zone detection. The MeetingControl (Start/Join/End + history)
  // renders only while the local avatar is inside a Zone of type 'meeting'.
  // Purely derived; also feeds the A11 presence status below.
  const meetingZone = useMemo(
    () => findZoneAt({ x: localPlayer.x, y: localPlayer.y }, zones.filter((z) => z.type === 'meeting')),
    [localPlayer.x, localPlayer.y, zones],
  );

  // A11 — Presence status (consolidates A3 Focus + A5 meeting detection). Zone
  // wins over the manual choice: inside a meeting zone → 'in_meeting'; inside a
  // focus zone → 'focus'; otherwise the user's last manual pick
  // (available/lunch/away). On change, update the store (drives DND gating +
  // badge) and broadcast so other clients see it. Leaving a zone re-applies the
  // remembered manual status automatically.
  const workMode = useGameStore((s) => s.workMode);
  const setWorkMode = useGameStore((s) => s.setWorkMode);
  const manualStatus = useGameStore((s) => s.manualStatus);
  const awayReason = useGameStore((s) => s.awayReason);
  useEffect(() => {
    const focusZone = findZoneAt({ x: localPlayer.x, y: localPlayer.y }, zones.filter((z) => z.type === 'focus'));
    const effective: WorkMode = meetingZone ? 'in_meeting' : focusZone ? 'focus' : manualStatus;
    if (effective !== workMode) {
      setWorkMode(effective);
      emitWorkMode(effective, meetingZone?.id ?? focusZone?.id, effective === 'away' ? awayReason ?? undefined : undefined);
    }
  }, [localPlayer.x, localPlayer.y, zones, meetingZone, manualStatus, workMode, setWorkMode, emitWorkMode, awayReason]);

  // Last position we know we were legitimately allowed to occupy — restored
  // when a zone-entry attempt gets refused, so the avatar snaps back out
  // instead of visibly standing inside a locked room it was denied entry to.
  const lastAllowedPosRef = useRef({ x: localPlayer.x, y: localPlayer.y });

  useEffect(() => {
    const zone = findZoneAt(localPlayer, zones);
    const zoneId = zone?.id ?? null;
    if (zoneId === currentZoneIdRef.current) {
      lastAllowedPosRef.current = { x: localPlayer.x, y: localPlayer.y };
      return;
    }

    // A locked zone holds you in until it's unlocked (even for the person who
    // locked it — see server zoneLock.ts). The server refuses the zone:exit
    // anyway (membership drives zone chat + A/V), so without this the avatar
    // would stand outside while still being IN the meeting — worse than not
    // letting them walk out at all.
    const leaving = currentZoneIdRef.current;
    if (leaving) {
      const lock = zoneLock.lockOf(leaving);
      if (lock) {
        pushBackInside(leaving);
        return;
      }
      emitZoneExit(leaving);
      // "Ngobrol dengan CEO" queue — leaving early completes the ticket
      // server-side (zoneHandler.ts's completeActiveZoneQueueEntry), but
      // nothing else ever refreshes our own cached zoneQueueTicket once its
      // status is 'active' (useZoneLock.ts's poll deliberately stops once
      // active — there's nothing left to wait for while genuinely inside).
      // Without dropping it here, walking back in during the same session
      // would read the stale 'active' status as still-admitted and skip the
      // restricted-zone bounce below entirely, even though the server has
      // already closed that ticket and will deny the re-entry.
      zoneLock.clearZoneQueueTicketOnExit(leaving);
    }

    // A locked zone also holds people OUT — not just chat/AV membership, the
    // avatar itself must not be able to stand inside it. Checked client-side
    // against the mirrored lock state (same pattern as the leaving check
    // above) so the bounce is instant, no round trip needed.
    if (zoneId) {
      const lock = zoneLock.lockOf(zoneId);
      if (lock && !zoneLock.isKeyholder(zoneId) && !zoneLock.isAdmitted(zoneId)) {
        const back = lastAllowedPosRef.current;
        useGameStore.getState().setLocalPlayer({ x: back.x, y: back.y, isMoving: false });
        zoneLock.denyEntry(zoneId);
        return;
      }
      // "Ngobrol dengan CEO" queue, zone-level — a restricted zone (Room
      // Editor's "Restricted area" tool) must physically hold out anyone who
      // isn't the room owner or explicitly granted CEO access, AND hasn't
      // been called/admitted into their queue slot, same bounce as a manual
      // lock above, mirroring the exact authoritative check
      // zoneHandler.ts's ZONE_ENTER does server-side so the decision is
      // instant and client-only — no round trip, no brief "stood inside it"
      // flash before the server's own ZONE_LOCKED_DENIED came back.
      //
      // Deliberately NOT role-based (no roleAtLeast/minRole check) — an
      // ordinary room admin must queue like anyone else here; only the room
      // owner and whoever's been granted CEO access (see gameStore's
      // localIsCeo, roomHandler.ts's ceoUserIds) bypass.
      // "Ngobrol dengan CEO" v2 — a bookingMode zone is always freely
      // walkable (see zoneHandler.ts's own ZONE_ENTER, which skips this same
      // gate server-side), so this client-side mirror must skip it too, or
      // the avatar would get bounced back out locally even though the
      // server would have let it through.
      const restriction = zoneLock.restrictionOf(zoneId);
      if (restriction && !restriction.bookingMode && localRole !== 'owner' && !localIsCeo) {
        const ticket = zoneLock.zoneQueueTicket;
        const admitted = ticket?.zoneId === zoneId && (ticket.status === 'called' || ticket.status === 'active');
        if (!admitted) {
          const back = lastAllowedPosRef.current;
          useGameStore.getState().setLocalPlayer({ x: back.x, y: back.y, isMoving: false });
          zoneLock.denyEntry(zoneId, restriction.queueEnabled ? 'queue' : 'restricted');
          return;
        }
      }
      emitZoneEnter(zoneId);
    }
    currentZoneIdRef.current = zoneId;
    onZoneChange(zone ? { id: zone.id, name: zone.name } : null);
    lastAllowedPosRef.current = { x: localPlayer.x, y: localPlayer.y };
    // Reaching this line at all means the crossing succeeded (every denial
    // branch above returns early) — whether that landed us in no zone or a
    // completely different one, whatever we were previously denied from is
    // no longer relevant, so the knock/queue-form card should go away.
    //
    // Bug fix — this used to only clear when zoneId was null (no zone at
    // all), so walking straight from a CEO Office denial into a DIFFERENT
    // zone (e.g. a neighboring "AI Team" area) skipped this entirely — the
    // stale "isi form antrean" card for CEO Office stayed on screen
    // indefinitely, since the player never passed through a genuine
    // "in no zone" gap to trigger the old guard.
    zoneLock.clearDenied();
  }, [localPlayer.x, localPlayer.y, zones, emitZoneEnter, emitZoneExit]);


  // App renders <MeetingControl> off this; reported rather than returned so
  // App only re-renders when the meeting zone genuinely changes.
  useEffect(() => {
    onMeetingZoneChange(meetingZone?.id ?? null);
  }, [meetingZone?.id, onMeetingZoneChange]);

  return null;
}
