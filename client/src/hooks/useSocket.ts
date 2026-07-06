import { useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { SocketEvents, Avatar, AvatarConfig, ChatMessage, EmoteEvent, RoomUpdatePayload } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { loadAvatarConfig } from '@/hooks/useAvatarConfig';

export function useSocket(authUserName: string = '', roomSlug: string = 'main-office', authUserId: string = '') {
  const socketRef = useRef<Socket | null>(null);
  const lastEmitRef = useRef<number>(0);

  const setConnected = useGameStore((s) => s.setConnected);
  const setLocalPlayerId = useGameStore((s) => s.setLocalPlayerId);
  const setRoomState = useGameStore((s) => s.setRoomState);
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
    });

    socket.on(SocketEvents.PLAYER_JOINED, (player: Avatar) => {
      console.log('[socket] player joined:', player.name);
      upsertPlayer(player);
    });

    socket.on(SocketEvents.PLAYER_MOVED, (data: { id: string; x: number; y: number; direction: string }) => {
      setPlayerTarget(data.id, data.x, data.y);
      upsertPlayer({
        id: data.id,
        direction: data.direction as Avatar['direction'],
        isMoving: true,
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
      removePlayer(playerId);
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

    socket.on(SocketEvents.CHAT_BROADCAST, (msg: ChatMessage) => {
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

    socket.on(SocketEvents.ROOM_UPDATED, (data: RoomUpdatePayload) => {
      const tiles = data.tiles.map((row, y) =>
        row.map((t, x) => ({ ...t, x, y, type: t.type as any }))
      );
      setTilesFromData(tiles);
      setFurniture(data.furniture || []);
      setZones(data.zones || []);
    });

    socket.on(SocketEvents.ADMIN_CHANGED, (data: { adminUserIds: string[]; masterAdminUserId: string }) => {
      console.log('[socket] admin:changed —', data.adminUserIds.length, 'admins, master:', data.masterAdminUserId);
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
    (x: number, y: number, direction: string) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) return;

      const now = Date.now();
      if (now - lastEmitRef.current < 50) return;
      lastEmitRef.current = now;

      socket.emit(SocketEvents.PLAYER_MOVE, { x, y, direction });
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

  const emitChat = useCallback((text: string, isProximity?: boolean, zoneId?: string) => {
    socketRef.current?.emit(SocketEvents.CHAT_MESSAGE, text, isProximity, zoneId);
  }, []);

  const emitBubble = useCallback((text: string) => {
    socketRef.current?.emit(SocketEvents.CHAT_BUBBLE, text);
  }, []);

  const emitEmote = useCallback((emote: string, x: number, y: number) => {
    socketRef.current?.emit(SocketEvents.EMOTE_PLAY, { emote, x, y });
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

  const emitRoomDelete = useCallback(() => {
    socketRef.current?.emit(SocketEvents.ROOM_DELETE);
  }, []);

  return { emitMove, emitStop, emitAvatarUpdate, emitPlayerStatus, emitSit, socketRef, emitChat, emitBubble, emitEmote, emitZoneEnter, emitZoneExit, emitRoomUpdate, emitAdminGrant, emitAdminRevoke, emitRoomDelete };
}
