import { useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { SocketEvents, Avatar, AvatarConfig, ChatMessage, EmoteEvent, JumpEvent, NudgeEvent, RoomUpdatePayload, Notice, FollowInfo, FollowerChangedPayload, TeleportRequest, FollowRequestPayload, FollowResultPayload, SummonRequestPayload, SummonResultPayload, MediaType, MediaPayload, MapMediaObject, WhiteboardStroke, Channel, ChannelMessage, DirectConversationStarted, TILE_SIZE, findAdjacentFreeTile, WorkMode, InteractivePasswordResultPayload } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { loadAvatarConfig } from '@/hooks/useAvatarConfig';
import { notifyNewMessage, notifyNudge } from '@/services/browserNotifications';
import { playNudgeSound, playHandRaiseSound } from '@/services/soundEffects';
import { SERVER_URL } from '@/services/serverUrl';
import { registerCustomAssets } from '@/data/customAssets';

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

export function useSocket(authUserName: string = '', roomSlug: string = 'main-office', authUserId: string = '') {
  const socketRef = useRef<Socket | null>(null);
  const lastEmitRef = useRef<number>(0);

  const setConnected = useGameStore((s) => s.setConnected);
  const setLocalPlayerId = useGameStore((s) => s.setLocalPlayerId);
  const setRoomState = useGameStore((s) => s.setRoomState);
  const setLocalPlayer = useGameStore((s) => s.setLocalPlayer);
  const upsertPlayer = useGameStore((s) => s.upsertPlayer);
  const removePlayer = useGameStore((s) => s.removePlayer);
  const setPlayerTarget = useGameStore((s) => s.setPlayerTarget);
  const interpolatePlayers = useGameStore((s) => s.interpolatePlayers);
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

  useEffect(() => {
    const interval = setInterval(() => {
      interpolatePlayers();
    }, 16);
    return () => clearInterval(interval);
  }, [interpolatePlayers]);

  useEffect(() => {
    // Reset for this room-join attempt — see gameStore.ts's doc comment on
    // roomStateReceived for why Game.tsx gates the canvas on this instead
    // of just "roomState exists" (App.tsx seeds a hardcoded placeholder
    // room before any socket connection exists at all).
    useGameStore.getState().setRoomStateReceived(false);
    // Same reasoning for the Activity Feed — without this, portal travel or
    // leaving-and-rejoining a different room left the previous room's
    // events mixed in with the new room's own (see clearActivity's doc
    // comment in gameStore.ts).
    useGameStore.getState().clearActivity();

    // Connect directly to the game server — bypass Vite proxy entirely
    // to avoid WebSocket proxy ECONNABORTED issues. The JWT (if logged in)
    // lets the server verify our identity server-side instead of trusting
    // the userId we hand it in JOIN_ROOM below (see index.ts io.use()).
    const socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      autoConnect: false,
      auth: { token: localStorage.getItem('vm_token') || undefined },
    });
    socketRef.current = socket;

    socket.on(SocketEvents.CONNECT, () => {
      console.log('[socket] connected:', socket.id);
      setLocalPlayerId(socket.id!);
      setConnected(true);

      const config = loadAvatarConfig();
      const uid = authUserId || localStorage.getItem('vm_userId') || socket.id;
      const displayName = authUserName || config.name || 'Player';
      socket.emit(SocketEvents.JOIN_ROOM, roomSlug, displayName, config, uid);
    });

    socket.on(SocketEvents.DISCONNECT, (reason) => {
      console.warn('[socket] disconnected — reason:', reason);
      setConnected(false);
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

    socket.on(SocketEvents.PLAYER_MOVED, (data: { id: string; x: number; y: number; direction: string; isRunning?: boolean }) => {
      setPlayerTarget(data.id, data.x, data.y);
      upsertPlayer({
        id: data.id,
        direction: data.direction as Avatar['direction'],
        isMoving: true,
        isRunning: !!data.isRunning,
      } as Avatar);
    });

    socket.on(SocketEvents.PLAYER_STOPPED, (data: { id: string; direction: string }) => {
      upsertPlayer({
        id: data.id,
        direction: data.direction as Avatar['direction'],
        isMoving: false,
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
      console.log('[socket] avatar updated for:', data.id);
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) return;
      upsertPlayer({
        id: data.id,
        avatarConfig: data.avatarConfig,
        color: data.avatarConfig.color,
        name: data.avatarConfig.name,
      } as Avatar);
    });

    socket.on(SocketEvents.PLAYER_STATUS_UPDATED, (data: { id: string; status: string }) => {
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) return;
      upsertPlayer({ id: data.id, status: data.status || undefined } as Avatar);
    });

    socket.on(SocketEvents.PLAYER_HAND_UPDATED, (data: { id: string; handRaised: boolean }) => {
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) return;
      upsertPlayer({ id: data.id, handRaised: data.handRaised || undefined } as Avatar);
    });

    // A3 — another player's Focus/Public change; update their record so their
    // badge + proximity DND (useProximity) reflect it here.
    socket.on(SocketEvents.WORK_MODE_CHANGED, (data: { id: string; workMode: WorkMode }) => {
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) return;
      // 'available' → no badge (undefined); any other status keeps its value.
      upsertPlayer({ id: data.id, workMode: data.workMode === 'available' ? undefined : data.workMode } as Avatar);
    });

    // A5 — an official meeting started/ended in a zone; drives the join banner.
    socket.on(SocketEvents.MEETING_STARTED, (d: { momRecordId: string; zoneId: string; url: string; startedBy: string }) => {
      useGameStore.getState().setMeetingStarted(d.zoneId, { momRecordId: d.momRecordId, url: d.url, startedBy: d.startedBy });
    });
    socket.on(SocketEvents.MEETING_ENDED, (d: { zoneId: string }) => {
      useGameStore.getState().setMeetingEnded(d.zoneId);
    });

    socket.on(SocketEvents.PLAYER_SAT, (data: { id: string; isSitting: boolean; x: number; y: number; direction: Avatar['direction']; seatFurnitureId?: string }) => {
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) return;
      // seatFurnitureId carried through so this peer's table membership (and
      // chair occupancy) is known locally — undefined once they stand.
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
      // Clears any in-flight lerp target left over from a move right before
      // the teleport — otherwise interpolatePlayers would still nudge this
      // avatar toward the pre-teleport target for a frame or two.
      setPlayerTarget(data.id, data.x, data.y);
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

    // Fitur 15B — reply to MY OWN INTERACTIVE_PASSWORD_CHECK.
    socket.on(SocketEvents.INTERACTIVE_PASSWORD_RESULT, (data: InteractivePasswordResultPayload) => {
      useGameStore.getState().setInteractivePasswordResult(data);
    });

    // Follow, same consent shape as Summon above.
    socket.on(SocketEvents.FOLLOW_INCOMING, (data: FollowRequestPayload) => {
      useGameStore.getState().setIncomingFollowRequest(data);
    });

    socket.on(SocketEvents.FOLLOW_RESULT, (data: FollowResultPayload) => {
      useGameStore.getState().setFollowResult(data);
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

    socket.on(SocketEvents.FURNITURE_ASSIGNED, (data: { furnitureId: string; userId: string; name: string }) => {
      useGameStore.getState().setFurnitureAssignment(data.furnitureId, data.userId, data.name);
    });

    socket.on(SocketEvents.FURNITURE_UNASSIGNED, (data: { furnitureId: string }) => {
      useGameStore.getState().setFurnitureAssignment(data.furnitureId, undefined, undefined);
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
      if (msg.senderId !== useGameStore.getState().localPlayerId && useGameStore.getState().workMode !== 'focus') {
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
        if (state.workMode !== 'focus') notifyNewMessage(msg.senderName, msg.text);
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
        if (state.workMode !== 'focus') notifyNewMessage(msg.senderName, msg.text);
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
      state.triggerNudge(event.targetId, event.timestamp, event.fromId);
      const isMe = event.targetId === state.localPlayerId;
      // Everyone in the room hears an ambient blip (so a nudge nearby is
      // audible); the actual target hears a stronger, doubled version so it
      // clearly reads as "someone poked YOU", not just ambient noise. Both
      // respect the user's sound setting (see playNudgeSound).
      // A3 — Focus/DND: a nudge is pure real-time disruption (nothing to read
      // later), so mute its sound + toast + OS notification entirely.
      if (state.workMode !== 'focus') {
        playNudgeSound(isMe);
        if (isMe) {
          const nudgerName = state.playerRecords[event.fromId]?.name ?? 'Seseorang';
          // In-app toast — shows even while the tab is focused, which the
          // OS-level notification below deliberately does not (it only fires
          // when the tab is in the background, to avoid double-pinging someone
          // already looking at the screen).
          state.setNudgedBy(nudgerName);
          notifyNudge(nudgerName);
        }
      }
    });

    // A10 — Slap ("colek") received. The server already enforced Focus/DND +
    // cooldown, so just play the effect: vibrate, soft sound, shake own avatar
    // (reusing the nudge machinery), and a dedicated toast.
    socket.on(SocketEvents.SLAPPED, (data: { fromName: string; fromId?: string }) => {
      const state = useGameStore.getState();
      navigator.vibrate?.(200);
      playNudgeSound(true);
      if (state.localPlayerId) state.triggerNudge(state.localPlayerId, Date.now(), data.fromId);
      state.setSlappedBy(data.fromName || 'Seseorang');
    });

    // Bug 14 — someone in my zone raised their hand. Server already scoped this
    // to the zone + applied a per-sender cooldown, so just play the polite
    // chime. A3 — Focus/DND mutes the SOUND only; the ✋ badge still updates via
    // PLAYER_HAND_UPDATED above, so a focused user can still see it.
    socket.on(SocketEvents.HAND_RAISED_ALERT, () => {
      if (useGameStore.getState().workMode !== 'focus') playHandRaiseSound();
    });

    socket.on(SocketEvents.ROOM_UPDATED, (data: RoomUpdatePayload) => {
      const tiles = data.tiles.map((row, y) =>
        row.map((t, x) => ({ ...t, x, y, type: t.type as any }))
      );
      setTilesFromData(tiles);
      setFurniture(data.furniture || []);
      setZones(data.zones || []);
    });

    socket.on(SocketEvents.ADMIN_CHANGED, (data: { adminUserIds: string[]; masterAdminUserId: string; staffUserIds?: string[] }) => {
      console.log('[socket] admin:changed —', data.adminUserIds.length, 'admins,', (data.staffUserIds ?? []).length, 'staff, master:', data.masterAdminUserId);
      applyAdminChanged(data);
    });

    socket.on('admin:error', (data: { message: string }) => {
      console.warn('[socket] admin error:', data.message);
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

    socket.on(SocketEvents.ROOM_LOCK_UPDATED, (data: { locked: boolean }) => {
      useGameStore.getState().setRoomLocked(!!data.locked);
      useGameStore.getState().addActivity(data.locked ? '🔒 Room locked' : '🔓 Room unlocked');
    });

    socket.on(SocketEvents.ROOM_LOCKED_DENIED, () => {
      // Unlike roomDeletedNotice/kickedNotice, this does NOT auto-bounce — the
      // denied overlay (App.tsx) offers "Knock to enter" as well as leaving,
      // so we just surface the state and let the user choose.
      console.warn('[socket] join denied — room is locked');
      useGameStore.getState().setRoomLockedNotice('This room is locked — ask the host to let you in.');
    });

    socket.on(SocketEvents.ROOM_KNOCK_REQUEST, (payload: { userId: string; name: string }) => {
      useGameStore.getState().setIncomingKnock(payload);
    });

    socket.on(SocketEvents.ROOM_KNOCK_ADMITTED, () => {
      // The host let us in — retry the join (this time the server's lock gate
      // finds us on the allowlist) and clear the denied overlay.
      console.log('[socket] admitted after knock — rejoining');
      const config = loadAvatarConfig();
      const uid = authUserId || localStorage.getItem('vm_userId') || socket.id;
      const displayName = authUserName || config.name || 'Player';
      socket.emit(SocketEvents.JOIN_ROOM, roomSlug, displayName, config, uid);
      useGameStore.getState().setRoomLockedNotice(null);
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
    });

    // Bug 1 — server-initiated kick when a NEW login supersedes this live
    // socket (emitted just before the forced disconnect, see lib/sessionKick).
    socket.on('SESSION_SUPERSEDED', (d: { message?: string }) => {
      window.dispatchEvent(new CustomEvent('vm-session-superseded', { detail: d?.message }));
    });

    // All listeners attached — safe to connect now
    socket.connect();

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [authUserName, roomSlug, authUserId]);

  const emitMove = useCallback(
    (x: number, y: number, direction: string, isRunning?: boolean) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) return;

      const now = Date.now();
      if (now - lastEmitRef.current < 50) return;
      lastEmitRef.current = now;

      socket.emit(SocketEvents.PLAYER_MOVE, { x, y, direction, isRunning });
    },
    [],
  );

  const emitStop = useCallback(
    (direction: string) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) return;
      socket.emit(SocketEvents.PLAYER_STOP, { direction });
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

  const emitPlayerStatus = useCallback((status: string) => {
    socketRef.current?.emit(SocketEvents.PLAYER_STATUS_UPDATE, status);
  }, []);

  const emitWorkMode = useCallback((mode: WorkMode, zoneId?: string) => {
    socketRef.current?.emit(SocketEvents.WORK_MODE_CHANGE, { mode, zoneId });
  }, []);

  // A4 — free double-click teleport. Server validates + re-broadcasts as
  // PLAYER_TELEPORTED so everyone snaps.
  const emitTeleportTo = useCallback((x: number, y: number, direction: Avatar['direction']) => {
    socketRef.current?.emit(SocketEvents.PLAYER_TELEPORT_TO, { x, y, direction });
  }, []);

  const emitPlayerHand = useCallback((raised: boolean) => {
    socketRef.current?.emit(SocketEvents.PLAYER_HAND, raised);
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

  // Fitur 15B — Password prompt. The attempt travels to the server for
  // comparison; the reply lands via INTERACTIVE_PASSWORD_RESULT below.
  const emitInteractivePasswordCheck = useCallback((furnitureId: string, attempt: string) => {
    socketRef.current?.emit(SocketEvents.INTERACTIVE_PASSWORD_CHECK, { furnitureId, attempt });
  }, []);

  const emitChat = useCallback((text: string, isProximity?: boolean, zoneId?: string) => {
    socketRef.current?.emit(SocketEvents.CHAT_MESSAGE, text, isProximity, zoneId);
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

  const emitRoomDelete = useCallback(() => {
    socketRef.current?.emit(SocketEvents.ROOM_DELETE);
  }, []);

  const emitKick = useCallback((targetUserId: string) => {
    console.log('[socket] emit player:kick →', targetUserId);
    socketRef.current?.emit(SocketEvents.PLAYER_KICK, { targetUserId });
  }, []);

  const emitRoomLock = useCallback((locked: boolean) => {
    socketRef.current?.emit(SocketEvents.ROOM_LOCK_SET, { locked });
  }, []);

  const emitKnock = useCallback((roomId: string) => {
    socketRef.current?.emit(SocketEvents.ROOM_KNOCK, { roomId });
  }, []);

  const emitKnockAdmit = useCallback((userId: string) => {
    socketRef.current?.emit(SocketEvents.ROOM_KNOCK_ADMIT, { userId });
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

  // A10 — "colek" a participant (by nickname, like summon).
  const emitSlap = useCallback((nickname: string) => {
    socketRef.current?.emit(SocketEvents.SLAP, { nickname });
  }, []);

  const emitSummonRespond = useCallback((requestId: string, accept: boolean) => {
    socketRef.current?.emit(SocketEvents.SUMMON_RESPOND, { requestId, accept });
  }, []);

  const emitFollowRespond = useCallback((requestId: string, accept: boolean) => {
    socketRef.current?.emit(SocketEvents.FOLLOW_RESPOND, { requestId, accept });
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

  return { emitMove, emitStop, emitAvatarUpdate, emitPlayerStatus, emitWorkMode, emitTeleportTo, emitPlayerHand, emitSit, emitFurnitureAssign, emitFurnitureUnassign, socketRef, emitChat, emitBubble, emitEmote, emitJump, emitNudge, emitZoneEnter, emitZoneExit, emitRoomUpdate, emitAdminGrant, emitAdminRevoke, emitStaffGrant, emitStaffRevoke, emitRoomDelete, emitKick, emitRoomLock, emitKnock, emitKnockAdmit, emitNoticePin, emitNoticeUnpin, emitFollowRequest, emitFollowRespond, emitFollowUnfollow, emitTeleportRequest, emitSummonUser, emitSummonRespond, emitSlap, emitMediaAdd, emitMediaRemove, emitWhiteboardStroke, emitWhiteboardClear, emitRecordingStart, emitRecordingStop, emitRecordingFinalize, emitChannelJoin, emitChannelLeave, emitChannelMessageSend, emitDmJoin, emitDmLeave, emitDmMessageSend, emitChannelTyping, emitDmTyping, emitDeleteMessage, emitEditMessage, emitInteractivePasswordCheck };
}
