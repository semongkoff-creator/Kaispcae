import { useEffect, useState, useCallback, useRef } from 'react';
import { GearFill, Clipboard, Link45deg, PersonWalking, X, MagnetFill } from 'react-bootstrap-icons';
import { AvatarConfig, EmoteType, TileType, MAP_WIDTH, TILE_SIZE, Furniture, roleAtLeast, MediaType, MediaPayload, CONSENT_REQUEST_TIMEOUT_MS } from '@virtualmeet/shared';
import { PALETTE_BY_ID } from './data/themeAssets';
import { GameCanvas } from './components/canvas/GameCanvas';
import { ConnectionIndicator } from './components/ui/ConnectionIndicator';
import { NameModal } from './components/ui/NameModal';
import { AvatarSetup } from './components/avatar/AvatarSetup';
import { VideoGrid } from './components/ui/VideoGrid';
import { MeetingView } from './components/ui/MeetingView';
import { MiniMode, isMiniModeSupported, openMiniModeWindow } from './components/ui/MiniMode';
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
import { ActivityFeed } from './components/ui/ActivityFeed';
import { PendingRequestToast } from './components/ui/PendingRequestToast';
import { Sidebar } from './components/ui/Sidebar';
import { MicButton } from './components/hud/MicButton';
import { CameraButton } from './components/hud/CameraButton';
import { ScreenShareButton } from './components/hud/ScreenShareButton';
import { NotificationSettings } from './components/ui/NotificationSettings';
import { Lobby } from './pages/Lobby';
import { LoginPage } from './pages/LoginPage';
import { useAuth } from './hooks/useAuth';
import { useTheme, Theme } from './hooks/useTheme';
import { api } from './services/api';
import { createDefaultRoom, isTileBlocked } from './utils/createDefaultRoom';
import { useGameStore } from './stores/gameStore';
import { useSocket } from './hooks/useSocket';
import { useChannelChat } from './hooks/useChannelChat';
import { useProximity, findZoneAt } from './hooks/useProximity';
import { useWebRTC } from './hooks/useWebRTC';
import { useScreenRecording } from './hooks/useScreenRecording';
import { webrtcService } from './services/webrtcService';
import { loadAvatarConfig, saveAvatarConfig } from './hooks/useAvatarConfig';

// Shared phrasing for the two non-accepted outcomes a Summon/Follow request
// can resolve to — 'declined' and 'timeout' read very differently ("they
// said no" vs "they never answered"), so this is deliberately not a single
// generic "was declined" string.
function describeConsentDecline(reason: 'declined' | 'timeout' | 'offline' | undefined): string {
  if (reason === 'timeout') return "didn't respond to";
  if (reason === 'offline') return 'went offline before responding to';
  return 'declined';
}

// A mouse click (e.g. the "My Seat" sidebar button) never fires a keyup for
// whatever movement key the player happened to be physically holding at
// that instant — useMovement.ts's keysRef only clears a key on its own
// keyup (or the whole window losing focus, which a same-page click isn't).
// Without this, a teleport-then-sit request sent while a key is still
// "held" left the movement loop free to keep walking from the PRE-teleport
// position for the round-trip's duration (using its own currentXRef, which
// GameCanvas.tsx only resyncs to the new store position reactively, after
// React commits) — visible as the character taking a step or two, then
// blinking back before landing on the seat. Dispatching real keyup events
// reuses the exact listener useMovement.ts already has on window, so no
// change to that hook (or GameCanvas) is needed.
function releaseMovementKeys() {
  const keys: { key: string; code: string }[] = [
    { key: 'ArrowUp', code: 'ArrowUp' },
    { key: 'ArrowDown', code: 'ArrowDown' },
    { key: 'ArrowLeft', code: 'ArrowLeft' },
    { key: 'ArrowRight', code: 'ArrowRight' },
    { key: 'w', code: 'KeyW' },
    { key: 'a', code: 'KeyA' },
    { key: 's', code: 'KeyS' },
    { key: 'd', code: 'KeyD' },
    { key: 'r', code: 'KeyR' },
  ];
  for (const { key, code } of keys) {
    window.dispatchEvent(new KeyboardEvent('keyup', { key, code }));
  }
}

function Game({ roomSlug, onLeave, onLogout, onPortalTravel, authDisplayName, authUserId, theme, onToggleTheme }: { roomSlug: string; onLeave: () => void; onLogout: () => void; onPortalTravel: (slug: string) => void; authDisplayName: string; authUserId: string; theme: Theme; onToggleTheme: () => void }) {
  const playerName = useGameStore((s) => s.localPlayer.name);
  const { emitMove, emitStop, emitJump, emitNudge, emitAvatarUpdate, emitPlayerStatus, emitSit, emitFurnitureAssign, emitFurnitureUnassign, socketRef, emitChat, emitBubble, emitEmote, emitZoneEnter, emitZoneExit, emitRoomUpdate, emitAdminGrant, emitAdminRevoke, emitStaffGrant, emitStaffRevoke, emitKick, emitNoticePin, emitNoticeUnpin, emitFollowRequest, emitFollowRespond, emitFollowUnfollow, emitTeleportRequest, emitSummonUser, emitSummonRespond, emitMediaAdd, emitMediaRemove, emitWhiteboardStroke, emitWhiteboardClear, emitSpotlightToggle, emitRecordingStart, emitRecordingStop, emitRecordingFinalize, emitChannelJoin, emitChannelLeave, emitChannelMessageSend, emitDmJoin, emitDmLeave, emitDmMessageSend } = useSocket(authDisplayName, roomSlug, authUserId);
  const channelChat = useChannelChat(roomSlug, { emitChannelJoin, emitChannelLeave, emitChannelMessageSend, emitDmJoin, emitDmLeave, emitDmMessageSend });
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
    mediaError,
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
  const roomStateReceived = useGameStore((s) => s.roomStateReceived);
  const zones = useGameStore((s) => s.zones);
  const sittingFurnitureId = useGameStore((s) => s.sittingFurnitureId);
  const furniture = useGameStore((s) => s.furniture);
  const localUserId = useGameStore((s) => s.localUserId);
  const sittingItem = sittingFurnitureId ? furniture.find((f) => f.id === sittingFurnitureId) : undefined;
  const spotlightedUserIds = useGameStore((s) => s.spotlightedUserIds);

  // "My Seat" — one-click jump to whichever furniture is assigned to me in
  // THIS room (assignment is per-room, see Furniture.assignedToUserId).
  // If more than one piece is ever assigned to the same user (nothing stops
  // that today), the server picks whichever it finds first — same
  // simplification as here, not worth a seat picker for an edge case.
  const hasMySeat = furniture.some((f) => f.assignedToUserId === localUserId);
  const handleMySeat = useCallback(() => {
    releaseMovementKeys();
    emitTeleportRequest({ kind: 'seat' });
  }, [emitTeleportRequest]);

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

  // Mini Mode has to be opened directly inside a real click handler (see
  // openMiniModeWindow's own doc comment for why it can't live in a mount
  // effect) — this is that handler, now called from the Sidebar icon
  // instead of its own standalone floating button.
  const handleToggleMiniMode = useCallback(async () => {
    let win: Window | null = null;
    try {
      win = await openMiniModeWindow();
    } catch (e) {
      // Defense in depth — openMiniModeWindow shouldn't throw anymore
      // (every failure path inside it now resolves to null instead), but a
      // rejected promise here previously meant this whole handler crashed
      // silently: no window, no error message, nothing — exactly what
      // "clicking Mini Mode does nothing at all" looks like from outside.
      console.warn('[minimode] unexpected error opening window:', e);
    }
    if (win) {
      setMiniModeWindow(win);
    } else {
      // openMiniModeWindow already logs the underlying error to the
      // console — this is the user-visible half. addActivity alone isn't
      // enough: the Activity Feed panel starts collapsed (see
      // ActivityFeed.tsx), so a message logged there is invisible unless the
      // user happens to already have it open. A transient banner (same
      // pattern as the camera/mic mediaError one below) is what actually
      // gets seen — previously there was neither, so clicking read as
      // "nothing happens at all" regardless of what got logged.
      useGameStore.getState().addActivity('Mini Mode couldn’t be opened — try again.');
      setMiniModeError('Mini Mode couldn’t be opened — your browser may not support it (needs Chrome or Edge 116+), or blocked the popup.');
      if (miniModeErrorTimerRef.current) clearTimeout(miniModeErrorTimerRef.current);
      miniModeErrorTimerRef.current = setTimeout(() => setMiniModeError(null), 6000);
    }
  }, []);

  // §7 — Screen Recording
  const activeRecording = useGameStore((s) => s.activeRecording);
  const findSocketIdByUserId = useCallback(
    (userId: string) => Object.values(playerRecords).find((p) => p.userId === userId)?.id,
    [playerRecords],
  );
  const { requestRecording, stopMyRecording, isRecordingMine, uploading: recordingUploading } = useScreenRecording({
    activeRecording,
    localUserId,
    findSocketIdByUserId,
    emitRecordingStop,
    emitRecordingFinalize,
  });
  // §7 — "Myself" is always an available recording target, spotlight or
  // not: recording myself captures my whole screen/tab via getDisplayMedia
  // (see useScreenRecording.ts), not a peer connection, so there's no
  // reachability requirement the way there is for recording someone else.
  // This also means solo/testing use (no one around to spotlight) still
  // has something to record instead of the button just staying disabled.
  // Spotlighted others are listed after, excluding myself if I happen to
  // be spotlighted too (to avoid a duplicate "Myself" entry).
  const recordingTargets = [
    { userId: localUserId, name: `${localPlayer.name} (You)` },
    ...spotlightedUserIds
      .filter((uid) => uid !== localUserId)
      .map((uid) => {
        const p = Object.values(playerRecords).find((rec) => rec.userId === uid);
        return p ? { userId: uid, name: p.name } : null;
      })
      .filter((p): p is { userId: string; name: string } => !!p),
  ];

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
  // moment, then navigate back to the Lobby (React state, not a full page
  // reload).
  const roomDeletedNotice = useGameStore((s) => s.roomDeletedNotice);
  useEffect(() => {
    if (!roomDeletedNotice) return;
    const timer = setTimeout(() => {
      useGameStore.getState().setRoomDeletedNotice(null);
      onLeave();
    }, 2500);
    return () => clearTimeout(timer);
  }, [roomDeletedNotice, onLeave]);

  // Removed from the room by an admin's Kick (see shared/permissions.ts's
  // 'room:kick') — same "show it, then navigate back to the Lobby" pattern
  // as roomDeletedNotice above.
  const kickedNotice = useGameStore((s) => s.kickedNotice);
  useEffect(() => {
    if (!kickedNotice) return;
    const timer = setTimeout(() => {
      useGameStore.getState().setKickedNotice(null);
      onLeave();
    }, 2500);
    return () => clearTimeout(timer);
  }, [kickedNotice, onLeave]);

  // Summon/Follow consent requests (see PendingRequestToast.tsx). Incoming
  // requests auto-clear on the same clock the server uses to auto-decline
  // them (CONSENT_REQUEST_TIMEOUT_MS) so the toast never outlives a request
  // that's already dead server-side; result toasts are a one-off ping.
  const incomingSummonRequest = useGameStore((s) => s.incomingSummonRequest);
  useEffect(() => {
    if (!incomingSummonRequest) return;
    const timer = setTimeout(() => useGameStore.getState().setIncomingSummonRequest(null), CONSENT_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [incomingSummonRequest]);

  const summonResult = useGameStore((s) => s.summonResult);
  useEffect(() => {
    if (!summonResult) return;
    const timer = setTimeout(() => useGameStore.getState().setSummonResult(null), 3000);
    return () => clearTimeout(timer);
  }, [summonResult]);

  const incomingFollowRequest = useGameStore((s) => s.incomingFollowRequest);
  useEffect(() => {
    if (!incomingFollowRequest) return;
    const timer = setTimeout(() => useGameStore.getState().setIncomingFollowRequest(null), CONSENT_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [incomingFollowRequest]);

  const followResult = useGameStore((s) => s.followResult);
  useEffect(() => {
    if (!followResult) return;
    const timer = setTimeout(() => useGameStore.getState().setFollowResult(null), 3000);
    return () => clearTimeout(timer);
  }, [followResult]);

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
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [roomCodeCopied, setRoomCodeCopied] = useState(false);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);

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
  const notice = useGameStore((s) => s.notice);
  const followInfo = useGameStore((s) => s.followInfo);
  const [showEmoteWheel, setShowEmoteWheel] = useState(false);
  const [showMinimap, setShowMinimap] = useState(true);
  const [meetingViewActive, setMeetingViewActive] = useState(false);
  const [miniModeWindow, setMiniModeWindow] = useState<Window | null>(null);
  const [miniModeError, setMiniModeError] = useState<string | null>(null);
  const miniModeErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Simplified View — hides everything that isn't about "who's here and
  // talking": the feature sidebar, minimap, room-meta hint text, and the
  // participant/notice panels. Its own toggle deliberately lives OUTSIDE the
  // sidebar (a fixed corner button) since the sidebar is exactly what gets
  // hidden — there'd be no way back otherwise.
  const [simplifiedView, setSimplifiedView] = useState(false);

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

  // B key for emote wheel, M key for minimap — was Z, but Z is now the
  // nudge/senggol key (GameCanvas.tsx), and both handlers listen on the
  // same window keydown, so a single Z press fired the emote wheel toggle
  // here AND the nudge attempt there at once.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'b' || e.key === 'B') {
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

  // Until the real room:state for THIS room arrives, `roomState` in the
  // store is still whatever App() seeded at startup (always the Main
  // Office layout, regardless of which room/template was actually joined
  // — see gameStore.ts's roomStateReceived doc comment). Render a plain
  // loading placeholder instead of GameCanvas rather than briefly showing
  // the wrong room shape (and risking a spawn tile that's a wall in the
  // real layout).
  if (!roomStateReceived) {
    return (
      <div className="w-screen h-screen bg-gradient-to-br from-white to-purple-50 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400 text-xl">Joining room…</p>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-purple-50">
      <GameCanvas
        emitMove={emitMove}
        emitStop={emitStop}
        emitJump={emitJump}
        emitNudge={emitNudge}
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

      {miniModeWindow && (
        <MiniMode
          pipWindow={miniModeWindow}
          nearby={nearby}
          localStream={webrtcService.getLocalStream()}
          remoteStreams={remoteStreams}
          remoteScreenStreams={remoteScreenStreams}
          micMuted={isMicMuted}
          cameraOff={!isCameraOn}
          onToggleMic={handleMicToggle}
          onToggleCamera={handleCameraToggle}
          onClose={() => setMiniModeWindow(null)}
        />
      )}

      {!simplifiedView && (
        <>
          <div className="absolute top-4 left-28 pointer-events-none">
            <p className="text-gray-500 dark:text-gray-400 text-xs font-mono">WASD / Arrows to move · hold R to run · Space to jump · Z to nudge</p>
          </div>
          <div className="absolute top-10 left-28 pointer-events-none">
            <p className="text-gray-500 dark:text-gray-400 text-xs font-mono">
              Playing as: <span className="text-gray-700 dark:text-gray-300">{playerName}</span>
            </p>
          </div>
          <div className="absolute top-14 left-16 flex items-start gap-2 pointer-events-none">
            <ParticipantPanel remoteStreams={remoteStreams} emitFollowRequest={emitFollowRequest} emitFollowUnfollow={emitFollowUnfollow} emitSummonUser={emitSummonUser} emitSpotlightToggle={emitSpotlightToggle} onStartDm={channelChat.startDm} emitKick={emitKick} />
            <ActivityFeed />
          </div>
        </>
      )}

      <ConnectionIndicator />

      {/* Follow (§3) indicator — only the ONE new thing from this pass that's
          always visible without opening a panel first. 'standby' means the
          target went offline; movement pauses but the relationship is kept
          server-side (see followHandler.ts) and resumes automatically the
          moment they reconnect, no need to click Follow again. */}
      {followInfo && (
        <div className="absolute bottom-28 left-16 z-30 pointer-events-auto">
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

      {/* Summon/Follow consent toasts — z-50 so they win over the Follow
          indicator below, which sits at the same bottom-28 corner. Incoming
          requests need Accept/Decline; results are a one-off ping about a
          request I sent. */}
      <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2">
        {incomingSummonRequest && (
          <PendingRequestToast
            icon={<MagnetFill size={13} className="text-amber-500" />}
            message={<><span className="font-medium">{incomingSummonRequest.actorName}</span> wants to summon you to their location</>}
            onAccept={() => { emitSummonRespond(incomingSummonRequest.requestId, true); useGameStore.getState().setIncomingSummonRequest(null); }}
            onDecline={() => { emitSummonRespond(incomingSummonRequest.requestId, false); useGameStore.getState().setIncomingSummonRequest(null); }}
          />
        )}
        {incomingFollowRequest && (
          <PendingRequestToast
            icon={<PersonWalking size={13} className="text-purple-600" />}
            message={<><span className="font-medium">{incomingFollowRequest.actorName}</span> wants to follow you</>}
            onAccept={() => { emitFollowRespond(incomingFollowRequest.requestId, true); useGameStore.getState().setIncomingFollowRequest(null); }}
            onDecline={() => { emitFollowRespond(incomingFollowRequest.requestId, false); useGameStore.getState().setIncomingFollowRequest(null); }}
          />
        )}
        {summonResult && (
          <div className="bg-purple-600/90 text-white text-xs font-semibold px-4 py-2 rounded-full shadow-lg pointer-events-none inline-flex items-center gap-1.5">
            <MagnetFill size={13} />
            {summonResult.accepted
              ? `${summonResult.targetName} accepted your summon request`
              : `${summonResult.targetName} ${describeConsentDecline(summonResult.reason)} your summon request`}
          </div>
        )}
        {followResult && (
          <div className="bg-purple-600/90 text-white text-xs font-semibold px-4 py-2 rounded-full shadow-lg pointer-events-none inline-flex items-center gap-1.5">
            <PersonWalking size={13} />
            {followResult.accepted
              ? `${followResult.targetName} accepted your follow request`
              : `${followResult.targetName} ${describeConsentDecline(followResult.reason)} your follow request`}
          </div>
        )}
      </div>

      {/* ZEP-style left icon rail — every room-level feature button used to
          be its own absolutely-positioned floating pill scattered around
          the screen edges (Meeting View/Simplify/Mini Mode top-right,
          Teleport/Add Media/Record bottom-left, ...), which had started
          overflowing/wrapping and reading as cluttered once enough features
          landed in the same session. Now it's one rail, one icon per
          feature; each feature's own panel/popover opens to the right of
          the rail instead of scattered across the screen. Always rendered
          (not conditional on simplifiedView) — it collapses to just the
          "Show UI" exit icon internally when simplified, since that's the
          one thing that must always stay reachable. */}
      <Sidebar
        onEditAvatar={() => setShowEditor(true)}
        status={localPlayer.status || ''}
        onSaveStatus={handleStatusSave}
        isAdmin={isAdmin}
        editorMode={editorMode}
        onToggleEditorMode={toggleEditorMode}
        canTeleport={roleAtLeast(localRole, 'staff')}
        showTeleportPanel={showTeleportPanel}
        onToggleTeleport={() => setShowTeleportPanel((v) => !v)}
        hasMySeat={hasMySeat}
        onMySeat={handleMySeat}
        meetingViewActive={meetingViewActive}
        onToggleMeetingView={() => setMeetingViewActive((v) => !v)}
        simplifiedView={simplifiedView}
        onToggleSimplifiedView={() => setSimplifiedView((v) => !v)}
        miniModeSupported={isMiniModeSupported()}
        miniModeActive={!!miniModeWindow}
        onToggleMiniMode={handleToggleMiniMode}
        showAddMediaPanel={showAddMediaPanel}
        onToggleAddMedia={() => setShowAddMediaPanel((v) => !v)}
        canRecord={isAdmin}
        recordingTargets={recordingTargets}
        activeRecording={activeRecording}
        isRecordingMine={isRecordingMine}
        recordingUploading={recordingUploading}
        roomSlug={roomSlug}
        onStartRecording={(targetUserId, title) => requestRecording(targetUserId, title, emitRecordingStart)}
        onStopRecording={stopMyRecording}
        onLeaveRoom={onLeave}
        onLogout={() => setShowLogoutConfirm(true)}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />

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

      {meetingViewActive ? (
        <MeetingView
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
          onClose={() => setMeetingViewActive(false)}
        />
      ) : (
        <>
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
        </>
      )}

      {/* HUD Controls — z-50 so mic/camera/screen-share stay reachable even
          while Meeting View's z-40 full-screen overlay is active; without
          this there was no way to mute/unmute or stop screen share without
          exiting Meeting View first. */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-2 z-50">
        <MicButton muted={isMicMuted} onToggle={handleMicToggle} />
        <CameraButton enabled={isCameraOn} onToggle={handleCameraToggle} />
        <ScreenShareButton sharing={isScreenSharing} onToggle={handleScreenShareToggle} />
        <NotificationSettings />
      </div>

      {/* Only shown once getUserMedia has actually failed (denied / no
          device) — otherwise clicking Mic/Camera with no stream yet just
          silently did nothing, with no way to tell a permission problem
          apart from "the button is broken". */}
      {mediaError && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 bg-red-50 dark:bg-red-900/80 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-200 text-xs px-3 py-1.5 rounded-full shadow-sm pointer-events-none">
          {mediaError} — click Mic or Camera below to retry
        </div>
      )}

      {/* Self-dismissing (see handleToggleMiniMode) — a one-off action
          failure, not an ongoing state like mediaError above, so it doesn't
          need to stick around until the user does something about it. */}
      {miniModeError && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 bg-red-50 dark:bg-red-900/80 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-200 text-xs px-3 py-1.5 rounded-full shadow-sm pointer-events-none max-w-md text-center">
          {miniModeError}
        </div>
      )}

      {/* Room name HUD + code */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-auto">
        <p className="text-gray-500 dark:text-gray-400 text-xs font-medium tracking-wider uppercase">MAIN OFFICE</p>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(roomSlug);
            setRoomCodeCopied(true);
            setTimeout(() => setRoomCodeCopied(false), 2000);
          }}
          className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-xs cursor-pointer transition-colors inline-flex items-center gap-1"
          title="Copy room code"
        >
          <Clipboard size={11} /> {roomSlug.slice(0, 12)}
        </button>
        <button
          onClick={async () => {
            // ?join=<slug> — read back on load by App()'s own pending-invite
            // effect below, which auto-joins this exact room once the
            // clicker is authenticated (logging in first if they weren't).
            const url = new URL(window.location.href);
            url.search = '';
            url.searchParams.set('join', roomSlug);
            await navigator.clipboard.writeText(url.toString());
            setInviteLinkCopied(true);
            setTimeout(() => setInviteLinkCopied(false), 2000);
          }}
          className="text-gray-400 hover:text-gray-700 text-xs cursor-pointer transition-colors inline-flex items-center gap-1"
          title="Copy invite link"
        >
          <Link45deg size={12} /> Invite
        </button>
      </div>

      {roomCodeCopied && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 bg-purple-100 text-purple-700 text-[10px] px-2 py-0.5 rounded-full pointer-events-none">
          Code copied!
        </div>
      )}
      {inviteLinkCopied && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 bg-purple-100 text-purple-700 text-[10px] px-2 py-0.5 rounded-full pointer-events-none">
          Invite link copied!
        </div>
      )}

      {showLogoutConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 text-center">
            <p className="text-gray-900 dark:text-gray-100 text-sm mb-4">Log out of your account?</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLogoutConfirm(false)}
                className="px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowLogoutConfirm(false); onLogout(); }}
                className="px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm cursor-pointer"
              >
                Logout
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
          <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 text-center max-w-xs">
            <p className="text-gray-900 dark:text-gray-100 text-sm font-medium mb-1">{roomDeletedNotice}</p>
            <p className="text-gray-400 dark:text-gray-500 text-xs">Returning to the Lobby...</p>
          </div>
        </div>
      )}

      {kickedNotice && (
        <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 text-center max-w-xs">
            <p className="text-gray-900 dark:text-gray-100 text-sm font-medium mb-1">{kickedNotice}</p>
            <p className="text-gray-400 dark:text-gray-500 text-xs">Returning to the Lobby...</p>
          </div>
        </div>
      )}

      {notice && !simplifiedView && (
        <NoticeBanner notice={notice} isAdmin={isAdmin} onUnpin={emitNoticeUnpin} />
      )}

      <ChatPanel
        localPlayerName={playerName}
        localUserId={authUserId}
        onBubble={emitBubble}
        onEmote={handleEmoteSelect}
        currentZone={currentZone}
        zoneMessages={currentZone ? zoneChatHistory[currentZone.id] ?? [] : []}
        onSendZone={handleSendZoneChat}
        isAdmin={isAdmin}
        onPinNotice={handlePinNotice}
        open={channelChat.chatPanelOpen}
        onToggleOpen={channelChat.setChatPanelOpen}
        channels={channelChat.channels}
        dmConversations={channelChat.dmConversations}
        activeChatTarget={channelChat.activeChatTarget}
        onSelectTarget={channelChat.setActiveChatTarget}
        messages={channelChat.activeMessages}
        onSend={channelChat.sendMessage}
        onLoadOlder={channelChat.loadOlder}
        onCreateChannel={channelChat.createChannel}
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
        visible={showMinimap && !simplifiedView}
      />
    </div>
  );
}

export default function App() {
  const { user, loading, error, sessionExpiredMessage, login, register, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [roomSlug, setRoomSlug] = useState<string | null>(null);

  // Invite links (see the "Copy invite link" button in Game() above) are
  // just this app's own URL with ?join=<slug> appended. Also mirrored into
  // sessionStorage, not just this component's own state: the login/register
  // form below causes an unrelated full page reload on submit in some
  // browsers (a native form-submit fallback, despite handleSubmit's own
  // preventDefault — observed even on a totally plain register flow once a
  // query string had been present at some point in the tab's history), which
  // would otherwise silently drop the pending invite the instant someone
  // registers straight from a shared link. sessionStorage survives that
  // reload (same tab); a fresh URL always wins over whatever's already there.
  const PENDING_INVITE_KEY = 'vm_pending_invite_slug';
  const [pendingInviteSlug, setPendingInviteSlug] = useState<string | null>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('join');
    if (fromUrl) {
      sessionStorage.setItem(PENDING_INVITE_KEY, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(PENDING_INVITE_KEY);
  });

  // Scrub ?join=... back out of the visible URL immediately — the slug
  // itself isn't secret (it's the same code "Copy room code" hands out),
  // but leaving it sitting in the address bar after the invite's been
  // consumed reads as broken/stale if the link is reshared from there.
  useEffect(() => {
    if (!pendingInviteSlug) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('join');
    window.history.replaceState({}, '', url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-join once BOTH a pending invite exists AND we know who's asking —
  // covers "already logged in, clicked a link" immediately, and "not logged
  // in yet" the moment `user` flips truthy right after they log in/register
  // (LoginPage below renders as normal in the meantime; nothing here forces
  // that flow, it just waits on it). A dead/deleted room's slug fails
  // getRoom() and falls through to the ordinary Lobby, not a blank screen.
  useEffect(() => {
    if (!user || !pendingInviteSlug || roomSlug) return;
    const slug = pendingInviteSlug;
    setPendingInviteSlug(null);
    sessionStorage.removeItem(PENDING_INVITE_KEY);
    api.getRoom(slug).then((room) => setRoomSlug(room.slug)).catch(() => {});
  }, [user, pendingInviteSlug, roomSlug]);

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
    return <LoginPage onLogin={async (e, p) => { await login(e, p); }} onRegister={async (e, p, n) => { await register(e, p, n); }} error={error} sessionExpiredMessage={sessionExpiredMessage} theme={theme} onToggleTheme={toggleTheme} />;
  }

  // Lobby
  if (!roomSlug) {
    return <Lobby user={user} onJoinRoom={setRoomSlug} onLogout={logout} theme={theme} onToggleTheme={toggleTheme} />;
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

  // key={roomSlug} — portal travel (handlePortalEnter -> onPortalTravel ->
  // setRoomSlug) previously updated roomSlug on the SAME mounted Game
  // instance, so its own useState (meetingViewActive, simplifiedView,
  // miniModeWindow, showMinimap, ...) all survived into the new room
  // untouched — e.g. still full-screen in Meeting View, or a Mini Mode PiP
  // window still open, with no signal anything changed underneath. Forcing
  // a remount on room change gives every room a clean slate, matching what
  // already happens when leaving to the Lobby and rejoining.
  return <Game key={roomSlug} roomSlug={roomSlug} onLeave={() => setRoomSlug(null)} onLogout={logout} onPortalTravel={setRoomSlug} authDisplayName={user.displayName} authUserId={user.id} theme={theme} onToggleTheme={toggleTheme} />;
}
