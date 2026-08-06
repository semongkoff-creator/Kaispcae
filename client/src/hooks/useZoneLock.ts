import { useEffect, useState, useCallback, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { SocketEvents, ZoneLockState, ZoneKnockRequest, ZoneApprovalRequest } from '@virtualmeet/shared';

// Client state for per-zone locks. The server is authoritative for every
// decision here — this hook only mirrors what it broadcasts and sends intents.
export function useZoneLock(socketRef: React.RefObject<Socket | null>, myUserId: string) {
  const [zoneLocks, setZoneLocks] = useState<ZoneLockState[]>([]);
  const [knocks, setKnocks] = useState<ZoneKnockRequest[]>([]);
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
  // has no keyholder to knock on.
  const [deniedReason, setDeniedReason] = useState<'locked' | 'member_only' | null>(null);
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
      setDeniedReason(msg.reason === 'member_only' ? 'member_only' : 'locked');
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
    return () => {
      socket.off(SocketEvents.ZONE_LOCK_UPDATED, onUpdated);
      socket.off(SocketEvents.ZONE_LOCKED_DENIED, onDenied);
      socket.off(SocketEvents.ZONE_KNOCK_REQUEST, onKnock);
      socket.off(SocketEvents.ZONE_KNOCK_DECIDED, onDecided);
      socket.off(SocketEvents.ZONE_APPROVAL_REQUESTED, onApprovalRequested);
      socket.off(SocketEvents.ZONE_APPROVAL_DECIDED, onApprovalDecided);
      socket.off(SocketEvents.ZONE_APPROVAL_CANCELLED, onApprovalCancelled);
      socket.off(SocketEvents.ZONE_KNOCK_CANCELLED, onCancelled);
    };
  }, [socketRef, flash]);

  const lockOf = useCallback((zoneId: string | null) =>
    (zoneId ? zoneLocks.find((z) => z.zoneId === zoneId && z.locked) : undefined), [zoneLocks]);

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
    clearDenied: () => setDeniedZoneId(null),
    // App.tsx's client-side entry check calls this directly (no server round
    // trip needed — the physical block already happened locally) to surface
    // the same "knock to enter" prompt a server-side denial would show. Only
    // ever used for a zone already known to be manually locked (mirrored
    // zoneLocks state) — member_only has no local pre-check, it always goes
    // through the server round trip (onDenied above) — so 'locked' here is
    // never wrong, and importantly overwrites any stale reason left over
    // from an earlier, different denial.
    denyEntry: (zoneId: string) => { setDeniedZoneId(zoneId); setDeniedReason('locked'); },
  };
}
