import { useEffect, useState, useCallback, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { SocketEvents, ZoneLockState, ZoneKnockRequest } from '@virtualmeet/shared';

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
    };
    const onDenied = (msg: { zoneId: string; reason?: string; lockedByName?: string }) => {
      if (msg.reason === 'already_locked') { flash(`Zona ini sudah dikunci ${msg.lockedByName ?? 'orang lain'}.`); return; }
      if (msg.reason === 'not_keyholder') { flash(`Hanya ${msg.lockedByName ?? 'yang mengunci'} yang bisa membuka zona ini.`); return; }
      setDeniedZoneId(msg.zoneId);
    };
    const onKnock = (msg: ZoneKnockRequest) => {
      // De-dupe: someone mashing the knock button shouldn't stack popups.
      setKnocks((k) => (k.some((x) => x.userId === msg.userId && x.zoneId === msg.zoneId) ? k : [...k, msg]));
    };
    const onDecided = (msg: { zoneId: string; admitted: boolean; byName?: string }) => {
      setDeniedZoneId(msg.admitted ? null : msg.zoneId);
      if (msg.admitted) setAdmittedZoneIds((s) => new Set(s).add(msg.zoneId));
      flash(msg.admitted ? `${msg.byName ?? 'Pengunci'} mengizinkan kamu masuk.` : `${msg.byName ?? 'Pengunci'} menolak permintaanmu.`);
    };

    socket.on(SocketEvents.ZONE_LOCK_UPDATED, onUpdated);
    socket.on(SocketEvents.ZONE_LOCKED_DENIED, onDenied);
    socket.on(SocketEvents.ZONE_KNOCK_REQUEST, onKnock);
    socket.on(SocketEvents.ZONE_KNOCK_DECIDED, onDecided);
    return () => {
      socket.off(SocketEvents.ZONE_LOCK_UPDATED, onUpdated);
      socket.off(SocketEvents.ZONE_LOCKED_DENIED, onDenied);
      socket.off(SocketEvents.ZONE_KNOCK_REQUEST, onKnock);
      socket.off(SocketEvents.ZONE_KNOCK_DECIDED, onDecided);
    };
  }, [socketRef, flash]);

  const lockOf = useCallback((zoneId: string | null) =>
    (zoneId ? zoneLocks.find((z) => z.zoneId === zoneId && z.locked) : undefined), [zoneLocks]);

  const setLock = useCallback((zoneId: string, locked: boolean, zoneName?: string) => {
    socketRef.current?.emit(SocketEvents.ZONE_LOCK_SET, { zoneId, locked, zoneName });
  }, [socketRef]);

  const knock = useCallback((zoneId: string, zoneName?: string) => {
    socketRef.current?.emit(SocketEvents.ZONE_KNOCK, { zoneId, zoneName });
    flash('Ketukan terkirim. Menunggu jawaban…');
  }, [socketRef, flash]);

  const decide = useCallback((k: ZoneKnockRequest, admit: boolean) => {
    socketRef.current?.emit(SocketEvents.ZONE_KNOCK_DECIDE, { zoneId: k.zoneId, userId: k.userId, playerId: k.playerId, admit });
    setKnocks((list) => list.filter((x) => !(x.userId === k.userId && x.zoneId === k.zoneId)));
  }, [socketRef]);

  const isKeyholder = useCallback((zoneId: string | null) => {
    const l = lockOf(zoneId);
    return !!l && l.lockedByUserId === myUserId;
  }, [lockOf, myUserId]);

  const isAdmitted = useCallback((zoneId: string | null) => !!zoneId && admittedZoneIds.has(zoneId), [admittedZoneIds]);

  return {
    zoneLocks, knocks, deniedZoneId, toast, lockOf, setLock, knock, decide, isKeyholder, isAdmitted,
    clearDenied: () => setDeniedZoneId(null),
    // App.tsx's client-side entry check calls this directly (no server round
    // trip needed — the physical block already happened locally) to surface
    // the same "knock to enter" prompt a server-side denial would show.
    denyEntry: (zoneId: string) => setDeniedZoneId(zoneId),
  };
}
