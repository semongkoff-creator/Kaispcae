import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { AvatarConfig, EmoteType, TileType } from '@virtualmeet/shared';
import { GameCanvas } from './components/canvas/GameCanvas';
import { ConnectionIndicator } from './components/ui/ConnectionIndicator';
import { NameModal } from './components/ui/NameModal';
import { AvatarSetup } from './components/avatar/AvatarSetup';
import { AvatarEditorButton } from './components/avatar/AvatarEditorButton';
import { VideoGrid } from './components/ui/VideoGrid';
import { ChatPanel } from './components/ui/ChatPanel';
import { EmoteWheel } from './components/ui/EmoteWheel';
import { Minimap } from './components/hud/Minimap';
import { RoomEditor } from './components/ui/RoomEditor';
import { AdminPanel } from './components/ui/AdminPanel';
import { MicButton } from './components/hud/MicButton';
import { CameraButton } from './components/hud/CameraButton';
import { Lobby } from './pages/Lobby';
import { LoginPage } from './pages/LoginPage';
import { useAuth } from './hooks/useAuth';
import { api } from './services/api';
import { createDefaultRoom } from './utils/createDefaultRoom';
import { useGameStore } from './stores/gameStore';
import { useSocket } from './hooks/useSocket';
import { useProximity } from './hooks/useProximity';
import { useWebRTC } from './hooks/useWebRTC';
import { webrtcService } from './services/webrtcService';
import { loadAvatarConfig, saveAvatarConfig } from './hooks/useAvatarConfig';

function Game({ roomSlug, onLeave, authDisplayName }: { roomSlug: string; onLeave: () => void; authDisplayName: string }) {
  const playerName = useGameStore((s) => s.localPlayer.name);
  const { emitMove, emitStop, emitAvatarUpdate, socketRef, emitChat, emitBubble, emitEmote, emitRoomUpdate, emitAdminGrant, emitAdminRevoke } = useSocket(authDisplayName, roomSlug);
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
    isMicMuted,
    isCameraOn,
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

  const nearby = useProximity(
    { x: localPlayer.x, y: localPlayer.y, id: localPlayerId },
    playerRecords,
  );

  // Update WebRTC connections based on proximity
  useEffect(() => {
    updateProximity(nearby);
  }, [nearby, updateProximity]);

  // Media toggles — single call, track is toggled directly in the hook
  const handleMicToggle = useCallback(() => {
    toggleMic();
  }, [toggleMic]);

  const handleCameraToggle = useCallback(() => {
    toggleCamera();
  }, [toggleCamera]);

  // Cleanup
  useEffect(() => () => destroy(), [destroy]);

  // Admin / Editor
  const isAdmin = useGameStore((s) => s.isAdmin);
  const editorMode = useGameStore((s) => s.editorMode);
  const toggleEditorMode = useGameStore((s) => s.toggleEditorMode);
  const selectedTileType = useGameStore((s) => s.selectedTileType);
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
    if (currentTiles[y]?.[x]) {
      currentTiles[y][x].type = type;
      setTiles(currentTiles);
    }
  }, [setTiles]);

  const handleTileHistoryPush = useCallback(() => {
    const state = useGameStore.getState();
    pushTileHistory(state.tiles.map((row) => row.map((t) => t.type)));
  }, [pushTileHistory]);

  const handleRoomSave = useCallback(() => {
    const state = useGameStore.getState();
    const tileData = state.tiles.map((row) => row.map((t) => ({ type: t.type, x: t.x, y: t.y })));
    emitRoomUpdate(tileData);
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

  const savedConfig = loadAvatarConfig();

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
    <div className="w-screen h-screen overflow-hidden bg-gray-900">
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
        onTilePaint={handleTilePaint}
        onTileHistoryPush={handleTileHistoryPush}
      />

      <div className="absolute top-4 left-28 pointer-events-none">
        <p className="text-white/30 text-xs font-mono">WASD / Arrow keys to move</p>
      </div>
      <div className="absolute top-10 left-28 pointer-events-none">
        <p className="text-white/30 text-xs font-mono">
          Playing as: <span className="text-white/60">{playerName}</span>
        </p>
      </div>

      <ConnectionIndicator />

      <AvatarEditorButton onClick={() => setShowEditor(true)} />

      {isAdmin && (
        <button
          onClick={toggleEditorMode}
          className={`absolute bottom-4 left-28 z-30 px-3 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer ${editorMode ? 'bg-orange-500 text-white border-orange-400' : 'bg-gray-800/80 text-white/60 hover:text-white border-white/10'}`}
        >
          🛠️ {editorMode ? 'Editing...' : 'Edit Room'}
        </button>
      )}

      {isAdmin && editorMode && (
        <RoomEditor onSave={handleRoomSave} />
      )}

      {editorMode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-orange-500/90 text-white text-xs font-bold px-3 py-1 rounded-full pointer-events-none">
          🔧 EDIT MODE
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
        localStream={webrtcService.getLocalStream()}
        remoteStreams={remoteStreams}
        micMuted={isMicMuted}
        cameraOff={!isCameraOn}
      />

      {/* HUD Controls */}
      <div className="absolute bottom-24 left-1/2 -translate-x-1/2 flex gap-3 z-30">
        <MicButton muted={isMicMuted} onToggle={handleMicToggle} />
        <CameraButton enabled={isCameraOn} onToggle={handleCameraToggle} />
      </div>

      {/* Room name HUD + code */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-auto">
        <p className="text-white/40 text-xs font-medium tracking-wider uppercase">MAIN OFFICE</p>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(roomSlug);
            setRoomCodeCopied(true);
            setTimeout(() => setRoomCodeCopied(false), 2000);
          }}
          className="text-white/30 hover:text-white/70 text-xs cursor-pointer transition-colors"
          title="Copy room code"
        >
          📋 {roomSlug.slice(0, 12)}
        </button>
      </div>

      {roomCodeCopied && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 bg-white/10 text-white text-[10px] px-2 py-0.5 rounded-full pointer-events-none">
          Code copied!
        </div>
      )}

      {/* Leave Room button */}
      <div className="absolute top-4 left-4 pointer-events-auto">
        <button
          onClick={() => setShowLeaveConfirm(true)}
          className="text-red-400/60 hover:text-red-400 text-xs font-medium cursor-pointer transition-colors"
        >
          🚪 Leave
        </button>
      </div>

      {showLeaveConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-gray-800 rounded-xl p-6 shadow-2xl border border-white/10 text-center">
            <p className="text-white text-sm mb-4">Leave this room?</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLeaveConfirm(false)}
                className="px-4 py-2 rounded-lg bg-gray-700 text-white/70 hover:bg-gray-600 text-sm cursor-pointer"
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

      <ChatPanel
        messages={chatMessages}
        localPlayerName={playerName}
        onSend={handleChatSend}
        onBubble={emitBubble}
        onEmote={handleEmoteSelect}
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
          useGameStore.getState().setLocalPlayer({ x, y });
        }}
        visible={showMinimap}
      />
    </div>
  );
}

export default function App() {
  const { user, loading, error, login, register, logout } = useAuth();
  const [roomSlug, setRoomSlug] = useState<string | null>(null);
  const [playerName, setPlayerName] = useState<string | null>(null);
  const [showAvatarSetup, setShowAvatarSetup] = useState(false);
  const [isRoomReady, setIsRoomReady] = useState(false);
  const setRoomState = useGameStore((s) => s.setRoomState);
  const setLocalPlayer = useGameStore((s) => s.setLocalPlayer);

  // If authenticated, use user's displayName and avatarConfig
  useEffect(() => {
    if (user) {
      setPlayerName(user.displayName);
      setLocalPlayer({
        name: user.displayName,
        color: user.avatarConfig?.color || '#ff6b6b',
        avatarConfig: user.avatarConfig || undefined,
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
      <div className="w-screen h-screen bg-gray-900 flex items-center justify-center">
        <p className="text-white/40 text-sm">Loading VirtualMeet...</p>
      </div>
    );
  }

  // Auth gate
  if (!user) {
    return <LoginPage onLogin={async (e, p) => { await login(e, p); }} onRegister={async (e, p, n) => { await register(e, p, n); }} error={error} />;
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
      <div className="w-screen h-screen bg-gray-900 flex items-center justify-center">
        <p className="text-white text-xl">Loading VirtualMeet…</p>
      </div>
    );
  }

  return <Game roomSlug={roomSlug} onLeave={() => setRoomSlug(null)} authDisplayName={user.displayName} />;
}
