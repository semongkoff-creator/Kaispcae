import { useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { SocketEvents, Avatar, AvatarConfig, ChatMessage, EmoteEvent, JumpEvent, RoomUpdatePayload, Notice, FollowInfo, FollowerChangedPayload, TeleportRequest, FollowRequestPayload, FollowResultPayload, SummonRequestPayload, SummonResultPayload, MediaType, MediaPayload, MapMediaObject, WhiteboardStroke } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { loadAvatarConfig } from '@/hooks/useAvatarConfig';
import { notifyNewMessage } from '@/services/browserNotifications';

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
  const addChatMessage = useGameStore((s) => s.addChatMessage);
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
    // Connect directly to the game server — bypass Vite proxy entirely
    // to avoid WebSocket proxy ECONNABORTED issues. The JWT (if logged in)
    // lets the server verify our identity server-side instead of trusting
    // the userId we hand it in JOIN_ROOM below (see index.ts io.use()).
    const socket = io('http://localhost:3001', {
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
      setRoomState(roomState);

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

    socket.on(SocketEvents.PLAYER_SAT, (data: { id: string; isSitting: boolean; x: number; y: number; direction: Avatar['direction'] }) => {
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) return;
      upsertPlayer({ id: data.id, isSitting: data.isSitting, x: data.x, y: data.y, direction: data.direction, isMoving: false } as Avatar);
    });

    // §4 — Teleport. Broadcast via io.to(room) (not socket.to(room)), so the
    // mover's own client gets this too — unlike a normal walk, there's no
    // local prediction to reconcile with, the server's resolved x/y is the
    // only source of truth. Snaps instantly rather than going through
    // playerTargets' lerp (interpolatePlayers in gameStore.ts) — sliding a
    // remote avatar across the whole map over ~200ms would look like a fast
    // walk, not a teleport.
    socket.on(SocketEvents.PLAYER_TELEPORTED, (data: { id: string; x: number; y: number; direction: Avatar['direction'] }) => {
      console.log('[socket] player teleported:', data.id, '→', data.x, data.y);
      const state = useGameStore.getState();
      if (data.id === state.localPlayerId) {
        // Stand up first if sitting — otherwise x/y jumps to the teleport
        // target but isSitting stays true, so useMovement's isFrozen check
        // keeps refusing all WASD input there. Server already dropped our
        // sit state server-side implicitly (positions are independent), but
        // the local store needs the same reset explicitly.
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

    // §6 (RTC upgrade) — full replacement list each time (small set, simpler
    // than diffing add/remove), including the one sent right after JOIN_ROOM
    // for spotlights that were already active before I connected.
    socket.on(SocketEvents.SPOTLIGHT_CHANGED, (data: { spotlightedUserIds: string[] }) => {
      console.log('[socket] spotlight changed —', data.spotlightedUserIds.length, 'spotlighted');
      useGameStore.getState().setSpotlightedUserIds(data.spotlightedUserIds);
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

    socket.on(SocketEvents.CHAT_BROADCAST, (msg: ChatMessage) => {
      // §10 — only for messages from someone else, and notifyNewMessage
      // itself no-ops unless the tab is actually in the background (spec's
      // own rule) and the user has actually turned notifications on.
      if (msg.senderId !== useGameStore.getState().localPlayerId) {
        notifyNewMessage(msg.senderName, msg.text);
      }
      if (msg.zoneId) {
        addZoneChatMessage(msg.zoneId, msg);
        return;
      }
      addChatMessage(msg);
      // Also show speech bubble above sender for 4 seconds
      if (!msg.isProximity) {
        setSpeechBubble(msg.senderId, {
          playerId: msg.senderId,
          text: msg.text,
          expireAt: Date.now() + 4000,
        });
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

  const emitSit = useCallback((sitting: boolean, x: number, y: number, direction: Avatar['direction']) => {
    socketRef.current?.emit(SocketEvents.PLAYER_SIT, { sitting, x, y, direction });
  }, []);

  const emitFurnitureAssign = useCallback((furnitureId: string, name: string) => {
    socketRef.current?.emit(SocketEvents.FURNITURE_ASSIGN, { furnitureId, name });
  }, []);

  const emitFurnitureUnassign = useCallback((furnitureId: string) => {
    socketRef.current?.emit(SocketEvents.FURNITURE_UNASSIGN, { furnitureId });
  }, []);

  const emitChat = useCallback((text: string, isProximity?: boolean, zoneId?: string) => {
    socketRef.current?.emit(SocketEvents.CHAT_MESSAGE, text, isProximity, zoneId);
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

  const emitSpotlightToggle = useCallback((targetUserId: string) => {
    socketRef.current?.emit(SocketEvents.SPOTLIGHT_TOGGLE, { targetUserId });
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

  return { emitMove, emitStop, emitAvatarUpdate, emitPlayerStatus, emitSit, emitFurnitureAssign, emitFurnitureUnassign, socketRef, emitChat, emitBubble, emitEmote, emitJump, emitZoneEnter, emitZoneExit, emitRoomUpdate, emitAdminGrant, emitAdminRevoke, emitStaffGrant, emitStaffRevoke, emitRoomDelete, emitNoticePin, emitNoticeUnpin, emitFollowRequest, emitFollowRespond, emitFollowUnfollow, emitTeleportRequest, emitSummonUser, emitSummonRespond, emitMediaAdd, emitMediaRemove, emitWhiteboardStroke, emitWhiteboardClear, emitSpotlightToggle, emitRecordingStart, emitRecordingStop, emitRecordingFinalize };
}
