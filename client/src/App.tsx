import { useEffect, useState, useCallback, useRef } from 'react';
import { Tools, GearFill, Clipboard, BoxArrowLeft } from 'react-bootstrap-icons';
import { AvatarConfig, EmoteType, TileType, MAP_WIDTH, TILE_SIZE, Furniture } from '@virtualmeet/shared';
import { TILE_PALETTE_BY_ID } from './data/tilePaletteManifest';
import { GameCanvas } from './components/canvas/GameCanvas';
import { ConnectionIndicator } from './components/ui/ConnectionIndicator';
import { NameModal } from './components/ui/NameModal';
import { AvatarSetup } from './components/avatar/AvatarSetup';
import { AvatarEditorButton } from './components/avatar/AvatarEditorButton';
import { StatusButton } from './components/avatar/StatusButton';
import { VideoGrid } from './components/ui/VideoGrid';
import { ChatPanel } from './components/ui/ChatPanel';
import { EmoteWheel } from './components/ui/EmoteWheel';
import { Minimap } from './components/hud/Minimap';
import { RoomEditor } from './components/ui/RoomEditor';
import { AdminPanel } from './components/ui/AdminPanel';
import { ParticipantPanel } from './components/ui/ParticipantPanel';
import { MicButton } from './components/hud/MicButton';
import { CameraButton } from './components/hud/CameraButton';
import { ScreenShareButton } from './components/hud/ScreenShareButton';
import { Lobby } from './pages/Lobby';
import { LoginPage } from './pages/LoginPage';
import { useAuth } from './hooks/useAuth';
import { api } from './services/api';
import { createDefaultRoom, isTileBlocked } from './utils/createDefaultRoom';
import { useGameStore } from './stores/gameStore';
import { useSocket } from './hooks/useSocket';
import { useProximity, findZoneAt } from './hooks/useProximity';
import { useWebRTC } from './hooks/useWebRTC';
import { webrtcService } from './services/webrtcService';
import { loadAvatarConfig, saveAvatarConfig } from './hooks/useAvatarConfig';

function Game({ roomSlug, onLeave, onPortalTravel, authDisplayName, authUserId }: { roomSlug: string; onLeave: () => void; onPortalTravel: (slug: string) => void; authDisplayName: string; authUserId: string }) {
  const playerName = useGameStore((s) => s.localPlayer.name);
  const { emitMove, emitStop, emitAvatarUpdate, emitPlayerStatus, emitSit, emitFurnitureAssign, emitFurnitureUnassign, socketRef, emitChat, emitBubble, emitEmote, emitZoneEnter, emitZoneExit, emitRoomUpdate, emitAdminGrant, emitAdminRevoke } = useSocket(authDisplayName, roomSlug, authUserId);
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
    destroy,
  } = useWebRTC({ socketRef });

  // Remote video streams
  const [remoteStreams] = useState(() => new Map<string, MediaStream>());
  const [streamsVersion, setStreamsVersion] = useState(0);

  useEffect(() => {
    webrtcService.setOnRemoteStream((id, stream) => {
      remoteStreams.set(id, stream);
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

  const nearby = useProximity(
    { x: localPlayer.x, y: localPlayer.y, id: localPlayerId },
    playerRecords,
    zones,
  );

  // Update WebRTC connections based on proximity
  useEffect(() => {
    updateProximity(nearby);
  }, [nearby, updateProximity]);

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
    const entry = TILE_PALETTE_BY_ID[paletteId];
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
  const [showEmoteWheel, setShowEmoteWheel] = useState(false);
  const [showMinimap, setShowMinimap] = useState(true);

  const handleChatSend = useCallback((text: string, isProximity?: boolean) => {
    emitChat(text, isProximity);
  }, [emitChat]);

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
      <ParticipantPanel remoteStreams={remoteStreams} />

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
          onGrant={(userId) => emitAdminGrant(userId)}
          onRevoke={(userId) => emitAdminRevoke(userId)}
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
        localStream={isScreenSharing ? webrtcService.getScreenStream() : webrtcService.getLocalStream()}
        remoteStreams={remoteStreams}
        micMuted={isMicMuted}
        cameraOff={!isCameraOn}
      />

      {/* HUD Controls */}
      <div className="absolute bottom-24 left-1/2 -translate-x-1/2 flex gap-3 z-30">
        <MicButton muted={isMicMuted} onToggle={handleMicToggle} />
        <CameraButton enabled={isCameraOn} onToggle={handleCameraToggle} />
        <ScreenShareButton sharing={isScreenSharing} onToggle={handleScreenShareToggle} />
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

      <ChatPanel
        messages={chatMessages}
        localPlayerName={playerName}
        onSend={handleChatSend}
        onBubble={emitBubble}
        onEmote={handleEmoteSelect}
        currentZone={currentZone}
        zoneMessages={currentZone ? zoneChatHistory[currentZone.id] ?? [] : []}
        onSendZone={handleSendZoneChat}
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
          state.setLocalPlayer({ x, y });
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
