import { useEffect, useState, useCallback, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { SocketEvents, ZoneLockState, ZoneKnockRequest, ZoneApprovalRequest, ZoneRestrictionState } from '@virtualmeet/shared';
import { api } from '@/services/api';

// Client state for per-zone locks. The server is authoritative for every
// decision here — this hook only mirrors what it broadcasts and sends intents.
// `onAdmitted` — "Ngobrol dengan CEO" queue — called the moment our own
// ticket flips to 'called', so App.tsx (which owns the avatar's position
// and currentZoneIdRef) can teleport us straight in instead of this hook
// blindly re-emitting ZONE_ENTER itself, which used to leave the avatar
// standing wherever it was bounced to and currentZoneIdRef never updated.
export function useZoneLock(socketRef: React.RefObject<Socket | null>, myUserId: string, roomSlug: string, onAdmitted?: (zoneId: string) => void) {
  const [zoneLocks, setZoneLocks] = useState<ZoneLockState[]>([]);
  const [knocks, setKnocks] = useState<ZoneKnockRequest[]>([]);
  // "Ngobrol dengan CEO" queue, zone-level (see schema.prisma's
  // ZoneRestriction) — persistent admin config, independent of the manual
  // keyholder lock above. Loaded once at JOIN_ROOM and re-broadcast to the
  // room whenever an admin edits one (see roomHandler.ts/roomMembers.ts).
  const [zoneRestrictions, setZoneRestrictions] = useState<ZoneRestrictionState[]>([]);
  // The requester's own zone-scoped ticket, if any — 'loading' only while
  // fetching right after joining the queue; null otherwise (including "no
  // ticket at all yet", which is the common case so this doesn't default to
  // 'loading' the way JoinGate's room-level version does).
  // `endsAt` (epoch ms) is only meaningful once `status === 'active'` (set by
  // admitCalledEntry the moment the holder actually walks in — see
  // roomQueue.ts) — null while still 'waiting'/'called'. ZoneLockBar uses it
  // to render a live countdown without polling the server every second.
  const [zoneQueueTicket, setZoneQueueTicket] = useState<{
    zoneId: string; status: 'waiting' | 'called' | 'active'; durationMin: number;
    mode: 'quick' | 'booking'; bookingStart: number | null; bookingEnd: number | null;
    position: number | null; endsAt: number | null;
  } | null>(null);
  const [zoneQueueBusy, setZoneQueueBusy] = useState(false);
  const [zoneQueueError, setZoneQueueError] = useState('');
  // The zone we were just bounced from, so the UI can offer "knock?".
  const [deniedZoneId, setDeniedZoneId] = useState<string | null>(null);
  // Zones the keyholder has admitted us into (via a knock), so App.tsx's
  // entry check doesn't keep bouncing us back out after we've been let in.
  // Cleared per-zone the moment it goes fully unlocked — a fresh lock cycle
  // means admission has to be earned again, not grandfathered in.
  const [admittedZoneIds, setAdmittedZoneIds] = useState<Set<string>>(new Set());
  // Potongan A2 — set the moment WE knock, cleared the moment it's resolved
  // (admitted, rejected, cancelled, or the zone unlocks/its keyholder leaves
  // while we're still waiting). Drives the persistent "Menunggu
  // persetujuan..." + Cancel card — replaces the old fire-and-forget toast
  // for this specific flow, since a knock is exactly the kind of pending
  // state a user needs to be able to see and back out of, not just glimpse
  // for 3.5 seconds.
  const [pendingKnock, setPendingKnock] = useState<{ zoneId: string; zoneName: string } | null>(null);
  // QA #8 — which kind of denial deniedZoneId represents: a manual lock
  // (offer "Ketuk pintu", emits ZONE_KNOCK) or a member-only zone (offer
  // "Minta izin masuk", emits ZONE_APPROVAL_REQUEST instead) — same
  // deniedZoneId/card, different action underneath since a member-only zone
  // has no keyholder to knock on. 'restricted'/'queue' are the "Ngobrol
  // dengan CEO" persistent-config siblings: 'restricted' has no
  // self-service path at all (queueEnabled is off), 'queue' offers the form.
  const [deniedReason, setDeniedReason] = useState<'locked' | 'member_only' | 'restricted' | 'queue' | null>(null);
  // Mirrors pendingKnock above, but for the no-keyholder member-only flow.
  const [pendingApproval, setPendingApproval] = useState<{ zoneId: string; zoneName: string } | null>(null);
  // Every admin's own view of guests currently waiting on THEM to decide —
  // populated only for sockets that are actually admins (the server only
  // ever emits ZONE_APPROVAL_REQUESTED to getConnectedAdminSocketIds).
  const [approvalRequests, setApprovalRequests] = useState<ZoneApprovalRequest[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const onUpdated = (msg: { zones: ZoneLockState[] }) => {
      const zones = msg?.zones ?? [];
      setZoneLocks(zones);
      const stillLocked = new Set(zones.map((z) => z.zoneId));
      setAdmittedZoneIds((adm) => {
        let changed = false;
        const next = new Set(adm);
        for (const id of adm) if (!stillLocked.has(id)) { next.delete(id); changed = true; }
        return changed ? next : adm;
      });
      // A2 — the zone we're waiting on unlocked (explicitly, or its keyholder
      // disconnected) before ever deciding. Nothing left to wait for — we're
      // free to just walk in now, so drop the "menunggu" card. Purely
      // client-derived from this existing broadcast; no extra server event
      // needed for this specific case.
      setPendingKnock((pk) => (pk && !stillLocked.has(pk.zoneId) ? null : pk));
    };
    const onDenied = (msg: { zoneId: string; reason?: string; lockedByName?: string }) => {
      if (msg.reason === 'already_locked') { flash(`Zona ini sudah dikunci ${msg.lockedByName ?? 'orang lain'}.`); return; }
      if (msg.reason === 'not_keyholder') { flash(`Hanya ${msg.lockedByName ?? 'yang mengunci'} yang bisa membuka zona ini.`); return; }
      // Item #14 — capacity denial isn't a lock, so there's no keyholder to
      // knock on: just a toast, same as the two reasons above, never the
      // deniedZoneId "knock?" prompt (which is lock-specific).
      if (msg.reason === 'zone_full') { flash('Zona ini penuh.'); return; }
      // QA #8 — same card as a manual lock (deniedZoneId), tagged with WHICH
      // kind so requestEntry below knows whether to knock or ask for approval.
      setDeniedZoneId(msg.zoneId);
      if (msg.reason === 'member_only') setDeniedReason('member_only');
      else if (msg.reason === 'restricted') setDeniedReason('restricted');
      else if (msg.reason === 'queue') setDeniedReason('queue');
      else setDeniedReason('locked');
    };
    const onZoneRestrictions = (msg: { zones: ZoneRestrictionState[] }) => {
      setZoneRestrictions(msg?.zones ?? []);
    };
    // "Ngobrol dengan CEO" queue, zone-level — our timed slot ran out (see
    // roomHandler.ts's forceZoneExitForQueue). The actual avatar repositioning
    // + ZONE_EXIT emit is handled separately in App.tsx (it owns player
    // position, this hook doesn't) — this listener only owns this hook's own
    // state: the toast, and dropping a now-finished ticket. `nudgeOut` (v2) —
    // App.tsx's own listener decides whether to actually move the avatar;
    // this hook's toast/state cleanup happens either way.
    const onZoneSessionEnded = (msg: { zoneId: string; zoneName: string; nudgeOut?: boolean }) => {
      flash(`Waktu sesimu di ${msg.zoneName} sudah habis.`);
      setZoneQueueTicket((t) => (t && t.zoneId === msg.zoneId ? null : t));
    };
    const onKnock = (msg: ZoneKnockRequest) => {
      // De-dupe: someone mashing the knock button shouldn't stack popups.
      setKnocks((k) => (k.some((x) => x.userId === msg.userId && x.zoneId === msg.zoneId) ? k : [...k, msg]));
    };
    const onDecided = (msg: { zoneId: string; admitted: boolean; byName?: string }) => {
      setDeniedZoneId(msg.admitted ? null : msg.zoneId);
      // A2 — the keyholder decided either way: our wait is over.
      setPendingKnock((pk) => (pk && pk.zoneId === msg.zoneId ? null : pk));
      if (msg.admitted) setAdmittedZoneIds((s) => new Set(s).add(msg.zoneId));
      flash(msg.admitted ? `${msg.byName ?? 'Pengunci'} mengizinkan kamu masuk.` : `${msg.byName ?? 'Pengunci'} menolak permintaanmu.`);
    };
    // A2 — the keyholder-side signal that a pending knock is moot for any
    // reason other than their own decision (the requester cancelled,
    // disconnected, or the zone unlocked/its keyholder left first). Same
    // removal predicate onKnock's own de-dupe already uses.
    const onCancelled = (msg: { zoneId: string; userId: string }) => {
      setKnocks((k) => k.filter((x) => !(x.userId === msg.userId && x.zoneId === msg.zoneId)));
    };

    // QA #8 — admin-side incoming request; every connected admin gets this
    // independently (no single keyholder), so de-dupe the same way onKnock does.
    const onApprovalRequested = (msg: ZoneApprovalRequest) => {
      setApprovalRequests((r) => (r.some((x) => x.guestId === msg.guestId && x.zoneId === msg.zoneId) ? r : [...r, msg]));
    };
    const onApprovalDecided = (msg: { zoneId: string; admitted: boolean; byName?: string }) => {
      setDeniedZoneId(msg.admitted ? null : msg.zoneId);
      setPendingApproval((p) => (p && p.zoneId === msg.zoneId ? null : p));
      // Same admittedZoneIds Set a knock-admission uses — either kind of
      // approval means the same thing to App.tsx's entry check: "let me in".
      if (msg.admitted) setAdmittedZoneIds((s) => new Set(s).add(msg.zoneId));
      flash(msg.admitted ? `${msg.byName ?? 'Admin'} mengizinkan kamu masuk.` : `${msg.byName ?? 'Admin'} menolak permintaanmu.`);
    };
    const onApprovalCancelled = (msg: { zoneId: string; guestId: string }) => {
      setApprovalRequests((r) => r.filter((x) => !(x.guestId === msg.guestId && x.zoneId === msg.zoneId)));
    };

    socket.on(SocketEvents.ZONE_LOCK_UPDATED, onUpdated);
    socket.on(SocketEvents.ZONE_LOCKED_DENIED, onDenied);
    socket.on(SocketEvents.ZONE_KNOCK_REQUEST, onKnock);
    socket.on(SocketEvents.ZONE_KNOCK_DECIDED, onDecided);
    socket.on(SocketEvents.ZONE_KNOCK_CANCELLED, onCancelled);
    socket.on(SocketEvents.ZONE_APPROVAL_REQUESTED, onApprovalRequested);
    socket.on(SocketEvents.ZONE_APPROVAL_DECIDED, onApprovalDecided);
    socket.on(SocketEvents.ZONE_APPROVAL_CANCELLED, onApprovalCancelled);
    socket.on(SocketEvents.ZONE_RESTRICTIONS, onZoneRestrictions);
    socket.on(SocketEvents.ZONE_SESSION_ENDED, onZoneSessionEnded);
    return () => {
      socket.off(SocketEvents.ZONE_LOCK_UPDATED, onUpdated);
      socket.off(SocketEvents.ZONE_LOCKED_DENIED, onDenied);
      socket.off(SocketEvents.ZONE_KNOCK_REQUEST, onKnock);
      socket.off(SocketEvents.ZONE_KNOCK_DECIDED, onDecided);
      socket.off(SocketEvents.ZONE_APPROVAL_REQUESTED, onApprovalRequested);
      socket.off(SocketEvents.ZONE_APPROVAL_DECIDED, onApprovalDecided);
      socket.off(SocketEvents.ZONE_APPROVAL_CANCELLED, onApprovalCancelled);
      socket.off(SocketEvents.ZONE_KNOCK_CANCELLED, onCancelled);
      socket.off(SocketEvents.ZONE_RESTRICTIONS, onZoneRestrictions);
      socket.off(SocketEvents.ZONE_SESSION_ENDED, onZoneSessionEnded);
    };
  }, [socketRef, flash]);

  const restrictionOf = useCallback((zoneId: string | null) =>
    (zoneId ? zoneRestrictions.find((r) => r.zoneId === zoneId) : undefined), [zoneRestrictions]);

  // "Ngobrol dengan CEO" queue, zone-level — poll our own ticket while
  // there's a live one to watch, same 5s convention as JoinGate's room-level
  // poll.
  //
  // v2 — 'called' -> onAdmitted (App.tsx's client-side "teleport to zone
  // center + emit ZONE_ENTER") only fires for a NON-bookingMode zone now. A
  // bookingMode zone's 'called' -> 'active' transition is entirely
  // server-driven (advanceZoneQuickQueue / queueSweep's admitBookingIfDue
  // pass push a real PLAYER_TELEPORTED the moment it happens — see
  // roomHandler.ts's autoSummonToZoneForQueue), so self-teleporting here
  // too would at best double-move the avatar, and at worst — for a
  // 'booking' entry specifically — move them the INSTANT the CEO approves,
  // long before the scheduled bookingStart. This poll still exists to drive
  // the ZoneLockBar countdown/status UI, just without the onAdmitted side effect.
  useEffect(() => {
    if (!zoneQueueTicket || zoneQueueTicket.status === 'active') return;
    const zoneId = zoneQueueTicket.zoneId;
    const bookingMode = restrictionOf(zoneId)?.bookingMode ?? false;
    const iv = setInterval(async () => {
      try {
        const { entry } = await api.getMyQueueStatus(roomSlug, zoneId);
        if (!entry) {
          // Skipped by the no-show sweep, or an admin removed it.
          setZoneQueueTicket(null);
          if (deniedZoneId === zoneId) setDeniedZoneId(null);
          return;
        }
        setZoneQueueTicket({
          zoneId, status: entry.status, durationMin: entry.durationMin,
          mode: entry.mode, bookingStart: entry.bookingStart, bookingEnd: entry.bookingEnd,
          position: entry.position, endsAt: entry.endsAt,
        });
        if (entry.status === 'called' && !bookingMode) {
          onAdmitted?.(zoneId);
        }
      } catch {
        // Transient failure — keep waiting rather than dropping the ticket.
      }
    }, 5000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneQueueTicket?.zoneId, zoneQueueTicket?.status, roomSlug]);

  const lockOf = useCallback((zoneId: string | null) =>
    (zoneId ? zoneLocks.find((z) => z.zoneId === zoneId && z.locked) : undefined), [zoneLocks]);

  const joinZoneQueue = useCallback(async (zoneId: string, durationMin: number, topic?: string) => {
    setZoneQueueBusy(true);
    setZoneQueueError('');
    try {
      await api.joinQueue(roomSlug, durationMin, topic, zoneId);
      const { entry } = await api.getMyQueueStatus(roomSlug, zoneId);
      if (entry) {
        setZoneQueueTicket({
          zoneId, status: entry.status, durationMin: entry.durationMin,
          mode: entry.mode, bookingStart: entry.bookingStart, bookingEnd: entry.bookingEnd,
          position: entry.position, endsAt: entry.endsAt,
        });
      }
    } catch (e) {
      setZoneQueueError(e instanceof Error ? e.message : 'Gagal mendaftar antrean');
    } finally {
      setZoneQueueBusy(false);
    }
  }, [roomSlug]);

  // v2 — the G-key booking form's submit, same shape as joinZoneQueue above
  // but for a scheduled window instead of an open-ended FCFS ticket.
  const bookZoneQueueSlot = useCallback(async (zoneId: string, bookingStart: number, bookingEnd: number, topic?: string) => {
    setZoneQueueBusy(true);
    setZoneQueueError('');
    try {
      await api.bookQueueSlot(roomSlug, zoneId, bookingStart, bookingEnd, topic);
      const { entry } = await api.getMyQueueStatus(roomSlug, zoneId);
      if (entry) {
        setZoneQueueTicket({
          zoneId, status: entry.status, durationMin: entry.durationMin,
          mode: entry.mode, bookingStart: entry.bookingStart, bookingEnd: entry.bookingEnd,
          position: entry.position, endsAt: entry.endsAt,
        });
      }
      return true;
    } catch (e) {
      setZoneQueueError(e instanceof Error ? e.message : 'Gagal booking jadwal');
      return false;
    } finally {
      setZoneQueueBusy(false);
    }
  }, [roomSlug]);

  // App.tsx's zone-crossing effect calls this the moment it detects US
  // voluntarily walking out of a zone we hold an 'active' ticket for —
  // client-only, no server round trip (the server already closed the ticket
  // itself, see zoneHandler.ts's completeActiveZoneQueueEntry on ZONE_EXIT).
  // Without this, zoneQueueTicket would keep reporting 'active' forever
  // (the poll effect above deliberately stops polling once active), so
  // walking back in during the same session would misread the stale status
  // as still-admitted and skip the restricted-zone bounce entirely.
  const clearZoneQueueTicketOnExit = useCallback((zoneId: string) => {
    setZoneQueueTicket((t) => (t && t.zoneId === zoneId && t.status === 'active' ? null : t));
  }, []);

  const cancelZoneQueue = useCallback(async () => {
    if (!zoneQueueTicket) return;
    setZoneQueueBusy(true);
    setZoneQueueError('');
    try {
      await api.cancelQueue(roomSlug, zoneQueueTicket.zoneId);
      setZoneQueueTicket(null);
    } catch (e) {
      setZoneQueueError(e instanceof Error ? e.message : 'Gagal membatalkan antrean');
    } finally {
      setZoneQueueBusy(false);
    }
  }, [roomSlug, zoneQueueTicket]);

  const setLock = useCallback((zoneId: string, locked: boolean, zoneName?: string) => {
    socketRef.current?.emit(SocketEvents.ZONE_LOCK_SET, { zoneId, locked, zoneName });
  }, [socketRef]);

  const knock = useCallback((zoneId: string, zoneName?: string) => {
    socketRef.current?.emit(SocketEvents.ZONE_KNOCK, { zoneId, zoneName });
    // A2 — persistent "Menunggu persetujuan..." card (see pendingKnock's own
    // doc comment) replaces the old fire-and-forget toast here specifically;
    // the toast is still used for the eventual outcome (onDecided above).
    setPendingKnock({ zoneId, zoneName: zoneName ?? zoneId });
  }, [socketRef]);

  // A2 — the requester backs out of their own pending knock before the
  // keyholder ever decides.
  const cancelKnock = useCallback(() => {
    setPendingKnock((pk) => {
      if (pk) socketRef.current?.emit(SocketEvents.ZONE_KNOCK_CANCEL, { zoneId: pk.zoneId });
      return null;
    });
  }, [socketRef]);

  const decide = useCallback((k: ZoneKnockRequest, admit: boolean) => {
    socketRef.current?.emit(SocketEvents.ZONE_KNOCK_DECIDE, { zoneId: k.zoneId, userId: k.userId, playerId: k.playerId, admit });
    setKnocks((list) => list.filter((x) => !(x.userId === k.userId && x.zoneId === k.zoneId)));
  }, [socketRef]);

  // QA #8 — the ZoneLockBar's single "ask to get in" button calls this
  // regardless of WHY entry was denied; it picks the right event/pending
  // state off deniedReason so the caller doesn't need to know the
  // lock-vs-member-only distinction at all.
  const requestEntry = useCallback((zoneId: string, zoneName?: string) => {
    if (deniedReason === 'member_only') {
      socketRef.current?.emit(SocketEvents.ZONE_APPROVAL_REQUEST, { zoneId, zoneName });
      setPendingApproval({ zoneId, zoneName: zoneName ?? zoneId });
    } else {
      knock(zoneId, zoneName);
    }
  }, [socketRef, deniedReason, knock]);

  const cancelApproval = useCallback(() => {
    setPendingApproval((p) => {
      if (p) socketRef.current?.emit(SocketEvents.ZONE_APPROVAL_CANCEL, { zoneId: p.zoneId });
      return null;
    });
  }, [socketRef]);

  const decideApproval = useCallback((req: ZoneApprovalRequest, admit: boolean) => {
    socketRef.current?.emit(SocketEvents.ZONE_APPROVAL_DECIDE, { zoneId: req.zoneId, guestId: req.guestId, admit });
    setApprovalRequests((list) => list.filter((x) => !(x.guestId === req.guestId && x.zoneId === req.zoneId)));
  }, [socketRef]);

  const isKeyholder = useCallback((zoneId: string | null) => {
    const l = lockOf(zoneId);
    return !!l && l.lockedByUserId === myUserId;
  }, [lockOf, myUserId]);

  const isAdmitted = useCallback((zoneId: string | null) => !!zoneId && admittedZoneIds.has(zoneId), [admittedZoneIds]);

  return {
    zoneLocks, knocks, deniedZoneId, deniedReason, pendingKnock, pendingApproval, approvalRequests, toast,
    lockOf, setLock, knock, cancelKnock, decide, isKeyholder, isAdmitted, requestEntry, cancelApproval, decideApproval,
    // "Ngobrol dengan CEO" queue, zone-level.
    zoneRestrictions, restrictionOf, zoneQueueTicket, zoneQueueBusy, zoneQueueError, joinZoneQueue, bookZoneQueueSlot, cancelZoneQueue,
    clearZoneQueueTicketOnExit,
    clearDenied: () => setDeniedZoneId(null),
    // App.tsx's client-side entry check calls this directly (no server round
    // trip needed — the physical block already happened locally) to surface
    // the same "knock to enter"/"join queue" prompt a server-side denial
    // would show. Used for a zone already known to be manually locked
    // (mirrored zoneLocks state, reason defaults to 'locked') AND now also
    // for a restricted zone's own local pre-check (reason explicitly passed
    // as 'restricted'/'queue', mirroring zoneHandler.ts's ZONE_ENTER denial
    // reasons exactly) — member_only still has no local pre-check, it always
    // goes through the server round trip (onDenied above).
    denyEntry: (zoneId: string, reason: 'locked' | 'restricted' | 'queue' = 'locked') => { setDeniedZoneId(zoneId); setDeniedReason(reason); },
    // v2 — the G-key handler's own "no booking zone in this room" case has
    // no dedicated card to show (there's no zone to attach one to), so it
    // reuses this hook's existing ephemeral toast instead of inventing a
    // separate message channel for one edge case.
    flashToast: flash,
  };
}
