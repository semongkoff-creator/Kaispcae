import { useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { SocketEvents, Avatar, AvatarConfig, ChatMessage, EmoteEvent, JumpEvent, NudgeEvent, RoomUpdatePayload, Notice, RoomBroadcast, FollowInfo, FollowerChangedPayload, TeleportRequest, FollowRequestPayload, FollowResultPayload, RemoteHelpRequestPayload, RemoteHelpResultPayload, RemoteHelpCredentialPayload, RemoteHelpEndPayload, SummonRequestPayload, SummonResultPayload, MediaType, MediaPayload, MapMediaObject, WhiteboardStroke, Channel, ChannelMessage, ChatReadEntry, DirectConversationStarted, TILE_SIZE, findAdjacentFreeTile, WorkMode, InteractivePasswordResultPayload, InteractiveDoorPasswordResultPayload, DoorUnlockedNoticePayload, InteractiveDoorAreaPasswordResultPayload, DoorAreaUnlockedNoticePayload, InteractiveChoiceResultPayload, InteractiveApiCallResultPayload, SoundboardSoundData, SoundboardPlayedPayload, SOUNDBOARD_DEFAULT_SOUNDS, MusicSessionState, JoinRequestPopupPayload, ZoneQueueRequestedPayload, ZoneQueueSessionActivePayload, ZoneQueueSessionClearedPayload, GuestJoinRequest, PlayerMovedPayload, PlayerStoppedPayload, DeskNoteData, RosterEntry, RosterUpdate, SeatClaimRequest } from '@kaispace/shared';
import { serverTimeToClient, resetServerClock } from '@/stores/serverClock';
import { snapRemotePosition, clearRemotePositions, pushRemoteSnapshot } from '@/stores/remotePositions';
import { useGameStore } from '@/stores/gameStore';
import { loadAvatarConfig } from '@/hooks/useAvatarConfig';
import { notifyNewMessage, notifyNudge } from '@/services/browserNotifications';
import { playNudgeSound, playSlapSound, playHandRaiseSound, playSoundboardClip } from '@/services/soundEffects';
import { SERVER_URL } from '@/services/serverUrl';
import { registerCustomAssets } from '@/data/customAssets';
import { setProfileName } from '@/hooks/useProfiles';
import { textMentionsUser } from '@/utils/mentions';

// Bump a chat target's unread count unless the user is actively looking at
// it right now (panel open AND that exact target selected) — in which case
// they've already "seen" the message so there's nothing to badge.
function markUnreadIfHidden(key: string): void {
  const state = useGameStore.getState();
  const active = state.activeChatTarget;
  const activeKey = active ? `${active.type}:${active.id}` : null;
  if (state.chatPanelOpen && activeKey === key) return;
  state.bumpUnread(key);
}

// Soundboard — a soundId is either one of the static SOUNDBOARD_DEFAULT_SOUNDS
// (client already has these, no server round trip) or one of this room's own
// uploaded sounds (synced via SOUNDBOARD_LIST/SOUNDBOARD_SOUND_ADDED). Used by
// both the optimistic local play (emitSoundboardPlay) and the SOUNDBOARD_PLAYED
// listener for nearby recipients.
function resolveSoundboardSound(soundId: string): SoundboardSoundData | undefined {
  return SOUNDBOARD_DEFAULT_SOUNDS.find((s) => s.id === soundId)
    ?? useGameStore.getState().soundboardSounds.find((s) => s.id === soundId);
}

// Guest Link & Ruang Tunggu — a guest session token (from GuestEntry.tsx's
// POST /guest/join exchange), kept ENTIRELY separate from `vm_token` so a
// guest visit never touches/overwrites a real account's stored session.
// When present, it's used INSTEAD of vm_token for the socket handshake —
// see index.ts's io.use(), which verifies it via a structurally different
// claims shape (guestId, never userId).
export function useSocket(authUserName: string = '', roomSlug: string = 'main-office', authUserId: string = '', guestToken?: string) {
  const socketRef = useRef<Socket | null>(null);
  const lastEmitRef = useRef<number>(0);
  const moveSeqRef = useRef<number>(0);
  const lastRemoteMoveSeqRef = useRef<Map<string, number>>(new Map());

  const setConnected = useGameStore((s) => s.setConnected);
  const setLocalPlayerId = useGameStore((s) => s.setLocalPlayerId);
  const setRoomState = useGameStore((s) => s.setRoomState);
  const setLocalPlayer = useGameStore((s) => s.setLocalPlayer);
  const upsertPlayer = useGameStore((s) => s.upsertPlayer);
  const removePlayer = useGameStore((s) => s.removePlayer);
  const addZoneChatMessage = useGameStore((s) => s.addZoneChatMessage);
  const setSpeechBubble = useGameStore((s) => s.setSpeechBubble);
  const addEmote = useGameStore((s) => s.addEmote);
  const setFurniture = useGameStore((s) => s.setFurniture);
  const setZones = useGameStore((s) => s.setZones);
  const setTilesFromData = useGameStore((s) => s.setTiles);
  const applyAdminChanged = useGameStore((s) => s.applyAdminChanged);
  const setLocalUserId = useGameStore((s) => s.setLocalUserId);
  const setNotice = useGameStore((s) => s.setNotice);
  const setFollowInfo = useGameStore((s) => s.setFollowInfo);
  const setFollowerUserIds = useGameStore((s) => s.setFollowerUserIds);
  const setMediaObjects = useGameStore((s) => s.setMediaObjects);
  const addMediaObject = useGameStore((s) => s.addMediaObject);
  const removeMediaObject = useGameStore((s) => s.removeMediaObject);
  const appendWhiteboardStroke = useGameStore((s) => s.appendWhiteboardStroke);
  const clearWhiteboardStrokes = useGameStore((s) => s.clearWhiteboardStrokes);

  // Identify this player by their real authenticated account id whenever one
  // is available, so admin/ownership checks (which compare against
  // Room.ownerId, a real DB user id) actually match. vm_userId is a random
  // per-browser fallback for the (currently unreachable, since login is
  // required before the Lobby) anonymous case — kept for backward compat.
  useEffect(() => {
    if (authUserId) {
      setLocalUserId(authUserId);
      return;
    }
    let uid = localStorage.getItem('vm_userId');
    if (!uid) {
      uid = crypto.randomUUID();
      localStorage.setItem('vm_userId', uid);
    }
    setLocalUserId(uid);
  }, [authUserId]);

  // Interpolation is driven by GameCanvas's requestAnimationFrame loop now,
  // not by a standalone 16ms setInterval. One clock instead of two racing
  // ones, no work at all while the tab is backgrounded (rAF pauses,
  // setInterval does not), and the sampled positions land in the same frame
  // that draws them rather than up to a frame early or late.
  //
  // Remote position overlays are per-room state: leaving must not carry
  // someone else's coordinates into the next room.
  useEffect(() => () => clearRemotePositions(), []);

  useEffect(() => {
    // Reset for this room-join attempt — see gameStore.ts's doc comment on
    // roomStateReceived for why Game.tsx gates the canvas on this instead
    // of just "roomState exists" (App.tsx seeds a hardcoded placeholder
    // room before any socket connection exists at all).
    useGameStore.getState().setRoomStateReceived(false);
    // A stale 'room-full' notice from a PREVIOUS denied join must not keep
    // showing for this new attempt (different room, or a retry of the same
    // one) — gameStore is a global singleton that outlives any one
    // useSocket instance, so nothing else would ever clear this otherwise.
    useGameStore.getState().setRoomFullNotice(null);
    // Same reasoning — a stale "recording active" banner from the PREVIOUS
    // room must not carry over; recordingHandler.ts sends the real current
    // state right after JOIN_ROOM regardless, but that arrives a tick
    // later than this synchronous reset, so without this line the banner
    // would flash on/off if the old and new room's states differ.
    useGameStore.getState().setRoomRecordingActive(false);
    // Same reasoning for the Activity Feed — without this, portal travel or
    // leaving-and-rejoining a different room left the previous room's
    // events mixed in with the new room's own (see clearActivity's doc
    // comment in gameStore.ts).
    useGameStore.getState().clearActivity();
    lastEmitRef.current = 0;
    moveSeqRef.current = 0;
    lastRemoteMoveSeqRef.current.clear();

    // Connect directly to the game server — bypass Vite proxy entirely
    // to avoid WebSocket proxy ECONNABORTED issues. The JWT (if logged in)
    // lets the server verify our identity server-side instead of trusting
    // the userId we hand it in JOIN_ROOM below (see index.ts io.use()).
    const socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      autoConnect: false,
      auth: { token: guestToken || localStorage.getItem('vm_token') || undefined },
    });
    socketRef.current = socket;

    socket.on(SocketEvents.CONNECT, () => {
      console.log('[socket] connected:', socket.id);
      setLocalPlayerId(socket.id!);
      setConnected(true);
      // Skew samples from the previous connection describe a clock this
      // session can no longer be compared against — a reconnect can land on
      // a different server process entirely, and even the same one may have
      // been restarted. Keeping them would offset every snapshot by a
      // constant error for the rest of the session.
      resetServerClock();

      const config = loadAvatarConfig();
      const uid = authUserId || localStorage.getItem('vm_userId') || socket.id;
      const displayName = authUserName || config.name || 'Player';
      socket.emit(SocketEvents.JOIN_ROOM, roomSlug, displayName, config, uid);
    });

    socket.on(SocketEvents.DISCONNECT, (reason) => {
      console.warn('[socket] disconnected — reason:', reason);
      setConnected(false);
      // Final-review Fix 2 — remoteHelpHandler.ts's own DISCONNECT handler
      // unconditionally destroys any active/pending remote-help session the
      // instant EITHER party disconnects, and can only notify the OTHER
      // party. So whichever side actually disconnected (portal travel calls
      // socket.disconnect() on every roomSlug change — see this effect's own
      // cleanup above; a network blip that auto-reconnects hits this too)
      // must reconcile its own stale remote-help state here, since
      // gameStore is a module-level singleton that outlives any one socket
      // connection/reconnect and nothing else would ever clear it.
      useGameStore.getState().setIncomingRemoteHelpRequest(null);
      useGameStore.getState().setActiveRemoteHelp(null);
      useGameStore.getState().setReceivedRemoteHelpCredential(null);
    });

    socket.on(SocketEvents.ROOM_STATE, (roomState) => {
      console.log('[socket] room:state received — players:', roomState.players?.length, 'tiles:', roomState.tiles?.length ?? 0);
      // Fitur 15 — register this room's custom Floor/Wall/Object uploads
      // into PALETTE_BY_ID BEFORE setRoomState/the render loop reads `tiles`/
      // `furniture` above, which may already reference their paletteIds.
      registerCustomAssets(roomState.customAssets);
      setRoomState(roomState);
      useGameStore.getState().setRoomStateReceived(true);

      // setRoomState() deliberately skips the local player's own entry (it
      // only reads other players' data from room:state, so a stray re-sync
      // never teleports someone mid-movement) — but on the very first
      // room:state after joining, the server's own entry for us IS the
      // authoritative spawn position (computed from the room's actual
      // 'spawn' tile — see roomHandler.ts's findSpawnPixel), so apply it
      // here once, explicitly, rather than leaving the local player at
      // gameStore's static initial default position regardless of where
      // this room's spawn tile actually is.
      const localId = useGameStore.getState().localPlayerId;
      const serverSelf = roomState.players?.find((p: Avatar) => p.id === localId);
      if (serverSelf) {
        setLocalPlayer({ x: serverSelf.x, y: serverSelf.y, direction: serverSelf.direction });
      }
    });

    socket.on(SocketEvents.PLAYER_JOINED, (player: Avatar) => {
      console.log('[socket] player joined:', player.name);
      upsertPlayer(player);
      useGameStore.getState().addActivity(`${player.name} joined the room`);
    });

    socket.on(SocketEvents.PLAYER_MOVED, (data: PlayerMovedPayload) => {
      const receivedAt = Date.now();
      if (typeof data.seq === 'number') {
        const lastSeq = lastRemoteMoveSeqRef.current.get(data.id);
        if (lastSeq !== undefined && data.seq <= lastSeq) return;
        lastRemoteMoveSeqRef.current.set(data.id, data.seq);
      }
      // Timestamp the snapshot by when the server SENT it, not when it
      // happened to land here — see serverClock.ts. Arrival time carried the
      // network's jitter into the interpolation buffer, which is what made
      // remote avatars stutter on an otherwise healthy connection.
      pushRemoteSnapshot(data.id, data.x, data.y, serverTimeToClient(data.serverTime, receivedAt));
      upsertPlayer({
        id: data.id,
        direction: data.direction as Avatar['direction'],
        isMoving: true,
        isRunning: !!data.isRunning,
      } as Avatar);
    });

    socket.on(SocketEvents.PLAYER_STOPPED, (data: PlayerStoppedPayload) => {
      const x = data.x;
      const y = data.y;
      const hasPosition = typeof x === 'number' && typeof y === 'number';
      if (hasPosition) {
        const receivedAt = serverTimeToClient(data.serverTime, Date.now());
        const state = useGameStore.getState();
        if (data.id === state.localPlayerId) {
          setLocalPlayer({
            x,
            y,
            direction: data.direction as Avatar['direction'],
            isMoving: false,
            isRunning: false,
          });
          return;
        }
        pushRemoteSnapshot(data.id, x, y, receivedAt);
      }
      upsertPlayer({
        id: data.id,
        ...(hasPosition ? { x, y } : {}),
        direction: data.direction as Avatar['direction'],
        isMoving: false,
        isRunning: false,
      } as Avatar);
    });

    socket.on(SocketEvents.PLAYER_LEFT, (playerId: string) => {
      console.log('[socket] player left:', playerId);
      // Must read the name BEFORE removePlayer() — it deletes this exact
      // record, so looking it up after would always come back empty.
      const leavingName = useGameStore.getState().playerRecords[playerId]?.name;
      removePlayer(playerId);
      if (leavingName) useGameStore.getState().addActivity(`${leavingName} left the room`);
    });

    socket.on(SocketEvents.AVATAR_UPDATED, (data: { id: string; avatarConfig: AvatarConfig }) => {
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) return;
      // Bug: chat's sender-name cache (useProfiles) resolves by userId and
      // never refetches once cached, so a rename mid-session never reached
      // it — the nametag/panel updated live via playerRecords, chat didn't.
      // We already know the new name right here in real time, so push it in
      // directly instead of waiting for a refetch that would never happen.
      const userId = state.playerRecords[data.id]?.userId;
      if (userId && data.avatarConfig.name) setProfileName(userId, data.avatarConfig.name);
      upsertPlayer({
        id: data.id,
        avatarConfig: data.avatarConfig,
        color: data.avatarConfig.color,
        name: data.avatarConfig.name,
      } as Avatar);
    });

    socket.on(SocketEvents.PLAYER_HAND_UPDATED, (data: { id: string; handRaised: boolean }) => {
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) return;
      upsertPlayer({ id: data.id, handRaised: data.handRaised || undefined } as Avatar);
    });

    socket.on(SocketEvents.PLAYER_MIC_UPDATED, (data: { id: string; micMuted: boolean }) => {
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) return;
      upsertPlayer({ id: data.id, micMuted: data.micMuted || undefined } as Avatar);
    });

    socket.on(SocketEvents.PLAYER_HIDDEN_UPDATED, (data: { id: string; hidden: boolean }) => {
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) return;
      upsertPlayer({ id: data.id, hidden: data.hidden || undefined } as Avatar);
    });

    // A3 — another player's Focus/Public change; update their record so their
    // badge + proximity DND (useProximity) reflect it here.
    socket.on(SocketEvents.WORK_MODE_CHANGED, (data: { id: string; workMode: WorkMode; reason?: string }) => {
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) return;
      // 'available' → no badge (undefined); any other status keeps its value.
      upsertPlayer({
        id: data.id,
        workMode: data.workMode === 'available' ? undefined : data.workMode,
        awayReason: data.workMode === 'away' ? data.reason : undefined,
      } as Avatar);
    });

    // ZEP-style Spotlight — unlike WORK_MODE_CHANGED above, this is NOT
    // skipped for the local player: the target never applied it themselves
    // (an admin toggled it on them), so if WE are the target this is the
    // only place our own spotlightActive ever gets set.
    socket.on(SocketEvents.SPOTLIGHT_CHANGED, (data: { id: string; active: boolean }) => {
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) {
        state.setLocalPlayer({ spotlightActive: data.active || undefined });
      } else {
        upsertPlayer({ id: data.id, spotlightActive: data.active || undefined } as Avatar);
      }
    });

    // QA #9/#10 — CEO/admin text broadcast toast, everyone in the room
    // (including the sender) gets this since the server emits via
    // io.to(room), same reasoning as SPOTLIGHT_CHANGED above.
    socket.on(SocketEvents.BROADCAST_RECEIVED, (data: RoomBroadcast) => {
      useGameStore.getState().enqueueBroadcast(data);
    });

    socket.on(SocketEvents.PLAYER_SAT, (data: { id: string; isSitting: boolean; x: number; y: number; direction: Avatar['direction']; seatFurnitureId?: string }) => {
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) return;
      // seatFurnitureId carried through so this peer's table membership (and
      // chair occupancy) is known locally — undefined once they stand.
      // Sitting places the avatar exactly on the chair — snap the live
      // overlay too, or it would keep drawing them at the last interpolated
      // step until the buffer drains.
      snapRemotePosition(data.id, data.x, data.y);
      upsertPlayer({ id: data.id, isSitting: data.isSitting, seatFurnitureId: data.seatFurnitureId, x: data.x, y: data.y, direction: data.direction, isMoving: false } as Avatar);
    });

    // §4 — Teleport. Broadcast via io.to(room) (not socket.to(room)), so the
    // mover's own client gets this too — unlike a normal walk, there's no
    // local prediction to reconcile with, the server's resolved x/y is the
    // only source of truth. Snaps instantly rather than going through
    // playerTargets' lerp (interpolatePlayers in gameStore.ts) — sliding a
    // remote avatar across the whole map over ~200ms would look like a fast
    // walk, not a teleport.
    socket.on(SocketEvents.PLAYER_TELEPORTED, (data: { id: string; x: number; y: number; direction: Avatar['direction']; seatFurnitureId?: string }) => {
      console.log('[socket] player teleported:', data.id, '→', data.x, data.y);
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) {
        if (data.seatFurnitureId) {
          // "My Seat" — the server resolved this teleport to the requester's
          // own assigned furniture (see roomHandler.ts's TELEPORT_REQUEST
          // 'seat' branch); land AND sit in one action rather than just
          // standing at the seat's tile. Mirrors GameCanvas.tsx's
          // performSit's local bookkeeping — sitReturnPos is set together
          // with the new position/sitting-flag in ONE store update via
          // landOnSeat, not several separate set() calls (one to clear any
          // previous sit state, one for sittingFurnitureId, one for
          // localPlayer's position) — each of those is its own render, and
          // the renders in between still had localPlayer at the OLD
          // position, i.e. a visible flash back to where the player started
          // before snapping to the seat.
          //
          // sitReturnPos here is a tile adjacent to the SEAT (via
          // findAdjacentFreeTile), not wherever the player happened to be
          // standing before they clicked "My Seat" — that previous spot can
          // be anywhere on the map (a different zone, clear across the
          // room), so standing back up (Space, or any movement key — see
          // GameCanvas.tsx's performStandUp) used to snap the player back to
          // that unrelated distant position instead of just stepping away
          // from the seat they were just sitting in.
          const seatTileX = Math.floor(data.x / TILE_SIZE);
          const seatTileY = Math.floor(data.y / TILE_SIZE);
          const adjacent = state.tiles.length > 0
            ? findAdjacentFreeTile(state.tiles, seatTileX, seatTileY)
            : { x: seatTileX, y: seatTileY + 1 };
          const returnPos = { x: adjacent.x * TILE_SIZE + TILE_SIZE / 2, y: adjacent.y * TILE_SIZE + TILE_SIZE / 2 };
          state.landOnSeat(data.seatFurnitureId, returnPos, data.x, data.y, data.direction);
          socket.emit(SocketEvents.PLAYER_SIT, { sitting: true, x: data.x, y: data.y, direction: data.direction, seatFurnitureId: data.seatFurnitureId });
          return;
        }
        // Stand up first if sitting — otherwise x/y jumps to the teleport
        // target but isSitting stays true, so useMovement's isFrozen check
        // keeps refusing all WASD input there. Server already dropped our
        // sit state server-side implicitly (positions are independent), but
        // the local store needs the same reset explicitly. (The seat-landing
        // branch above never needs this — landOnSeat already sets a fresh
        // sittingFurnitureId/isSitting regardless of what they were before.)
        if (state.localPlayer.isSitting) {
          state.setSittingFurnitureId(null);
          state.setSitReturnPos(null);
        }
        state.setLocalPlayer({ x: data.x, y: data.y, direction: data.direction, isMoving: false, isSitting: false });
        return;
      }
      upsertPlayer({ id: data.id, x: data.x, y: data.y, direction: data.direction, isMoving: false } as Avatar);
      // Drops the lerp buffer and places the avatar, in one call. This
      // used to append a snapshot under a comment claiming it CLEARED the
      // in-flight target — appending does the opposite, handing the
      // interpolator one more point to glide toward, so a teleport rendered
      // as a slide across the map: the very thing PLAYER_TELEPORTED exists
      // to avoid.
      snapRemotePosition(data.id, data.x, data.y);
    });

    // §5 — Summon, consent-gated. SUMMON_REQUEST is someone else asking to
    // move me — shown as an Accept/Decline toast (PendingRequestToast.tsx)
    // instead of moving me immediately. SUMMON_RESULT is the reply to MY
    // OWN request, telling me whether they accepted/declined/timed out.
    socket.on(SocketEvents.SUMMON_REQUEST, (data: SummonRequestPayload) => {
      useGameStore.getState().setIncomingSummonRequest(data);
    });

    socket.on(SocketEvents.SUMMON_RESULT, (data: SummonResultPayload) => {
      useGameStore.getState().setSummonResult(data);
    });

    // "Tarik Paksa" (Force-pull) — FORCE_PULL_RESULT is feedback to the
    // ADMIN who pulled (delivered now vs queued for the target's next
    // join); FORCE_PULLED tells the TARGET's own client it happened to
    // them, either right away (online) or on the join that consumes their
    // queued landing spot (was offline) — see roomHandler.ts's JOIN_ROOM.
    // Reuses the activity feed rather than a bespoke toast, same lightweight
    // one-way-notice pattern as the door-unlock notice.
    socket.on(SocketEvents.FORCE_PULL_RESULT, (data: { targetUserId: string; delivered: boolean }) => {
      useGameStore.getState().addActivity(data.delivered ? '✅ Berhasil menarik paksa.' : '📨 Target sedang offline — notifikasi dikirim.');
    });

    socket.on(SocketEvents.FORCE_PULLED, (data: { byName: string }) => {
      useGameStore.getState().addActivity(`📍 ${data.byName} menarik Anda ke sini.`);
    });

    // Fitur 15B — reply to MY OWN INTERACTIVE_PASSWORD_CHECK.
    socket.on(SocketEvents.INTERACTIVE_PASSWORD_RESULT, (data: InteractivePasswordResultPayload) => {
      useGameStore.getState().setInteractivePasswordResult(data);
    });

    // Fitur 15B — reply to MY OWN INTERACTIVE_CHOICE_CHECK.
    socket.on(SocketEvents.INTERACTIVE_CHOICE_RESULT, (data: InteractiveChoiceResultPayload) => {
      useGameStore.getState().setInteractiveChoiceResult(data);
    });

    // ZEP-style door password — reply to MY OWN INTERACTIVE_DOOR_PASSWORD_CHECK.
    // A correct result also unlocks the door client-side (GameCanvas's local
    // collision prediction) — the server independently did the same for its
    // own authoritative check (see doorLock.ts).
    socket.on(SocketEvents.INTERACTIVE_DOOR_PASSWORD_RESULT, (data: InteractiveDoorPasswordResultPayload) => {
      useGameStore.getState().setInteractiveDoorPasswordResult(data);
      if (data.correct) useGameStore.getState().unlockDoorClientSide(data.x, data.y);
    });

    // Item #6 (Akses & Password Pintu audit) follow-up — someone ELSE in the
    // room just solved a door password; only they got INTERACTIVE_DOOR_PASSWORD_RESULT
    // above, so without this the rest of the room would have no idea a door
    // opened at all. No visual door state to update yet — just a notice.
    socket.on(SocketEvents.DOOR_UNLOCKED_NOTICE, (data: DoorUnlockedNoticePayload) => {
      useGameStore.getState().addActivity(`${data.byName} membuka pintu.`);
    });

    // "Door Area" — area-id counterparts to the two listeners just above.
    socket.on(SocketEvents.INTERACTIVE_DOOR_AREA_PASSWORD_RESULT, (data: InteractiveDoorAreaPasswordResultPayload) => {
      useGameStore.getState().setInteractiveDoorAreaPasswordResult(data);
      if (data.correct) useGameStore.getState().unlockDoorAreaLocally(data.areaId);
    });
    socket.on(SocketEvents.DOOR_AREA_UNLOCKED_NOTICE, (data: DoorAreaUnlockedNoticePayload) => {
      useGameStore.getState().addActivity(`${data.byName} membuka pintu.`);
    });

    // Fitur 15B — reply to MY OWN INTERACTIVE_API_CALL. No modal to feed —
    // this IS the notification (spec: "jangan diam-diam gagal").
    socket.on(SocketEvents.INTERACTIVE_API_CALL_RESULT, (data: InteractiveApiCallResultPayload) => {
      useGameStore.getState().addActivity(data.success ? 'API call berhasil.' : `API call gagal: ${data.error || 'unknown error'}`);
    });

    // Follow, same consent shape as Summon above.
    socket.on(SocketEvents.FOLLOW_INCOMING, (data: FollowRequestPayload) => {
      useGameStore.getState().setIncomingFollowRequest(data);
    });

    socket.on(SocketEvents.FOLLOW_RESULT, (data: FollowResultPayload) => {
      useGameStore.getState().setFollowResult(data);
    });

    // Minta Bantuan Remote — same consent shape as Follow above.
    socket.on(SocketEvents.REMOTE_HELP_INCOMING, (data: RemoteHelpRequestPayload) => {
      useGameStore.getState().setIncomingRemoteHelpRequest(data);
    });
    socket.on(SocketEvents.REMOTE_HELP_RESULT, (data: RemoteHelpResultPayload) => {
      useGameStore.getState().setRemoteHelpResult(data);
      // Accepted means THIS client is the helper — the target's own client
      // sets its half of activeRemoteHelp optimistically on accept-click
      // instead (see App.tsx), same "clear pending state on my own action
      // without waiting for a round trip" convention every other
      // accept/decline flow in this codebase already uses.
      if (data.accepted) useGameStore.getState().setActiveRemoteHelp({ role: 'helper', otherName: data.targetName });
    });
    socket.on(SocketEvents.REMOTE_HELP_CREDENTIAL, (data: RemoteHelpCredentialPayload) => {
      useGameStore.getState().setReceivedRemoteHelpCredential({ rustdeskId: data.rustdeskId, password: data.password });
    });
    // Final-review Fix 3 — authoritative confirmation the credential
    // actually reached the helper; the only signal RemoteHelpCredentialForm
    // is allowed to treat as "Terkirim".
    socket.on(SocketEvents.REMOTE_HELP_CREDENTIAL_ACK, () => {
      useGameStore.getState().setRemoteHelpCredentialAcked(true);
    });
    socket.on(SocketEvents.REMOTE_HELP_END, (data: RemoteHelpEndPayload) => {
      // addActivity is the same lightweight one-off notice mechanism this
      // file already uses for INTERACTIVE_API_CALL_RESULT/
      // DOOR_AREA_UNLOCKED_NOTICE — reused here so whoever did NOT click
      // "Selesai" themselves still learns who ended the session, instead of
      // the banner just silently vanishing.
      useGameStore.getState().addActivity(`Sesi bantuan remote diakhiri oleh ${data.endedByName}.`);
      useGameStore.getState().setActiveRemoteHelp(null);
      useGameStore.getState().setReceivedRemoteHelpCredential(null);
    });

    // §6 — Add Media. MEDIA_LIST arrives once right after ROOM_STATE (this
    // module's own JOIN_ROOM emit in mediaHandler.ts, not bundled into
    // ROOM_STATE itself — see that handler's doc comment for why); the rest
    // stay live via ADDED/REMOVED for the whole session.
    socket.on(SocketEvents.MEDIA_LIST, (data: { mediaObjects: MapMediaObject[] }) => {
      setMediaObjects(data.mediaObjects);
    });
    socket.on(SocketEvents.MEDIA_ADDED, (data: MapMediaObject) => {
      addMediaObject(data);
      const kind = data.type === 'youtube' ? 'a YouTube video' : data.type === 'whiteboard' ? 'a whiteboard' : data.type === 'file' ? 'a file' : 'an image';
      useGameStore.getState().addActivity(`${data.createdByName} added ${kind}`);
    });
    socket.on(SocketEvents.MEDIA_REMOVED, (data: { id: string }) => {
      removeMediaObject(data.id);
    });
    socket.on(SocketEvents.WHITEBOARD_STROKE_ADDED, (data: { mediaId: string; stroke: WhiteboardStroke }) => {
      appendWhiteboardStroke(data.mediaId, data.stroke);
    });
    socket.on(SocketEvents.WHITEBOARD_CLEARED, (data: { mediaId: string }) => {
      clearWhiteboardStrokes(data.mediaId);
    });

    // Soundboard — SOUNDBOARD_LIST arrives once right after ROOM_STATE, same
    // "list right after room:state" shape as MEDIA_LIST above; defaults need
    // no server round trip at all (SOUNDBOARD_DEFAULT_SOUNDS is static).
    socket.on(SocketEvents.SOUNDBOARD_LIST, (data: { sounds: SoundboardSoundData[] }) => {
      useGameStore.getState().setSoundboardSounds(data.sounds);
    });
    socket.on(SocketEvents.SOUNDBOARD_SOUND_ADDED, (data: SoundboardSoundData) => {
      useGameStore.getState().addSoundboardSound(data);
    });
    socket.on(SocketEvents.SOUNDBOARD_SOUND_REMOVED, (data: { id: string }) => {
      useGameStore.getState().removeSoundboardSound(data.id);
    });
    // Server already scoped this to proximity/zone (see getNearbyRecipients,
    // shared with HAND_RAISED_ALERT) and never echoes it back to the sender —
    // the sender's own playback is the optimistic local play in
    // emitSoundboardPlay below, not this listener.
    // Music Bot — one snapshot per state change (see musicHandler.ts's
    // broadcastState), scoped to whoever is currently in that zone (same
    // getSocketIdsInZone audience zone-private chat already uses).
    socket.on(SocketEvents.MUSIC_STATE, (data: MusicSessionState) => {
      useGameStore.getState().setMusicSessionState(data);
    });

    socket.on(SocketEvents.SOUNDBOARD_PLAYED, (data: SoundboardPlayedPayload) => {
      const sound = resolveSoundboardSound(data.soundId);
      if (!sound) return;
      playSoundboardClip(data.fromId, sound.url);
      useGameStore.getState().triggerSoundboardPlaying(data.fromId, Date.now() + Math.max(sound.durationMs, 800));
    });

    // §7 — only ever arrives for clients allowed to see it at all (see
    // recordingHandler.ts's per-socket emit) — App.tsx's own effect watches
    // this same state to decide whether IT was the request that started
    // it (and if so, begins the actual client-side capture).
    socket.on(SocketEvents.RECORDING_STARTED, (data: { recordingId: string; targetUserId: string; targetName: string; startedByName: string; title: string }) => {
      useGameStore.getState().setActiveRecording(data);
      useGameStore.getState().addActivity(`${data.startedByName} started recording ${data.targetName}`);
    });
    socket.on(SocketEvents.RECORDING_ENDED, () => {
      const active = useGameStore.getState().activeRecording;
      useGameStore.getState().setActiveRecording(null);
      if (active) useGameStore.getState().addActivity(`Recording of ${active.targetName} finished`);
    });
    socket.on(SocketEvents.RECORDING_FAILED, () => {
      useGameStore.getState().setActiveRecording(null);
    });

    // QA (Data A/V checklist item 7) — genuinely room-wide, every socket
    // gets this regardless of role (see the event's own doc comment).
    socket.on(SocketEvents.RECORDING_ACTIVE_CHANGED, (data: { active: boolean }) => {
      useGameStore.getState().setRoomRecordingActive(!!data?.active);
    });

    socket.on(SocketEvents.FURNITURE_ASSIGNED, (data: { furnitureId: string; userId: string; name: string }) => {
      useGameStore.getState().setFurnitureAssignment(data.furnitureId, data.userId, data.name);
    });

    socket.on(SocketEvents.FURNITURE_UNASSIGNED, (data: { furnitureId: string }) => {
      useGameStore.getState().setFurnitureAssignment(data.furnitureId, undefined, undefined);
    });

    // QA #7/#8/#9 — desk notes, live create/edit/delete.
    socket.on(SocketEvents.NOTE_ADDED, (note: DeskNoteData) => {
      useGameStore.getState().addNote(note);
    });
    socket.on(SocketEvents.NOTE_UPDATED, (note: DeskNoteData) => {
      useGameStore.getState().updateNote(note);
    });
    socket.on(SocketEvents.NOTE_DELETED, (data: { id: string }) => {
      useGameStore.getState().removeNoteById(data.id);
    });

    // QA (Presence checklist item #8, "Member list akurat") — workspace-wide
    // roster: a one-time snapshot answered only to us (requested when
    // MemberListPanel opens), plus live deltas from then on for every
    // connected socket, not just this room.
    socket.on(SocketEvents.ROSTER_SNAPSHOT, (entries: RosterEntry[]) => {
      useGameStore.getState().setRosterSnapshot(entries ?? []);
    });
    socket.on(SocketEvents.ROSTER_UPDATED, (update: RosterUpdate) => {
      useGameStore.getState().applyRosterUpdate(update);
    });

    // Claimable-seat markers (Room Editor's 'claimableSeat' tile effect) —
    // server broadcasts the full claim list on every change, same
    // wholesale-refresh shape as zone locks.
    socket.on(SocketEvents.SEAT_CLAIMS_UPDATED, (data: { claims: { seatId: string; userId: string; name: string }[] }) => {
      useGameStore.getState().setSeatClaims(data?.claims ?? []);
    });
    socket.on(SocketEvents.SEAT_CLAIM_DENIED, (data: { seatId: string; byName?: string; fallbackSeatId?: string }) => {
      const byName = data.byName ?? 'orang lain';
      // Server already redirected the claim to the nearest free desk (see
      // seatClaim.ts's nearestFreeSeat) — SEAT_CLAIMS_UPDATED right before
      // this reflects the new ownership; this toast just explains why.
      const msg = data.fallbackSeatId
        ? `Kursi ini sudah diklaim ${byName} — kamu dipindah ke kursi kosong terdekat.`
        : `Kursi ini sudah diklaim ${byName}.`;
      useGameStore.getState().setSitNotice(msg);
    });

    // Someone wants to take over a seat WE own — see seatClaim.ts's
    // SEAT_CLAIM_REQUEST handler. Rendered as an Izinkan/Tolak card
    // (SeatClaimBar.tsx).
    socket.on(SocketEvents.SEAT_CLAIM_REQUESTED, (data: SeatClaimRequest) => {
      useGameStore.getState().addSeatClaimRequest(data);
    });
    // The owner decided on OUR request (or disconnected before deciding —
    // seatClaim.ts's DISCONNECT handler resolves that the same way, as a
    // denial, so this "menunggu" card never hangs forever).
    socket.on(SocketEvents.SEAT_CLAIM_DECIDED, (data: { seatId: string; approved: boolean; byName?: string }) => {
      const state = useGameStore.getState();
      if (state.pendingSeatClaimRequest?.seatId === data.seatId) state.setPendingSeatClaimRequest(null);
      state.setSitNotice(data.approved
        ? `${data.byName ?? 'Pemilik'} mengizinkan kamu memakai kursi ini.`
        : `${data.byName ?? 'Pemilik'} menolak permintaanmu.`);
    });
    // Our own pending request became moot from the OWNER's side of the
    // card — the requester cancelled, disconnected, or the seat's actual
    // owner never comes back into play here (this event only ever targets
    // the OWNER's socket, dropping their card for a request that's no
    // longer pending).
    socket.on(SocketEvents.SEAT_CLAIM_REQUEST_CANCELLED, (data: { seatId: string; requesterUserId: string }) => {
      useGameStore.getState().removeSeatClaimRequest(data.seatId, data.requesterUserId);
    });

    // Zone-private chat only now — the old whole-room broadcast case is
    // superseded by CHANNEL_MESSAGE_NEW/the room's default "general" channel
    // (see chatHandler.ts, which no longer emits this without a zoneId).
    socket.on(SocketEvents.CHAT_BROADCAST, (msg: ChatMessage) => {
      // §10 — only for messages from someone else, and notifyNewMessage
      // itself no-ops unless the tab is actually in the background (spec's
      // own rule) and the user has actually turned notifications on.
      // A3 — while in Focus/DND, suppress the disruptive popup; the message is
      // still stored/rendered below, just no real-time notification.
      if (msg.senderId !== useGameStore.getState().localPlayerId && useGameStore.getState().workMode !== 'focus' && useGameStore.getState().isNotifKindEnabled('chat')) {
        notifyNewMessage(msg.senderName, msg.text);
      }
      if (msg.zoneId) addZoneChatMessage(msg.zoneId, msg);
      // Also show speech bubble above sender for 4 seconds
      if (!msg.isProximity) {
        setSpeechBubble(msg.senderId, {
          playerId: msg.senderId,
          text: msg.text,
          expireAt: Date.now() + 4000,
        });
      }
    });

    // Thread replies (parentId set) go to repliesByParent/bumpReplyCount
    // instead of messagesByTarget — see those actions' doc comments in
    // gameStore.ts. A reply landing for a thread nobody has open is a
    // harmless no-op in appendParentReply (only the parent's reply count
    // updates); one landing while the sender (or anyone else) has that
    // thread expanded shows up immediately, no refetch/timeout needed.
    socket.on(SocketEvents.CHANNEL_MESSAGE_NEW, (msg: ChannelMessage) => {
      if (!msg.channelId) return;
      const state = useGameStore.getState();
      if (msg.parentId) {
        state.appendParentReply(msg.parentId, msg);
        state.bumpReplyCount(`channel:${msg.channelId}`, msg.parentId);
      } else {
        state.appendTargetMessage(`channel:${msg.channelId}`, msg);
        // Bug 13 — regression from the chat-system migration: the speech
        // bubble over the sender's avatar was a side effect of the OLD
        // room-wide CHAT_BROADCAST handler, and when everyday chat moved to
        // persisted channels this handler never picked it up — so bubbles
        // kept working for zone chat / "Say nearby" but vanished for the
        // chat people actually use. ChannelMessage.senderId is a USER id
        // while bubbles key on the in-room socket id, so map it through
        // playerRecords (localPlayerId for our own echo). Top-level messages
        // with text only: thread replies live in their thread, and an
        // attachment-only send has nothing to say in a bubble. DMs
        // deliberately get NO bubble — floating private-message text over
        // someone's head would broadcast it to the whole room.
        if (msg.text) {
          const pid = msg.senderId === state.localUserId
            ? state.localPlayerId
            : Object.values(state.playerRecords).find((p) => p.userId === msg.senderId)?.id;
          if (pid) state.setSpeechBubble(pid, { playerId: pid, text: msg.text, expireAt: Date.now() + 4000 });
        }
      }
      if (msg.senderId !== state.localUserId) {
        // A3 — Focus/DND mutes the popup but STILL marks unread (message kept).
        if (state.workMode !== 'focus') {
          // Potongan C2 Bagian 3 — a mention gets a distinctly more
          // prominent title (reuses the exact same notifyNewMessage/browser-
          // notification plumbing as every other chat notification, not a
          // second system) and, uniquely, a click jumps straight to the
          // channel it happened in. senderId !== localUserId above already
          // means you never get this for mentioning yourself.
          if (textMentionsUser(msg.text, state.localUserId)) {
            if (state.isNotifKindEnabled('mention')) {
              const channelName = state.channels.find((c) => c.id === msg.channelId)?.name;
              notifyNewMessage(
                `${msg.senderName} menyebut kamu${channelName ? ` di #${channelName}` : ''}`,
                msg.text,
                () => {
                  useGameStore.getState().setActiveChatTarget({ type: 'channel', id: msg.channelId! });
                  useGameStore.getState().setChatPanelOpen(true);
                },
              );
            }
          } else if (state.isNotifKindEnabled('chat')) {
            notifyNewMessage(msg.senderName, msg.text);
          }
        }
        markUnreadIfHidden(`channel:${msg.channelId}`);
      }
    });

    socket.on(SocketEvents.DM_MESSAGE_NEW, (msg: ChannelMessage) => {
      if (!msg.conversationId) return;
      const state = useGameStore.getState();
      if (msg.parentId) {
        state.appendParentReply(msg.parentId, msg);
        state.bumpReplyCount(`dm:${msg.conversationId}`, msg.parentId);
      } else {
        state.appendTargetMessage(`dm:${msg.conversationId}`, msg);
      }
      if (msg.senderId !== state.localUserId) {
        // A3 — Focus/DND mutes the popup but STILL marks unread (message kept).
        if (state.workMode !== 'focus' && state.isNotifKindEnabled('chat')) notifyNewMessage(msg.senderName, msg.text);
        markUnreadIfHidden(`dm:${msg.conversationId}`);
      }
    });

    socket.on(SocketEvents.MESSAGE_DELETED, (data: { messageId: string; channelId?: string; conversationId?: string; parentId?: string }) => {
      const key = data.channelId ? `channel:${data.channelId}` : `dm:${data.conversationId}`;
      useGameStore.getState().removeTargetMessage(key, data.messageId, data.parentId);
    });

    socket.on(SocketEvents.MESSAGE_EDITED, (data: { messageId: string; channelId?: string; conversationId?: string; parentId?: string; text: string }) => {
      const key = data.channelId ? `channel:${data.channelId}` : `dm:${data.conversationId}`;
      useGameStore.getState().editTargetMessage(key, data.messageId, data.text, data.parentId);
    });

    socket.on(SocketEvents.MESSAGE_PINNED, (data: { messageId: string; channelId?: string; conversationId?: string; parentId?: string; pinned: boolean }) => {
      const key = data.channelId ? `channel:${data.channelId}` : `dm:${data.conversationId}`;
      useGameStore.getState().setMessagePinned(key, data.messageId, data.pinned, data.parentId);
    });

    socket.on(SocketEvents.CHAT_READ_STATE_SYNC, (data: { channelId?: string; conversationId?: string; entries: ChatReadEntry[] }) => {
      const key = data.channelId ? `channel:${data.channelId}` : `dm:${data.conversationId}`;
      useGameStore.getState().setReadState(key, data.entries);
    });

    socket.on(SocketEvents.CHAT_READ_UPDATED, (data: { channelId?: string; conversationId?: string; userId: string; lastReadAt: number }) => {
      const key = data.channelId ? `channel:${data.channelId}` : `dm:${data.conversationId}`;
      useGameStore.getState().updateReadEntry(key, data.userId, data.lastReadAt);
    });

    socket.on(SocketEvents.CHANNEL_TYPING_UPDATE, (data: { channelId: string; userId: string }) => {
      if (data.userId === useGameStore.getState().localUserId) return;
      useGameStore.getState().noteTyping(`channel:${data.channelId}`, data.userId);
    });

    socket.on(SocketEvents.DM_TYPING_UPDATE, (data: { conversationId: string; userId: string }) => {
      if (data.userId === useGameStore.getState().localUserId) return;
      useGameStore.getState().noteTyping(`dm:${data.conversationId}`, data.userId);
    });

    socket.on(SocketEvents.CHANNEL_CREATED, (channel: Channel) => {
      const state = useGameStore.getState();
      if (!state.channels.some((c) => c.id === channel.id)) {
        state.setChannels([...state.channels, channel]);
      }
    });

    socket.on(SocketEvents.DM_STARTED, (data: DirectConversationStarted) => {
      const localUid = useGameStore.getState().localUserId;
      if (data.userA.id !== localUid && data.userB.id !== localUid) return;
      const otherUser = data.userA.id === localUid ? data.userB : data.userA;
      const state = useGameStore.getState();
      if (!state.dmConversations.some((c) => c.id === data.id)) {
        state.setDmConversations([{ id: data.id, roomId: data.roomId, otherUser, createdAt: data.createdAt }, ...state.dmConversations]);
      }
    });

    socket.on(SocketEvents.CHANNEL_DELETED, (data: { channelId: string }) => {
      const state = useGameStore.getState();
      state.setChannels(state.channels.filter((c) => c.id !== data.channelId));
      if (state.activeChatTarget?.type === 'channel' && state.activeChatTarget.id === data.channelId) {
        const fallback = state.channels.find((c) => c.isDefault) ?? state.channels[0];
        state.setActiveChatTarget(fallback ? { type: 'channel', id: fallback.id } : null);
      }
    });

    socket.on(SocketEvents.CHAT_BUBBLE, (data: { playerId: string; text: string }) => {
      setSpeechBubble(data.playerId, {
        playerId: data.playerId,
        text: data.text,
        expireAt: Date.now() + 4000,
      });
    });

    socket.on(SocketEvents.EMOTE_PLAY, (event: EmoteEvent) => {
      addEmote(event);
    });

    socket.on(SocketEvents.PLAYER_JUMP, (event: JumpEvent) => {
      useGameStore.getState().triggerJump(event.playerId, event.timestamp);
    });

    socket.on(SocketEvents.PLAYER_NUDGE, (event: NudgeEvent) => {
      const state = useGameStore.getState();
      // Personal mute (services/mutedUsers.ts) — a muted person's nudges
      // are suppressed entirely on MY client, whether or not I'm the
      // target; they have no way to tell, nothing changes for anyone else.
      const nudgerUserId = state.playerRecords[event.fromId]?.userId;
      if (nudgerUserId && state.mutedUserIds.has(nudgerUserId)) return;
      state.triggerNudge(event.targetId, event.timestamp, event.fromId);
      const isMe = event.targetId === state.localPlayerId;
      // Everyone in the room hears an ambient blip (so a nudge nearby is
      // audible); the actual target hears a stronger, doubled version so it
      // clearly reads as "someone poked YOU", not just ambient noise. Both
      // respect the user's sound setting (see playNudgeSound).
      // A3 — Focus/DND: a nudge is pure real-time disruption (nothing to read
      // later), so mute its sound + toast + OS notification entirely.
      if (state.workMode !== 'focus') {
        if (state.isNotifKindEnabled('nudge')) playNudgeSound(isMe);
        if (isMe) {
          const nudgerName = state.playerRecords[event.fromId]?.name ?? 'Seseorang';
          // In-app toast — shows even while the tab is focused, which the
          // OS-level notification below deliberately does not (it only fires
          // when the tab is in the background, to avoid double-pinging someone
          // already looking at the screen).
          state.setNudgedBy(nudgerName);
          // A single toast/native popup was easy to miss entirely, so one
          // nudge now lands as a short burst instead of a one-shot alert —
          // each pulse still respects the visible-tab/hidden-tab split
          // inside notifyNudge itself (toast vs. native+tab-flash).
          if (state.isNotifKindEnabled('nudge')) {
            const NUDGE_BURST_COUNT = 3;
            const NUDGE_BURST_INTERVAL_MS = 450;
            for (let i = 0; i < NUDGE_BURST_COUNT; i++) {
              setTimeout(() => notifyNudge(nudgerName), i * NUDGE_BURST_INTERVAL_MS);
            }
          }
        }
      }
    });

    // A10 — Slap ("colek") received. The server already enforced Focus/DND +
    // cooldown, so just play the effect: vibrate, soft sound, shake own avatar
    // (reusing the nudge machinery), and a dedicated toast.
    socket.on(SocketEvents.SLAPPED, (data: { fromName: string; fromId?: string }) => {
      const state = useGameStore.getState();
      // Personal mute — same suppression as PLAYER_NUDGE above.
      const slapperUserId = data.fromId ? state.playerRecords[data.fromId]?.userId : undefined;
      if (slapperUserId && state.mutedUserIds.has(slapperUserId)) return;
      navigator.vibrate?.(200);
      if (state.isNotifKindEnabled('slap')) playSlapSound(true);
      if (state.localPlayerId) state.triggerNudge(state.localPlayerId, Date.now(), data.fromId);
      state.setSlappedBy(data.fromName || 'Seseorang');
    });

    // A10 — local confirmation for the SENDER only, mirroring the receiver's
    // sound so a slap is audible on exactly 2 devices (sender + target) and
    // nowhere else in the room.
    socket.on(SocketEvents.SLAP_SENT, () => {
      if (useGameStore.getState().isNotifKindEnabled('slap')) playSlapSound(false);
    });

    // Bug 14 — someone in my zone raised their hand. Server already scoped this
    // to the zone + applied a per-sender cooldown, so just play the polite
    // chime. A3 — Focus/DND mutes the SOUND only; the ✋ badge still updates via
    // PLAYER_HAND_UPDATED above, so a focused user can still see it.
    socket.on(SocketEvents.HAND_RAISED_ALERT, () => {
      const state = useGameStore.getState();
      if (state.workMode !== 'focus' && state.isNotifKindEnabled('handRaise')) playHandRaiseSound();
    });

    socket.on(SocketEvents.ROOM_UPDATED, (data: RoomUpdatePayload) => {
      const tiles = data.tiles.map((row, y) =>
        row.map((t, x) => ({ ...t, x, y, type: t.type as any }))
      );
      setTilesFromData(tiles);
      setFurniture(data.furniture || []);
      setZones(data.zones || []);
      // Item #9 (precise-collision follow-up) — only applied when present:
      // the legacy socket ROOM_UPDATE save path never includes this field at
      // all (see RoomUpdatePayload's doc comment), and treating its absence
      // as "clear the rects" would wipe a client's already-known Impassable
      // Areas the instant anyone saved through that older path.
      if (data.impassableAreaRects) useGameStore.getState().setImpassableAreaRects(data.impassableAreaRects);
      if (data.wallAreaRects) useGameStore.getState().setWallAreaRects(data.wallAreaRects);
      if (data.doorAreaRects) useGameStore.getState().setDoorAreaRects(data.doorAreaRects);
    });

    socket.on(SocketEvents.ADMIN_CHANGED, (data: { adminUserIds: string[]; masterAdminUserId: string; staffUserIds?: string[]; ceoUserIds?: string[] }) => {
      console.log('[socket] admin:changed —', data.adminUserIds.length, 'admins,', (data.staffUserIds ?? []).length, 'staff,', (data.ceoUserIds ?? []).length, 'ceo, master:', data.masterAdminUserId);
      applyAdminChanged(data);
    });

    socket.on('admin:error', (data: { message: string }) => {
      console.warn('[socket] admin error:', data.message);
      useGameStore.getState().setAdminErrorMessage(data.message);
    });

    socket.on(SocketEvents.ROOM_DELETED, (data: { roomId: string }) => {
      console.warn('[socket] room deleted by owner:', data.roomId);
      // Game watches roomDeletedNotice and navigates back to the Lobby via
      // React state — no alert()/reload(), so there's no multi-second
      // window where the player is just stuck looking at a stale canvas.
      useGameStore.getState().setRoomDeletedNotice('This room has been deleted by the owner.');
    });

    socket.on(SocketEvents.PLAYER_KICKED, (data: { byName: string }) => {
      console.warn('[socket] kicked from room by', data.byName);
      // Same "show a notice, then navigate back to the Lobby" pattern as
      // roomDeletedNotice above — the server already ran handleLeave's
      // cleanup for us before sending this, so there's nothing left to do
      // here but inform the player and get them out.
      useGameStore.getState().setKickedNotice(`You were removed from this room by ${data.byName}.`);
    });

    // "Ngobrol dengan CEO" queue (see server/src/lib/roomQueue.ts) — this
    // user's timed slot ran out and the sweep already force-removed them via
    // the same handleLeave cleanup PLAYER_KICKED uses; reuses kickedNotice's
    // own "show it, then leave" UI rather than a whole new notice slot for
    // what is, from this screen's point of view, the same event.
    socket.on(SocketEvents.QUEUE_SESSION_ENDED, (data: { roomSlug: string; roomName: string }) => {
      console.warn('[socket] queue session ended in', data.roomSlug);
      useGameStore.getState().setKickedNotice('Waktu sesi ngobrolmu sudah habis.');
    });

    // QA (Moderasi checklist item 11, "Kick/mute admin") — this listener
    // itself only records the notice; the ACTUAL mute (flipping the local
    // mic track + re-broadcasting PLAYER_MIC so the badge updates for
    // everyone) happens in App.tsx's own effect, which is where
    // toggleMic/isMicMuted actually live (useWebRTC, a sibling hook this
    // one has no reference to) — see PLAYER_FORCE_MUTED's own doc comment
    // in shared/types for why the server can only ask, not act directly.
    socket.on(SocketEvents.PLAYER_FORCE_MUTED, (data: { byName: string }) => {
      console.warn('[socket] force-muted by', data.byName);
      useGameStore.getState().setForceMutedNotice(`Mic kamu dimatikan oleh ${data.byName}.`);
    });

    // QA items #9/#10 (multi-tab) — a NEWER tab/connection took over this
    // account (or guest token) and this specific socket was force-
    // disconnected server-side. Deliberately does NOT touch vm_token —
    // unlike SESSION_SUPERSEDED (a real new login elsewhere, which DOES
    // clear it), this tab's token is still perfectly valid; clearing it
    // here would also log the OTHER (winning) tab out, since localStorage
    // is shared across every tab of this origin.
    socket.on(SocketEvents.SESSION_TAKEN_OVER, () => {
      console.warn('[socket] session taken over by a newer tab/connection');
      useGameStore.getState().setSessionTakenOverNotice('Sesi ini diambil alih oleh tab atau perangkat lain.');
    });

    // Item #9 — emergency door override toggled by an admin; everyone in the
    // room (including the toggler) gets this so the banner + the admin's own
    // control stay in sync.
    socket.on(SocketEvents.DOOR_OVERRIDE_UPDATED, (data: { active: boolean }) => {
      useGameStore.getState().setDoorOverride(!!data.active);
      useGameStore.getState().addActivity(data.active ? '🚨 Semua pintu dibuka (mode darurat)' : '🔒 Mode darurat pintu dimatikan');
    });

    // QA (Load checklist item 1, "Concurrency tim penuh") — JOIN_ROOM's
    // other denial reasons ('needs-request'/'pending'/'rejected'/'error')
    // are already surfaced through the separate REST pre-check
    // (App.tsx's JoinGate, api.getMembership) before the socket even
    // connects — only 'room-full' has no equivalent pre-check (capacity can
    // only be known live, socket-side), so only that reason is handled
    // here. Without this, a full room fell through to the generic 12s
    // "can't reach server" timeout (see App.tsx's joinTimedOut) with a
    // misleading "check your internet" message instead of the real reason.
    socket.on(SocketEvents.JOIN_DENIED, (data: { roomSlug: string; reason: string }) => {
      if (data?.reason === 'room-full') {
        console.warn('[socket] join denied — room is full');
        useGameStore.getState().setRoomFullNotice('Room ini sudah penuh. Coba lagi nanti.');
      }
    });

    // Item #5 — a room-join request, popped up for every admin currently
    // connected to that room (server already filtered by role — see
    // roomMembers.ts's getConnectedAdminSocketIds — so anything arriving here
    // is safe to show without a client-side admin check).
    socket.on(SocketEvents.JOIN_REQUESTED, (payload: JoinRequestPopupPayload) => {
      useGameStore.getState().addIncomingJoinRequest(payload);
    });

    // "Ngobrol dengan CEO" queue, zone-level — same "server already
    // filtered by role" posture as JOIN_REQUESTED above.
    socket.on(SocketEvents.ZONE_QUEUE_REQUESTED, (payload: ZoneQueueRequestedPayload) => {
      useGameStore.getState().addIncomingQueueRequest(payload);
    });

    // "Ngobrol dengan CEO" queue, zone-level — broadcast to the WHOLE room
    // (not just the ticket holder), so every client can render the floating
    // countdown badge above the right avatar, self or otherwise (e.g. the
    // CEO's own avatar, from every other player's point of view).
    socket.on(SocketEvents.ZONE_QUEUE_SESSION_ACTIVE, (payload: ZoneQueueSessionActivePayload) => {
      useGameStore.getState().upsertActiveZoneSession(payload);
    });
    socket.on(SocketEvents.ZONE_QUEUE_SESSION_CLEARED, (payload: ZoneQueueSessionClearedPayload) => {
      useGameStore.getState().clearActiveZoneSessionByZone(payload.zoneId);
    });

    // A decision was made — via the manual queue panel, or another admin's
    // popup — so this popup (if still showing) is stale. userId + roomSlug
    // scoped: other pending requests for this room must stay untouched.
    socket.on(SocketEvents.JOIN_QUEUE_CHANGED, (payload: { roomId: string; userId?: string; roomSlug?: string }) => {
      if (payload.userId && payload.roomSlug) {
        useGameStore.getState().removeIncomingJoinRequest(payload.userId, payload.roomSlug);
      }
    });

    // Guest Link & Ruang Tunggu — this socket's OWN JOIN_ROOM landed it in
    // the waiting room (see roomHandler.ts's guest branch).
    socket.on(SocketEvents.GUEST_JOIN_WAITING, () => {
      useGameStore.getState().setGuestWaitState('waiting');
    });

    // An admin admitted this guest — retry the exact same JOIN_ROOM; this
    // time the server finds it on guestAllowlist and lets it fall through
    // to a normal join.
    socket.on(SocketEvents.GUEST_JOIN_ADMITTED, () => {
      console.log('[socket] guest admitted — rejoining');
      const config = loadAvatarConfig();
      socket.emit(SocketEvents.JOIN_ROOM, roomSlug, authUserName, config, authUserId);
      useGameStore.getState().setGuestWaitState('admitted');
    });

    socket.on(SocketEvents.GUEST_JOIN_REJECTED, () => {
      useGameStore.getState().setGuestWaitState('rejected');
    });

    // Admin side — a guest is waiting for a decision. Fans out to every
    // admin socket currently connected to the room (server-side), so
    // anything arriving here is already safe to show without a further
    // client-side admin check (same posture as JOIN_REQUESTED above).
    socket.on(SocketEvents.GUEST_JOIN_REQUESTED, (payload: GuestJoinRequest) => {
      useGameStore.getState().addPendingGuest(payload);
    });

    // The guest left/disconnected before a decision was made — drop it from
    // the admin's pending list.
    socket.on(SocketEvents.GUEST_JOIN_CANCELLED, (payload: { guestId: string }) => {
      useGameStore.getState().removePendingGuest(payload.guestId);
    });

    socket.on(SocketEvents.NOTICE_UPDATED, (notice: Notice | null) => {
      setNotice(notice);
      if (notice) useGameStore.getState().addActivity(`${notice.pinnedByName} pinned a notice`);
    });

    socket.on(SocketEvents.FOLLOW_UPDATED, (info: FollowInfo | null) => {
      setFollowInfo(info);
    });

    socket.on(SocketEvents.FOLLOWER_CHANGED, (data: FollowerChangedPayload) => {
      const localUid = useGameStore.getState().localUserId;
      if (data.targetUserId === localUid) setFollowerUserIds(data.followerUserIds);
    });

    socket.on('connect_error', (err) => {
      console.error('[socket] connect_error:', err.message, '| full error:', err);
      setConnected(false);
      // Bug 1 — the handshake was rejected because a newer login superseded
      // this session. Route it through the same global handler as the REST path.
      if (err?.message === 'SESSION_SUPERSEDED') {
        window.dispatchEvent(new CustomEvent('vm-session-superseded', { detail: 'Akun ini baru saja login di perangkat lain. Sesi ini telah berakhir.' }));
      }
      // QA (Akses tamu checklist item 7, "Revoke") — the handshake itself was
      // rejected because this guest's link was revoked (e.g. they reloaded
      // after already being kicked, or their tab never even got the live-kick
      // event). Reuses kickedNotice — same "show a message, then onLeave()"
      // effect in App.tsx that the live-kick GUEST_LINK_REVOKED event below
      // triggers, so both paths converge on identical behavior.
      if (err?.message === 'GUEST_LINK_REVOKED') {
        useGameStore.getState().setKickedNotice('Akses tamu ini sudah dicabut oleh admin.');
      }
    });

    // Bug 1 — server-initiated kick when a NEW login supersedes this live
    // socket (emitted just before the forced disconnect, see lib/sessionKick).
    socket.on('SESSION_SUPERSEDED', (d: { message?: string }) => {
      window.dispatchEvent(new CustomEvent('vm-session-superseded', { detail: d?.message }));
    });

    // QA (Akses tamu checklist item 7, "Revoke") — this guest's session is
    // still live (transport connected) but the admin just revoked the link
    // they came in on. Sent only to this socket (see roomHandler.ts's
    // kickRevokedGuestSocket) — same "reuse kickedNotice" shape as the
    // PLAYER_KICKED listener above, so the same App.tsx effect shows it
    // and then calls onLeave() (handleGuestLeave for a guest — clears the
    // stored token and reloads to a clean slate, there's no Lobby to
    // fall back to).
    socket.on('GUEST_LINK_REVOKED', (d: { message?: string }) => {
      useGameStore.getState().setKickedNotice(d?.message || 'Akses tamu ini sudah dicabut oleh admin.');
    });

    // All listeners attached — safe to connect now
    socket.connect();

    return () => {
      // QA (LiveKit checklist item 11, "Buat/join/leave bersih; tak ada
      // hantu") — this cleanup fires on every INTENTIONAL leave (back to
      // Lobby, portal travel remounting Game with a new roomSlug, logout —
      // anything that's a real React unmount/dep-change, as opposed to a
      // hard network drop/tab close, which never runs cleanup at all and
      // correctly still falls through to the disconnect+grace-period path
      // below). Before this fix, EVERY leave — deliberate or not — went
      // through bare socket.disconnect(), which server-side always takes
      // roomHandler.ts's graced path (RECONNECT_GRACE_MS = 4s) rather than
      // the immediate one LEAVE_ROOM triggers — so even clicking "back to
      // lobby" left your avatar and everyone's live WebRTC connection to
      // you lingering for up to ~4.5s after you'd already torn everything
      // down locally. Emitting this first (synchronous, before disconnect())
      // lets socket.io flush it over the still-open connection — same
      // "notify then disconnect" ordering used by SocketEvents.PLAYER_KICK
      // server-side. Safe to call even when the server already ran
      // handleLeave for this socket via another path (kick, room deleted,
      // session superseded) — the server's own LEAVE_ROOM handler no-ops
      // once `currentRoom` is already null.
      if (socket.connected) socket.emit(SocketEvents.LEAVE_ROOM);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [authUserName, roomSlug, authUserId, guestToken]);

  const emitMove = useCallback(
    (x: number, y: number, direction: string, isRunning?: boolean) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) return;

      const now = Date.now();
      if (now - lastEmitRef.current < 50) return;
      lastEmitRef.current = now;
      const seq = ++moveSeqRef.current;

      socket.volatile.emit(SocketEvents.PLAYER_MOVE, { x, y, direction, isRunning, seq });
    },
    [],
  );

  const emitStop = useCallback(
    (x: number, y: number, direction: string) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) return;
      socket.emit(SocketEvents.PLAYER_STOP, { x, y, direction });
    },
    [],
  );

  const emitAvatarUpdate = useCallback(
    (config: AvatarConfig) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) return;
      socket.emit(SocketEvents.AVATAR_UPDATE, config);
    },
    [],
  );

  const emitWorkMode = useCallback((mode: WorkMode, zoneId?: string, reason?: string) => {
    socketRef.current?.emit(SocketEvents.WORK_MODE_CHANGE, { mode, zoneId, reason });
  }, []);

  const emitSpotlight = useCallback((targetUserId: string, active: boolean) => {
    socketRef.current?.emit(SocketEvents.SPOTLIGHT_TOGGLE, { targetUserId, active });
  }, []);

  const emitBroadcastSend = useCallback((text: string) => {
    socketRef.current?.emit(SocketEvents.BROADCAST_SEND, { text });
  }, []);

  // A4 — free double-click teleport. Server validates + re-broadcasts as
  // PLAYER_TELEPORTED so everyone snaps.
  const emitTeleportTo = useCallback((x: number, y: number, direction: Avatar['direction']) => {
    socketRef.current?.emit(SocketEvents.PLAYER_TELEPORT_TO, { x, y, direction });
  }, []);

  const emitPlayerHand = useCallback((raised: boolean) => {
    socketRef.current?.emit(SocketEvents.PLAYER_HAND, raised);
  }, []);

  const emitPlayerMic = useCallback((muted: boolean) => {
    socketRef.current?.emit(SocketEvents.PLAYER_MIC, muted);
  }, []);

  const emitPlayerHidden = useCallback((hidden: boolean) => {
    socketRef.current?.emit(SocketEvents.PLAYER_HIDDEN, hidden);
  }, []);

  const emitSit = useCallback((sitting: boolean, x: number, y: number, direction: Avatar['direction'], seatFurnitureId?: string) => {
    socketRef.current?.emit(SocketEvents.PLAYER_SIT, { sitting, x, y, direction, seatFurnitureId });
  }, []);

  const emitFurnitureAssign = useCallback((furnitureId: string, name: string) => {
    socketRef.current?.emit(SocketEvents.FURNITURE_ASSIGN, { furnitureId, name });
  }, []);

  const emitFurnitureUnassign = useCallback((furnitureId: string) => {
    socketRef.current?.emit(SocketEvents.FURNITURE_UNASSIGN, { furnitureId });
  }, []);

  const emitNoteAdd = useCallback((x: number, y: number, text: string) => {
    socketRef.current?.emit(SocketEvents.NOTE_ADD, { x, y, text });
  }, []);

  const emitNoteEdit = useCallback((id: string, text: string) => {
    socketRef.current?.emit(SocketEvents.NOTE_EDIT, { id, text });
  }, []);

  const emitNoteDelete = useCallback((id: string) => {
    socketRef.current?.emit(SocketEvents.NOTE_DELETE, { id });
  }, []);

  // QA (Presence checklist item #8, "Member list akurat") — one-time roster
  // snapshot request, fired when MemberListPanel opens (see its own effect).
  const emitRosterListRequest = useCallback(() => {
    socketRef.current?.emit(SocketEvents.ROSTER_LIST_REQUEST);
  }, []);

  const emitClaimSeat = useCallback((seatId: string) => {
    socketRef.current?.emit(SocketEvents.CLAIM_SEAT, { seatId });
  }, []);

  const emitReleaseSeat = useCallback((seatId: string) => {
    socketRef.current?.emit(SocketEvents.RELEASE_SEAT, { seatId });
  }, []);

  // Asking the current OWNER for a seat instead of letting CLAIM_SEAT
  // silently redirect to the nearest free desk — see seatClaim.ts's
  // SEAT_CLAIM_REQUEST handler. GameCanvas.tsx sets pendingSeatClaimRequest
  // locally right after calling this, same optimistic-local-state
  // convention as useZoneLock.ts's knock().
  const emitSeatClaimRequest = useCallback((seatId: string) => {
    socketRef.current?.emit(SocketEvents.SEAT_CLAIM_REQUEST, { seatId });
  }, []);

  const emitSeatClaimDecide = useCallback((seatId: string, playerId: string, approve: boolean) => {
    socketRef.current?.emit(SocketEvents.SEAT_CLAIM_DECIDE, { seatId, playerId, approve });
  }, []);

  const emitSeatClaimRequestCancel = useCallback((seatId: string) => {
    socketRef.current?.emit(SocketEvents.SEAT_CLAIM_REQUEST_CANCEL, { seatId });
  }, []);

  // Fitur 15B — Password prompt. The attempt travels to the server for
  // comparison; the reply lands via INTERACTIVE_PASSWORD_RESULT below.
  const emitInteractivePasswordCheck = useCallback((furnitureId: string, attempt: string) => {
    socketRef.current?.emit(SocketEvents.INTERACTIVE_PASSWORD_CHECK, { furnitureId, attempt });
  }, []);

  // Fitur 15B — Multiple choice pop-up, same request/reply shape as password
  // above (the reply lands via INTERACTIVE_CHOICE_RESULT below).
  const emitInteractiveChoiceCheck = useCallback((furnitureId: string, selectedIndex: number) => {
    socketRef.current?.emit(SocketEvents.INTERACTIVE_CHOICE_CHECK, { furnitureId, selectedIndex });
  }, []);

  // ZEP-style door password, same shape as the furniture password check
  // above but keyed by tile (x,y) — the reply lands via
  // INTERACTIVE_DOOR_PASSWORD_RESULT above.
  const emitInteractiveDoorPasswordCheck = useCallback((x: number, y: number, attempt: string) => {
    socketRef.current?.emit(SocketEvents.INTERACTIVE_DOOR_PASSWORD_CHECK, { x, y, attempt });
  }, []);

  // "Door Area" — area-id counterpart, reply via INTERACTIVE_DOOR_AREA_PASSWORD_RESULT above.
  const emitInteractiveDoorAreaPasswordCheck = useCallback((areaId: string, attempt: string) => {
    socketRef.current?.emit(SocketEvents.INTERACTIVE_DOOR_AREA_PASSWORD_CHECK, { areaId, attempt });
  }, []);

  // Fitur 15B — API call. No local result state needed (unlike password/
  // choice, this has no modal to feed) — the result listener below just
  // posts straight to the activity feed as a one-off toast.
  const emitInteractiveApiCall = useCallback((furnitureId: string) => {
    socketRef.current?.emit(SocketEvents.INTERACTIVE_API_CALL, { furnitureId });
  }, []);

  // Fitur 15B — Change object. No reply event to listen for — the piece
  // disappearing from the next ROOM_UPDATED (already handled elsewhere) is
  // the only feedback there is, same for every client in the room at once.
  const emitInteractiveChangeObject = useCallback((furnitureId: string) => {
    socketRef.current?.emit(SocketEvents.INTERACTIVE_CHANGE_OBJECT, { furnitureId });
  }, []);

  const emitChat = useCallback((text: string, isProximity?: boolean, zoneId?: string, attachmentUrl?: string, attachmentName?: string) => {
    socketRef.current?.emit(SocketEvents.CHAT_MESSAGE, text, isProximity, zoneId, attachmentUrl, attachmentName);
  }, []);

  const emitChannelJoin = useCallback((channelId: string) => {
    socketRef.current?.emit(SocketEvents.CHANNEL_JOIN, channelId);
  }, []);

  const emitChannelLeave = useCallback((channelId: string) => {
    socketRef.current?.emit(SocketEvents.CHANNEL_LEAVE, channelId);
  }, []);

  const emitChannelMessageSend = useCallback((channelId: string, text: string, parentId?: string, attachmentUrl?: string, attachmentName?: string, clientId?: string) => {
    socketRef.current?.emit(SocketEvents.CHANNEL_MESSAGE_SEND, { channelId, text, parentId, attachmentUrl, attachmentName, clientId });
  }, []);

  const emitDmJoin = useCallback((conversationId: string) => {
    socketRef.current?.emit(SocketEvents.DM_JOIN, conversationId);
  }, []);

  const emitDmLeave = useCallback((conversationId: string) => {
    socketRef.current?.emit(SocketEvents.DM_LEAVE, conversationId);
  }, []);

  const emitDmMessageSend = useCallback((conversationId: string, text: string, parentId?: string, attachmentUrl?: string, attachmentName?: string, clientId?: string) => {
    socketRef.current?.emit(SocketEvents.DM_MESSAGE_SEND, { conversationId, text, parentId, attachmentUrl, attachmentName, clientId });
  }, []);

  const emitDeleteMessage = useCallback((messageId: string) => {
    socketRef.current?.emit(SocketEvents.MESSAGE_DELETE, { messageId });
  }, []);

  const emitEditMessage = useCallback((messageId: string, text: string) => {
    socketRef.current?.emit(SocketEvents.MESSAGE_EDIT, { messageId, text });
  }, []);

  const emitPinMessage = useCallback((messageId: string, pinned: boolean) => {
    socketRef.current?.emit(SocketEvents.MESSAGE_PIN, { messageId, pinned });
  }, []);

  const emitMarkRead = useCallback((target: { type: 'channel' | 'dm'; id: string }) => {
    socketRef.current?.emit(SocketEvents.CHAT_MARK_READ, target.type === 'channel' ? { channelId: target.id } : { conversationId: target.id });
  }, []);

  const emitChannelTyping = useCallback((channelId: string) => {
    socketRef.current?.emit(SocketEvents.CHANNEL_TYPING, channelId);
  }, []);

  const emitDmTyping = useCallback((conversationId: string) => {
    socketRef.current?.emit(SocketEvents.DM_TYPING, conversationId);
  }, []);

  const emitBubble = useCallback((text: string) => {
    socketRef.current?.emit(SocketEvents.CHAT_BUBBLE, text);
  }, []);

  const emitEmote = useCallback((emote: string, x: number, y: number) => {
    socketRef.current?.emit(SocketEvents.EMOTE_PLAY, { emote, x, y });
  }, []);

  const emitJump = useCallback(() => {
    socketRef.current?.emit(SocketEvents.PLAYER_JUMP);
  }, []);

  const emitNudge = useCallback((targetId: string) => {
    socketRef.current?.emit(SocketEvents.PLAYER_NUDGE, { targetId });
  }, []);

  const emitZoneEnter = useCallback((zoneId: string) => {
    socketRef.current?.emit(SocketEvents.ZONE_ENTER, zoneId);
  }, []);

  const emitZoneExit = useCallback((zoneId: string) => {
    socketRef.current?.emit(SocketEvents.ZONE_EXIT, zoneId);
  }, []);

  const emitRoomUpdate = useCallback((payload: RoomUpdatePayload) => {
    socketRef.current?.emit(SocketEvents.ROOM_UPDATE, payload);
  }, []);

  const emitAdminGrant = useCallback((targetUserId: string) => {
    console.log('[socket] emit admin:grant →', targetUserId);
    socketRef.current?.emit(SocketEvents.ADMIN_GRANT, { targetUserId });
  }, []);

  const emitAdminRevoke = useCallback((targetUserId: string) => {
    console.log('[socket] emit admin:revoke →', targetUserId);
    socketRef.current?.emit(SocketEvents.ADMIN_REVOKE, { targetUserId });
  }, []);

  const emitStaffGrant = useCallback((targetUserId: string) => {
    socketRef.current?.emit(SocketEvents.STAFF_GRANT, { targetUserId });
  }, []);

  const emitStaffRevoke = useCallback((targetUserId: string) => {
    socketRef.current?.emit(SocketEvents.STAFF_REVOKE, { targetUserId });
  }, []);

  const emitCeoGrant = useCallback((targetUserId: string) => {
    socketRef.current?.emit(SocketEvents.CEO_GRANT, { targetUserId });
  }, []);

  const emitCeoRevoke = useCallback((targetUserId: string) => {
    socketRef.current?.emit(SocketEvents.CEO_REVOKE, { targetUserId });
  }, []);

  const emitRoomDelete = useCallback(() => {
    socketRef.current?.emit(SocketEvents.ROOM_DELETE);
  }, []);

  const emitKick = useCallback((targetUserId: string) => {
    console.log('[socket] emit player:kick →', targetUserId);
    socketRef.current?.emit(SocketEvents.PLAYER_KICK, { targetUserId });
  }, []);

  const emitForceMute = useCallback((targetUserId: string) => {
    console.log('[socket] emit player:force_mute →', targetUserId);
    socketRef.current?.emit(SocketEvents.PLAYER_FORCE_MUTE, { targetUserId });
  }, []);

  const emitDoorOverride = useCallback((active: boolean) => {
    socketRef.current?.emit(SocketEvents.DOOR_OVERRIDE_SET, { active });
  }, []);

  const emitGuestJoinDecide = useCallback((guestId: string, admit: boolean) => {
    socketRef.current?.emit(SocketEvents.GUEST_JOIN_DECIDE, { guestId, admit });
  }, []);

  const emitNoticePin = useCallback((messageId: string, text: string, senderName: string) => {
    socketRef.current?.emit(SocketEvents.NOTICE_PIN, { messageId, text, senderName });
  }, []);

  const emitNoticeUnpin = useCallback(() => {
    socketRef.current?.emit(SocketEvents.NOTICE_UNPIN);
  }, []);

  const emitFollowRequest = useCallback((targetUserId: string) => {
    socketRef.current?.emit(SocketEvents.FOLLOW_REQUEST, { targetUserId });
  }, []);

  const emitTeleportRequest = useCallback((request: TeleportRequest) => {
    socketRef.current?.emit(SocketEvents.TELEPORT_REQUEST, request);
  }, []);

  const emitSummonUser = useCallback((nickname: string) => {
    socketRef.current?.emit(SocketEvents.SUMMON_USER, { nickname });
  }, []);

  // "Tarik Paksa" (Force-pull) — by uid (like Kick), not nickname.
  const emitForcePull = useCallback((targetUserId: string) => {
    socketRef.current?.emit(SocketEvents.FORCE_PULL, { targetUserId });
  }, []);

  // A10 — "colek" a participant (by nickname, like summon).
  const emitSlap = useCallback((nickname: string) => {
    socketRef.current?.emit(SocketEvents.SLAP, { nickname });
  }, []);

  // Soundboard — the server never echoes SOUNDBOARD_PLAYED back to its own
  // sender (see getNearbyRecipients, which excludes senderSocketId), so the
  // sender's own audio + indicator is played optimistically here, right on
  // click — same "local confirmation, independent of the round trip" pattern
  // as SLAP_SENT/raise-hand's own chime.
  const emitSoundboardPlay = useCallback((soundId: string) => {
    socketRef.current?.emit(SocketEvents.SOUNDBOARD_PLAY, { soundId });
    const sound = resolveSoundboardSound(soundId);
    if (!sound) return;
    const state = useGameStore.getState();
    playSoundboardClip(state.localPlayerId, sound.url);
    state.triggerSoundboardPlaying(state.localPlayerId, Date.now() + Math.max(sound.durationMs, 800));
  }, []);

  const emitSummonRespond = useCallback((requestId: string, accept: boolean) => {
    socketRef.current?.emit(SocketEvents.SUMMON_RESPOND, { requestId, accept });
  }, []);

  const emitFollowRespond = useCallback((requestId: string, accept: boolean) => {
    socketRef.current?.emit(SocketEvents.FOLLOW_RESPOND, { requestId, accept });
  }, []);

  const emitRemoteHelpRequest = useCallback((targetUserId: string) => {
    socketRef.current?.emit(SocketEvents.REMOTE_HELP_REQUEST, { targetUserId });
  }, []);

  const emitRemoteHelpRespond = useCallback((requestId: string, accept: boolean) => {
    socketRef.current?.emit(SocketEvents.REMOTE_HELP_RESPOND, { requestId, accept });
  }, []);

  const emitRemoteHelpCredential = useCallback((rustdeskId: string, password: string) => {
    socketRef.current?.emit(SocketEvents.REMOTE_HELP_CREDENTIAL, { rustdeskId, password });
  }, []);

  const emitRemoteHelpEnd = useCallback(() => {
    socketRef.current?.emit(SocketEvents.REMOTE_HELP_END);
  }, []);

  const emitFollowUnfollow = useCallback(() => {
    socketRef.current?.emit(SocketEvents.FOLLOW_UNFOLLOW);
  }, []);

  const emitMediaAdd = useCallback((type: MediaType, x: number, y: number, payload?: MediaPayload) => {
    socketRef.current?.emit(SocketEvents.MEDIA_ADD, { type, x, y, payload });
  }, []);

  const emitMediaRemove = useCallback((id: string) => {
    socketRef.current?.emit(SocketEvents.MEDIA_REMOVE, { id });
  }, []);

  const emitWhiteboardStroke = useCallback((mediaId: string, stroke: WhiteboardStroke) => {
    socketRef.current?.emit(SocketEvents.WHITEBOARD_STROKE, { mediaId, stroke });
  }, []);

  const emitWhiteboardClear = useCallback((mediaId: string) => {
    socketRef.current?.emit(SocketEvents.WHITEBOARD_CLEAR, { mediaId });
  }, []);

  const emitRecordingStart = useCallback((targetUserId: string, title: string) => {
    socketRef.current?.emit(SocketEvents.RECORDING_START, { targetUserId, title });
  }, []);

  const emitRecordingStop = useCallback((recordingId: string) => {
    socketRef.current?.emit(SocketEvents.RECORDING_STOP, { recordingId });
  }, []);

  const emitRecordingFinalize = useCallback((recordingId: string, fileUrl: string | null) => {
    socketRef.current?.emit(SocketEvents.RECORDING_FINALIZE, { recordingId, fileUrl });
  }, []);

  return { emitMove, emitStop, emitAvatarUpdate, emitWorkMode, emitTeleportTo, emitPlayerHand, emitPlayerMic, emitPlayerHidden, emitSit, emitFurnitureAssign, emitFurnitureUnassign, emitNoteAdd, emitNoteEdit, emitNoteDelete, emitRosterListRequest, emitClaimSeat, emitReleaseSeat, emitSeatClaimRequest, emitSeatClaimDecide, emitSeatClaimRequestCancel, socketRef, emitChat, emitBubble, emitEmote, emitJump, emitNudge, emitZoneEnter, emitZoneExit, emitRoomUpdate, emitAdminGrant, emitAdminRevoke, emitStaffGrant, emitStaffRevoke, emitCeoGrant, emitCeoRevoke, emitRoomDelete, emitKick, emitForceMute, emitDoorOverride, emitGuestJoinDecide, emitNoticePin, emitNoticeUnpin, emitFollowRequest, emitFollowRespond, emitFollowUnfollow, emitRemoteHelpRequest, emitRemoteHelpRespond, emitRemoteHelpCredential, emitRemoteHelpEnd, emitTeleportRequest, emitSummonUser, emitSummonRespond, emitForcePull, emitSlap, emitMediaAdd, emitMediaRemove, emitWhiteboardStroke, emitWhiteboardClear, emitRecordingStart, emitRecordingStop, emitRecordingFinalize, emitChannelJoin, emitChannelLeave, emitChannelMessageSend, emitDmJoin, emitDmLeave, emitDmMessageSend, emitChannelTyping, emitDmTyping, emitDeleteMessage, emitEditMessage, emitPinMessage, emitMarkRead, emitInteractivePasswordCheck, emitInteractiveChoiceCheck, emitInteractiveApiCall, emitInteractiveChangeObject, emitInteractiveDoorPasswordCheck, emitInteractiveDoorAreaPasswordCheck, emitSoundboardPlay, emitSpotlight, emitBroadcastSend };
}
