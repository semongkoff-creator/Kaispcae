import { Server, Socket } from 'socket.io';
import { SocketEvents, RtcSignal } from '@kaispace/shared';


// A socket only ever joins one room (the room slug) via socket.join() in
// roomHandler.ts's JOIN_ROOM — socket.io also auto-joins every socket to a
// room named after its own id, so filtering that out leaves at most the
// one real room this socket is in.
function getSocketRoom(socket: Socket): string | undefined {
  for (const r of socket.rooms) {
    if (r !== socket.id) return r;
  }
  return undefined;
}

// QA (Load checklist item 3, "War Room share massal") — every SIMULTANEOUS
// presenter in a room adds their own full-bitrate track to every other
// existing mesh peer connection (see webrtcService.startScreenShare's own
// comment) — this compounds directly on top of the already-capped
// camera/mic mesh. Room slug -> socket ids currently sharing. Cleared
// per-socket on RTC_SCREEN_SHARE(streamId:null) (explicit stop) and on
// disconnect (implicit stop — see below); never persisted, purely
// in-memory bookkeeping like roomHandler.ts's own per-room maps.
const activeScreeners = new Map<string, Set<string>>();
const MAX_SCREEN_SHARES_PER_ROOM = 4;

function releaseScreenShareSlot(socket: Socket, room: string | undefined) {
  if (!room) return;
  activeScreeners.get(room)?.delete(socket.id);
}

// QA (Stabilitas checklist item 12, "Kuota biaya API") — a rough, workspace-
// wide COUNT of peer connections that ended up relaying through TURN today
// (see webrtcService's reportSelectedPath / TURN_RELAY_USED). This is NOT
// billing data — actual bytes-relayed only exists on the TURN server
// itself, outside this app entirely — it's an early trend signal ("today
// looks unusually high") for whoever's watching /api/health, which
// previously had zero visibility into TURN usage of any kind. Same WIB-day
// reset convention as youtubeService.ts's quota counter.
function wibToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}
let turnRelayDay = wibToday();
let turnRelayCountToday = 0;

export function getTurnRelayStatus(): { relayConnectionsToday: number; day: string } {
  const today = wibToday();
  if (today !== turnRelayDay) { turnRelayDay = today; turnRelayCountToday = 0; }
  return { relayConnectionsToday: turnRelayCountToday, day: turnRelayDay };
}

export function registerRtcHandlers(io: Server, socket: Socket) {
  // Previously relayed to ANY socket id the client claimed as `toId`, with
  // no check that the target was even in the same room — any connected
  // client could probe/spam-signal arbitrary sockets server-wide. Now both
  // ends must share a room, and `fromId` is always server-set to the real
  // sender rather than trusting whatever the client put in the payload
  // (same "never trust client-claimed identity" principle as §2's
  // socket.data.userId check in index.ts).
  function relay(event: string, signal: RtcSignal) {
    const myRoom = getSocketRoom(socket);
    const targetSocket = io.sockets.sockets.get(signal.toId);
    const ok = !!myRoom && !!targetSocket && targetSocket.rooms.has(myRoom);
    // [webrtc-diag] TEMPORARY — this relay drops signals silently, so a
    // mismatch here is invisible from the client: offers simply never
    // arrive, no error anywhere. Logging both sides' room sets makes a drop
    // (and WHY) readable straight from the server log. Remove once the
    // two-way audio cause is confirmed and fixed.
    console.log('[webrtc-diag]', ok ? 'relay OK' : 'relay DROPPED', {
      event: event.replace('rtc:', ''),
      from: socket.id,
      to: signal.toId,
      myRoom,
      myRooms: Array.from(socket.rooms).filter((r) => r !== socket.id),
      targetFound: !!targetSocket,
      targetRooms: targetSocket ? Array.from(targetSocket.rooms).filter((r) => r !== targetSocket.id) : null,
    });
    if (!ok) return;
    io.to(signal.toId).emit(event, { ...signal, fromId: socket.id });
  }

  // Broadcast, not relayed to one peer: anyone already in the room needs it,
  // and so does anyone who walks up later (the client re-announces on each new
  // peer connection). fromId is set server-side from the real socket, never
  // taken from the payload — same rule as the offer/answer relay below, so a
  // client can't claim someone else's screen is theirs.
  socket.on(SocketEvents.RTC_SCREEN_SHARE, (data: { streamId: string | null }) => {
    const room = getSocketRoom(socket);
    if (!room) return;
    const streamId = typeof data?.streamId === 'string' ? data.streamId.slice(0, 200) : null;
    if (streamId) {
      // Bookkeeping only here — the actual GATE already ran at
      // RTC_SCREEN_SHARE_REQUEST below. Not re-enforcing the cap on this
      // announce: rejecting a share the client was already told to start
      // (and has already opened the OS picker for) would strand it
      // half-started with no clean way to back out. Track it regardless so
      // the count stays accurate for the next REQUEST's check.
      if (!activeScreeners.has(room)) activeScreeners.set(room, new Set());
      activeScreeners.get(room)!.add(socket.id);
    } else {
      releaseScreenShareSlot(socket, room);
    }
    socket.to(room).emit(SocketEvents.RTC_SCREEN_SHARE, { fromId: socket.id, streamId });
  });

  // The actual gate — asked BEFORE the client opens getDisplayMedia's OS
  // picker, so a denial never even prompts for screen-capture permission.
  // Answered directly to the requester only (never broadcast).
  socket.on(SocketEvents.RTC_SCREEN_SHARE_REQUEST, () => {
    const room = getSocketRoom(socket);
    if (!room) return;
    const current = activeScreeners.get(room)?.size ?? 0;
    if (current >= MAX_SCREEN_SHARES_PER_ROOM) {
      socket.emit(SocketEvents.RTC_SCREEN_SHARE_DENIED, {
        reason: `Sudah ada ${current} orang share layar di room ini (maks ${MAX_SCREEN_SHARES_PER_ROOM}). Coba lagi setelah salah satu berhenti.`,
      });
      return;
    }
    socket.emit(SocketEvents.RTC_SCREEN_SHARE_GRANTED);
  });

  socket.on(SocketEvents.TURN_RELAY_USED, () => {
    const today = wibToday();
    if (today !== turnRelayDay) { turnRelayDay = today; turnRelayCountToday = 0; }
    turnRelayCountToday++;
  });

  socket.on(SocketEvents.RTC_OFFER, (signal: RtcSignal) => relay(SocketEvents.RTC_OFFER, signal));
  socket.on(SocketEvents.RTC_ANSWER, (signal: RtcSignal) => relay(SocketEvents.RTC_ANSWER, signal));
  socket.on(SocketEvents.RTC_ICE_CANDIDATE, (signal: RtcSignal) => relay(SocketEvents.RTC_ICE_CANDIDATE, signal));

  // A hard disconnect (tab closed, crash, network gone) never gets a chance
  // to emit the explicit RTC_SCREEN_SHARE(streamId:null) stop — without
  // this, a slot leaked by a dropped connection would count against the
  // cap forever (until the room itself is torn down), silently shrinking
  // real capacity every time someone sharing loses their connection.
  //
  // 'disconnecting' (not SocketEvents.DISCONNECT = the raw 'disconnect'
  // event) deliberately — socket.io removes the socket from every room
  // BEFORE 'disconnect' fires, so getSocketRoom(socket) would already read
  // back empty by then and this cleanup would silently no-op every time.
  // 'disconnecting' fires first, while socket.rooms is still populated.
  socket.on('disconnecting', () => releaseScreenShareSlot(socket, getSocketRoom(socket)));
}
