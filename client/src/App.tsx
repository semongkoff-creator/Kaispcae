import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { Clipboard, Link45deg, PersonWalking, X, MagnetFill, HandIndexThumbFill, PersonPlusFill, DoorOpenFill, VolumeUpFill, BriefcaseFill, Display } from 'react-bootstrap-icons';
import { Avatar, AvatarConfig, EmoteType, TileType, MAP_WIDTH, TILE_SIZE, Furniture, roleAtLeast, MediaType, MediaPayload, CONSENT_REQUEST_TIMEOUT_MS, WorkMode, SocketEvents } from '@kaispace/shared';
import { PALETTE_BY_ID } from './data/themeAssets';
import type { ManualStatus } from './data/presence';
import { GameCanvas } from './components/canvas/GameCanvas';
import { ConnectionIndicator } from './components/ui/ConnectionIndicator';
import { Tooltip } from './components/ui/Tooltip';
import { MapZoomControl } from './components/ui/MapZoomControl';
import { MobileControls } from './components/hud/MobileControls';
import { NameModal } from './components/ui/NameModal';
import { AvatarSetup } from './components/avatar/AvatarSetup';
import { VideoGrid } from './components/ui/VideoGrid';
import { MeetingView } from './components/ui/MeetingView';
// QA (Kompat checklist item 7) — same reasoning as RoomEditorPage above:
// only a workspace admin ever opens this (AdminConsole itself re-gates on
// workspaceRole, see its own file), so splitting it out means the far more
// common case (an ordinary member who never opens it) never pays for its
// code at all.
const AdminConsole = lazy(() => import('./admin/AdminConsole').then((m) => ({ default: m.AdminConsole })));
// Operator-only, same "don't pay for code you never load" reasoning as
// AdminConsole above — an even smaller audience (one person today).
const OperatorConsole = lazy(() => import('./operator/OperatorConsole').then((m) => ({ default: m.OperatorConsole })));
// Productivity Analytics — every real employee can open this (see PanelId's
// doc comment), so it's split out for the same "don't pay for code you
// never load" reason as AdminConsole above, just for a much larger audience.
const MyAnalyticsPanel = lazy(() => import('./admin/MyAnalyticsPanel').then((m) => ({ default: m.MyAnalyticsPanel })));
import { CalendarApp } from './components/Calendar/CalendarApp';
import { AttendanceApp } from './components/Attendance/AttendanceApp';
import { toCurrentUser, type CurrentUser } from './hooks/useCurrentUser';
import { isTypingTarget, shouldIgnoreRoomHotkey } from './utils/hotkeys';
import { useZoneLock } from './hooks/useZoneLock';
import { ZoneLockBar } from './components/ui/ZoneLockBar';
import { MiniMode, isMiniModeSupported, openMiniModeWindow } from './components/ui/MiniMode';
import { ChatPanel } from './components/ui/ChatPanel';
import { setProfileName } from './hooks/useProfiles';
import { JoinGate, JoinRequestPanel } from './components/ui/JoinApproval';
import { MessengerApp } from './components/Messenger/MessengerApp';
import { NoticeBanner } from './components/ui/NoticeBanner';
import { EmoteWheel } from './components/ui/EmoteWheel';
import { BookingForm } from './components/ui/BookingForm';
import { SettingsPanel } from './components/ui/SettingsPanel';
import { Minimap } from './components/hud/Minimap';
import { AdminPanel } from './components/ui/AdminPanel';
import { TeleportPanel } from './components/ui/TeleportPanel';
// QA (Kompat checklist item 7, "Low-spec") — lazy: the Room Editor (tile
// palette, canvas editing tools, etc.) only ever renders behind the
// ?roomEditor= query-param gate below, in its own tab per this file's own
// doc comment — an ordinary player visiting the room to just walk around
// and chat has zero use for any of that code, but was downloading and
// JIT-compiling it as part of the single main bundle regardless (see
// TESTING.md's "no code-splitting" gap). Splitting it into its own chunk
// means only whoever actually opens the editor pays that cost.
const RoomEditorPage = lazy(() => import('./pages/RoomEditorPage').then((m) => ({ default: m.RoomEditorPage })));
import { useBgm } from './hooks/useBgm';
import { AddMediaPanel } from './components/ui/AddMediaPanel';
import { MediaViewerModal } from './components/ui/MediaViewerModal';
import { InteractiveObjectModal } from './components/ui/InteractiveObjectModal';
import { NoteModal } from './components/ui/NoteModal';
import { TutorialModal } from './components/ui/TutorialModal';
import { UserGuidePanel } from './components/ui/UserGuidePanel';
import { StatusPickModal } from './components/ui/StatusPickModal';
import { MemberListPanel } from './components/ui/MemberListPanel';
import { ParticipantPanel } from './components/ui/ParticipantPanel';
import { PlayerCard } from './components/ui/PlayerCard';
import { ReportUserModal } from './components/ui/ReportUserModal';
import { GlobalModal } from './components/ui/GlobalModal';
import { SoundboardPanel } from './components/ui/SoundboardPanel';
import { MusicPlayerWidget } from './components/ui/MusicPlayerWidget';
import { AwayReasonModal } from './components/ui/AwayReasonModal';
import { ActivityFeed } from './components/ui/ActivityFeed';
import { PendingRequestToast } from './components/ui/PendingRequestToast';
import { RemoteHelpBanner } from './components/ui/RemoteHelpBanner';
import { RemoteHelpCredentialForm } from './components/ui/RemoteHelpCredentialForm';
import { RustdeskSetupHint } from './components/ui/RustdeskSetupHint';
import { Sidebar } from './components/ui/Sidebar';
import { MicButton } from './components/hud/MicButton';
import { HandButton } from './components/hud/HandButton';
import { playHandRaiseSound, updateSoundboardVolumes } from './services/soundEffects';
import { CameraButton } from './components/hud/CameraButton';
import { DeviceMenu } from './components/hud/DeviceMenu';
import { ScreenShareButton } from './components/hud/ScreenShareButton';
import { EmojiButton } from './components/hud/EmojiButton';
import { ParticipantsToggleButton } from './components/hud/ParticipantsToggleButton';
import { LeaveButton } from './components/hud/LeaveButton';
import { Lobby } from './pages/Lobby';
import { LoginPage } from './pages/LoginPage';
import { GuestEntry, GuestSession } from './pages/GuestEntry';
import { JoinOrgInvite } from './pages/JoinOrgInvite';
import { useAuth } from './hooks/useAuth';
import { useTheme, Theme } from './hooks/useTheme';
import { api, UserPreferences } from './services/api';
import { createDefaultRoom, isTileBlocked } from './utils/createDefaultRoom';
import { useGameStore } from './stores/gameStore';
import { showAlert, showConfirm, showPrompt } from '@/stores/modalStore';
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

// "Ngobrol dengan CEO" v2 — HH:MM in the viewer's own timezone, for booking
// toasts/widgets. Deliberately no date shown — bookings are always same-day
// (see BookingForm.tsx's own toTodayOrTomorrow reasoning).
function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
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

// Idle window before a player is auto-prompted for an Away reason (Fitur 3B).
const AFK_IDLE_MS = 120000; // 2 minutes

// Fitur 15B — 'show_word_balloon' Interactive Object's "Random" style pool,
// picked once per trigger (see handleInteractiveTrigger below).
const WORD_BALLOON_RANDOM_COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#ddd6fe'];

function Game({ roomSlug, onLeave, onLogout, onPortalTravel, authDisplayName, authUserId, currentUser, theme, onToggleTheme, guestToken, isGuest, onUpdatePreferences }: { roomSlug: string; onLeave: () => void; onLogout: () => void; onPortalTravel: (slug: string) => void; authDisplayName: string; authUserId: string; currentUser: CurrentUser; theme: Theme; onToggleTheme: () => void; guestToken?: string; isGuest?: boolean; onUpdatePreferences?: (patch: UserPreferences) => void }) {
  const playerName = useGameStore((s) => s.localPlayer.name);
  const { emitMove, emitStop, emitJump, emitNudge, emitAvatarUpdate, emitWorkMode, emitTeleportTo, emitPlayerHand, emitPlayerMic, emitPlayerHidden, emitSit, emitFurnitureAssign, emitFurnitureUnassign, emitNoteAdd, emitNoteEdit, emitNoteDelete, emitRosterListRequest, emitClaimSeat, emitReleaseSeat, socketRef, emitChat, emitBubble, emitEmote, emitZoneEnter, emitZoneExit, emitAdminGrant, emitAdminRevoke, emitStaffGrant, emitStaffRevoke, emitCeoGrant, emitCeoRevoke, emitKick, emitForceMute, emitDoorOverride, emitNoticePin, emitNoticeUnpin, emitFollowRequest, emitFollowRespond, emitFollowUnfollow, emitRemoteHelpRequest, emitRemoteHelpRespond, emitRemoteHelpCredential, emitRemoteHelpEnd, emitTeleportRequest, emitSummonUser, emitSummonRespond, emitForcePull, emitSlap, emitMediaAdd, emitMediaRemove, emitWhiteboardStroke, emitWhiteboardClear, emitRecordingStart, emitRecordingStop, emitRecordingFinalize, emitChannelJoin, emitChannelLeave, emitChannelMessageSend, emitDmJoin, emitDmLeave, emitDmMessageSend, emitChannelTyping, emitDmTyping, emitDeleteMessage, emitEditMessage, emitPinMessage, emitMarkRead, emitInteractivePasswordCheck, emitInteractiveChoiceCheck, emitInteractiveApiCall, emitInteractiveChangeObject, emitInteractiveDoorPasswordCheck, emitInteractiveDoorAreaPasswordCheck, emitSoundboardPlay, emitSpotlight, emitBroadcastSend, emitGuestJoinDecide } = useSocket(authDisplayName, roomSlug, authUserId, guestToken);
  const channelChat = useChannelChat(roomSlug, { emitChannelJoin, emitChannelLeave, emitChannelMessageSend, emitDmJoin, emitDmLeave, emitDmMessageSend, emitChannelTyping, emitDmTyping, emitDeleteMessage, emitEditMessage, emitPinMessage, emitMarkRead });
  // ZEP-style User Guide — Sidebar's "Panduan" row (Room Features menu).
  // Independent of MainApp's own first-run TutorialModal gate (shown before
  // <Game> ever mounts, for new accounts/guests) — that one is untouched,
  // different purpose (a forced onboarding step, not a reference doc).
  //
  // Fix panel numpuk, round 2 — showEditor/showUserGuide/showMemberList used
  // to each be their own independent useState here, so e.g. Avatar Setup and
  // the Member List could both be open at once. Folded into the same
  // activePanel single-slot store the Sidebar's own Room Features dropdown
  // and Soundboard already used (round 1) — see the *Active consts below.

  // Media state from store — setters only. The VALUES (localSpeaking,
  // speakingPlayers) are deliberately NOT read here any more (tile flicker
  // diagnosis — measured 20 re-renders of this entire component, cascading
  // into every video tile, per 12s of continuous speech): speakingPlayers is
  // a Set rebuilt on every change, so subscribing to it directly at this top
  // level re-rendered the WHOLE room UI on every speaking edge, for every
  // peer. GameCanvas — the only consumer — reads both directly from the
  // store inside its own animation-frame loop instead (see its own comment),
  // and VideoTile already has its own isolated per-tile selector. Nothing
  // else in this component needs the raw values, only the stable setters
  // below (which don't cause this component to re-render on their own).
  const setLocalSpeaking = useGameStore((s) => s.setLocalSpeaking);
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
    screenShareError,
    failedPeers,
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
  const isSocketConnected = useGameStore((s) => s.isConnected);
  const roomFullNotice = useGameStore((s) => s.roomFullNotice);
  // QA (Fallback checklist item 9, "Server down: status jelas, auto-retry,
  // tak hang") — before this, an unreachable server (down, or a network
  // that can't complete the handshake at all) left the user staring at a
  // bare "Joining room…" string FOREVER: socket.io's own reconnection is
  // infinite by default (never fires 'reconnect_failed'), so nothing ever
  // flipped this into a terminal state. This timer is purely a UI decision,
  // not a real give-up — the underlying socket keeps retrying regardless —
  // it just stops pretending "almost there" past a point where that's
  // clearly no longer true, and gives an actual way out (reload) instead of
  // an indefinite spinner. Resets whenever roomStateReceived flips true or
  // the room being joined changes (see the effect below).
  const [joinTimedOut, setJoinTimedOut] = useState(false);
  useEffect(() => {
    if (roomStateReceived) { setJoinTimedOut(false); return; }
    const JOIN_TIMEOUT_MS = 12000;
    const timer = setTimeout(() => setJoinTimedOut(true), JOIN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [roomStateReceived, roomSlug]);
  const guestWaitState = useGameStore((s) => s.guestWaitState);
  const pendingGuests = useGameStore((s) => s.pendingGuests);
  const zones = useGameStore((s) => s.zones);
  const sittingFurnitureId = useGameStore((s) => s.sittingFurnitureId);
  const furniture = useGameStore((s) => s.furniture);
  const notes = useGameStore((s) => s.notes);
  const doorOverride = useGameStore((s) => s.doorOverride);
  const localUserId = useGameStore((s) => s.localUserId);
  const sittingItem = sittingFurnitureId ? furniture.find((f) => f.id === sittingFurnitureId) : undefined;
  const sitNotice = useGameStore((s) => s.sitNotice);
  // A "couldn't sit" notice (chair taken) self-dismisses — one-off action
  // failure, same treatment as miniModeError.
  useEffect(() => {
    if (!sitNotice) return;
    const t = setTimeout(() => useGameStore.getState().setSitNotice(null), 2500);
    return () => clearTimeout(t);
  }, [sitNotice]);

  // "My Seat" — one-click jump to whichever furniture is assigned to me in
  // THIS room (assignment is per-room, see Furniture.assignedToUserId).
  // If more than one piece is ever assigned to the same user (nothing stops
  // that today), the server picks whichever it finds first — same
  // simplification as here, not worth a seat picker for an edge case.
  //
  // Tahap 3 — claimable-seat markers (seatClaims) are a second, independent
  // source of "my seat": in-memory only, not in Room.furniture, so they
  // don't go through the DB-backed TELEPORT_REQUEST 'seat' lookup below.
  // Furniture takes priority if somehow both exist for the same user (an
  // edge case, same "not worth a picker" call as above).
  const seatClaims = useGameStore((s) => s.seatClaims);
  const tiles = useGameStore((s) => s.tiles);
  const doorAreaRects = useGameStore((s) => s.doorAreaRects);
  const myClaimedSeatId = Object.keys(seatClaims).find((id) => seatClaims[id].userId === localUserId);
  const hasMySeat = furniture.some((f) => f.assignedToUserId === localUserId) || !!myClaimedSeatId;
  const handleMySeat = useCallback(() => {
    releaseMovementKeys();
    if (!furniture.some((f) => f.assignedToUserId === localUserId) && myClaimedSeatId) {
      // Resolve the marker's tile from the live tiles grid (its position only
      // ever lives there, see mapLayers.ts's TileEffect 'claimableSeat') and
      // teleport there directly — same primitive (PLAYER_TELEPORT_TO) the
      // marker's own click handler in GameCanvas.tsx uses, not a second
      // teleport system. socket.to() there excludes the sender, so the local
      // position is set here too; GameCanvas's existing effect that keeps its
      // movement source-of-truth in sync with localPlayer.x/y picks this up.
      for (let y = 0; y < tiles.length; y++) {
        const row = tiles[y];
        const x = row?.findIndex((t) => t?.claimableSeatId === myClaimedSeatId) ?? -1;
        if (x >= 0) {
          const cx = x * TILE_SIZE + TILE_SIZE / 2;
          const cy = y * TILE_SIZE + TILE_SIZE / 2;
          const store = useGameStore.getState();
          store.setLocalPlayer({ x: cx, y: cy, isMoving: false });
          emitTeleportTo(cx, cy, store.localPlayer.direction);
          return;
        }
      }
    }
    emitTeleportRequest({ kind: 'seat' });
  }, [emitTeleportRequest, emitTeleportTo, furniture, localUserId, myClaimedSeatId, tiles]);

  const nearby = useProximity(
    { x: localPlayer.x, y: localPlayer.y, id: localPlayerId, isSitting: localPlayer.isSitting, seatFurnitureId: localPlayer.seatFurnitureId, workMode: localPlayer.workMode },
    playerRecords,
    zones,
    furniture,
  );

  // Potong 6 — area background music. Conversation (any full-connected peer)
  // always takes priority: the hook pauses the music while one is active.
  const bgm = useBgm(nearby.some((p) => p.visibility === 'full_visible'));

  // Update WebRTC connections based on proximity
  useEffect(() => {
    updateProximity(nearby);
    updateSoundboardVolumes(nearby);
  }, [nearby, updateProximity]);

  // Meeting zone detection — purely derived; feeds the A11 presence status
  // below, so standing inside a Zone of type 'meeting' shows as "In a
  // meeting". Conversation itself happens over the room's own proximity
  // WebRTC, with the zone's audio isolation deciding who can hear whom.
  const meetingZone = useMemo(
    () => findZoneAt({ x: localPlayer.x, y: localPlayer.y }, zones.filter((z) => z.type === 'meeting')),
    [localPlayer.x, localPlayer.y, zones],
  );

  // A11 — Presence status (consolidates A3 Focus + A5 meeting detection). Zone
  // wins over the manual choice: inside a meeting zone → 'in_meeting'; inside a
  // focus zone → 'focus'; otherwise the user's last manual pick
  // (available/lunch/away). On change, update the store (drives DND gating +
  // badge) and broadcast so other clients see it. Leaving a zone re-applies the
  // remembered manual status automatically.
  const workMode = useGameStore((s) => s.workMode);
  const setWorkMode = useGameStore((s) => s.setWorkMode);
  const manualStatus = useGameStore((s) => s.manualStatus);
  const setManualStatus = useGameStore((s) => s.setManualStatus);
  const awayReason = useGameStore((s) => s.awayReason);
  const setAwayReason = useGameStore((s) => s.setAwayReason);
  useEffect(() => {
    const focusZone = findZoneAt({ x: localPlayer.x, y: localPlayer.y }, zones.filter((z) => z.type === 'focus'));
    const effective: WorkMode = meetingZone ? 'in_meeting' : focusZone ? 'focus' : manualStatus;
    if (effective !== workMode) {
      setWorkMode(effective);
      emitWorkMode(effective, meetingZone?.id ?? focusZone?.id, effective === 'away' ? awayReason ?? undefined : undefined);
    }
  }, [localPlayer.x, localPlayer.y, zones, meetingZone, manualStatus, workMode, setWorkMode, emitWorkMode, awayReason]);

  // Focus area — the room's dedicated "Fokus" text channel (lazily created
  // server-side the first time an admin saves a Focus area, see rooms.ts's
  // PUT /editor/layers) auto-opens the moment workMode flips TO 'focus' and
  // closes again the moment it flips AWAY from 'focus', per the room admin's
  // explicit ask. Gated on the transition itself (prevWorkModeRef), not on
  // workMode being 'focus', so a player who closes/reopens chat manually
  // mid-session while still standing in the area isn't fought every render.
  const prevWorkModeRef = useRef<WorkMode>(workMode);
  useEffect(() => {
    const prev = prevWorkModeRef.current;
    prevWorkModeRef.current = workMode;
    if (workMode === prev) return;
    if (workMode === 'focus') {
      const fokus = channelChat.channels.find((c) => c.name === 'Fokus');
      if (fokus) {
        channelChat.setActiveChatTarget({ type: 'channel', id: fokus.id });
        channelChat.setChatPanelOpen(true);
      }
    } else if (prev === 'focus') {
      channelChat.setChatPanelOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workMode]);

  // Fitur 3B — Away-reason popup. Fires either from the idle-AFK timer below
  // or a manual "Away" pick (PresenceButton) — never applies 'away' directly;
  // both paths go through this same prompt-then-apply flow.
  const [awayPromptOpen, setAwayPromptOpen] = useState(false);
  // True only while the CURRENT away state was entered via the idle timer —
  // gates whether the next activity event silently restores 'available'.
  // A manually-picked Away must NOT auto-revert on the next mouse jiggle.
  const autoAwayRef = useRef(false);
  const prevManualStatusRef = useRef<'available' | 'lunch' | 'away'>('available');
  // Separate from autoAwayRef: true only while the PROMPT ITSELF is open AND
  // was opened by the idle timer — lets markActive cancel an idle-triggered
  // prompt outright (never apply 'away' at all) instead of applying it and
  // immediately reverting. A manually-opened prompt never sets this, so
  // moving the mouse while deciding on a manual "Away" click doesn't make
  // the popup vanish out from under them.
  const awayPromptOpenRef = useRef(false);

  const resolveAwayPrompt = useCallback((reason?: string) => {
    awayPromptOpenRef.current = false;
    setAwayPromptOpen(false);
    setManualStatus('away');
    setAwayReason(reason ?? null);
  }, [setManualStatus, setAwayReason]);

  // Manual pick from PresenceButton — 'away' opens the SAME reason prompt
  // (poin 8b: "user klik tombol Away/Leave manual"); every other status
  // applies immediately, no reason needed.
  const handlePresencePick = useCallback((status: ManualStatus) => {
    autoAwayRef.current = false; // a deliberate pick is never auto-reverted
    if (status === 'away') {
      setAwayPromptOpen(true);
      return;
    }
    setManualStatus(status);
    setAwayReason(null);
  }, [setManualStatus, setAwayReason]);

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
  const roomRecordingActive = useGameStore((s) => s.roomRecordingActive);
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
  // §7 — recording captures my own screen/tab via getDisplayMedia (see
  // useScreenRecording.ts), so "Myself" is the only target. (Recording other
  // people was only ever reachable by first spotlighting them; that feature
  // was removed in Bug 7, so the picker is now just this single entry.)
  const recordingTargets = [
    { userId: localUserId, name: `${localPlayer.name} (You)` },
  ];

  // Track which zone (if any) the local player is standing in — drives the
  // ChatPanel's "Private" tab, and notifies other players in the room when
  // it changes. State (not a ref) so the Private tab can actually appear.
  const currentZoneIdRef = useRef<string | null>(null);
  const [currentZone, setCurrentZone] = useState<{ id: string; name: string } | null>(null);
  const localRole = useGameStore((s) => s.localRole);
  const localIsCeo = useGameStore((s) => s.localIsCeo);
  // "Ngobrol dengan CEO" queue — teleport the avatar straight into the zone
  // the instant our ticket is called, instead of requiring a manual walk-in.
  // Also fixes a real desync: the old behavior (useZoneLock.ts's poll doing
  // a raw ZONE_ENTER re-emit) never touched currentZoneIdRef, so it stayed
  // stale — which is exactly what onZoneSessionEnded's own "are we even
  // still in that zone" guard below relies on, so a session-end notice
  // could silently no-op instead of walking the avatar back out.
  const enterZoneNow = useCallback((zoneId: string) => {
    const z = zones.find((x) => x.id === zoneId);
    if (z) {
      useGameStore.getState().setLocalPlayer({
        x: (z.x + z.width / 2) * TILE_SIZE,
        y: (z.y + z.height / 2) * TILE_SIZE,
        isMoving: false,
      });
      setCurrentZone({ id: z.id, name: z.name });
    }
    currentZoneIdRef.current = zoneId;
    emitZoneEnter(zoneId);
  }, [zones, emitZoneEnter]);
  const zoneLock = useZoneLock(socketRef, authUserId, roomSlug, enterZoneNow);
  // QA (Booking popup close button) — X on the booking-approved card
  // (ZoneLockBar.tsx) only hides it, never touches the booking itself.
  // Reopen affordance lives in Sidebar (hasActiveBooking icon). Reset back
  // to false whenever a genuinely new booking ticket starts or this one
  // transitions to 'called' (the approval moment) — an old dismissal must
  // never silently swallow a DIFFERENT, later booking's notice.
  const [bookingNoticeDismissed, setBookingNoticeDismissed] = useState(false);
  const prevBookingTicketRef = useRef<{ zoneId: string; status: string } | null>(null);
  useEffect(() => {
    const ticket = zoneLock.zoneQueueTicket;
    if (!ticket || ticket.mode !== 'booking') { prevBookingTicketRef.current = null; return; }
    const prev = prevBookingTicketRef.current;
    const isNewOrJustApproved = !prev || prev.zoneId !== ticket.zoneId || (prev.status !== 'called' && ticket.status === 'called');
    if (isNewOrJustApproved) setBookingNoticeDismissed(false);
    prevBookingTicketRef.current = { zoneId: ticket.zoneId, status: ticket.status };
  }, [zoneLock.zoneQueueTicket?.zoneId, zoneLock.zoneQueueTicket?.status, zoneLock.zoneQueueTicket?.mode]);
  // "Ngobrol dengan CEO" v2 — the "Selesai meeting" widget. Assumes one
  // bookingMode zone per room (this session's Q&A) — derived from the
  // already-broadcast zoneRestrictions rather than a separate fetch.
  const ceoZoneId = useMemo(() => zoneLock.zoneRestrictions.find((r) => r.bookingMode)?.zoneId ?? null, [zoneLock.zoneRestrictions]);
  const activeZoneSessions = useGameStore((s) => s.activeZoneSessions);
  const myActiveZoneSession = localIsCeo && ceoZoneId
    ? [...activeZoneSessions.values()].find((s) => s.zoneId === ceoZoneId)
    : undefined;
  const [finishingSession, setFinishingSession] = useState(false);
  const finishActiveZoneSession = useCallback(async () => {
    if (!ceoZoneId) return;
    setFinishingSession(true);
    try {
      const { entries } = await api.getZoneQueueEntries(roomSlug, ceoZoneId);
      const active = entries.find((e) => e.status === 'active');
      if (active) await api.skipQueueEntry(roomSlug, active.id);
    } catch {
      // Best-effort — the widget just stays up if this fails; the CEO can
      // retry, or the session ends on its own at endsAt regardless.
    } finally {
      setFinishingSession(false);
    }
  }, [ceoZoneId, roomSlug]);
  // "Ngobrol dengan CEO" queue, zone-level — the map's own visual "tile
  // effect" (a lock badge on the zone's banner, see GameCanvas.tsx), so a
  // restricted area like "CEO Office" is visibly marked from a distance
  // instead of only revealing itself once someone walks in and gets
  // bounced. Shown to everyone regardless of whether THEY personally
  // qualify to enter — same as a real "Authorized Personnel Only" sign.
  const restrictedZoneIds = useMemo(() => new Set(zoneLock.zoneRestrictions.map((r) => r.zoneId)), [zoneLock.zoneRestrictions]);

  // Put the player back on the nearest tile inside the zone they may not leave.
  const pushBackInside = useCallback((zoneId: string) => {
    const z = zones.find((x) => x.id === zoneId);
    if (!z) return;
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    const setLocal = useGameStore.getState().setLocalPlayer;
    const p = useGameStore.getState().localPlayer;
    setLocal({
      ...p,
      x: clamp(p.x, (z.x + 0.5) * TILE_SIZE, (z.x + z.width - 0.5) * TILE_SIZE),
      y: clamp(p.y, (z.y + 0.5) * TILE_SIZE, (z.y + z.height - 0.5) * TILE_SIZE),
      isMoving: false,
    });
  }, [zones]);
  // Last position we know we were legitimately allowed to occupy — restored
  // when a zone-entry attempt gets refused, so the avatar snaps back out
  // instead of visibly standing inside a locked room it was denied entry to.
  const lastAllowedPosRef = useRef({ x: localPlayer.x, y: localPlayer.y });

  useEffect(() => {
    const zone = findZoneAt(localPlayer, zones);
    const zoneId = zone?.id ?? null;
    if (zoneId === currentZoneIdRef.current) {
      lastAllowedPosRef.current = { x: localPlayer.x, y: localPlayer.y };
      return;
    }

    // A locked zone holds you in until it's unlocked (even for the person who
    // locked it — see server zoneLock.ts). The server refuses the zone:exit
    // anyway (membership drives zone chat + A/V), so without this the avatar
    // would stand outside while still being IN the meeting — worse than not
    // letting them walk out at all.
    const leaving = currentZoneIdRef.current;
    if (leaving) {
      const lock = zoneLock.lockOf(leaving);
      if (lock) {
        pushBackInside(leaving);
        return;
      }
      emitZoneExit(leaving);
      // "Ngobrol dengan CEO" queue — leaving early completes the ticket
      // server-side (zoneHandler.ts's completeActiveZoneQueueEntry), but
      // nothing else ever refreshes our own cached zoneQueueTicket once its
      // status is 'active' (useZoneLock.ts's poll deliberately stops once
      // active — there's nothing left to wait for while genuinely inside).
      // Without dropping it here, walking back in during the same session
      // would read the stale 'active' status as still-admitted and skip the
      // restricted-zone bounce below entirely, even though the server has
      // already closed that ticket and will deny the re-entry.
      zoneLock.clearZoneQueueTicketOnExit(leaving);
    }

    // A locked zone also holds people OUT — not just chat/AV membership, the
    // avatar itself must not be able to stand inside it. Checked client-side
    // against the mirrored lock state (same pattern as the leaving check
    // above) so the bounce is instant, no round trip needed.
    if (zoneId) {
      const lock = zoneLock.lockOf(zoneId);
      if (lock && !zoneLock.isKeyholder(zoneId) && !zoneLock.isAdmitted(zoneId)) {
        const back = lastAllowedPosRef.current;
        useGameStore.getState().setLocalPlayer({ x: back.x, y: back.y, isMoving: false });
        zoneLock.denyEntry(zoneId);
        return;
      }
      // "Ngobrol dengan CEO" queue, zone-level — a restricted zone (Room
      // Editor's "Restricted area" tool) must physically hold out anyone who
      // isn't the room owner or explicitly granted CEO access, AND hasn't
      // been called/admitted into their queue slot, same bounce as a manual
      // lock above, mirroring the exact authoritative check
      // zoneHandler.ts's ZONE_ENTER does server-side so the decision is
      // instant and client-only — no round trip, no brief "stood inside it"
      // flash before the server's own ZONE_LOCKED_DENIED came back.
      //
      // Deliberately NOT role-based (no roleAtLeast/minRole check) — an
      // ordinary room admin must queue like anyone else here; only the room
      // owner and whoever's been granted CEO access (see gameStore's
      // localIsCeo, roomHandler.ts's ceoUserIds) bypass.
      // "Ngobrol dengan CEO" v2 — a bookingMode zone is always freely
      // walkable (see zoneHandler.ts's own ZONE_ENTER, which skips this same
      // gate server-side), so this client-side mirror must skip it too, or
      // the avatar would get bounced back out locally even though the
      // server would have let it through.
      const restriction = zoneLock.restrictionOf(zoneId);
      if (restriction && !restriction.bookingMode && localRole !== 'owner' && !localIsCeo) {
        const ticket = zoneLock.zoneQueueTicket;
        const admitted = ticket?.zoneId === zoneId && (ticket.status === 'called' || ticket.status === 'active');
        if (!admitted) {
          const back = lastAllowedPosRef.current;
          useGameStore.getState().setLocalPlayer({ x: back.x, y: back.y, isMoving: false });
          zoneLock.denyEntry(zoneId, restriction.queueEnabled ? 'queue' : 'restricted');
          return;
        }
      }
      emitZoneEnter(zoneId);
    }
    currentZoneIdRef.current = zoneId;
    setCurrentZone(zone ? { id: zone.id, name: zone.name } : null);
    lastAllowedPosRef.current = { x: localPlayer.x, y: localPlayer.y };
    // Reaching this line at all means the crossing succeeded (every denial
    // branch above returns early) — whether that landed us in no zone or a
    // completely different one, whatever we were previously denied from is
    // no longer relevant, so the knock/queue-form card should go away.
    //
    // Bug fix — this used to only clear when zoneId was null (no zone at
    // all), so walking straight from a CEO Office denial into a DIFFERENT
    // zone (e.g. a neighboring "AI Team" area) skipped this entirely — the
    // stale "isi form antrean" card for CEO Office stayed on screen
    // indefinitely, since the player never passed through a genuine
    // "in no zone" gap to trigger the old guard.
    zoneLock.clearDenied();
  }, [localPlayer.x, localPlayer.y, zones, emitZoneEnter, emitZoneExit]);

  // "Ngobrol dengan CEO" queue, zone-level — our timed slot in a restricted
  // zone ran out (see roomHandler.ts's forceZoneExitForQueue). Unlike a
  // manually-locked zone (which the player can only ever be pushed BACK INTO,
  // never out of — see pushBackInside above), this needs the opposite: the
  // server can't reach into the client's canvas to move the avatar itself,
  // so this nudges it just outside the zone's own rect and emits ZONE_EXIT —
  // exactly what a normal voluntary walk-out already does, just server-
  // triggered. Not pixel-perfect (no attempt to find the nearest actually-
  // walkable tile), but the access control itself already happened
  // server-side regardless of where the avatar visually lands.
  //
  // Bug fix — this used to bail out entirely if currentZoneIdRef didn't
  // already match msg.zoneId, on the assumption that meant we'd already
  // left. But the server is authoritative here (it only sends this because
  // IT still had our ticket as active) — trusting a possibly-stale local
  // ref instead meant a real desync (e.g. the ref never getting set at all
  // on some entry path) could make this silently no-op forever, leaving
  // the avatar stuck inside a zone whose session had already ended.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const onZoneSessionEnded = (msg: { zoneId: string; zoneName: string; nudgeOut?: boolean }) => {
      // "Ngobrol dengan CEO" v2 — a bookingMode zone stays freely walkable
      // after the session ends (see roomHandler.ts's forceZoneExitForQueue),
      // so there's nothing for THIS handler to do: no repositioning, no
      // ZONE_EXIT, the avatar just keeps standing wherever it already was.
      // useZoneLock's own onZoneSessionEnded still fires independently and
      // handles the toast + dropping the finished ticket.
      if (msg.nudgeOut === false) return;
      const z = zones.find((x) => x.id === msg.zoneId);
      if (z) {
        useGameStore.getState().setLocalPlayer({
          x: (z.x + z.width / 2) * TILE_SIZE,
          y: Math.max(0, z.y - 1) * TILE_SIZE,
          isMoving: false,
        });
      }
      emitZoneExit(msg.zoneId);
      currentZoneIdRef.current = null;
      setCurrentZone(null);
    };
    socket.on(SocketEvents.ZONE_SESSION_ENDED, onZoneSessionEnded);
    return () => { socket.off(SocketEvents.ZONE_SESSION_ENDED, onZoneSessionEnded); };
  }, [socketRef, zones, emitZoneExit]);

  const zoneChatHistory = useGameStore((s) => s.zoneChatHistory);
  const handleSendZoneChat = useCallback((text: string, zoneId: string, attachmentUrl?: string, attachmentName?: string) => {
    emitChat(text, false, zoneId, attachmentUrl, attachmentName);
  }, [emitChat]);

  // Media toggles — single call, track is toggled directly in the hook.
  // Broadcasts the new mute state so ParticipantPanel/VideoTile can show a
  // muted badge for peers outside WebRTC proximity range (see PLAYER_MIC).
  const handleMicToggle = useCallback(async () => {
    const enabled = await toggleMic();
    emitPlayerMic(!enabled);
  }, [toggleMic, emitPlayerMic]);

  // QA (Moderasi checklist item 11, "Kick/mute admin") — the server can
  // only ASK (see PLAYER_FORCE_MUTED's own doc comment); this is where the
  // ask is actually carried out. Guarded on `!isMicMuted` so it's a true
  // "force OFF", not a blind toggle that would turn the mic back ON if it
  // happened to already be muted for some other reason. Self-dismisses the
  // toast — same shape as miniModeError/screenShareError.
  const forceMutedNotice = useGameStore((s) => s.forceMutedNotice);
  useEffect(() => {
    if (!forceMutedNotice) return;
    if (!isMicMuted) handleMicToggle();
    const t = setTimeout(() => useGameStore.getState().setForceMutedNotice(null), 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceMutedNotice]);

  const handleCameraToggle = useCallback(() => {
    toggleCamera();
  }, [toggleCamera]);

  const handleScreenShareToggle = useCallback(() => {
    toggleScreenShare();
  }, [toggleScreenShare]);

  // Raise/lower hand — persistent toggle broadcast to the room; renders as a
  // ✋ over the avatar and on the video tile (AvatarSprite / VideoGrid).
  const handleHandToggle = useCallback(() => {
    const next = !useGameStore.getState().localPlayer.handRaised;
    useGameStore.getState().setLocalPlayer({ handRaised: next || undefined });
    emitPlayerHand(next);
    // Bug 14 — soft local confirmation for the raiser (the server chime goes
    // only to OTHERS in the same zone/nearby, so without this the person who
    // pressed it would hear nothing and think it did nothing). Raise only.
    if (next) playHandRaiseSound();
  }, [emitPlayerHand]);

  // "Sembunyikan diri" — persistent toggle broadcast to the room; regular
  // members' render loop skips this avatar entirely, admin+ still sees it
  // (see Avatar.hidden's doc comment in shared/types).
  const handleHiddenToggle = useCallback(() => {
    const next = !useGameStore.getState().localPlayer.hidden;
    useGameStore.getState().setLocalPlayer({ hidden: next || undefined });
    emitPlayerHidden(next);
  }, [emitPlayerHidden]);

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

  // QA items #9/#10 (multi-tab) — same "show it, then leave" shape as
  // kickedNotice above, but its own state slot (see SESSION_TAKEN_OVER's
  // doc comment — must never touch vm_token/logout, only leave this room).
  const sessionTakenOverNotice = useGameStore((s) => s.sessionTakenOverNotice);
  useEffect(() => {
    if (!sessionTakenOverNotice) return;
    const timer = setTimeout(() => {
      useGameStore.getState().setSessionTakenOverNotice(null);
      onLeave();
    }, 2500);
    return () => clearTimeout(timer);
  }, [sessionTakenOverNotice, onLeave]);

  // Guest Link & Ruang Tunggu — prompt-based, same lightweight "quick admin
  // config" convention as the Room Editor's door-password/capacity prompts,
  // rather than a dedicated management panel. Remembers only the MOST
  // RECENTLY created link's id (not a full history/list — there's still no
  // management panel) so handleRevokeGuestLink below has something to act
  // on without a separate "list my links" endpoint, which doesn't exist yet.
  const lastGuestInviteId = useRef<string | null>(null);
  const handleCreateGuestLink = useCallback(async () => {
    const hoursRaw = await showPrompt('Guest link berlaku berapa jam? (kosongkan = tanpa batas waktu)', '24');
    if (hoursRaw === null) return;
    const oneTime = await showConfirm('Link ini HANYA BISA DIPAKAI SEKALI?\n\nOK = ya, sekali pakai — otomatis tidak berlaku lagi setelah satu tamu masuk.\nBatal = tidak, bisa dipakai berkali-kali sampai kedaluwarsa.');
    // Password is mandatory on every link (server enforces this too — this
    // prompt is just the input, not the source of truth). Empty input means
    // "auto-generate", not "no password" — the server never creates a link
    // without one.
    const passwordRaw = await showPrompt('Password link (kosongkan = dibuatkan otomatis):', '');
    if (passwordRaw === null) return;
    const trimmed = hoursRaw.trim();
    const expiresInHours = trimmed ? Number(trimmed) : undefined;
    try {
      const result = await api.createGuestInvite(roomSlug, { expiresInHours, maxUses: oneTime ? 1 : undefined, password: passwordRaw.trim() || undefined });
      lastGuestInviteId.current = result.id;
      const url = `${window.location.origin}/?guest=${encodeURIComponent(result.token)}`;
      await navigator.clipboard.writeText(url);
      // Alert (not just the clipboard toast) because the password can't also
      // fit in the clipboard alongside the link — this is the ONLY moment
      // the plain password is ever shown, so it has to be read here, not
      // copy-pasted from a second place.
      await showAlert(`Guest link dibuat.\n\nLink (sudah disalin ke clipboard):\n${url}\n\nPassword: ${result.password}\n\nBagikan link DAN password ini ke tamu — keduanya dibutuhkan untuk masuk.`);
      useGameStore.getState().addActivity('🔗 Guest link dibuat.');
    } catch (e) {
      console.error('[guest] create invite failed:', e);
      useGameStore.getState().addActivity('Gagal membuat guest link.');
    }
  }, [roomSlug]);

  // QA (Akses tamu checklist item 7, "Revoke") — server now actually kicks
  // any guest currently connected via this link (see guestInvite.ts's
  // DELETE handler), not just blocks future joins. Only ever targets the
  // most recently created link (see lastGuestInviteId above) — a proper
  // "pick which link" management panel is a separate, bigger piece of work.
  const handleRevokeGuestLink = useCallback(async () => {
    const id = lastGuestInviteId.current;
    if (!id) {
      await showAlert('Belum ada guest link yang dibuat di sesi ini untuk dicabut.');
      return;
    }
    if (!(await showConfirm('Cabut guest link terakhir yang dibuat?\n\nLink tidak bisa dipakai lagi, dan tamu yang sedang masuk lewat link ini akan langsung dikeluarkan.'))) return;
    try {
      await api.revokeGuestInvite(roomSlug, id);
      lastGuestInviteId.current = null;
      useGameStore.getState().addActivity('🚫 Guest link dicabut.');
    } catch (e) {
      console.error('[guest] revoke invite failed:', e);
      useGameStore.getState().addActivity('Gagal mencabut guest link.');
    }
  }, [roomSlug]);

  // QA #9/#10 — CEO/admin text broadcast. Same prompt-based "quick admin
  // config" convention as Guest Link above — the server independently
  // re-checks 'broadcast:text' (roomHandler.ts), this is just the trigger.
  const handleBroadcast = useCallback(async () => {
    const text = ((await showPrompt('Pesan broadcast ke SEMUA orang di room ini:')) ?? '').trim();
    if (!text) return;
    emitBroadcastSend(text);
  }, [emitBroadcastSend]);

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

  // "Kamu disenggol!" toast — set by useSocket.ts's PLAYER_NUDGE handler
  // only when I'm the target; auto-clears after a few seconds, same one-shot
  // ping pattern as summonResult above.
  const nudgedBy = useGameStore((s) => s.nudgedBy);
  useEffect(() => {
    if (!nudgedBy) return;
    const timer = setTimeout(() => useGameStore.getState().setNudgedBy(null), 3000);
    return () => clearTimeout(timer);
  }, [nudgedBy]);

  // A10 — "colek"/slap toast, same auto-clear pattern as the nudge toast above.
  const slappedBy = useGameStore((s) => s.slappedBy);
  useEffect(() => {
    if (!slappedBy) return;
    const timer = setTimeout(() => useGameStore.getState().setSlappedBy(null), 3000);
    return () => clearTimeout(timer);
  }, [slappedBy]);

  // Server-side admin-permission rejections (Spotlight, Kick, room lock, …)
  // — same brief-toast pattern as nudgedBy/slappedBy above, see gameStore's
  // doc comment on adminErrorMessage for why this needed to exist at all.
  const adminErrorMessage = useGameStore((s) => s.adminErrorMessage);
  useEffect(() => {
    if (!adminErrorMessage) return;
    const timer = setTimeout(() => useGameStore.getState().setAdminErrorMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [adminErrorMessage]);

  // QA #9/#10 — CEO/admin text broadcast toast. Longer-lived (8s) than the
  // other brief pings above — this is a room-wide announcement meant to
  // actually be read, not a quick "someone poked you" ping.
  const roomBroadcast = useGameStore((s) => s.roomBroadcast);
  useEffect(() => {
    if (!roomBroadcast) return;
    const timer = setTimeout(() => useGameStore.getState().setRoomBroadcast(null), 8000);
    return () => clearTimeout(timer);
  }, [roomBroadcast]);

  const incomingFollowRequest = useGameStore((s) => s.incomingFollowRequest);
  useEffect(() => {
    if (!incomingFollowRequest) return;
    const timer = setTimeout(() => useGameStore.getState().setIncomingFollowRequest(null), CONSENT_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [incomingFollowRequest]);

  // Final-review Fix 1 — same auto-clear as incomingSummonRequest/
  // incomingFollowRequest above: the toast must not outlive a request the
  // server already auto-declined server-side after CONSENT_REQUEST_TIMEOUT_MS.
  const incomingRemoteHelpRequest = useGameStore((s) => s.incomingRemoteHelpRequest);
  useEffect(() => {
    if (!incomingRemoteHelpRequest) return;
    const timer = setTimeout(() => useGameStore.getState().setIncomingRemoteHelpRequest(null), CONSENT_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [incomingRemoteHelpRequest]);

  // Item #5 — room-join requests popped up for admins. No auto-clear timer
  // like the knock/summon/follow toasts above: those have a matching
  // server-side auto-decline (CONSENT_REQUEST_TIMEOUT_MS), but a join request
  // has none — it just waits in the queue — so there's nothing for a client
  // timeout to stay in sync with. The card only goes away on an explicit
  // decision (here or from the manual queue panel, via JOIN_QUEUE_CHANGED).
  const incomingJoinRequests = useGameStore((s) => s.incomingJoinRequests);
  const decideIncomingJoinRequest = useCallback((req: { userId: string; roomSlug: string }, decision: 'approve' | 'reject') => {
    useGameStore.getState().removeIncomingJoinRequest(req.userId, req.roomSlug);
    api.decideJoinRequest(req.roomSlug, req.userId, decision).catch((e) => {
      console.error('[join-request] decide from popup failed:', e);
    });
  }, []);

  // "Ngobrol dengan CEO" queue, zone-level — same "persists until an
  // explicit decision" shape as incomingJoinRequests above.
  const incomingQueueRequests = useGameStore((s) => s.incomingQueueRequests);
  const decideIncomingQueueRequest = useCallback((req: { entryId: string; roomSlug: string }, decision: 'approve' | 'reject') => {
    useGameStore.getState().removeIncomingQueueRequest(req.entryId);
    const call = decision === 'approve' ? api.approveQueueEntry(req.roomSlug, req.entryId) : api.skipQueueEntry(req.roomSlug, req.entryId);
    call.catch((e) => console.error('[queue-request] decide from popup failed:', e));
  }, []);

  const followResult = useGameStore((s) => s.followResult);
  useEffect(() => {
    if (!followResult) return;
    const timer = setTimeout(() => useGameStore.getState().setFollowResult(null), 3000);
    return () => clearTimeout(timer);
  }, [followResult]);

  const remoteHelpResult = useGameStore((s) => s.remoteHelpResult);
  const activeRemoteHelp = useGameStore((s) => s.activeRemoteHelp);
  const receivedRemoteHelpCredential = useGameStore((s) => s.receivedRemoteHelpCredential);
  const remoteHelpCredentialAcked = useGameStore((s) => s.remoteHelpCredentialAcked);
  useEffect(() => {
    if (!remoteHelpResult) return;
    const timer = setTimeout(() => useGameStore.getState().setRemoteHelpResult(null), 3000);
    return () => clearTimeout(timer);
  }, [remoteHelpResult]);

  // Admin / Editor. editorMode (the old in-map overlay editor) can no longer
  // be switched on — the toggle went with the retired editor (Potong 7) — but
  // the store field and GameCanvas's editor branches remain, permanently off.
  const isAdmin = useGameStore((s) => s.isAdmin);
  const editorMode = useGameStore((s) => s.editorMode);
  const selectedTileType = useGameStore((s) => s.selectedTileType);
  const selectedPaletteId = useGameStore((s) => s.selectedPaletteId);
  const zoneDrawMode = useGameStore((s) => s.zoneDrawMode);
  const bannerPlaceMode = useGameStore((s) => s.bannerPlaceMode);
  const pushTileHistory = useGameStore((s) => s.pushTileHistory);
  const setTiles = useGameStore((s) => s.setTiles);
  // Bug 12 — "one panel at a time": every main panel derives its open state
  // from a single store field. Opening one closes the rest (and chat / room
  // editor); see gameStore openPanel/closePanel. Names are kept identical to
  // the old local booleans so the rest of the component is unchanged.
  const activePanel = useGameStore((s) => s.activePanel);
  const openPanel = useGameStore((s) => s.openPanel);
  const closePanel = useGameStore((s) => s.closePanel);
  const showAdminPanel = activePanel === 'adminPanel';
  const showTeleportPanel = activePanel === 'teleport';
  const showAddMediaPanel = activePanel === 'addMedia';
  const [viewingMediaId, setViewingMediaId] = useState<string | null>(null);
  // Fitur 15B — Interactive Object trigger (Press F / automatic). Holds the
  // Furniture id; the modal itself resolves the piece from `furniture` below.
  const [triggeredInteractiveId, setTriggeredInteractiveId] = useState<string | null>(null);
  // ZEP-style door password — same trigger shape as above, but a door is a
  // tile (x,y), not a Furniture id.
  const [doorPasswordTile, setDoorPasswordTile] = useState<{ x: number; y: number } | null>(null);
  // "Door Area" — area-id counterpart to doorPasswordTile above.
  const [doorAreaPasswordAreaId, setDoorAreaPasswordAreaId] = useState<string | null>(null);
  // QA #7/#8/#9 — clicking a note marker opens it. Same "just the id,
  // resolve the rest at render time" shape as triggeredInteractiveId above.
  const [noteEditingId, setNoteEditingId] = useState<string | null>(null);
  // Item 13, "Panic/report user" — who ParticipantPanel's "Laporkan" was
  // clicked for, if anyone; the modal itself does the actual submit.
  const [reportTarget, setReportTarget] = useState<{ userId: string; name: string } | null>(null);
  // ZEP-style player card — who was clicked on the map, if anyone, and
  // where on screen to anchor the card (see GameCanvas's onPlayerClick).
  // The clicked player's own live record is kept whole (not decomposed
  // into separate id/name/config fields) since PlayerCard needs several of
  // its fields together and the record is already fully in hand at click
  // time — no extra store lookup needed.
  const [playerCardTarget, setPlayerCardTarget] = useState<{ player: Avatar; x: number; y: number } | null>(null);
  const mediaObjects = useGameStore((s) => s.mediaObjects);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [roomCodeCopied, setRoomCodeCopied] = useState(false);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);

  const adminViewActive = activePanel === 'adminConsole';
  const operatorConsoleActive = activePanel === 'operatorConsole';
  const myAnalyticsActive = activePanel === 'myAnalytics';
  const calendarViewActive = activePanel === 'calendar';
  const attendanceViewActive = activePanel === 'attendance';
  const messengerViewActive = activePanel === 'messenger';
  // Join-approval queue (admin). pendingJoinCount only drives the menu badge;
  // the panel refetches from the server when opened, so a stale count can
  // never turn into a stale decision.
  const joinQueueActive = activePanel === 'joinQueue';
  const [pendingJoinCount, setPendingJoinCount] = useState(0);
  const avatarSetupActive = activePanel === 'avatarSetup';
  const userGuideActive = activePanel === 'userGuide';
  const memberListActive = activePanel === 'memberList';
  const settingsActive = activePanel === 'settings';
  const bookingFormActive = activePanel === 'bookingForm';

  // Keep the badge fresh for admins. Polled rather than driven by the
  // JOIN_REQUESTED broadcast the server already sends: wiring a new listener
  // means threading it through useSocket, and a 20s badge lag costs nothing —
  // the panel itself always refetches on open, so a decision is never made
  // against a stale list. Worth revisiting if the delay ever feels slow.
  useEffect(() => {
    if (!isAdmin || !roomSlug) { setPendingJoinCount(0); return; }
    let cancelled = false;
    const refresh = () => {
      api.getJoinRequests(roomSlug)
        .then((r) => { if (!cancelled) setPendingJoinCount(r.requests.length); })
        .catch(() => {}); // a failed count is not worth surfacing
    };
    refresh();
    const iv = setInterval(refresh, 20000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [isAdmin, roomSlug, joinQueueActive]);

  // True while any full-screen suite module covers the room. Room affordances
  // (hotkeys, the floating Chat button) must stand down while it's open —
  // they belong to the office, not to a spreadsheet or a document.
  // Messenger is deliberately NOT included any more: it docks as a left
  // sidebar now (see MessengerApp.tsx), not a full-screen takeover, so the
  // map/HUD/movement stay live beside it, Gather-style.
  const moduleOpen = calendarViewActive || adminViewActive || attendanceViewActive || myAnalyticsActive;

  // Tab for admin panel. (The old E-for-editor hotkey went with the retired
  // overlay editor — Potong 7; editing now lives on the /?roomEditor= page.)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldIgnoreRoomHotkey(e.target, moduleOpen)) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        openPanel('adminPanel');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [moduleOpen]);

  const handleTilePaint = useCallback(async (x: number, y: number, type: TileType) => {
    const state = useGameStore.getState();
    const currentTiles = state.tiles.map((row) => row.map((t) => ({ ...t })));
    if (!currentTiles[y]?.[x]) return;

    if (type === 'portal') {
      const target = await showPrompt('Kode room tujuan (dari URL/kode share room):', '');
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
      // Group into the active table only for actual chairs — a non-sittable
      // piece has no occupant, so a tableId on it would be meaningless.
      tableId: (entry.sittable && state.activeTableId) ? state.activeTableId : undefined,
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

  const handleAvatarSave = useCallback((config: AvatarConfig) => {
    saveAvatarConfig(config);
    useGameStore.getState().setLocalPlayer({
      name: config.name,
      color: config.color,
      avatarConfig: config,
    });
    emitAvatarUpdate(config);
    // Chat's sender-name cache (useProfiles) resolves by userId and never
    // refetches once cached — AVATAR_UPDATED (above) excludes the sender's
    // own socket, so the renamer's OWN chat view needs this pushed directly
    // too, or their own new messages would still show their old cached name.
    if (localUserId && config.name) setProfileName(localUserId, config.name);
    // Bug 2 — this save path only ever broadcast the change (fine for anyone
    // ALREADY in the room) and cached it in localStorage; it never told the
    // server. So a rename never survived the renamer's own refresh/reconnect,
    // or reached anyone who joined the room fresh afterward — both read the
    // name back from User.avatarConfig in the DB, which this never touched.
    // saveAvatarConfig(config) two lines up is the local-only cache; this is
    // the one that actually persists it. Login is mandatory before a room is
    // reachable at all, so there's no logged-out case to gate this behind.
    api.saveAvatar(config).catch(() => {});
    if (useGameStore.getState().activePanel === 'avatarSetup') closePanel();
  }, [emitAvatarUpdate, localUserId]);

  // ─── AFK auto-away (ZEP/Gather-style) ────────────────────────────────
  // Fitur 3B — after AFK_IDLE_MS with no keyboard/pointer/touch input, show
  // the Away-reason prompt (same one PresenceButton's manual "Away" pick
  // uses) instead of silently flipping a status; any activity before it's
  // answered cancels it, and any activity AFTER an idle-triggered away
  // restores 'available' straight away. Consolidated onto workMode/
  // manualStatus (see resolveAwayPrompt/handlePresencePick above) — this
  // used to drive the separate free-text `status` field instead, which read
  // as two disconnected presence signals rather than one source of truth.
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    const markActive = () => {
      lastActivityRef.current = Date.now();
      if (awayPromptOpenRef.current) {
        // Idle was detected and the prompt is showing, but the user is
        // clearly back now — cancel it silently, never apply 'away' at all.
        awayPromptOpenRef.current = false;
        setAwayPromptOpen(false);
        return;
      }
      if (autoAwayRef.current) {
        autoAwayRef.current = false;
        setManualStatus(prevManualStatusRef.current);
        setAwayReason(null);
      }
    };
    const events: (keyof WindowEventMap)[] = ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel'];
    events.forEach((e) => window.addEventListener(e, markActive, { passive: true }));

    const iv = setInterval(() => {
      if (autoAwayRef.current || awayPromptOpenRef.current) return;
      if (Date.now() - lastActivityRef.current < AFK_IDLE_MS) return;
      // Only idle-prompt from the fully open/default state — don't interrupt
      // a zone-driven in_meeting/focus, or a status the user already picked
      // themselves (lunch/away).
      if (useGameStore.getState().manualStatus !== 'available' || useGameStore.getState().workMode !== 'available') return;
      prevManualStatusRef.current = 'available';
      autoAwayRef.current = true;
      awayPromptOpenRef.current = true;
      setAwayPromptOpen(true);
    }, 5000);

    return () => {
      events.forEach((e) => window.removeEventListener(e, markActive));
      clearInterval(iv);
    };
  }, [setManualStatus, setAwayReason]);

  // loadAvatarConfig()'s default `name` is the placeholder 'You' used for
  // the editor's own live preview. Seed it with the real account name so
  // opening the editor and saving without touching the name field doesn't
  // broadcast "You" to every other player in the room.
  const savedConfig = { ...loadAvatarConfig(), name: playerName || loadAvatarConfig().name };

  // Player card's "Copy Outfit" — reuses handleAvatarSave verbatim (same
  // broadcast + persist path as the Avatar Setup panel), just with a
  // constructed config: every VISUAL field taken from the clicked player,
  // name/statusTag kept as the local player's own (AvatarConfig mixes
  // identity into the same object — copying it whole would also steal the
  // other player's name, see PlayerCard.tsx's own prop comment).
  const handleCopyOutfit = useCallback((source: AvatarConfig) => {
    handleAvatarSave({
      ...savedConfig,
      bodyShape: source.bodyShape,
      color: source.color,
      accessory: source.accessory,
      expression: source.expression,
      spriteMode: source.spriteMode,
      bodyId: source.bodyId,
      eyesId: source.eyesId,
      outfitId: source.outfitId,
      hairId: source.hairId,
      spriteAccessoryId: source.spriteAccessoryId,
      premadeId: source.premadeId,
    });
    setPlayerCardTarget(null);
  }, [handleAvatarSave, savedConfig]);

  // Chat + emotes + minimap state
  const notice = useGameStore((s) => s.notice);
  const followInfo = useGameStore((s) => s.followInfo);
  const followerUserIds = useGameStore((s) => s.followerUserIds);
  const [showEmoteWheel, setShowEmoteWheel] = useState(false);
  // "Ngobrol dengan CEO" v2 — the G-key booking form. Assumes one bookingMode
  // zone per room (this session's own Q&A) — fetched fresh on each G press
  // rather than cached, since it's a rare action and always wants the
  // current admin config, not a stale snapshot from page load.
  const [bookingZone, setBookingZone] = useState<{ zoneId: string; name: string } | null>(null);
  const meetingViewActive = activePanel === 'meeting';
  const [miniModeWindow, setMiniModeWindow] = useState<Window | null>(null);
  const [miniModeError, setMiniModeError] = useState<string | null>(null);
  const miniModeErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Simplified View — hides everything that isn't about "who's here and
  // talking": the feature sidebar, minimap, room-meta hint text, and the
  // participant/notice panels. Its own toggle deliberately lives OUTSIDE the
  // sidebar (a fixed corner button) since the sidebar is exactly what gets
  // hidden — there'd be no way back otherwise.
  const [simplifiedView, setSimplifiedView] = useState(false);
  // "Layar Penuh" on a screen share is now a true edge-to-edge takeover (see
  // VideoGrid/ScreenSharePanel's own comments) — on request, "bener-bener
  // full screen kayak nonton YouTube". The sidebar rail and bottom HUD
  // toolbar both sit at z-50, above the panel's z-30, so leaving them
  // rendered would just float them on top of the picture instead of the
  // picture actually filling the screen. VideoGrid reports maximize
  // start/stop here so both can hide for as long as it lasts.
  const [screenShareMaximized, setScreenShareMaximized] = useState(false);

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
  const triggeredInteractive = triggeredInteractiveId ? furniture.find((f) => f.id === triggeredInteractiveId) ?? null : null;
  const interactiveDoorPasswordResult = useGameStore((s) => s.interactiveDoorPasswordResult);

  // ZEP-style door password — reuses InteractiveObjectModal's 'password'
  // branch verbatim by adapting the door tile into the same Furniture shape
  // the modal already knows how to render (id/name/interactiveType/
  // interactiveConfig are the only fields it reads). doorPassword itself was
  // already stripped from `tiles` server-side (redactDoorPasswords) — this
  // adapter never has the real value to leak.
  const doorPasswordFurniture = doorPasswordTile
    ? (() => {
        const t = tiles[doorPasswordTile.y]?.[doorPasswordTile.x];
        if (!t || t.type !== 'door') return null;
        return {
          id: `door:${doorPasswordTile.x}:${doorPasswordTile.y}`,
          x: doorPasswordTile.x, y: doorPasswordTile.y, paletteId: '', tilesW: 1, tilesH: 1,
          name: 'Pintu',
          interactiveType: 'password' as const,
          interactiveConfig: {
            passwordDescription: t.doorPasswordDescription,
            correctText: 'Password benar — silakan lewat.',
            failureMessage: t.doorFailureMessage,
          },
        };
      })()
    : null;
  // Adapts interactiveDoorPasswordResult (keyed by x,y) into the
  // furnitureId-keyed shape InteractiveObjectModal expects, so the SAME
  // modal component works for both without any changes to it.
  const doorPasswordResultAdapted = (doorPasswordTile && interactiveDoorPasswordResult
    && interactiveDoorPasswordResult.x === doorPasswordTile.x && interactiveDoorPasswordResult.y === doorPasswordTile.y)
    ? {
        furnitureId: `door:${doorPasswordTile.x}:${doorPasswordTile.y}`,
        correct: interactiveDoorPasswordResult.correct,
        correctText: doorPasswordFurniture?.interactiveConfig.correctText,
        failureMessage: interactiveDoorPasswordResult.failureMessage,
      }
    : null;

  // "Door Area" — same InteractiveObjectModal-reuse trick as the tile-based
  // door above, adapting the area into the same synthetic Furniture shape.
  // doorPassword itself was already stripped server-side
  // (redactDoorAreaPasswords) — this adapter never has the real value.
  const interactiveDoorAreaPasswordResult = useGameStore((s) => s.interactiveDoorAreaPasswordResult);
  const doorAreaPasswordFurniture = doorAreaPasswordAreaId
    ? (() => {
        const area = doorAreaRects.find((r) => r.id === doorAreaPasswordAreaId);
        if (!area) return null;
        return {
          id: `doorArea:${area.id}`,
          x: Math.floor(area.x / TILE_SIZE), y: Math.floor(area.y / TILE_SIZE), paletteId: '', tilesW: 1, tilesH: 1,
          name: area.name || 'Pintu',
          interactiveType: 'password' as const,
          interactiveConfig: {
            passwordDescription: area.doorPasswordDescription,
            correctText: 'Password benar — silakan lewat.',
            failureMessage: area.doorFailureMessage,
          },
        };
      })()
    : null;
  const doorAreaPasswordResultAdapted = (doorAreaPasswordAreaId && interactiveDoorAreaPasswordResult
    && interactiveDoorAreaPasswordResult.areaId === doorAreaPasswordAreaId)
    ? {
        furnitureId: `doorArea:${doorAreaPasswordAreaId}`,
        correct: interactiveDoorAreaPasswordResult.correct,
        correctText: doorAreaPasswordFurniture?.interactiveConfig.correctText,
        failureMessage: interactiveDoorAreaPasswordResult.failureMessage,
      }
    : null;

  // A correct door password should just let the player walk through — no
  // "Password benar" confirmation to dismiss. Movement itself is already
  // unblocked server-side the instant the check succeeds; this only closes
  // the now-redundant modal instead of leaving it up until a manual click.
  useEffect(() => {
    if (doorPasswordResultAdapted?.correct) {
      setDoorPasswordTile(null);
      useGameStore.getState().setInteractiveDoorPasswordResult(null);
    }
  }, [doorPasswordResultAdapted?.correct]);
  useEffect(() => {
    if (doorAreaPasswordResultAdapted?.correct) {
      setDoorAreaPasswordAreaId(null);
      useGameStore.getState().setInteractiveDoorAreaPasswordResult(null);
    }
  }, [doorAreaPasswordResultAdapted?.correct]);

  // Fitur 15B — 'website'/'website_tab' and 'api_call' have no modal of
  // their own (ZEP's own behavior for both website types is just opening a
  // new window/tab, and api_call has nothing to show but a toast) — all are
  // handled here instead of by InteractiveObjectModal, which only ever
  // renders the pop-up-style types (text/image/password/multiple_choice).
  const handleInteractiveTrigger = useCallback((id: string) => {
    const f = useGameStore.getState().furniture.find((ff) => ff.id === id);
    if (!f) return;
    if (f.interactiveType === 'website') {
      const cfg = f.interactiveConfig;
      if (!cfg?.url) return;
      const features = cfg.fullscreen === false ? `noopener,noreferrer,width=${cfg.width || 900},height=${cfg.height || 700}` : 'noopener,noreferrer';
      window.open(cfg.url, '_blank', features);
      return;
    }
    if (f.interactiveType === 'website_tab') {
      // Deliberately no size/fullscreen options — always a plain new-tab
      // open, ZEP's own documented fallback for sites that misbehave in a
      // sized popup window.
      if (!f.interactiveConfig?.url) return;
      window.open(f.interactiveConfig.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (f.interactiveType === 'api_call') {
      emitInteractiveApiCall(f.id);
      return;
    }
    if (f.interactiveType === 'change_object') {
      // No local state to update — the piece vanishing from the next
      // ROOM_UPDATED (server mutates the room's actual saved data, for
      // every player at once) is the only feedback there is.
      emitInteractiveChangeObject(f.id);
      return;
    }
    if (f.interactiveType === 'show_name') {
      // No modal — GameCanvas draws the floating label directly off
      // momentaryReveals for a fixed duration (matches speech bubbles' own
      // 4s convention). hideObjectName is a hard override.
      if (!f.name || f.hideObjectName) return;
      useGameStore.getState().triggerMomentaryReveal(f.id, 4000);
      return;
    }
    if (f.interactiveType === 'show_word_balloon') {
      const cfg = f.interactiveConfig;
      if (!cfg?.wordBalloonText) return;
      // 'random' picks the color ONCE here (trigger time) — see
      // momentaryReveals' own doc comment for why it can't be chosen at
      // draw time (would flicker every frame instead of staying stable).
      const variant = cfg.wordBalloonType === 'random'
        ? WORD_BALLOON_RANDOM_COLORS[Math.floor(Math.random() * WORD_BALLOON_RANDOM_COLORS.length)]
        : undefined;
      useGameStore.getState().triggerMomentaryReveal(f.id, 4000, variant);
      return;
    }
    if (f.interactiveType === 'animation') {
      // Simplified from ZEP's own "moving objects through sprite files" —
      // plays as a floating overlay above the piece for a fixed window
      // (GameCanvas reads spriteFile/frame* off the config directly at draw
      // time), not a permanent swap of the piece's own base sprite. See the
      // config's own doc comment in shared/types for why.
      const cfg = f.interactiveConfig;
      if (!cfg?.spriteFile || !cfg.spriteFrameWidth || !cfg.spriteFrameHeight || !cfg.spriteFrameCount) return;
      useGameStore.getState().triggerMomentaryReveal(f.id, 4000);
      return;
    }
    // Fresh object → any stale reply from a PREVIOUS password/choice object
    // must not leak in as if it were this one's result.
    useGameStore.getState().setInteractivePasswordResult(null);
    useGameStore.getState().setInteractiveChoiceResult(null);
    setTriggeredInteractiveId(id);
  }, [emitInteractiveApiCall, emitInteractiveChangeObject]);

  const handleCheckPassword = useCallback((furnitureId: string, attempt: string) => {
    useGameStore.getState().setInteractivePasswordResult(null);
    emitInteractivePasswordCheck(furnitureId, attempt);
  }, [emitInteractivePasswordCheck]);

  const handleCheckChoice = useCallback((furnitureId: string, selectedIndex: number) => {
    useGameStore.getState().setInteractiveChoiceResult(null);
    emitInteractiveChoiceCheck(furnitureId, selectedIndex);
  }, [emitInteractiveChoiceCheck]);

  const interactivePasswordResult = useGameStore((s) => s.interactivePasswordResult);
  const interactiveChoiceResult = useGameStore((s) => s.interactiveChoiceResult);

  // ZEP-style door password — fires once per approach (GameCanvas re-arms on
  // leaving/re-entering range); ignore a re-trigger for the SAME door while
  // its modal is already open (e.g. the auto-trigger firing again a frame
  // later), but do let a genuinely different door replace it.
  const handleDoorPasswordTrigger = useCallback((x: number, y: number) => {
    setDoorPasswordTile((prev) => (prev && prev.x === x && prev.y === y) ? prev : { x, y });
    useGameStore.getState().setInteractiveDoorPasswordResult(null);
  }, []);

  const handleCheckDoorPassword = useCallback((_furnitureId: string, attempt: string) => {
    if (!doorPasswordTile) return;
    useGameStore.getState().setInteractiveDoorPasswordResult(null);
    emitInteractiveDoorPasswordCheck(doorPasswordTile.x, doorPasswordTile.y, attempt);
  }, [doorPasswordTile, emitInteractiveDoorPasswordCheck]);

  // "Door Area" — same shape as the tile-based pair just above.
  const handleDoorAreaPasswordTrigger = useCallback((areaId: string) => {
    setDoorAreaPasswordAreaId((prev) => (prev === areaId ? prev : areaId));
    useGameStore.getState().setInteractiveDoorAreaPasswordResult(null);
  }, []);

  const handleCheckDoorAreaPassword = useCallback((_furnitureId: string, attempt: string) => {
    if (!doorAreaPasswordAreaId) return;
    useGameStore.getState().setInteractiveDoorAreaPasswordResult(null);
    emitInteractiveDoorAreaPasswordCheck(doorAreaPasswordAreaId, attempt);
  }, [doorAreaPasswordAreaId, emitInteractiveDoorAreaPasswordCheck]);

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

  // B key for emote wheel — was Z, but Z is now the nudge/senggol key
  // (GameCanvas.tsx), and both handlers listen on the same window keydown,
  // so a single Z press fired the emote wheel toggle here AND the nudge
  // attempt there at once.
  //
  // Bug — M used to toggle the minimap's visibility, but nothing in the UI
  // ever explained that, and M is a common mute-mic convention in other
  // apps — a player pressing it expecting to mute instead made their
  // minimap vanish with no obvious way to know why or bring it back short
  // of knowing to press M again. The minimap is small and easy to ignore
  // when not needed, so there was never a real reason to let it be
  // toggled away at all — it's unconditionally visible now (still subject
  // to simplifiedView, same as before).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Inert while typing (the Docs editor is contenteditable, so "B" used
      // to open the emote wheel and eat the character) and while a suite
      // module is covering the room.
      if (shouldIgnoreRoomHotkey(e.target, moduleOpen)) return;
      // QA (Akses tamu checklist item 2, "Guest terbatas") — emotes are
      // hotkey-only (no visible button to hide), so the block has to live
      // here; also rejected server-side now (see emoteHandler.ts).
      if (isGuest) return;
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        setShowEmoteWheel((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [moduleOpen, isGuest]);

  // "Ngobrol dengan CEO" v2 — G opens the booking form, from anywhere in the
  // room (not gated by standing near the zone — see the spec's own "member
  // di mana saja / dekat area CEO"). Guests never get a real account queue
  // ticket (server-enforced, see roomQueue.ts's own reasoning), so this is
  // inert for them same as the other member-only hotkeys.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldIgnoreRoomHotkey(e.target, moduleOpen)) return;
      if (isGuest) return;
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        api.getBookingZones(roomSlug).then((res) => {
          const zone = res.zones[0];
          if (!zone) {
            zoneLock.flashToast?.('Tidak ada ruang booking di room ini.');
            return;
          }
          setBookingZone({ zoneId: zone.zoneId, name: zone.name });
          openPanel('bookingForm');
        }).catch(() => {});
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [moduleOpen, isGuest, roomSlug, zoneLock]);

  const allPlayers = { [localPlayerId]: useGameStore.getState().localPlayer, ...playerRecords };

  // Until the real room:state for THIS room arrives, `roomState` in the
  // store is still whatever App() seeded at startup (always the Main
  // Office layout, regardless of which room/template was actually joined
  // — see gameStore.ts's roomStateReceived doc comment). Render a plain
  // loading placeholder instead of GameCanvas rather than briefly showing
  // the wrong room shape (and risking a spawn tile that's a wall in the
  // real layout).
  //
  // Guest Link & Ruang Tunggu — a guest waiting on GUEST_JOIN_DECIDE (or
  // already rejected) also never gets room:state, so it needs the exact
  // same "final state, not just a loading flash" treatment.
  if (!roomStateReceived) {
    return (
      <div className="relative w-screen h-screen bg-gradient-to-br from-white to-purple-50 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center">
        {roomFullNotice ? (
          <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 text-center max-w-xs">
            <p className="text-2xl mb-1">🚪</p>
            <p className="text-gray-900 dark:text-gray-100 text-sm font-medium mb-1">{roomFullNotice}</p>
            <button
              onClick={onLeave}
              className="mt-3 px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs font-medium cursor-pointer"
            >
              Kembali ke Lobby
            </button>
          </div>
        ) : isGuest && guestWaitState === 'waiting' ? (
          <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 text-center max-w-xs">
            <p className="text-2xl mb-1">⏳</p>
            <p className="text-gray-900 dark:text-gray-100 text-sm font-medium mb-1">Menunggu persetujuan admin…</p>
            <p className="text-gray-400 dark:text-gray-500 text-xs">Anda akan masuk otomatis begitu disetujui.</p>
          </div>
        ) : isGuest && guestWaitState === 'rejected' ? (
          <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 text-center max-w-xs">
            <p className="text-2xl mb-1">🚫</p>
            <p className="text-gray-900 dark:text-gray-100 text-sm font-medium mb-1">Permintaan Anda ditolak.</p>
            <button
              onClick={onLeave}
              className="mt-3 px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs font-medium cursor-pointer"
            >
              Tutup
            </button>
          </div>
        ) : joinTimedOut ? (
          <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 text-center max-w-xs">
            <p className="text-2xl mb-1">⚠️</p>
            <p className="text-gray-900 dark:text-gray-100 text-sm font-medium mb-1">Gagal terhubung ke server.</p>
            <p className="text-gray-400 dark:text-gray-500 text-xs mb-3">
              {isSocketConnected ? 'Server merespons tapi room tidak kunjung siap.' : 'Periksa koneksi internet kamu, lalu coba lagi.'}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium cursor-pointer"
            >
              Coba lagi
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="w-6 h-6 border-2 border-purple-300 border-t-purple-600 rounded-full animate-spin" />
            <p className="text-gray-500 dark:text-gray-400 text-sm">
              {isSocketConnected ? 'Menyiapkan room…' : 'Menghubungkan ke server…'}
            </p>
          </div>
        )}
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
        emitTeleportTo={emitTeleportTo}
        emitClaimSeat={emitClaimSeat}
        emitReleaseSeat={emitReleaseSeat}
        onMediaOpen={setViewingMediaId}
        onPlayerClick={(player, x, y) => setPlayerCardTarget({ player, x, y })}
        onInteractiveTrigger={handleInteractiveTrigger}
        onNoteOpen={setNoteEditingId}
        onDoorPasswordTrigger={handleDoorPasswordTrigger}
        onDoorAreaPasswordTrigger={handleDoorAreaPasswordTrigger}
        lowSpecMode={simplifiedView}
        restrictedZoneIds={restrictedZoneIds}
      />

      {playerCardTarget && (
        <PlayerCard
          name={playerCardTarget.player.name}
          seed={playerCardTarget.player.userId ?? playerCardTarget.player.id}
          avatarConfig={playerCardTarget.player.avatarConfig}
          anchorX={playerCardTarget.x}
          anchorY={playerCardTarget.y}
          onSendMessage={
            playerCardTarget.player.userId && !playerCardTarget.player.isGuest
              ? () => { channelChat.startDm(playerCardTarget.player.userId!); setPlayerCardTarget(null); }
              : undefined
          }
          isFollowingThem={!!playerCardTarget.player.userId && followInfo?.targetUserId === playerCardTarget.player.userId}
          onFollow={
            playerCardTarget.player.userId
              ? () => { emitFollowRequest(playerCardTarget.player.userId!); setPlayerCardTarget(null); }
              : undefined
          }
          onUnfollow={() => { emitFollowUnfollow(); setPlayerCardTarget(null); }}
          onCopyOutfit={
            playerCardTarget.player.avatarConfig
              ? () => handleCopyOutfit(playerCardTarget.player.avatarConfig!)
              : undefined
          }
          onRequestRemoteHelp={
            playerCardTarget.player.userId && !playerCardTarget.player.isGuest
              ? () => { emitRemoteHelpRequest(playerCardTarget.player.userId!); setPlayerCardTarget(null); }
              : undefined
          }
          onClose={() => setPlayerCardTarget(null)}
        />
      )}

      {/* QA (Data A/V checklist item 7, "Rekaman & consent") — persistent
          (not a self-dismissing toast, unlike the notices below) and
          visible to LITERALLY EVERYONE regardless of role — see
          roomRecordingActive's own doc comment in gameStore.ts for why
          RECORDING_STARTED's existing role-filtered visibility isn't
          enough on its own. */}
      {roomRecordingActive && !editorMode && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-40 bg-red-600/95 text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg pointer-events-none inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          Room ini sedang direkam
        </div>
      )}

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

      {/* Controls text ("WASD / Arrows...") and "Playing as" removed from
          here — the map stayed permanently covered by them. The control
          list now lives in the existing Panduan (TutorialModal.tsx,
          Slide 2), reachable any time via Sidebar ☰ → Room Features →
          Panduan; "Playing as" was dropped entirely (the player's own
          name is already visible elsewhere — video tile, participant
          list, etc.). */}
      <div className="absolute top-14 left-16 flex items-start gap-2 pointer-events-none">
        {/* Peserta toggle — moved here from the bottom meeting-control bar
            (see that bar's own comment) so it sits directly left of
            Soundboard, matching the same icon-button-that-opens-a-panel
            convention already used by Soundboard/ActivityFeed. Kept on its
            own !moduleOpen/!screenShareMaximized gate — identical to its
            old bottom-bar condition — rather than folding into the
            !simplifiedView block below: Simplify hides Soundboard/
            ActivityFeed/MusicPlayer but the meeting-participation controls
            (mic/camera/.../Peserta) stay reachable during Simplify, exactly
            as before this move. Wrapped in its own pointer-events-auto div
            since this row's pointer-events-none only gets overridden by
            children that opt back in (Tooltip's own wrapper div doesn't). */}
        {!moduleOpen && !screenShareMaximized && (
          <div className="pointer-events-auto">
            <ParticipantsToggleButton open={activePanel === 'participants'} onToggle={() => openPanel('participants')} />
          </div>
        )}
        {!simplifiedView && (
          <>
            {/* QA (Akses tamu checklist item 2, "Guest terbatas") — Soundboard
                playback is now also server-rejected for guests
                (roomHandler.ts's SOUNDBOARD_PLAY), so hiding the panel too
                avoids a dead "nothing happens when I click" button. */}
            {!isGuest && (
              <SoundboardPanel roomSlug={roomSlug} emitSoundboardPlay={emitSoundboardPlay} open={activePanel === 'soundboard'} onToggle={() => openPanel('soundboard')} onClose={closePanel} />
            )}
            <ActivityFeed open={activePanel === 'activityFeed'} onToggle={() => openPanel('activityFeed')} />
          </>
        )}
      </div>
      {!simplifiedView && !isGuest && <MusicPlayerWidget zoneId={currentZone?.id ?? null} />}

      <div className="absolute top-4 right-4 flex items-center gap-2">
        <MapZoomControl />
        <ConnectionIndicator />
      </div>

      {/* On-screen movement/action controls — self-hides on non-touch devices
          (see MobileControls), so it only appears for phone/tablet players. */}
      {!editorMode && <MobileControls />}

      {/* Follow (§3) indicator — only the ONE new thing from this pass that's
          always visible without opening a panel first. 'standby' means the
          target went offline; movement pauses but the relationship is kept
          server-side (see followHandler.ts) and resumes automatically the
          moment they reconnect, no need to click Follow again. */}
      {(followInfo || followerUserIds.length > 0) && (
        <div className="absolute bottom-28 left-16 z-30 pointer-events-auto flex flex-col items-start gap-1.5">
          {followInfo && (
            <div className="bg-white/90 backdrop-blur-sm border border-purple-200 shadow-sm rounded-lg px-3 py-2 flex items-center gap-2 text-xs">
              <PersonWalking size={13} className="text-purple-600" />
              <span className="text-gray-700">
                {followInfo.status === 'active' ? 'Mengikuti ' : 'Menunggu '}
                <span className="font-medium">{followInfo.targetName}</span>
                {followInfo.status === 'standby' && <span className="text-gray-400"> (offline)</span>}
              </span>
              <button onClick={emitFollowUnfollow} title="Berhenti mengikuti" className="text-gray-400 hover:text-red-500 cursor-pointer">
                <X size={14} />
              </button>
            </div>
          )}
          {/* The other half of the relationship, which had no UI at all until
              now: followerUserIds has been in the store all along (its own
              comment even says "for a small UI indicator") but nothing ever
              rendered it, so being followed was completely invisible to the
              person being followed. Deliberately quieter than the row above —
              this is information, not something to act on. */}
          {followerUserIds.length > 0 && (
            <div className="bg-white/80 backdrop-blur-sm border border-gray-200 shadow-sm rounded-lg px-3 py-1.5 flex items-center gap-2 text-[11px]">
              <PersonWalking size={11} className="text-gray-400" />
              <span className="text-gray-500">
                <span className="font-medium text-gray-600">{followerUserIds.length}</span> orang mengikutimu
              </span>
            </div>
          )}
        </div>
      )}

      {/* Summon/Follow consent cards. Moved from bottom-centre to the top:
          down there they sat directly on top of the mic/camera toolbar, in
          the one strip the eye ignores while steering an avatar — the worst
          place for something that needs a decision. top-16 clears the room
          name strip at top-4. z-50 keeps them above the screen-share panel;
          during a presentation the card does overlap its title bar, which is
          the intended trade: a request waiting on you should interrupt. */}
      <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2">
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
        {incomingRemoteHelpRequest && (
          <PendingRequestToast
            icon={<Display size={13} className="text-purple-600" />}
            message={<><span className="font-medium">{incomingRemoteHelpRequest.actorName}</span> minta bantuan remote (RustDesk)</>}
            onAccept={() => {
              emitRemoteHelpRespond(incomingRemoteHelpRequest.requestId, true);
              useGameStore.getState().setIncomingRemoteHelpRequest(null);
              useGameStore.getState().setActiveRemoteHelp({ role: 'target', otherName: incomingRemoteHelpRequest.actorName });
              // Final-review Fix 3 — each new session starts unacknowledged;
              // without this a SECOND session in the same tab would inherit
              // the previous session's acked:true and show "Terkirim"
              // before the target has submitted anything this time.
              useGameStore.getState().setRemoteHelpCredentialAcked(false);
            }}
            onDecline={() => {
              emitRemoteHelpRespond(incomingRemoteHelpRequest.requestId, false);
              useGameStore.getState().setIncomingRemoteHelpRequest(null);
            }}
          />
        )}
        {/* Item #5 — stacked join-request popups. Capped at 3 visible cards
            (a "+N lainnya" pill for the rest) so several simultaneous
            requests can't fill the whole screen; isAdmin is defense-in-depth
            only — the server already never sends this to a non-admin. */}
        {isAdmin && incomingJoinRequests.slice(0, 3).map((req) => (
          <PendingRequestToast
            key={`${req.roomSlug}:${req.userId}`}
            icon={<PersonPlusFill size={13} className="text-emerald-500" />}
            message={<><span className="font-medium">{req.name}</span> minta bergabung ke <span className="font-medium">{req.roomName}</span></>}
            onAccept={() => decideIncomingJoinRequest(req, 'approve')}
            onDecline={() => decideIncomingJoinRequest(req, 'reject')}
          />
        ))}
        {isAdmin && incomingJoinRequests.length > 3 && (
          <div className="bg-slate-800/90 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow pointer-events-none">
            +{incomingJoinRequests.length - 3} permintaan bergabung lainnya
          </div>
        )}
        {/* "Ngobrol dengan CEO" queue, zone-level — same stacked-toast shape
            as the join-request popups above (capped at 3 + "+N lainnya").
            Gated on localIsCeo, NOT isAdmin — the server only ever sends
            this to whoever's actually been granted CEO access (see
            roomHandler.ts's getConnectedCeoSocketIds), so it's their queue
            to decide, not every room admin's. */}
        {localIsCeo && incomingQueueRequests.slice(0, 3).map((req) => (
          <PendingRequestToast
            key={req.entryId}
            icon={<BriefcaseFill size={13} className="text-amber-600" />}
            message={
              req.mode === 'booking' && req.bookingStart && req.bookingEnd ? (
                <><span className="font-medium">{req.name}</span> booking <span className="font-medium">{req.zoneName}</span> jam {formatClock(req.bookingStart)}–{formatClock(req.bookingEnd)}{req.topic ? <> — &quot;{req.topic}&quot;</> : null}</>
              ) : (
                <><span className="font-medium">{req.name}</span> minta antre ngobrol di <span className="font-medium">{req.zoneName}</span>{req.topic ? <> — &quot;{req.topic}&quot;</> : null} ({req.durationMin}m)</>
              )
            }
            onAccept={() => decideIncomingQueueRequest(req, 'approve')}
            onDecline={() => decideIncomingQueueRequest(req, 'reject')}
          />
        ))}
        {localIsCeo && incomingQueueRequests.length > 3 && (
          <div className="bg-slate-800/90 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow pointer-events-none">
            +{incomingQueueRequests.length - 3} antrean lainnya
          </div>
        )}
        {/* Guest Link & Ruang Tunggu — same stacked-toast shape as the
            member join-request queue above, distinct tint so the two are
            visually distinguishable (a guest has no account behind them). */}
        {isAdmin && pendingGuests.slice(0, 3).map((req) => (
          <PendingRequestToast
            key={req.guestId}
            icon={<PersonPlusFill size={13} className="text-purple-500" />}
            message={<><span className="font-medium">{req.name}</span> (tamu) minta masuk ke room ini</>}
            onAccept={() => { emitGuestJoinDecide(req.guestId, true); useGameStore.getState().removePendingGuest(req.guestId); }}
            onDecline={() => { emitGuestJoinDecide(req.guestId, false); useGameStore.getState().removePendingGuest(req.guestId); }}
          />
        ))}
        {isAdmin && pendingGuests.length > 3 && (
          <div className="bg-slate-800/90 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow pointer-events-none">
            +{pendingGuests.length - 3} tamu menunggu lainnya
          </div>
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
        {remoteHelpResult && (
          <div className="bg-purple-600/90 text-white text-xs font-semibold px-4 py-2 rounded-full shadow-lg pointer-events-none inline-flex items-center gap-1.5">
            <Display size={13} />
            {remoteHelpResult.accepted
              ? `${remoteHelpResult.targetName} accepted your remote-help request`
              : remoteHelpResult.reason === 'busy'
                ? `${remoteHelpResult.targetName} is already being helped by someone else`
                : remoteHelpResult.reason === 'helper-busy'
                  ? 'Kamu sedang aktif membantu orang lain — selesaikan sesi itu dulu.'
                  : `${remoteHelpResult.targetName} ${describeConsentDecline(remoteHelpResult.reason)} your remote-help request`}
          </div>
        )}
        {nudgedBy && (
          <div className="bg-amber-500/95 text-white text-sm font-semibold px-4 py-2 rounded-full shadow-lg pointer-events-none inline-flex items-center gap-2 animate-fade-in">
            <HandIndexThumbFill size={14} />
            <span className="font-bold">{nudgedBy}</span> menyenggolmu!
          </div>
        )}
        {slappedBy && (
          <div className="bg-purple-600/95 text-white text-sm font-semibold px-4 py-2 rounded-full shadow-lg pointer-events-none inline-flex items-center gap-2 animate-fade-in">
            👋 <span className="font-bold">{slappedBy}</span> nyoel kamu — sadar dong!
          </div>
        )}
        {/* QA #9/#10 — CEO/admin text broadcast. rounded-2xl + max-w-md
            (not the pill shape above) since this can be a real multi-word
            announcement, not a short one-liner ping. */}
        {roomBroadcast && (
          <div className="bg-teal-600/95 text-white text-sm font-semibold px-4 py-3 rounded-2xl shadow-lg pointer-events-none flex items-start gap-2 animate-fade-in max-w-md text-left">
            <VolumeUpFill size={16} className="shrink-0 mt-0.5" />
            <span>
              <span className="block text-[11px] font-normal opacity-80 mb-0.5">Pengumuman dari {roomBroadcast.senderName}</span>
              {roomBroadcast.text}
            </span>
          </div>
        )}
        {adminErrorMessage && (
          <div className="bg-red-600/95 text-white text-sm font-semibold px-4 py-2 rounded-full shadow-lg pointer-events-none inline-flex items-center gap-2 animate-fade-in">
            ⚠️ {adminErrorMessage}
          </div>
        )}
      </div>

      {activeRemoteHelp && (
        <RemoteHelpBanner
          role={activeRemoteHelp.role}
          otherName={activeRemoteHelp.otherName}
          onEnd={() => { emitRemoteHelpEnd(); useGameStore.getState().setActiveRemoteHelp(null); useGameStore.getState().setReceivedRemoteHelpCredential(null); }}
        />
      )}
      {activeRemoteHelp?.role === 'target' && !receivedRemoteHelpCredential && (
        <RemoteHelpCredentialForm
          helperName={activeRemoteHelp.otherName}
          onSubmit={(rustdeskId, password) => emitRemoteHelpCredential(rustdeskId, password)}
          acked={remoteHelpCredentialAcked}
        />
      )}
      {activeRemoteHelp?.role === 'helper' && receivedRemoteHelpCredential && (
        <div className="fixed top-32 right-4 z-50 w-72 bg-white/95 dark:bg-gray-900/95 rounded-xl shadow-lg px-3.5 py-3 text-xs text-gray-800 dark:text-gray-100 flex flex-col gap-2">
          <div className="font-semibold">ID+password dari {activeRemoteHelp.otherName}:</div>
          {/* ID only — safe to embed in a link, RustDesk shows this plainly
              on its own home screen too. Password NEVER goes into a link/URL
              (see RemoteHelpCredentialPayload's doc comment) — copy-button
              only, so it can't end up in browser/OS history. Real behavior
              of the rustdesk:// scheme (does it open the app? pre-fill the
              ID field?) depends on the RustDesk version installed — needs a
              real test, this is a best-effort convenience, not guaranteed. */}
          <a
            href={`rustdesk://${encodeURIComponent(receivedRemoteHelpCredential.rustdeskId)}`}
            className="flex items-center justify-between gap-2 font-mono bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 rounded px-2 py-1.5 hover:bg-purple-100 dark:hover:bg-purple-900/40 transition-colors"
          >
            <span className="select-all">{receivedRemoteHelpCredential.rustdeskId}</span>
            <span className="text-purple-600 dark:text-purple-400 text-[10px] font-sans font-semibold shrink-0">Buka RustDesk →</span>
          </a>
          <button
            onClick={() => { navigator.clipboard?.writeText(receivedRemoteHelpCredential.password).catch(() => {}); }}
            className="flex items-center justify-between gap-2 font-mono bg-gray-100 dark:bg-gray-800 rounded px-2 py-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors text-left cursor-pointer"
          >
            <span className="select-all">{receivedRemoteHelpCredential.password}</span>
            <span className="text-gray-500 dark:text-gray-400 text-[10px] font-sans font-semibold shrink-0">Copy</span>
          </button>
          <RustdeskSetupHint />
        </div>
      )}

      <AwayReasonModal open={awayPromptOpen} onResolve={resolveAwayPrompt} />
      {/* Global replacement for window.alert/confirm/prompt — see
          modalStore.ts's showAlert/showConfirm/showPrompt. Mounted once here
          so every caller anywhere in the tree can just await one of those
          instead of rendering its own overlay. */}
      <GlobalModal />

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
          one thing that must always stay reachable.

          Hidden while a screen share is truly maximized (screenShareMaximized)
          — the one exception to "always rendered" above, since a maximized
          share is a deliberate full-screen takeover of its own, same
          intent as simplifiedView but triggered from the video panel
          instead of the corner eye icon. Un-maximizing (its own control, or
          Escape) brings the rail straight back. */}
      {!screenShareMaximized && (
      <Sidebar
        roomFeaturesActive={activePanel === 'roomFeatures'}
        onToggleRoomFeatures={() => openPanel('roomFeatures')}
        onCloseRoomFeatures={() => { if (useGameStore.getState().activePanel === 'roomFeatures') closePanel(); }}
        onOpenSettings={() => openPanel('settings')}
        hasActiveBooking={zoneLock.zoneQueueTicket?.mode === 'booking'}
        onReopenBookingNotice={() => setBookingNoticeDismissed(false)}
        onEditAvatar={() => openPanel('avatarSetup')}
        onOpenTutorial={() => openPanel('userGuide')}
        onOpenMemberList={() => openPanel('memberList')}
        localRole={localRole}
        manualStatus={manualStatus}
        onPickPresence={handlePresencePick}
        isAdmin={isAdmin}
        onOpenRoomEditor={() => window.open(`/?roomEditor=${encodeURIComponent(roomSlug)}`, '_blank', 'noopener')}
        canTeleport={roleAtLeast(localRole, 'member')}
        showTeleportPanel={showTeleportPanel}
        onToggleTeleport={() => openPanel('teleport')}
        hasMySeat={hasMySeat}
        onMySeat={handleMySeat}
        doorOverride={doorOverride}
        canDoorOverride={isAdmin}
        onToggleDoorOverride={() => emitDoorOverride(!doorOverride)}
        canManageGuests={isAdmin}
        onCreateGuestLink={handleCreateGuestLink}
        onRevokeLastGuestLink={handleRevokeGuestLink}
        canBroadcast={isAdmin}
        onBroadcast={handleBroadcast}
        // Bug fix — `isGuest` alone is only the CLIENT's own memory of which
        // entry path it took (GuestEntry.tsx vs LoginPage). `localRole` is
        // the SERVER's own authoritative role for this session (room:state's
        // `role` field — see gameStore.ts, 'guest' is only ever assigned by
        // the server to an actual Guest Link connection, per
        // shared/permissions.ts). ORing them in is a pure safety net — if
        // they ever disagree, treat as guest. Reported: "Member" was still
        // reachable in a guest session despite the code already gating it on
        // `isGuest` alone, which this hardens against without knowing
        // (unreproduced) whether that was a real desync or a stale tab.
        isGuest={isGuest || localRole === 'guest'}
        simplifiedView={simplifiedView}
        onToggleSimplifiedView={() => setSimplifiedView((v) => !v)}
        currentZoneName={currentZone?.name ?? null}
        zoneLocked={!!zoneLock.lockOf(currentZone?.id ?? null)}
        zoneLockedByName={zoneLock.lockOf(currentZone?.id ?? null)?.lockedByName ?? null}
        canToggleZoneLock={!zoneLock.lockOf(currentZone?.id ?? null) || zoneLock.isKeyholder(currentZone?.id ?? null)}
        onToggleZoneLock={() => {
          if (!currentZone) return;
          zoneLock.setLock(currentZone.id, !zoneLock.lockOf(currentZone.id), currentZone.name);
        }}
        calendarViewActive={calendarViewActive}
        onToggleCalendarView={() => openPanel('calendar')}
        attendanceViewActive={attendanceViewActive}
        onToggleAttendanceView={() => openPanel('attendance')}
        messengerViewActive={messengerViewActive}
        onToggleMessengerView={() => openPanel('messenger')}
        joinQueueActive={joinQueueActive}
        onToggleJoinQueue={() => openPanel('joinQueue')}
        pendingJoinCount={pendingJoinCount}
        isWorkspaceAdmin={currentUser.workspaceRole === 'admin'}
        adminViewActive={adminViewActive}
        onToggleAdminView={() => openPanel('adminConsole')}
        isOperator={currentUser.isOperator}
        operatorConsoleActive={operatorConsoleActive}
        onToggleOperatorConsole={() => openPanel('operatorConsole')}
        myAnalyticsActive={myAnalyticsActive}
        onToggleMyAnalytics={() => openPanel('myAnalytics')}
        miniModeSupported={isMiniModeSupported()}
        miniModeActive={!!miniModeWindow}
        onToggleMiniMode={handleToggleMiniMode}
        showAddMediaPanel={showAddMediaPanel}
        onToggleAddMedia={() => openPanel('addMedia')}
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
        hiddenActive={!!localPlayer.hidden}
        canToggleHidden={roleAtLeast(localRole, 'admin')}
        onToggleHidden={handleHiddenToggle}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />
      )}

      {/* Permanent seat assignment (ZEP-style "this is my desk") — only
          shown while actually sitting, since it acts on the specific chair
          you're in. Distinct from the transient "SPACE to sit" prompt drawn
          on the canvas itself (GameCanvas.tsx), which anyone can use
          regardless of login; assigning requires an account (server-side
          checked) since it's meant to persist across sessions. */}
      {localPlayer.isSitting && sittingItem && (
        <div className="absolute bottom-40 left-1/2 -translate-x-1/2 z-30 pointer-events-auto">
          {!sittingItem.assignedToUserId ? (
            <Tooltip label="Jadikan Kursi Saya" detail="Tandai kursi ini jadi kursi tetapmu — otomatis kamu duduk di sini tiap masuk room.">
              <button
                onClick={() => emitFurnitureAssign(sittingItem.id, playerName)}
                className="bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold px-4 py-2 rounded-full shadow-lg cursor-pointer inline-flex items-center gap-1.5"
              >
                🪑 Assign as My Seat
              </button>
            </Tooltip>
          ) : sittingItem.assignedToUserId === localUserId ? (
            <Tooltip label="Lepas Kursi Saya" detail="Batalkan status kursi tetap ini.">
              <button
                onClick={() => emitFurnitureUnassign(sittingItem.id)}
                className="bg-white hover:bg-gray-50 text-purple-700 text-xs font-semibold px-4 py-2 rounded-full shadow-lg border border-purple-200 cursor-pointer inline-flex items-center gap-1.5"
              >
                Unassign My Seat
              </button>
            </Tooltip>
          ) : (
            <div className="bg-white/90 backdrop-blur-sm text-gray-500 text-xs font-medium px-4 py-2 rounded-full shadow-sm border border-purple-100 inline-flex items-center gap-1.5">
              🔒 Reserved by {sittingItem.assignedToName || 'someone'}
            </div>
          )}
        </div>
      )}


      {adminViewActive && (
        <Suspense fallback={null}>
          <AdminConsole currentUser={currentUser} onClose={closePanel} />
        </Suspense>
      )}
      {operatorConsoleActive && (
        <Suspense fallback={null}>
          <OperatorConsole currentUser={currentUser} onClose={closePanel} />
        </Suspense>
      )}
      {myAnalyticsActive && (
        <Suspense fallback={null}>
          <MyAnalyticsPanel onClose={closePanel} />
        </Suspense>
      )}
      {/* Absensi + Cuti sekaligus — Cuti adalah tab di dalam AttendanceApp. */}
      {attendanceViewActive && <AttendanceApp onClose={closePanel} />}
      {joinQueueActive && isAdmin && (
        <JoinRequestPanel roomSlug={roomSlug} onClose={closePanel} />
      )}
      {/* Messenger — the full-screen chat surface. Shares every bit of state
          with the floating ChatPanel below (same useChannelChat instance), so
          the two are two views of one conversation, not two inboxes. */}
      {messengerViewActive && (
        <MessengerApp
          localUserId={authUserId}
          isAdmin={isAdmin}
          roomSlug={roomSlug}
          onClose={closePanel}
          channels={channelChat.channels}
          dmConversations={channelChat.dmConversations}
          activeChatTarget={channelChat.activeChatTarget}
          onSelectTarget={channelChat.setActiveChatTarget}
          messages={channelChat.activeMessages}
          onSend={channelChat.sendMessage}
          onSendFile={channelChat.sendFileMessage}
          onRetry={channelChat.retryMessage}
          onTyping={channelChat.notifyTyping}
          onDeleteMessage={channelChat.deleteMessage}
          onEditMessage={channelChat.editMessage}
          onPinMessage={channelChat.pinMessage}
          onLoadOlder={channelChat.loadOlder}
          onCreateChannel={channelChat.createChannel}
        />
      )}
      {calendarViewActive && (
        <CalendarApp
          currentUser={{ id: authUserId, name: authDisplayName, timezone: currentUser.timezone }}
          onClose={closePanel}
          onStartMeeting={(slug) => { closePanel(); onPortalTravel(slug); }}
        />
      )}

      {showAdminPanel && (
        <AdminPanel
          onGrantAdmin={(userId) => emitAdminGrant(userId)}
          onRevokeAdmin={(userId) => emitAdminRevoke(userId)}
          onGrantStaff={(userId) => emitStaffGrant(userId)}
          onRevokeStaff={(userId) => emitStaffRevoke(userId)}
          onGrantCeo={(userId) => emitCeoGrant(userId)}
          onRevokeCeo={(userId) => emitCeoRevoke(userId)}
        />
      )}

      {showTeleportPanel && (
        <TeleportPanel
          roomSlug={roomSlug}
          isOwner={localRole === 'owner'}
          // Bug 4 — everyone may open the panel and jump to saved locations,
          // but only staff+ see the add/delete/reorder controls (mirrors the
          // server's 'teleport:admin' gate on those REST endpoints).
          canManage={roleAtLeast(localRole, 'staff')}
          onTeleport={(kind, locationId) => emitTeleportRequest({ kind, locationId })}
          onClose={closePanel}
        />
      )}

      {showAddMediaPanel && (
        <AddMediaPanel
          onAdd={handleMediaAdd}
          onAddNote={(x, y, text) => emitNoteAdd(x, y, text)}
          onScreenshot={handleScreenshot}
          onClose={closePanel}
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

      {triggeredInteractive && (
        <InteractiveObjectModal
          furniture={triggeredInteractive}
          onClose={() => { setTriggeredInteractiveId(null); useGameStore.getState().setInteractivePasswordResult(null); useGameStore.getState().setInteractiveChoiceResult(null); }}
          onCheckPassword={handleCheckPassword}
          passwordResult={interactivePasswordResult}
          onCheckChoice={handleCheckChoice}
          choiceResult={interactiveChoiceResult}
        />
      )}

      {doorPasswordFurniture && (
        <InteractiveObjectModal
          furniture={doorPasswordFurniture}
          onClose={() => { setDoorPasswordTile(null); useGameStore.getState().setInteractiveDoorPasswordResult(null); }}
          onCheckPassword={handleCheckDoorPassword}
          passwordResult={doorPasswordResultAdapted}
          onCheckChoice={() => {}}
          choiceResult={null}
        />
      )}

      {doorAreaPasswordFurniture && (
        <InteractiveObjectModal
          furniture={doorAreaPasswordFurniture}
          onClose={() => { setDoorAreaPasswordAreaId(null); useGameStore.getState().setInteractiveDoorAreaPasswordResult(null); }}
          onCheckPassword={handleCheckDoorAreaPassword}
          passwordResult={doorAreaPasswordResultAdapted}
          onCheckChoice={() => {}}
          choiceResult={null}
        />
      )}

      {reportTarget && (
        <ReportUserModal target={reportTarget} roomSlug={roomSlug} onClose={() => setReportTarget(null)} />
      )}

      {noteEditingId && (
        <NoteModal
          noteId={noteEditingId}
          note={notes.find((n) => n.id === noteEditingId)}
          localUserId={authUserId}
          isGuest={isGuest}
          onSave={emitNoteEdit}
          onDelete={emitNoteDelete}
          onClose={() => setNoteEditingId(null)}
        />
      )}

      {avatarSetupActive && (
        <AvatarSetup
          initialConfig={savedConfig}
          onSave={handleAvatarSave}
          onClose={closePanel}
          localUserId={localUserId}
        />
      )}

      {userGuideActive && <UserGuidePanel onClose={closePanel} />}

      {memberListActive && (
        <MemberListPanel
          localUserId={authUserId}
          currentRoomSlug={roomSlug}
          emitRosterListRequest={emitRosterListRequest}
          onClose={closePanel}
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
          onClose={closePanel}
          onEmote={handleEmoteSelect}
          showReactions={showEmoteWheel}
          failedPeerIds={failedPeers}
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
            failedPeerIds={failedPeers}
            onToggleMeetingView={() => openPanel('meeting')}
            onScreenShareMaximizedChange={setScreenShareMaximized}
          />
        </>
      )}

      {/* HUD Controls — z-50 so mic/camera/screen-share stay reachable even
          while Meeting View's z-40 full-screen overlay is active; without
          this there was no way to mute/unmute or stop screen share without
          exiting Meeting View first.

          Hidden while a SUITE module is open (moduleOpen). Meeting View is
          deliberately NOT part of moduleOpen, so the "stay reachable over
          Meeting View" behaviour above is untouched — but a full-screen
          module (Calendar/Docs/Admin/etc.) is a different thing: the
          centered bar would land squarely on its content. Messenger is
          NOT part of moduleOpen either — it docks as a left sidebar now
          (see MessengerApp.tsx), leaving this bottom-center bar clear. */}
      {/* Potong 6 — area background-music control (only while inside a BGM area). */}
      {!moduleOpen && bgm.inAreaName && (
        <div className="absolute bottom-20 right-4 z-50 flex items-center gap-2 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-200 dark:border-gray-600 rounded-full px-3 py-1.5 shadow-sm pointer-events-auto text-xs text-gray-700 dark:text-gray-200">
          <span>🎵 {bgm.inAreaName}</span>
          {bgm.needsUnlock ? (
            <Tooltip label="Putar Musik" detail="Browser sempat memblokir musik otomatis — klik untuk mulai musik area ini.">
              <button onClick={bgm.playNow} className="text-purple-600 dark:text-purple-300 font-medium cursor-pointer">🔊 Putar musik</button>
            </Tooltip>
          ) : (
            <Tooltip label={bgm.muted ? 'Bunyikan' : 'Bisukan'} detail="Nyalakan/matikan musik latar area ini.">
              <button onClick={() => bgm.setMuted(!bgm.muted)} className="cursor-pointer">{bgm.muted ? '🔇' : '🔉'}</button>
            </Tooltip>
          )}
        </div>
      )}
      {!moduleOpen && !screenShareMaximized && (
      <>
        {/* ParticipantPanel now positions itself as a full-height drawer
            (left over the map HUD, right over Meeting View — see its own
            file), no longer a toolbar-anchored popover, so it no longer
            needs a positioning wrapper here. Ghost mode and Notification
            Settings moved to Sidebar.tsx (no longer in this bar) —
            Soundboard/ActivityFeed's own top-left panel spot is untouched,
            see the top-14 left-16 block above. */}
        <ParticipantPanel remoteStreams={remoteStreams} isMicMuted={isMicMuted} isGuest={isGuest} emitFollowRequest={emitFollowRequest} emitFollowUnfollow={emitFollowUnfollow} emitSummonUser={emitSummonUser} emitSlap={emitSlap} onStartDm={channelChat.startDm} onReport={(userId, name) => setReportTarget({ userId, name })} emitKick={emitKick} emitForceMute={emitForceMute} emitForcePull={emitForcePull} emitSpotlight={emitSpotlight} open={activePanel === 'participants'} onToggle={() => openPanel('participants')} onClose={closePanel} />
        {/* Fixed dead-centre, always — Messenger/Chat (see MessengerApp.tsx)
            is a pure `position: absolute` overlay docked to the left half of
            the screen; it never participates in layout flow, so it can't
            push this bar (or the video tile strip, or the minimap) anywhere
            by itself. An earlier version deliberately re-centred this bar
            into the remaining right-hand space while chat was open, to keep
            it from visually sitting on top of the panel — reverted on
            request: chat opening should never move anything else on screen,
            full stop. Where chat's z-[55] panel visually overlaps this z-50
            bar, chat now wins and covers it (see MessengerApp.tsx's own
            z-index comment) — flipped from an earlier version where this
            bar stayed on top and clickable through the overlap; that read
            as the toolbar barging in front of chat, not a feature. */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl border border-purple-200/60 dark:border-white/10 shadow-lg shadow-purple-500/10 rounded-full px-3 py-2">
          <MicButton muted={isMicMuted} onToggle={handleMicToggle} />
          <CameraButton enabled={isCameraOn} onToggle={handleCameraToggle} />
          <ScreenShareButton sharing={isScreenSharing} onToggle={handleScreenShareToggle} />
          {/* QA (Akses tamu checklist item 2, "Guest terbatas") — both
              server-rejected for guests now too (roomHandler.ts's
              PLAYER_HAND/PLAYER_HIDDEN, emoteHandler.ts). Mic/Camera/Share
              stay — those are the kept-open meeting-participation set.
              Peserta moved to the top-left rail beside Soundboard (see that
              section's own comment) — same !moduleOpen/!screenShareMaximized
              gate as this bar, just relocated, not removed from the set.
              Chat is its own standalone bottom-right button again (see
              ChatPanel.tsx), not part of this bar. */}
          {!isGuest && <HandButton raised={!!localPlayer.handRaised} onToggle={handleHandToggle} />}
          {!isGuest && <EmojiButton open={showEmoteWheel} onToggle={() => setShowEmoteWheel((v) => !v)} />}
          {/* Mic/speaker/camera device picker — was two small carets glued
              to Mic and Camera, merged into one ⋮ menu (see DeviceMenu.tsx)
              placed just left of Keluar. */}
          <DeviceMenu />
          <div className="w-px h-7 bg-purple-200/50 dark:bg-white/10 mx-0.5" />
          <LeaveButton onLeave={onLeave} />
        </div>
      </>
      )}

      {/* Only shown once getUserMedia has actually failed (denied / no
          device) — otherwise clicking Mic/Camera with no stream yet just
          silently did nothing, with no way to tell a permission problem
          apart from "the button is broken". Gated on !moduleOpen for the same
          reason as the bar it points at — it sits just above that bar. */}
      {mediaError && !moduleOpen && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 bg-red-50 dark:bg-red-900/80 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-200 text-xs px-3 py-1.5 rounded-full shadow-sm pointer-events-none">
          {mediaError} — click Mic or Camera below to retry
        </div>
      )}

      {/* Self-dismissing (see handleToggleMiniMode) — a one-off action
          failure, not an ongoing state like mediaError above, so it doesn't
          need to stick around until the user does something about it. */}
      {miniModeError && !moduleOpen && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 bg-red-50 dark:bg-red-900/80 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-200 text-xs px-3 py-1.5 rounded-full shadow-sm pointer-events-none max-w-md text-center">
          {miniModeError}
        </div>
      )}

      {/* QA (Load checklist item 3) — screen-share denial (room already at
          MAX_SCREEN_SHARES_PER_ROOM) or any other startScreenShare failure.
          Self-dismisses inside useWebRTC's own toggleScreenShare, same
          one-off-action-failure treatment as miniModeError above. */}
      {screenShareError && !moduleOpen && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 bg-red-50 dark:bg-red-900/80 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-200 text-xs px-3 py-1.5 rounded-full shadow-sm pointer-events-none max-w-md text-center">
          {screenShareError}
        </div>
      )}

      {/* QA (Moderasi checklist item 11) — self-dismisses via the effect
          near handleMicToggle above, same one-off-action-notice treatment
          as screenShareError/miniModeError. */}
      {forceMutedNotice && !moduleOpen && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 bg-amber-50 dark:bg-amber-900/80 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-200 text-xs px-3 py-1.5 rounded-full shadow-sm pointer-events-none max-w-md text-center">
          🔇 {forceMutedNotice}
        </div>
      )}

      {/* Couldn't-sit notice (e.g. chair taken) — self-dismisses via the effect
          above, same look as miniModeError. */}
      {sitNotice && !moduleOpen && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 bg-amber-50 dark:bg-amber-900/80 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-200 text-xs px-3 py-1.5 rounded-full shadow-sm pointer-events-none text-center">
          {sitNotice}
        </div>
      )}

      {/* Room name HUD + code */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-auto">
        <p className="text-gray-500 dark:text-gray-400 text-xs font-medium tracking-wider uppercase">MAIN OFFICE</p>
        <Tooltip label="Salin Kode Room" detail="Salin kode room ini untuk dibagikan.">
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(roomSlug);
              setRoomCodeCopied(true);
              setTimeout(() => setRoomCodeCopied(false), 2000);
            }}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-xs cursor-pointer transition-colors inline-flex items-center gap-1"
          >
            <Clipboard size={11} /> {roomSlug.slice(0, 12)}
          </button>
        </Tooltip>
        <Tooltip label="Salin Link Undangan" detail="Salin link undangan ke room ini.">
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
          >
            <Link45deg size={12} /> Invite
          </button>
        </Tooltip>
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
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowLogoutConfirm(false)}
        >
          <div
            className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 text-center"
            onClick={(e) => e.stopPropagation()}
          >
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

      {sessionTakenOverNotice && (
        <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 text-center max-w-xs">
            <p className="text-gray-900 dark:text-gray-100 text-sm font-medium mb-1">{sessionTakenOverNotice}</p>
            <p className="text-gray-400 dark:text-gray-500 text-xs">Tab/perangkat lain sekarang mengendalikan avatar Anda.</p>
          </div>
        </div>
      )}

      {/* Item #9 — everyone sees this, not just the admin who toggled it,
          styled as a clear danger state since it means every password door
          is currently bypassable. Hidden in Simplified View, same as the
          notice banner below. */}
      {doorOverride && !simplifiedView && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-40 pointer-events-none flex items-center gap-1.5 bg-red-600/95 text-white text-xs font-medium px-3 py-1 rounded-full shadow-sm">
          <DoorOpenFill size={11} /> Mode darurat: semua pintu terbuka
        </div>
      )}

      {notice && !simplifiedView && (
        <NoticeBanner notice={notice} isAdmin={isAdmin} onUnpin={emitNoticeUnpin} />
      )}

      {!moduleOpen && (
        <ZoneLockBar
          currentZone={currentZone}
          lock={zoneLock.lockOf(currentZone?.id ?? null)}
          isKeyholder={zoneLock.isKeyholder(currentZone?.id ?? null)}
          knocks={zoneLock.knocks}
          deniedZoneId={zoneLock.deniedZoneId}
          deniedZoneName={zones.find((z) => z.id === zoneLock.deniedZoneId)?.name ?? null}
          deniedReason={zoneLock.deniedReason}
          pendingKnock={zoneLock.pendingKnock}
          pendingApproval={zoneLock.pendingApproval}
          approvalRequests={zoneLock.approvalRequests}
          toast={zoneLock.toast}
          onKnock={() => zoneLock.deniedZoneId && zoneLock.requestEntry(zoneLock.deniedZoneId, zones.find((z) => z.id === zoneLock.deniedZoneId)?.name)}
          onCancelKnock={zoneLock.cancelKnock}
          onDecide={zoneLock.decide}
          onCancelApproval={zoneLock.cancelApproval}
          onDecideApproval={zoneLock.decideApproval}
          zoneQueueTicket={zoneLock.zoneQueueTicket}
          zoneQueueBusy={zoneLock.zoneQueueBusy}
          zoneQueueError={zoneLock.zoneQueueError}
          onJoinZoneQueue={zoneLock.joinZoneQueue}
          onCancelZoneQueue={zoneLock.cancelZoneQueue}
          bookingNoticeDismissed={bookingNoticeDismissed}
          onDismissBookingNotice={() => setBookingNoticeDismissed(true)}
        />
      )}

      {/* "Ngobrol dengan CEO" v2 — CEO-only, visible regardless of where the
          CEO is physically standing (the zone is freely walkable now, so
          "in the zone" no longer means "hosting the session" the way it did
          under the old gated model). */}
      {!moduleOpen && myActiveZoneSession && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 w-64 bg-white/95 dark:bg-gray-800/95 backdrop-blur-xl border border-purple-200/60 dark:border-white/10 shadow-lg shadow-purple-500/10 rounded-xl p-3">
          <p className="text-xs text-gray-800 dark:text-gray-100">
            Sesi aktif: <span className="font-semibold">{myActiveZoneSession.playerName}</span>
          </p>
          <p className="text-[10px] text-gray-400 mb-2">Berakhir otomatis {formatClock(myActiveZoneSession.endsAt)}.</p>
          <button
            onClick={finishActiveZoneSession}
            disabled={finishingSession}
            className="w-full py-1.5 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700 disabled:opacity-50"
          >
            {finishingSession ? 'Mengakhiri…' : 'Selesai meeting'}
          </button>
        </div>
      )}

      {/* The floating Chat button belongs to the room. While a suite module
          covers the screen it just sits on top of that module's UI (it landed
          over the Calendar's "Buat acara" button), so it stands down — same
          rule as the room hotkeys above. */}
      {!moduleOpen && (
      <ChatPanel
        localPlayerName={playerName}
        localUserId={authUserId}
        onBubble={emitBubble}
        onEmote={handleEmoteSelect}
        currentZone={currentZone}
        zoneMessages={currentZone ? zoneChatHistory[currentZone.id] ?? [] : []}
        onSendZone={handleSendZoneChat}
        roomSlug={roomSlug}
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
        onSendFile={channelChat.sendFileMessage}
        onRetry={channelChat.retryMessage}
        onTyping={channelChat.notifyTyping}
        onDeleteMessage={channelChat.deleteMessage}
        onEditMessage={channelChat.editMessage}
        onPinMessage={channelChat.pinMessage}
        onLoadOlder={channelChat.loadOlder}
        onCreateChannel={channelChat.createChannel}
      />
      )}

      {/* Suppressed during Meeting View — MeetingView's own quick-reactions
          strip (showReactions above) now handles the same toolbar Emoji
          toggle there instead, so the two pickers don't stack. */}
      <EmoteWheel
        open={showEmoteWheel && !meetingViewActive}
        onSelect={handleEmoteSelect}
        onClose={() => setShowEmoteWheel(false)}
      />

      {bookingFormActive && bookingZone && (
        <BookingForm
          zoneName={bookingZone.name}
          busy={zoneLock.zoneQueueBusy}
          error={zoneLock.zoneQueueError}
          onClose={closePanel}
          onSubmit={async (bookingStart, bookingEnd, topic) => {
            const ok = await zoneLock.bookZoneQueueSlot(bookingZone.zoneId, bookingStart, bookingEnd, topic);
            if (ok) closePanel();
          }}
        />
      )}

      {settingsActive && <SettingsPanel onClose={closePanel} onUpdatePreferences={onUpdatePreferences} onLogout={onLogout} />}

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
        visible={!simplifiedView}
      />
    </div>
  );
}

// Guest Link & Ruang Tunggu — kept entirely separate from vm_token/vm_userId
// (the real-account storage keys) so a guest visit never touches a real
// account's stored session, and a real login never inherits a stale guest one.
const GUEST_TOKEN_KEY = 'vm_guest_token';
const GUEST_ROOM_SLUG_KEY = 'vm_guest_room_slug';
const GUEST_ROOM_NAME_KEY = 'vm_guest_room_name';
const GUEST_NAME_KEY = 'vm_guest_name';

function loadStoredGuestSession(): GuestSession | null {
  const token = localStorage.getItem(GUEST_TOKEN_KEY);
  const roomSlug = localStorage.getItem(GUEST_ROOM_SLUG_KEY);
  const roomName = localStorage.getItem(GUEST_ROOM_NAME_KEY);
  const name = localStorage.getItem(GUEST_NAME_KEY);
  if (token && roomSlug && roomName && name) return { token, roomSlug, roomName, name };
  return null;
}

function storeGuestSession(session: GuestSession | null): void {
  if (session) {
    localStorage.setItem(GUEST_TOKEN_KEY, session.token);
    localStorage.setItem(GUEST_ROOM_SLUG_KEY, session.roomSlug);
    localStorage.setItem(GUEST_ROOM_NAME_KEY, session.roomName);
    localStorage.setItem(GUEST_NAME_KEY, session.name);
  } else {
    localStorage.removeItem(GUEST_TOKEN_KEY);
    localStorage.removeItem(GUEST_ROOM_SLUG_KEY);
    localStorage.removeItem(GUEST_ROOM_NAME_KEY);
    localStorage.removeItem(GUEST_NAME_KEY);
  }
}

// QA #1/#6 — a guest has no persisted User row (see server/src/routes/guestInvite.ts's
// doc comment — the token is a signed JWT, never a DB record), so unlike a real
// account's `tutorialCompletedAt` this can only live client-side. Good enough:
// a guest link is normally reused from the same browser by the same person.
const GUEST_TUTORIAL_SEEN_KEY = 'vm_tutorial_seen_guest';

// QA #1 — "set status saat login": unlike the tutorial (once ever), a work
// status is a daily thing, so the gate re-shows once per calendar day rather
// than once per account lifetime. gameStore.manualStatus is ephemeral —
// resets to 'available' on every reload (it's only broadcast/kept
// server-side per live socket session, see roomStore.ts's updatePlayerWorkMode
// — nothing persists it past a disconnect) — so this localStorage entry is
// the ONLY thing that remembers today's pick across a refresh; when the gate
// is skipped for "already picked today" the remembered status still has to
// be silently re-applied (see the effect below), or a same-day refresh would
// quietly drop the user back to 'available' despite never re-asking. Local
// (browser) date, not server timezone — fine for a UI nag, not a compliance
// record. Guests are excluded entirely (see the render-gate below) — WFO/
// WFH/Cuti describe a workspace employee's day, not an external visitor's.
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
const STATUS_PICKED_PREFIX = 'vm_status_picked:';

function MainApp() {
  const { user, loading, error, sessionExpiredMessage, login, register, acceptOrgInvite, createOrganization, logout, markTutorialSeen, updatePreferences } = useAuth();
  const { theme, toggleTheme } = useTheme();
  // Settings feature — sync the store's live tooltipsEnabled/notifKinds
  // mirrors from the account's saved preferences as soon as they're known,
  // at this top level (not inside Game) so they're already correct if
  // Settings is opened from Lobby, before ever entering a room. Guests keep
  // the store's defaults (tooltips on, every notif kind on).
  useEffect(() => {
    if (user) useGameStore.getState().setTooltipsEnabled(user.preferences?.tooltipsEnabled ?? true);
  }, [user?.preferences?.tooltipsEnabled]);
  useEffect(() => {
    if (user) useGameStore.getState().setNotifKinds(user.preferences?.notifKinds);
  }, [user?.preferences?.notifKinds]);
  // QA #1/#6 — "next-next sebelum masuk": gates <Game> itself, not just an
  // overlay on top of it, so a first-time user never sees the canvas/HUD
  // before finishing the walkthrough. Guests get their own client-only flag
  // (see GUEST_TUTORIAL_SEEN_KEY above); real accounts use `user.tutorialCompletedAt`
  // directly below, no separate state needed.
  const [guestTutorialSeen, setGuestTutorialSeen] = useState(
    () => localStorage.getItem(GUEST_TUTORIAL_SEEN_KEY) === '1',
  );
  const finishGuestTutorial = useCallback(() => {
    localStorage.setItem(GUEST_TUTORIAL_SEEN_KEY, '1');
    setGuestTutorialSeen(true);
  }, []);
  // QA #1 — has THIS account already picked a status today? Keyed per user
  // id (not a single shared key) so a shared browser with multiple accounts
  // doesn't cross-contaminate. `user` is still null on the very first render
  // (useAuth's session restore is async), so this re-reads once `user.id`
  // actually becomes available rather than trusting a lazy useState
  // initializer that would've only ever seen `null`. If today's pick is
  // already on record, it's re-applied to the (freshly-reset) store right
  // here instead of just skipping the gate — see STATUS_PICKED_PREFIX's own
  // comment for why that matters. useLayoutEffect (not useEffect) so this
  // resolves BEFORE the browser paints the frame where `user` just became
  // truthy — otherwise an already-picked-today user would see the picker
  // flash for one frame before flipping back to <Game>.
  const [statusPickedDate, setStatusPickedDate] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!user) return;
    const raw = localStorage.getItem(STATUS_PICKED_PREFIX + user.id);
    const saved = raw ? (JSON.parse(raw) as { date: string; status: ManualStatus }) : null;
    if (saved?.date === todayKey()) useGameStore.getState().setManualStatus(saved.status);
    setStatusPickedDate(saved?.date ?? null);
  }, [user?.id]);
  const finishStatusPick = useCallback((status: ManualStatus) => {
    if (!user) return;
    useGameStore.getState().setManualStatus(status);
    const today = todayKey();
    localStorage.setItem(STATUS_PICKED_PREFIX + user.id, JSON.stringify({ date: today, status }));
    setStatusPickedDate(today);
  }, [user]);
  const [roomSlug, setRoomSlug] = useState<string | null>(null);

  // ?guest=<token> — the invite link itself. Read once at mount, same
  // "scrub it back out of the visible URL immediately" treatment as ?join=
  // below (the token isn't meant to sit in browser history once consumed).
  const [guestInviteToken, setGuestInviteToken] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('guest'),
  );
  useEffect(() => {
    if (!guestInviteToken) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('guest');
    window.history.replaceState({}, '', url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Fase 5 (org-resolution) — ?orgInvite=<token>, same "read once, scrub
  // from the visible URL" treatment as ?guest= above.
  const [orgInviteToken, setOrgInviteToken] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('orgInvite'),
  );
  useEffect(() => {
    if (!orgInviteToken) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('orgInvite');
    window.history.replaceState({}, '', url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The exchanged guest session (see GuestEntry.tsx) — restored from
  // localStorage on mount so a refresh mid-visit doesn't force re-entering a
  // name and waiting for approval all over again.
  const [guestSession, setGuestSessionState] = useState<GuestSession | null>(loadStoredGuestSession);
  const setGuestSession = useCallback((session: GuestSession | null) => {
    storeGuestSession(session);
    setGuestSessionState(session);
  }, []);
  const handleGuestLeave = useCallback(() => {
    // No Lobby to fall back to (a guest never has one) — clear the session
    // and reload to a clean slate; a fresh visit needs a new invite link.
    setGuestSession(null);
    window.location.href = '/';
  }, [setGuestSession]);
  // Room join approval (see server/src/lib/roomMembership.ts). The socket
  // gate is the real enforcement (a failed/slow REST check here falls
  // through to it, never locks anyone out) — this is only a faster,
  // friendlier "why you're blocked" message than staring at a room that
  // never loads. Runs IN PARALLEL with <Game> mounting/connecting below,
  // not before it — swaps Game out for JoinGate on the next render if it
  // resolves to denied after Game already started.
  const [entryBlock, setEntryBlock] = useState<{ slug: string; reason: string } | null>(null);

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

  // Ask before entering. A room that takes walk-ins answers immediately and
  // this is one extra request; a gated one is caught here instead of at the
  // socket, which is the difference between an explanation and a blank room.
  useEffect(() => {
    if (!roomSlug || !user) { setEntryBlock(null); return; }
    let cancelled = false;
    api.getMembership(roomSlug)
      .then((m) => {
        if (cancelled) return;
        setEntryBlock(m.allowed ? null : { slug: roomSlug, reason: m.reason });
      })
      // A failed check must not lock someone out of a room they can enter —
      // the socket gate is the real enforcement, so fall through to it.
      .catch(() => { if (!cancelled) setEntryBlock(null); });
    return () => { cancelled = true; };
  }, [roomSlug, user]);

  // Loading
  if (loading) {
    return (
      <div className="w-screen h-screen bg-gradient-to-br from-white to-purple-50 flex items-center justify-center">
        <p className="text-gray-500 text-sm">Loading KaiSpace...</p>
      </div>
    );
  }

  // Guest Link & Ruang Tunggu — checked BEFORE the account gate below. A
  // guest never sees LoginPage/Lobby/JoinGate at all: name entry replaces
  // login, and the invite token already pins them to exactly one room.
  if (guestInviteToken && !guestSession) {
    return (
      <GuestEntry
        inviteToken={guestInviteToken}
        onEntered={(session) => { setGuestInviteToken(null); setGuestSession(session); }}
      />
    );
  }
  if (guestSession && !guestTutorialSeen) {
    return <TutorialModal onFinish={finishGuestTutorial} />;
  }
  if (guestSession) {
    return (
      <Game
        key={guestSession.roomSlug}
        roomSlug={guestSession.roomSlug}
        onLeave={handleGuestLeave}
        onLogout={handleGuestLeave}
        onPortalTravel={() => {}}
        authDisplayName={guestSession.name}
        authUserId=""
        guestToken={guestSession.token}
        isGuest
        currentUser={{ id: 'guest', name: guestSession.name, workspaceRole: 'member', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, isOperator: false }}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
    // Guests have no account to persist preferences to — onUpdatePreferences
    // is left undefined, so the Settings toggle only affects this tab's live
    // store state (see Tooltip.tsx), never attempts a PATCH.
  }

  // Fase 5 (org-resolution) — an org-invite link replaces LoginPage the
  // same way a guest-link token replaces it above, but this creates a REAL
  // account (via useAuth's acceptOrgInvite) landing in the inviting org,
  // not a guest session. Only while logged out — an already-authenticated
  // tab that happens to open an invite link just ignores it.
  if (orgInviteToken && !user) {
    return (
      <JoinOrgInvite
        inviteToken={orgInviteToken}
        onAccept={async (password, displayName) => {
          await acceptOrgInvite(orgInviteToken, password, displayName);
          setOrgInviteToken(null);
        }}
      />
    );
  }

  // Auth gate
  if (!user) {
    return (
      <LoginPage
        onLogin={async (e, p) => { await login(e, p); }}
        onRegister={async (e, p, n) => { await register(e, p, n); }}
        onCreateOrganization={async (o, e, p, n) => { await createOrganization(o, e, p, n); }}
        error={error}
        sessionExpiredMessage={sessionExpiredMessage}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  }

  // Lobby
  if (!roomSlug) {
    return <Lobby user={user} onJoinRoom={setRoomSlug} onLogout={logout} theme={theme} onToggleTheme={toggleTheme} onUpdatePreferences={updatePreferences} />;
  }

  // Blocked from entering — show why, and how to ask.
  if (roomSlug && entryBlock && entryBlock.slug === roomSlug) {
    return (
      <JoinGate
        roomSlug={roomSlug}
        reason={entryBlock.reason}
        onBack={() => { setEntryBlock(null); setRoomSlug(null); }}
        onAdmitted={() => setEntryBlock(null)}
      />
    );
  }
  // Bug — this used to block here until the membership REST check resolved,
  // THEN mount <Game> (which is what actually opens the socket connection
  // and starts the JOIN_ROOM handshake) — one full network round trip
  // serialized in front of another, even though the socket's own JOIN_ROOM
  // is the REAL enforcement (see the effect above's own comment: "A failed
  // check must not lock someone out... the socket gate is the real
  // enforcement"). This check is purely a faster/friendlier "why you're
  // blocked" UX than a blank room — not a gate — so it's safe to let <Game>
  // start connecting in parallel instead of waiting on it. If entryBlock
  // resolves to denied WHILE Game is already mounted/connecting, the
  // `entryBlock` check above swaps it out for JoinGate on the next render,
  // cleanly disconnecting the socket via Game's own unmount cleanup.

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
        <p className="text-gray-500 text-xl">Loading KaiSpace…</p>
      </div>
    );
  }

  // QA #1/#6 — "next-next sebelum masuk": a real account with a null
  // `tutorialCompletedAt` (brand-new, or any pre-existing account from
  // before this feature shipped) sees the walkthrough exactly once, gating
  // <Game> itself rather than overlaying on top of it.
  if (!user.tutorialCompletedAt) {
    return <TutorialModal onFinish={markTutorialSeen} />;
  }

  // QA #1 — "set status saat login": re-asked once per calendar day (see
  // todayKey/STATUS_PICKED_DATE_PREFIX above), after the tutorial gate so a
  // brand-new account meets the walkthrough first. `statusPickedDate` starts
  // null until the effect above resolves it from localStorage — treated as
  // "not picked yet today" rather than flashing the picker for a tick on
  // every load, which is why this sits after (not before) the tutorial gate:
  // by this point `user` has been stable for at least one render already.
  if (statusPickedDate !== todayKey()) {
    return <StatusPickModal onPick={finishStatusPick} />;
  }

  // key={roomSlug} — portal travel (handlePortalEnter -> onPortalTravel ->
  // setRoomSlug) previously updated roomSlug on the SAME mounted Game
  // instance, so its own useState (meetingViewActive, simplifiedView,
  // miniModeWindow, ...) all survived into the new room
  // untouched — e.g. still full-screen in Meeting View, or a Mini Mode PiP
  // window still open, with no signal anything changed underneath. Forcing
  // a remount on room change gives every room a clean slate, matching what
  // already happens when leaving to the Lobby and rejoining.
  return <Game key={roomSlug} roomSlug={roomSlug} onLeave={() => setRoomSlug(null)} onLogout={logout} onPortalTravel={setRoomSlug} authDisplayName={user.displayName} authUserId={user.id} currentUser={toCurrentUser(user)} theme={theme} onToggleTheme={toggleTheme} onUpdatePreferences={updatePreferences} />;
}

// ZEP Room Editor opens in its own tab as /?roomEditor=<slug> (a query param on
// the root path so the SPA index.html always loads — same scheme as ?join, no
// nginx SPA-fallback dependency). The tab shares localStorage, so it's the SAME
// session as the main tab (no new login, no single-device supersede). A tiny
// wrapper picks the page WITHOUT conditional hooks in either component.
export default function App() {
  const editorSlug = new URLSearchParams(window.location.search).get('roomEditor');
  if (editorSlug) {
    return (
      <Suspense fallback={<div className="w-screen h-screen bg-gradient-to-br from-white to-purple-50 flex items-center justify-center text-gray-500 text-sm">Memuat Room Editor…</div>}>
        <RoomEditorPage slug={editorSlug} />
      </Suspense>
    );
  }
  return <MainApp />;
}
