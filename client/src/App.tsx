import { useEffect, useState, useCallback, useRef } from 'react';
import { Tools, GearFill, Clipboard, BoxArrowLeft, PersonWalking, X, GeoAltFill, MagnetFill, ImageFill } from 'react-bootstrap-icons';
import { AvatarConfig, EmoteType, TileType, MAP_WIDTH, TILE_SIZE, Furniture, roleAtLeast, MediaType, MediaPayload } from '@virtualmeet/shared';
import { PALETTE_BY_ID } from './data/themeAssets';
import { GameCanvas } from './components/canvas/GameCanvas';
import { ConnectionIndicator } from './components/ui/ConnectionIndicator';
import { NameModal } from './components/ui/NameModal';
import { AvatarSetup } from './components/avatar/AvatarSetup';
import { AvatarEditorButton } from './components/avatar/AvatarEditorButton';
import { StatusButton } from './components/avatar/StatusButton';
import { VideoGrid } from './components/ui/VideoGrid';
import { ChatPanel } from './components/ui/ChatPanel';
import { NoticeBanner } from './components/ui/NoticeBanner';
import { EmoteWheel } from './components/ui/EmoteWheel';
import { Minimap } from './components/hud/Minimap';
import { RoomEditor } from './components/ui/RoomEditor';
import { AdminPanel } from './components/ui/AdminPanel';
import { TeleportPanel } from './components/ui/TeleportPanel';
import { AddMediaPanel } from './components/ui/AddMediaPanel';
import { MediaViewerModal } from './components/ui/MediaViewerModal';
import { ParticipantPanel } from './components/ui/ParticipantPanel';
import { RecordingControl } from './components/ui/RecordingControl';
import { MicButton } from './components/hud/MicButton';
import { CameraButton } from './components/hud/CameraButton';
import { ScreenShareButton } from './components/hud/ScreenShareButton';
import { NotificationSettings } from './components/ui/NotificationSettings';
import { Lobby } from './pages/Lobby';
import { LoginPage } from './pages/LoginPage';
import { useAuth } from './hooks/useAuth';
import { api } from './services/api';
import { createDefaultRoom, isTileBlocked } from './utils/createDefaultRoom';
import { useGameStore } from './stores/gameStore';
import { useSocket } from './hooks/useSocket';
import { useProximity, findZoneAt } from './hooks/useProximity';
import { useWebRTC } from './hooks/useWebRTC';
import { useScreenRecording } from './hooks/useScreenRecording';
import { webrtcService } from './services/webrtcService';
import { loadAvatarConfig, saveAvatarConfig } from './hooks/useAvatarConfig';

function Game({ roomSlug, onLeave, onPortalTravel, authDisplayName, authUserId }: { roomSlug: string; onLeave: () => void; onPortalTravel: (slug: string) => void; authDisplayName: string; authUserId: string }) {
  const playerName = useGameStore((s) => s.localPlayer.name);
  const { emitMove, emitStop, emitAvatarUpdate, emitPlayerStatus, emitSit, emitFurnitureAssign, emitFurnitureUnassign, socketRef, emitChat, emitBubble, emitEmote, emitZoneEnter, emitZoneExit, emitRoomUpdate, emitAdminGrant, emitAdminRevoke, emitStaffGrant, emitStaffRevoke, emitNoticePin, emitNoticeUnpin, emitFollowRequest, emitFollowUnfollow, emitTeleportRequest, emitSummonUser, emitSummonRoom, emitMediaAdd, emitMediaRemove, emitWhiteboardStroke, emitWhiteboardClear, emitSpotlightToggle, emitRecordingStart, emitRecordingStop, emitRecordingFinalize } = useSocket(authDisplayName, roomSlug, authUserId);
  const [showEditor, setShowEditor] = useState(false);

  // Media state from store
  const localSpeaking = useGameStore((s) => s.localSpeaking);
  const setLocalSpeaking = useGameStore((s) => s.setLocalSpeaking);
  const speakingPlayers = useGameStore((s) => s.speakingPlayers);
  const setPlayerSpeaking = useGameStore((s) => s.setPlayerSpeaking);

  // WebRTC
  const {
    initMedia,
    updateProximity,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    isMicMuted,
    isCameraOn,
    isScreenSharing,
    setManualVolume,
    destroy,
  } = useWebRTC({ socketRef });

  // Remote video streams
  const [remoteStreams] = useState(() => new Map<string, MediaStream>());
  // §6 — the peer's screen share, tracked separately from their camera
  // (remoteStreams above) so both can render as distinct VideoGrid tiles.
  const [remoteScreenStreams] = useState(() => new Map<string, MediaStream>());
  const [streamsVersion, setStreamsVersion] = useState(0);

  useEffect(() => {
    webrtcService.setOnRemoteStream((id, stream) => {
      remoteStreams.set(id, stream);
      setStreamsVersion((v) => v + 1);
    });
    webrtcService.setOnRemoteScreenStream((id, stream) => {
      remoteScreenStreams.set(id, stream);
      setStreamsVersion((v) => v + 1);
    });
    webrtcService.setOnRemoteScreenEnded((id) => {
      remoteScreenStreams.delete(id);
      setStreamsVersion((v) => v + 1);
    });
    webrtcService.setOnSpeakingChange((id, speaking) => {
      if (id === 'local') {
        setLocalSpeaking(speaking);
      } else {
        setPlayerSpeaking(id, speaking);
      }
    });
  }, []);

  // Init media on mount
  const mediaInitRef = useRef(false);
  useEffect(() => {
    if (!mediaInitRef.current) {
      mediaInitRef.current = true;
      initMedia();
    }
  }, [initMedia]);

  // Proximity calculation
  const localPlayer = useGameStore((s) => s.localPlayer);
  const playerRecords = useGameStore((s) => s.playerRecords);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const zones = useGameStore((s) => s.zones);
  const sittingFurnitureId = useGameStore((s) => s.sittingFurnitureId);
  const furniture = useGameStore((s) => s.furniture);
  const localUserId = useGameStore((s) => s.localUserId);
  const sittingItem = sittingFurnitureId ? furniture.find((f) => f.id === sittingFurnitureId) : undefined;
  const spotlightedUserIds = useGameStore((s) => s.spotlightedUserIds);

  const nearby = useProximity(
    { x: localPlayer.x, y: localPlayer.y, id: localPlayerId },
    playerRecords,
    zones,
    spotlightedUserIds,
  );

  // Update WebRTC connections based on proximity
  useEffect(() => {
    updateProximity(nearby);
  }, [nearby, updateProximity]);

  // §7 — Screen Recording
  const activeRecording = useGameStore((s) => s.activeRecording);
  const findSocketIdByUserId = useCallback(
    (userId: string) => Object.values(playerRecords).find((p) => p.userId === userId)?.id,
    [playerRecords],
  );
  const { requestRecording, stopMyRecording, isRecordingMine, uploading: recordingUploading } = useScreenRecording({
    activeRecording,
    findSocketIdByUserId,
    emitRecordingStop,
    emitRecordingFinalize,
  });
  // §7 — recording targets only, so excludes myself even if I'm spotlighted:
  // the mesh only gives me a capturable stream for REMOTE peers
  // (webrtcService.getRecordingStream looks up the peers Map, which never
  // contains my own connection) — recording my own outgoing camera isn't
  // reachable through this architecture, so it's left out of the picker
  // instead of silently failing after the server's already created the row.
  const spotlightedPlayers = spotlightedUserIds
    .filter((uid) => uid !== localUserId)
    .map((uid) => {
      const p = Object.values(playerRecords).find((rec) => rec.userId === uid);
      return p ? { userId: uid, name: p.name } : null;
    })
    .filter((p): p is { userId: string; name: string } => !!p);

  // Track which zone (if any) the local player is standing in — drives the
  // ChatPanel's "Private" tab, and notifies other players in the room when
  // it changes. State (not a ref) so the Private tab can actually appear.
  const currentZoneIdRef = useRef<string | null>(null);
  const [currentZone, setCurrentZone] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    const zone = findZoneAt(localPlayer, zones);
    const zoneId = zone?.id ?? null;
    if (zoneId === currentZoneIdRef.current) return;
    if (currentZoneIdRef.current) emitZoneExit(currentZoneIdRef.current);
    if (zoneId) emitZoneEnter(zoneId);
    currentZoneIdRef.current = zoneId;
    setCurrentZone(zone ? { id: zone.id, name: zone.name } : null);
  }, [localPlayer.x, localPlayer.y, zones, emitZoneEnter, emitZoneExit]);

  const zoneChatHistory = useGameStore((s) => s.zoneChatHistory);
  const handleSendZoneChat = useCallback((text: string, zoneId: string) => {
    emitChat(text, false, zoneId);
  }, [emitChat]);

  // Media toggles — single call, track is toggled directly in the hook
  const handleMicToggle = useCallback(() => {
    toggleMic();
  }, [toggleMic]);

  const handleCameraToggle = useCallback(() => {
    toggleCamera();
  }, [toggleCamera]);

  const handleScreenShareToggle = useCallback(() => {
    toggleScreenShare();
  }, [toggleScreenShare]);

  // Cleanup
  useEffect(() => () => destroy(), [destroy]);

  // Room deleted by its owner while we were in it — show the notice for a
  // moment, then navigate back to the Lobby the same way the "Leave" button
  // does (React state, not a full page reload).
  const roomDeletedNotice = useGameStore((s) => s.roomDeletedNotice);
  useEffect(() => {
    if (!roomDeletedNotice) return;
    const timer = setTimeout(() => {
      useGameStore.getState().setRoomDeletedNotice(null);
      onLeave();
    }, 2500);
    return () => clearTimeout(timer);
  }, [roomDeletedNotice, onLeave]);

  // §5 — Summon toasts. Both auto-clear: the warning matches its own
  // countdown (it's superseded by the actual PLAYER_TELEPORTED snap anyway,
  // this just stops the toast from lingering if that arrives late), the
  // notice is a one-off "you were summoned" ping.
  const summonWarning = useGameStore((s) => s.summonWarning);
  useEffect(() => {
    if (!summonWarning) return;
    const timer = setTimeout(() => useGameStore.getState().setSummonWarning(null), summonWarning.countdownSec * 1000);
    return () => clearTimeout(timer);
  }, [summonWarning]);

  const summonNotice = useGameStore((s) => s.summonNotice);
  useEffect(() => {
    if (!summonNotice) return;
    const timer = setTimeout(() => useGameStore.getState().setSummonNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [summonNotice]);

  // Admin / Editor
  const isAdmin = useGameStore((s) => s.isAdmin);
  const editorMode = useGameStore((s) => s.editorMode);
  const toggleEditorMode = useGameStore((s) => s.toggleEditorMode);
  const selectedTileType = useGameStore((s) => s.selectedTileType);
  const selectedPaletteId = useGameStore((s) => s.selectedPaletteId);
  const zoneDrawMode = useGameStore((s) => s.zoneDrawMode);
  const bannerPlaceMode = useGameStore((s) => s.bannerPlaceMode);
  const pushTileHistory = useGameStore((s) => s.pushTileHistory);
  const setTiles = useGameStore((s) => s.setTiles);
  const tiles = useGameStore((s) => s.tiles);
  const [editorToast, setEditorToast] = useState('');
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [showTeleportPanel, setShowTeleportPanel] = useState(false);
  const [showAddMediaPanel, setShowAddMediaPanel] = useState(false);
  const [viewingMediaId, setViewingMediaId] = useState<string | null>(null);
  const localRole = useGameStore((s) => s.localRole);
  const mediaObjects = useGameStore((s) => s.mediaObjects);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [roomCodeCopied, setRoomCodeCopied] = useState(false);

  // E key for editor, Tab for admin panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'e' || e.key === 'E') {
        if (isAdmin) toggleEditorMode();
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        setShowAdminPanel((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isAdmin, toggleEditorMode]);

  const handleTilePaint = useCallback((x: number, y: number, type: TileType) => {
    const state = useGameStore.getState();
    const currentTiles = state.tiles.map((row) => row.map((t) => ({ ...t })));
    if (!currentTiles[y]?.[x]) return;

    if (type === 'portal') {
      const target = window.prompt('Target room code to travel to (from the room URL/share code):', '');
      if (!target || !target.trim()) return;
      currentTiles[y][x].type = type;
      currentTiles[y][x].portalTarget = target.trim();
    } else {
      currentTiles[y][x].type = type;
      currentTiles[y][x].portalTarget = undefined;
    }
    setTiles(currentTiles);
  }, [setTiles]);

  const handleTileHistoryPush = useCallback(() => {
    const state = useGameStore.getState();
    pushTileHistory(state.tiles.map((row) => row.map((t) => t.type)));
  }, [pushTileHistory]);

  const handleFloorPaint = useCallback((x: number, y: number, paletteId: string) => {
    useGameStore.getState().setFloorPaletteId(x, y, paletteId);
  }, []);

  const handleFurniturePlace = useCallback((x: number, y: number, paletteId: string) => {
    const entry = PALETTE_BY_ID[paletteId];
    if (!entry || entry.category === 'floor') return;
    const state = useGameStore.getState();
    for (let dx = 0; dx < entry.tilesW; dx++) {
      const tx = x + dx;
      if (tx >= MAP_WIDTH - 1 || state.tiles[y]?.[tx]?.type !== 'floor') return;
    }
    const item: Furniture = {
      id: crypto.randomUUID(), paletteId, x, y, tilesW: entry.tilesW, tilesH: entry.tilesH,
      isInteractable: entry.sittable || undefined,
    };
    state.addFurniture(item);
  }, []);

  const handleFurnitureErase = useCallback((x: number, y: number) => {
    useGameStore.getState().removeFurnitureAt(x, y);
  }, []);

  const handleZoneDrawComplete = useCallback((x: number, y: number, width: number, height: number) => {
    const state = useGameStore.getState();
    state.setPendingZoneRect({ x, y, width, height });
    state.toggleZoneDrawMode();
  }, []);

  const handleBannerPlaceComplete = useCallback((x: number, y: number) => {
    const state = useGameStore.getState();
    state.setPendingBannerPos({ x, y });
    state.toggleBannerPlaceMode();
  }, []);

  const portalTravelGuardRef = useRef(false);
  const handlePortalEnter = useCallback((target: string) => {
    if (target === roomSlug || portalTravelGuardRef.current) return;
    portalTravelGuardRef.current = true;
    onPortalTravel(target);
    setTimeout(() => { portalTravelGuardRef.current = false; }, 1500);
  }, [roomSlug, onPortalTravel]);

  const handleRoomSave = useCallback(() => {
    const state = useGameStore.getState();
    const tileData = state.tiles.map((row) => row.map((t) => ({ type: t.type, x: t.x, y: t.y, floorPaletteId: t.floorPaletteId, portalTarget: t.portalTarget })));
    emitRoomUpdate({ tiles: tileData, furniture: state.furniture, zones: state.zones });
    setEditorToast('Room saved!');
    setTimeout(() => setEditorToast(''), 2000);
  }, [emitRoomUpdate]);

  const handleAvatarSave = useCallback((config: AvatarConfig) => {
    saveAvatarConfig(config);
    useGameStore.getState().setLocalPlayer({
      name: config.name,
      color: config.color,
      avatarConfig: config,
    });
    emitAvatarUpdate(config);
    setShowEditor(false);
  }, [emitAvatarUpdate]);

  const handleStatusSave = useCallback((status: string) => {
    useGameStore.getState().setLocalPlayer({ status: status || undefined });
    emitPlayerStatus(status);
  }, [emitPlayerStatus]);

  // loadAvatarConfig()'s default `name` is the placeholder 'You' used for
  // the editor's own live preview. Seed it with the real account name so
  // opening the editor and saving without touching the name field doesn't
  // broadcast "You" to every other player in the room.
  const savedConfig = { ...loadAvatarConfig(), name: playerName || loadAvatarConfig().name };

  // Chat + emotes + minimap state
  const chatMessages = useGameStore((s) => s.chatMessages);
  const notice = useGameStore((s) => s.notice);
  const followInfo = useGameStore((s) => s.followInfo);
  const [showEmoteWheel, setShowEmoteWheel] = useState(false);
  const [showMinimap, setShowMinimap] = useState(true);

  const handleChatSend = useCallback((text: string, isProximity?: boolean) => {
    emitChat(text, isProximity);
  }, [emitChat]);

  const handlePinNotice = useCallback((message: { id: string; text: string; senderName: string }) => {
    emitNoticePin(message.id, message.text, message.senderName);
  }, [emitNoticePin]);

  const handleMediaAdd = useCallback((type: MediaType, x: number, y: number, payload?: MediaPayload) => {
    emitMediaAdd(type, x, y, payload);
  }, [emitMediaAdd]);

  // §6 — Screenshot. Capturing the <canvas> bitmap directly (toDataURL)
  // already excludes every HTML overlay (chat, sidebar, media pins, HUD
  // buttons) for free — those are separate DOM elements never part of the
  // canvas's own pixels — which is exactly the spec's "map render without
  // UI overlay" requirement, with no extra hide/show-elements step needed.
  const handleScreenshot = useCallback(() => {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `meetkai-screenshot-${Date.now()}.png`;
    link.click();
  }, []);

  const viewingMedia = viewingMediaId ? mediaObjects.find((m) => m.id === viewingMediaId) ?? null : null;
  const canDeleteViewingMedia = !!viewingMedia && (viewingMedia.createdBy === localUserId || isAdmin);

  const handleEmoteSelect = useCallback((emote: EmoteType) => {
    const lp = useGameStore.getState().localPlayer;
    emitEmote(emote, lp.x, lp.y);
    useGameStore.getState().addEmote({
      playerId: localPlayerId,
      emote,
      x: lp.x,
      y: lp.y,
      timestamp: Date.now(),
    });
    setShowEmoteWheel(false);
  }, [emitEmote, localPlayerId]);

  // Z key for emote wheel, M key for minimap
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        setShowEmoteWheel((v) => !v);
      }
      if (e.key === 'm' || e.key === 'M') {
        setShowMinimap((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const allPlayers = { [localPlayerId]: useGameStore.getState().localPlayer, ...playerRecords };

  return (
    <div className="w-screen h-screen overflow-hidden bg-purple-50">
      <GameCanvas
        emitMove={emitMove}
        emitStop={emitStop}
        proximityData={nearby}
        localSpeaking={localSpeaking}
        speakingPlayers={speakingPlayers}
        micMuted={isMicMuted}
        cameraOn={isCameraOn}
        editorMode={editorMode}
        selectedTileType={selectedTileType}
        selectedPaletteId={selectedPaletteId}
        onTilePaint={handleTilePaint}
        onTileHistoryPush={handleTileHistoryPush}
        onFloorPaint={handleFloorPaint}
        onFurniturePlace={handleFurniturePlace}
        onFurnitureErase={handleFurnitureErase}
        zoneDrawMode={zoneDrawMode}
        onZoneDrawComplete={handleZoneDrawComplete}
        bannerPlaceMode={bannerPlaceMode}
        onBannerPlaceComplete={handleBannerPlaceComplete}
        onPortalEnter={handlePortalEnter}
        emitSit={emitSit}
        emitFollowUnfollow={emitFollowUnfollow}
        onMediaOpen={setViewingMediaId}
      />

      <div className="absolute top-4 left-28 pointer-events-none">
        <p className="text-gray-500 text-xs font-mono">WASD / Arrow keys to move</p>
      </div>
      <div className="absolute top-10 left-28 pointer-events-none">
        <p className="text-gray-500 text-xs font-mono">
          Playing as: <span className="text-gray-700">{playerName}</span>
        </p>
      </div>

      <ConnectionIndicator />
      <ParticipantPanel remoteStreams={remoteStreams} emitFollowRequest={emitFollowRequest} emitFollowUnfollow={emitFollowUnfollow} emitSummonUser={emitSummonUser} emitSpotlightToggle={emitSpotlightToggle} />

      {/* Follow (§3) indicator — only the ONE new thing from this pass that's
          always visible without opening a panel first. 'standby' means the
          target went offline; movement pauses but the relationship is kept
          server-side (see followHandler.ts) and resumes automatically the
          moment they reconnect, no need to click Follow again. */}
      {followInfo && (
        <div className="absolute bottom-28 left-4 z-30 pointer-events-auto">
          <div className="bg-white/90 backdrop-blur-sm border border-purple-200 shadow-sm rounded-lg px-3 py-2 flex items-center gap-2 text-xs">
            <PersonWalking size={13} className="text-purple-600" />
            <span className="text-gray-700">
              {followInfo.status === 'active' ? 'Following ' : 'Waiting for '}
              <span className="font-medium">{followInfo.targetName}</span>
              {followInfo.status === 'standby' && <span className="text-gray-400"> (offline)</span>}
            </span>
            <button onClick={emitFollowUnfollow} title="Stop following" className="text-gray-400 hover:text-red-500 cursor-pointer">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* §5 — Summon toasts. z-50 so they win over the Follow indicator
          below, which sits at the same bottom-28 corner. */}
      {summonWarning && (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-50 bg-amber-500/90 text-white text-xs font-semibold px-4 py-2 rounded-full shadow-lg pointer-events-none inline-flex items-center gap-1.5">
          <MagnetFill size={13} /> {summonWarning.actorName} is summoning you — moving in {summonWarning.countdownSec}s
        </div>
      )}
      {summonNotice && (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-50 bg-purple-600/90 text-white text-xs font-semibold px-4 py-2 rounded-full shadow-lg pointer-events-none inline-flex items-center gap-1.5">
          <MagnetFill size={13} /> Summoned by {summonNotice.actorName}
        </div>
      )}

      <AvatarEditorButton onClick={() => setShowEditor(true)} />
      <StatusButton status={localPlayer.status || ''} onSave={handleStatusSave} />

      {/* Permanent seat assignment (ZEP-style "this is my desk") — only
          shown while actually sitting, since it acts on the specific chair
          you're in. Distinct from the transient "SPACE to sit" prompt drawn
          on the canvas itself (GameCanvas.tsx), which anyone can use
          regardless of login; assigning requires an account (server-side
          checked) since it's meant to persist across sessions. */}
      {localPlayer.isSitting && sittingItem && (
        <div className="absolute bottom-40 left-1/2 -translate-x-1/2 z-30 pointer-events-auto">
          {!sittingItem.assignedToUserId ? (
            <button
              onClick={() => emitFurnitureAssign(sittingItem.id, playerName)}
              className="bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold px-4 py-2 rounded-full shadow-lg cursor-pointer inline-flex items-center gap-1.5"
            >
              🪑 Assign as My Seat
            </button>
          ) : sittingItem.assignedToUserId === localUserId ? (
            <button
              onClick={() => emitFurnitureUnassign(sittingItem.id)}
              className="bg-white hover:bg-gray-50 text-purple-700 text-xs font-semibold px-4 py-2 rounded-full shadow-lg border border-purple-200 cursor-pointer inline-flex items-center gap-1.5"
            >
              Unassign My Seat
            </button>
          ) : (
            <div className="bg-white/90 backdrop-blur-sm text-gray-500 text-xs font-medium px-4 py-2 rounded-full shadow-sm border border-purple-100 inline-flex items-center gap-1.5">
              🔒 Reserved by {sittingItem.assignedToName || 'someone'}
            </div>
          )}
        </div>
      )}

      {isAdmin && (
        <button
          onClick={toggleEditorMode}
          className={`absolute bottom-4 left-28 z-30 px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 ${editorMode ? 'bg-purple-600 text-white border-purple-500' : 'bg-white/90 backdrop-blur-sm text-purple-700 hover:text-purple-800 border-purple-200 shadow-sm'}`}
        >
          <Tools size={12} /> {editorMode ? 'Editing...' : 'Edit Room'}
        </button>
      )}

      {/* §4 — Teleport. Gated at staff+ since the panel's "Team Locations"
          tab is the only thing a plain member has no use for; the "My
          Bookmarks" tab inside the panel is further gated to owner-only. */}
      {roleAtLeast(localRole, 'staff') && (
        <button
          onClick={() => setShowTeleportPanel((v) => !v)}
          className={`absolute bottom-4 left-52 z-30 px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 ${showTeleportPanel ? 'bg-purple-600 text-white border-purple-500' : 'bg-white/90 backdrop-blur-sm text-purple-700 hover:text-purple-800 border-purple-200 shadow-sm'}`}
        >
          <GeoAltFill size={12} /> Teleport
        </button>
      )}

      {/* §5.2/5.3 — Summon All. Disruptive to everyone else in the room, so
          unlike Teleport's button this asks for confirmation first — same
          window.confirm pattern the Leave Room flow already uses elsewhere
          (well, that one's a styled modal; this reuses the simpler
          window.confirm since Summon All is staff-only and infrequent). */}
      {roleAtLeast(localRole, 'staff') && (
        <button
          onClick={() => {
            if (window.confirm('Summon everyone else in this room to your position?')) emitSummonRoom();
          }}
          className="absolute bottom-4 left-[19rem] z-30 px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 bg-white/90 backdrop-blur-sm text-purple-700 hover:text-purple-800 border-purple-200 shadow-sm"
        >
          <MagnetFill size={12} /> Summon All
        </button>
      )}

      {/* §6 — Add Media. Not role-gated — the spec's own dependency for
          this feature is just §1's Interact, no permission requirement
          (delete is separately gated to creator-or-admin, checked server
          side in mediaHandler.ts, not here). */}
      <button
        onClick={() => setShowAddMediaPanel((v) => !v)}
        className={`absolute bottom-4 left-[25rem] z-30 px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer inline-flex items-center gap-1.5 ${showAddMediaPanel ? 'bg-purple-600 text-white border-purple-500' : 'bg-white/90 backdrop-blur-sm text-purple-700 hover:text-purple-800 border-purple-200 shadow-sm'}`}
      >
        <ImageFill size={12} /> Add Media
      </button>

      {/* §7 — Screen Recording, admin+ only (gated one tier above the
          other staff+ controls — see shared/permissions.ts's doc comment
          on why). */}
      {isAdmin && (
        <div className="absolute bottom-4 left-[31rem] z-30">
          <RecordingControl
            spotlightedPlayers={spotlightedPlayers}
            activeRecording={activeRecording}
            isRecordingMine={isRecordingMine}
            uploading={recordingUploading}
            roomSlug={roomSlug}
            onStart={(targetUserId, title) => requestRecording(targetUserId, title, emitRecordingStart)}
            onStop={stopMyRecording}
          />
        </div>
      )}

      {isAdmin && editorMode && (
        <RoomEditor onSave={handleRoomSave} />
      )}

      {editorMode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-purple-600/90 text-white text-xs font-bold px-3 py-1 rounded-full pointer-events-none inline-flex items-center gap-1.5">
          <GearFill size={11} /> EDIT MODE
        </div>
      )}

      {editorToast && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 bg-emerald-500/90 text-white text-xs font-bold px-4 py-2 rounded-full animate-fade-in pointer-events-none">
          {editorToast}
        </div>
      )}

      {showAdminPanel && (
        <AdminPanel
          onGrantAdmin={(userId) => emitAdminGrant(userId)}
          onRevokeAdmin={(userId) => emitAdminRevoke(userId)}
          onGrantStaff={(userId) => emitStaffGrant(userId)}
          onRevokeStaff={(userId) => emitStaffRevoke(userId)}
        />
      )}

      {showTeleportPanel && (
        <TeleportPanel
          roomSlug={roomSlug}
          isOwner={localRole === 'owner'}
          onTeleport={(kind, locationId) => emitTeleportRequest({ kind, locationId })}
          onClose={() => setShowTeleportPanel(false)}
        />
      )}

      {showAddMediaPanel && (
        <AddMediaPanel
          onAdd={handleMediaAdd}
          onScreenshot={handleScreenshot}
          onClose={() => setShowAddMediaPanel(false)}
        />
      )}

      {viewingMedia && (
        <MediaViewerModal
          media={viewingMedia}
          canDelete={canDeleteViewingMedia}
          onDelete={() => { emitMediaRemove(viewingMedia.id); setViewingMediaId(null); }}
          onClose={() => setViewingMediaId(null)}
          emitWhiteboardStroke={emitWhiteboardStroke}
          emitWhiteboardClear={emitWhiteboardClear}
        />
      )}

      {showEditor && (
        <AvatarSetup
          initialConfig={savedConfig}
          onSave={handleAvatarSave}
          onClose={() => setShowEditor(false)}
        />
      )}

      <VideoGrid
        nearby={nearby}
        localStream={webrtcService.getLocalStream()}
        localScreenStream={isScreenSharing ? webrtcService.getScreenStream() : null}
        remoteStreams={remoteStreams}
        remoteScreenStreams={remoteScreenStreams}
        micMuted={isMicMuted}
        cameraOff={!isCameraOn}
        onManualVolumeChange={setManualVolume}
        recordedTargetUserId={activeRecording?.targetUserId}
        isLocalBeingRecorded={!!activeRecording && activeRecording.targetUserId === localUserId}
      />

      {/* HUD Controls */}
      <div className="absolute bottom-24 left-1/2 -translate-x-1/2 flex gap-3 z-30">
        <MicButton muted={isMicMuted} onToggle={handleMicToggle} />
        <CameraButton enabled={isCameraOn} onToggle={handleCameraToggle} />
        <ScreenShareButton sharing={isScreenSharing} onToggle={handleScreenShareToggle} />
        <NotificationSettings />
      </div>

      {/* Room name HUD + code */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-auto">
        <p className="text-gray-500 text-xs font-medium tracking-wider uppercase">MAIN OFFICE</p>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(roomSlug);
            setRoomCodeCopied(true);
            setTimeout(() => setRoomCodeCopied(false), 2000);
          }}
          className="text-gray-400 hover:text-gray-700 text-xs cursor-pointer transition-colors inline-flex items-center gap-1"
          title="Copy room code"
        >
          <Clipboard size={11} /> {roomSlug.slice(0, 12)}
        </button>
      </div>

      {roomCodeCopied && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 bg-purple-100 text-purple-700 text-[10px] px-2 py-0.5 rounded-full pointer-events-none">
          Code copied!
        </div>
      )}

      {/* Leave Room button */}
      <div className="absolute top-4 left-4 pointer-events-auto">
        <button
          onClick={() => setShowLeaveConfirm(true)}
          className="text-red-500/70 hover:text-red-500 text-xs font-medium cursor-pointer transition-colors inline-flex items-center gap-1"
        >
          <BoxArrowLeft size={12} /> Leave
        </button>
      </div>

      {showLeaveConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-xl p-6 shadow-xl shadow-purple-100/50 border border-purple-100 text-center">
            <p className="text-gray-900 text-sm mb-4">Leave this room?</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLeaveConfirm(false)}
                className="px-4 py-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 text-sm cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowLeaveConfirm(false); onLeave(); }}
                className="px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm cursor-pointer"
              >
                Leave Room
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Covers the (now-stale) canvas instead of leaving it visible and
          interactive — nothing on it will ever update again since the room
          is gone server-side. z-[60] so it wins over every other overlay. */}
      {roomDeletedNotice && (
        <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-white rounded-xl p-6 shadow-xl shadow-purple-100/50 border border-purple-100 text-center max-w-xs">
            <p className="text-gray-900 text-sm font-medium mb-1">{roomDeletedNotice}</p>
            <p className="text-gray-400 text-xs">Returning to the Lobby...</p>
          </div>
        </div>
      )}

      {notice && (
        <NoticeBanner notice={notice} isAdmin={isAdmin} onUnpin={emitNoticeUnpin} />
      )}

      <ChatPanel
        messages={chatMessages}
        localPlayerName={playerName}
        onSend={handleChatSend}
        onBubble={emitBubble}
        onEmote={handleEmoteSelect}
        currentZone={currentZone}
        zoneMessages={currentZone ? zoneChatHistory[currentZone.id] ?? [] : []}
        onSendZone={handleSendZoneChat}
        isAdmin={isAdmin}
        onPinNotice={handlePinNotice}
      />

      <EmoteWheel
        open={showEmoteWheel}
        onSelect={handleEmoteSelect}
        onClose={() => setShowEmoteWheel(false)}
      />

      <Minimap
        players={Object.values(allPlayers)}
        localPlayerId={localPlayerId}
        onTeleport={(x, y) => {
          // Reject clicks on walls/furniture — the minimap previously
          // teleported straight to wherever was clicked with no validation,
          // so clicking on a wall dropped the player inside it, and once
          // there they were stuck (every direction's own collision check
          // correctly refuses to move a player who's already standing in a
          // blocked tile back out the way they "shouldn't" have gotten in).
          const state = useGameStore.getState();
          const tileX = Math.floor(x / TILE_SIZE);
          const tileY = Math.floor(y / TILE_SIZE);
          if (state.tiles.length > 0 && isTileBlocked(state.tiles, tileX, tileY)) return;
          // Snap to the tile's center instead of the raw (sub-tile-precision)
          // clicked coordinate — the minimap is ~3px/tile, so a click can
          // land anywhere within the tile, including right at its edge.
          // useMovement's collision check uses the player's actual hitbox
          // (~28px wide), so landing near a tile edge — especially in the
          // office's many 1-tile-wide gaps between desk clusters — let that
          // hitbox clip into a neighboring blocked tile even though the
          // clicked tile itself was open, which then refused movement in
          // whichever direction would keep overlapping that neighbor. Read
          // exactly like "stuck on an object" despite the destination tile
          // passing the isTileBlocked check above.
          const targetX = tileX * TILE_SIZE + TILE_SIZE / 2;
          const targetY = tileY * TILE_SIZE + TILE_SIZE / 2;
          // Stand up first if sitting — otherwise the player's x/y moves to
          // the clicked spot but isSitting stays true, so useMovement's
          // isFrozen check keeps refusing all WASD input at the new
          // location. That reads exactly like "stuck" even on a perfectly
          // open tile, since nothing about the destination itself is
          // blocked — the player just can't move at all anymore.
          if (state.localPlayer.isSitting) {
            state.setSittingFurnitureId(null);
            state.setSitReturnPos(null);
            emitSit(false, targetX, targetY, state.localPlayer.direction);
          }
          state.setLocalPlayer({ x: targetX, y: targetY, isSitting: false });
          // Tell the server too — otherwise this jump is purely a local
          // visual change: the server's own position record (used both for
          // its authoritative movement/collision checks and for the value
          // it hands back to every OTHER client's socket.io ROOM_STATE
          // listener) stays at wherever we were before the click. The very
          // next room:state broadcast (fired whenever anyone else joins or
          // leaves — not something this teleport controls) then snaps us
          // straight back to that stale server-known spot, which is often
          // right up against whatever we'd just teleported away from. That
          // silent snap-back is what actually reads as "still stuck near an
          // object" even though the destination tile itself was never
          // blocked.
          emitMove(targetX, targetY, state.localPlayer.direction);
        }}
        visible={showMinimap}
      />
    </div>
  );
}

export default function App() {
  const { user, loading, error, sessionExpiredMessage, login, register, logout } = useAuth();
  const [roomSlug, setRoomSlug] = useState<string | null>(null);

  // Remembered purely for the Lobby's "Rejoin last room" shortcut — not
  // part of the auto-login mechanism itself (that's the JWT in vm_token).
  useEffect(() => {
    if (roomSlug) localStorage.setItem('vm_last_room_slug', roomSlug);
  }, [roomSlug]);
  const [playerName, setPlayerName] = useState<string | null>(null);
  const [showAvatarSetup, setShowAvatarSetup] = useState(false);
  const [isRoomReady, setIsRoomReady] = useState(false);
  const setRoomState = useGameStore((s) => s.setRoomState);
  const setLocalPlayer = useGameStore((s) => s.setLocalPlayer);

  // If authenticated, use user's displayName and avatarConfig. New accounts
  // have no avatarConfig saved yet (null from the DB) — fall back to
  // loadAvatarConfig()'s defaults (sprite mode etc.) instead of leaving it
  // undefined, which would silently drop back to the legacy shape avatar.
  useEffect(() => {
    if (user) {
      const config = user.avatarConfig || loadAvatarConfig();
      setPlayerName(user.displayName);
      setLocalPlayer({
        name: user.displayName,
        color: config.color,
        avatarConfig: config,
      });
    }
  }, [user, setLocalPlayer]);

  useEffect(() => {
    const room = createDefaultRoom('main-office', 'Main Office');
    setRoomState(room);
    setIsRoomReady(true);
  }, [setRoomState]);

  // Save avatar to server when changed
  const persistAvatar = useCallback((config: AvatarConfig) => {
    saveAvatarConfig(config);
    if (user) {
      api.saveAvatar(config).catch(() => {});
    }
  }, [user]);

  const handleNameSubmit = useCallback((name: string) => {
    setPlayerName(name);
    const savedConfig = loadAvatarConfig();
    if (savedConfig.bodyShape && savedConfig.name) {
      savedConfig.name = name;
      saveAvatarConfig(savedConfig);
      setLocalPlayer({ name, color: savedConfig.color, avatarConfig: savedConfig });
    } else {
      setShowAvatarSetup(true);
    }
  }, [setLocalPlayer]);

  const handleAvatarSave = useCallback((config: AvatarConfig) => {
    saveAvatarConfig(config);
    setLocalPlayer({ name: config.name, color: config.color, avatarConfig: config });
    setShowAvatarSetup(false);
    persistAvatar(config);
  }, [setLocalPlayer, persistAvatar]);

  // Loading
  if (loading) {
    return (
      <div className="w-screen h-screen bg-gradient-to-br from-white to-purple-50 flex items-center justify-center">
        <p className="text-gray-500 text-sm">Loading VirtualMeet...</p>
      </div>
    );
  }

  // Auth gate
  if (!user) {
    return <LoginPage onLogin={async (e, p) => { await login(e, p); }} onRegister={async (e, p, n) => { await register(e, p, n); }} error={error} sessionExpiredMessage={sessionExpiredMessage} />;
  }

  // Lobby
  if (!roomSlug) {
    return <Lobby user={user} onJoinRoom={setRoomSlug} onLogout={logout} />;
  }

  // Room (existing flow)
  if (!playerName) {
    return <NameModal onSubmit={handleNameSubmit} />;
  }

  if (showAvatarSetup) {
    return (
      <AvatarSetup
        initialConfig={{ ...loadAvatarConfig(), name: playerName }}
        onSave={handleAvatarSave}
      />
    );
  }

  if (!isRoomReady) {
    return (
      <div className="w-screen h-screen bg-gradient-to-br from-white to-purple-50 flex items-center justify-center">
        <p className="text-gray-500 text-xl">Loading VirtualMeet…</p>
      </div>
    );
  }

  return <Game roomSlug={roomSlug} onLeave={() => setRoomSlug(null)} onPortalTravel={setRoomSlug} authDisplayName={user.displayName} authUserId={user.id} />;
}
