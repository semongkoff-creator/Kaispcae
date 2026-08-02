import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Clipboard, Link45deg, PersonWalking, X, MagnetFill, HandIndexThumbFill, LockFill } from 'react-bootstrap-icons';
import { AvatarConfig, EmoteType, TileType, MAP_WIDTH, TILE_SIZE, Furniture, roleAtLeast, MediaType, MediaPayload, CONSENT_REQUEST_TIMEOUT_MS, WorkMode } from '@virtualmeet/shared';
import { PALETTE_BY_ID } from './data/themeAssets';
import { GameCanvas } from './components/canvas/GameCanvas';
import { ConnectionIndicator } from './components/ui/ConnectionIndicator';
import { MapZoomControl } from './components/ui/MapZoomControl';
import { MobileControls } from './components/hud/MobileControls';
import { NameModal } from './components/ui/NameModal';
import { AvatarSetup } from './components/avatar/AvatarSetup';
import { VideoGrid } from './components/ui/VideoGrid';
import { MeetingView } from './components/ui/MeetingView';
import { MeetingControl } from './components/ui/MeetingControl';
import { DailyTaskPanel } from './components/ui/DailyTaskPanel';
import { LeavePanel } from './components/ui/LeavePanel';
import { AdminConsole } from './admin/AdminConsole';
import { CalendarApp } from './components/Calendar/CalendarApp';
import { AttendanceApp } from './components/Attendance/AttendanceApp';
import { LarkAttendancePanel } from './components/Attendance/LarkAttendancePanel';
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
import { Minimap } from './components/hud/Minimap';
import { AdminPanel } from './components/ui/AdminPanel';
import { TeleportPanel } from './components/ui/TeleportPanel';
import { RoomEditorPage } from './pages/RoomEditorPage';
import { useBgm } from './hooks/useBgm';
import { AddMediaPanel } from './components/ui/AddMediaPanel';
import { MediaViewerModal } from './components/ui/MediaViewerModal';
import { InteractiveObjectModal } from './components/ui/InteractiveObjectModal';
import { ParticipantPanel } from './components/ui/ParticipantPanel';
import { SoundboardPanel } from './components/ui/SoundboardPanel';
import { MusicPlayerWidget } from './components/ui/MusicPlayerWidget';
import { AwayReasonModal } from './components/ui/AwayReasonModal';
import { ActivityFeed } from './components/ui/ActivityFeed';
import { PendingRequestToast } from './components/ui/PendingRequestToast';
import { Sidebar } from './components/ui/Sidebar';
import { MicButton } from './components/hud/MicButton';
import { HandButton } from './components/hud/HandButton';
import { playHandRaiseSound } from './services/soundEffects';
import { CameraButton } from './components/hud/CameraButton';
import { DeviceMenu } from './components/hud/DeviceMenu';
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

// Idle window before a player is auto-prompted for an Away reason (Fitur 3B).
const AFK_IDLE_MS = 120000; // 2 minutes

// Fitur 15B — 'show_word_balloon' Interactive Object's "Random" style pool,
// picked once per trigger (see handleInteractiveTrigger below).
const WORD_BALLOON_RANDOM_COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#ddd6fe'];

function Game({ roomSlug, onLeave, onLogout, onPortalTravel, authDisplayName, authUserId, currentUser, theme, onToggleTheme }: { roomSlug: string; onLeave: () => void; onLogout: () => void; onPortalTravel: (slug: string) => void; authDisplayName: string; authUserId: string; currentUser: CurrentUser; theme: Theme; onToggleTheme: () => void }) {
  const playerName = useGameStore((s) => s.localPlayer.name);
  const { emitMove, emitStop, emitJump, emitNudge, emitAvatarUpdate, emitPlayerStatus, emitWorkMode, emitTeleportTo, emitPlayerHand, emitSit, emitFurnitureAssign, emitFurnitureUnassign, socketRef, emitChat, emitBubble, emitEmote, emitZoneEnter, emitZoneExit, emitAdminGrant, emitAdminRevoke, emitStaffGrant, emitStaffRevoke, emitKick, emitRoomLock, emitKnock, emitKnockCancel, emitKnockAdmit, emitNoticePin, emitNoticeUnpin, emitFollowRequest, emitFollowRespond, emitFollowUnfollow, emitTeleportRequest, emitSummonUser, emitSummonRespond, emitSlap, emitMediaAdd, emitMediaRemove, emitWhiteboardStroke, emitWhiteboardClear, emitRecordingStart, emitRecordingStop, emitRecordingFinalize, emitChannelJoin, emitChannelLeave, emitChannelMessageSend, emitDmJoin, emitDmLeave, emitDmMessageSend, emitChannelTyping, emitDmTyping, emitDeleteMessage, emitEditMessage, emitInteractivePasswordCheck, emitInteractiveChoiceCheck, emitInteractiveApiCall, emitInteractiveChangeObject, emitInteractiveDoorPasswordCheck, emitSoundboardPlay } = useSocket(authDisplayName, roomSlug, authUserId);
  const channelChat = useChannelChat(roomSlug, { emitChannelJoin, emitChannelLeave, emitChannelMessageSend, emitDmJoin, emitDmLeave, emitDmMessageSend, emitChannelTyping, emitDmTyping, emitDeleteMessage, emitEditMessage });
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
  const roomLocked = useGameStore((s) => s.roomLocked);
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
  const hasMySeat = furniture.some((f) => f.assignedToUserId === localUserId);
  const handleMySeat = useCallback(() => {
    releaseMovementKeys();
    emitTeleportRequest({ kind: 'seat' });
  }, [emitTeleportRequest]);

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
  }, [nearby, updateProximity]);

  // A5 — Meeting zone detection. The MeetingControl (Start/Join/End + history)
  // renders only while the local avatar is inside a Zone of type 'meeting'.
  // Purely derived; also feeds the A11 presence status below.
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
  // (poin 8b: "user klik tombol Away/Leave manual"); Available/Lunch apply
  // immediately, no reason needed for those.
  const handlePresencePick = useCallback((status: 'available' | 'lunch' | 'away') => {
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
  const zoneLock = useZoneLock(socketRef, authUserId);

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
      emitZoneEnter(zoneId);
    }
    currentZoneIdRef.current = zoneId;
    setCurrentZone(zone ? { id: zone.id, name: zone.name } : null);
    lastAllowedPosRef.current = { x: localPlayer.x, y: localPlayer.y };
    // Walking out of the zone you were bounced from clears the knock prompt.
    if (!zoneId) zoneLock.clearDenied();
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

  // Join denied because the room is locked (Zoom-style "Lock Meeting", see
  // shared SocketEvents.ROOM_LOCKED_DENIED). Unlike the deleted/kicked
  // notices this does NOT auto-bounce — the overlay lets the user "Knock to
  // enter" or leave. `knocked` tracks the waiting-for-host state after a knock.
  const roomLockedNotice = useGameStore((s) => s.roomLockedNotice);
  const [knocked, setKnocked] = useState(false);
  useEffect(() => { if (!roomLockedNotice) setKnocked(false); }, [roomLockedNotice]);
  const handleKnock = useCallback(() => {
    emitKnock(roomSlug);
    setKnocked(true);
  }, [emitKnock, roomSlug]);
  const handleKnockCancel = useCallback(() => {
    emitKnockCancel();
    setKnocked(false);
  }, [emitKnockCancel]);

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

  const incomingFollowRequest = useGameStore((s) => s.incomingFollowRequest);
  useEffect(() => {
    if (!incomingFollowRequest) return;
    const timer = setTimeout(() => useGameStore.getState().setIncomingFollowRequest(null), CONSENT_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [incomingFollowRequest]);

  // A locked-room knock, shown to admins with Admit/Ignore. Auto-clears on
  // the same consent-timeout clock as the summon/follow requests above so a
  // stale knock toast doesn't linger after the knocker has given up.
  const incomingKnock = useGameStore((s) => s.incomingKnock);
  useEffect(() => {
    if (!incomingKnock) return;
    const timer = setTimeout(() => useGameStore.getState().setIncomingKnock(null), CONSENT_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [incomingKnock]);

  const followResult = useGameStore((s) => s.followResult);
  useEffect(() => {
    if (!followResult) return;
    const timer = setTimeout(() => useGameStore.getState().setFollowResult(null), 3000);
    return () => clearTimeout(timer);
  }, [followResult]);

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
  const tiles = useGameStore((s) => s.tiles);
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
  const localRole = useGameStore((s) => s.localRole);
  const mediaObjects = useGameStore((s) => s.mediaObjects);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [roomCodeCopied, setRoomCodeCopied] = useState(false);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);

  const dailyTaskActive = activePanel === 'dailyTask';
  const leaveActive = activePanel === 'leave';
  const adminViewActive = activePanel === 'adminConsole';
  const calendarViewActive = activePanel === 'calendar';
  const attendanceViewActive = activePanel === 'attendance';
  const larkAttendanceActive = activePanel === 'larkAttendance';
  const messengerViewActive = activePanel === 'messenger';
  // Join-approval queue (admin). pendingJoinCount only drives the menu badge;
  // the panel refetches from the server when opened, so a stale count can
  // never turn into a stale decision.
  const joinQueueActive = activePanel === 'joinQueue';
  const [pendingJoinCount, setPendingJoinCount] = useState(0);

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
  const moduleOpen = dailyTaskActive || leaveActive || calendarViewActive || adminViewActive || attendanceViewActive || messengerViewActive;

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
    setShowEditor(false);
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

  const handleStatusSave = useCallback((status: string) => {
    useGameStore.getState().setLocalPlayer({ status: status || undefined });
    emitPlayerStatus(status);
  }, [emitPlayerStatus]);

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

  // Chat + emotes + minimap state
  const notice = useGameStore((s) => s.notice);
  const followInfo = useGameStore((s) => s.followInfo);
  const followerUserIds = useGameStore((s) => s.followerUserIds);
  const [showEmoteWheel, setShowEmoteWheel] = useState(false);
  const [showMinimap, setShowMinimap] = useState(true);
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
      // Inert while typing (the Docs editor is contenteditable, so "B" used
      // to open the emote wheel and eat the character) and while a suite
      // module is covering the room.
      if (shouldIgnoreRoomHotkey(e.target, moduleOpen)) return;
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
  }, [moduleOpen]);

  const allPlayers = { [localPlayerId]: useGameStore.getState().localPlayer, ...playerRecords };

  // Locked-room denial overlay (see roomLockedNotice above). Extracted so it
  // can render in BOTH the pre-room:state loading gate below AND the main
  // view — a denied join never receives room:state, so without rendering it
  // in the loading branch the user would sit forever on "Joining room…".
  const lockedDeniedOverlay = roomLockedNotice ? (
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 text-center max-w-xs">
        <p className="text-2xl mb-1">🔒</p>
        <p className="text-gray-900 dark:text-gray-100 text-sm font-medium mb-1">{roomLockedNotice}</p>
        {knocked ? (
          <>
            <p className="text-gray-400 dark:text-gray-500 text-xs mb-4">🔔 Knocked — waiting for the host to let you in…</p>
            <div className="flex gap-2">
              <button
                onClick={handleKnockCancel}
                className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs font-medium cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={onLeave}
                className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs font-medium cursor-pointer"
              >
                Back to Lobby
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-gray-400 dark:text-gray-500 text-xs mb-4">Knock and the host can let you in.</p>
            <div className="flex gap-2">
              <button
                onClick={handleKnock}
                className="flex-1 px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium cursor-pointer"
              >
                🔔 Knock to enter
              </button>
              <button
                onClick={onLeave}
                className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs font-medium cursor-pointer"
              >
                Back to Lobby
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  ) : null;

  // Until the real room:state for THIS room arrives, `roomState` in the
  // store is still whatever App() seeded at startup (always the Main
  // Office layout, regardless of which room/template was actually joined
  // — see gameStore.ts's roomStateReceived doc comment). Render a plain
  // loading placeholder instead of GameCanvas rather than briefly showing
  // the wrong room shape (and risking a spawn tile that's a wall in the
  // real layout). If we were denied entry (locked room), show that overlay
  // here instead — room:state will never come, so this is the final state.
  if (!roomStateReceived) {
    return (
      <div className="relative w-screen h-screen bg-gradient-to-br from-white to-purple-50 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400 text-xl">Joining room…</p>
        {lockedDeniedOverlay}
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
        emitTeleportTo={emitTeleportTo}
        onMediaOpen={setViewingMediaId}
        onInteractiveTrigger={handleInteractiveTrigger}
        onDoorPasswordTrigger={handleDoorPasswordTrigger}
      />

      {/* A5 — meeting controls, only while standing inside a meeting-type zone */}
      {meetingZone && !editorMode && (
        <MeetingControl roomId={roomSlug} zoneId={meetingZone.id} />
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

      {!simplifiedView && (
        <>
          <div className="absolute top-4 left-28 pointer-events-none">
            <p className="text-gray-500 dark:text-gray-400 text-xs font-mono">WASD / Arrows to move · hold R to run · Space to jump · Z to nudge · X to interact</p>
          </div>
          <div className="absolute top-10 left-28 pointer-events-none">
            <p className="text-gray-500 dark:text-gray-400 text-xs font-mono">
              Playing as: <span className="text-gray-700 dark:text-gray-300">{playerName}</span>
            </p>
          </div>
          <div className="absolute top-14 left-16 flex items-start gap-2 pointer-events-none">
            <ParticipantPanel remoteStreams={remoteStreams} emitFollowRequest={emitFollowRequest} emitFollowUnfollow={emitFollowUnfollow} emitSummonUser={emitSummonUser} emitSlap={emitSlap} onStartDm={channelChat.startDm} emitKick={emitKick} open={activePanel === 'participants'} onToggle={() => openPanel('participants')} onClose={closePanel} />
            <SoundboardPanel roomSlug={roomSlug} emitSoundboardPlay={emitSoundboardPlay} open={activePanel === 'soundboard'} onToggle={() => openPanel('soundboard')} onClose={closePanel} />
            <ActivityFeed />
          </div>
          <MusicPlayerWidget zoneId={currentZone?.id ?? null} />
        </>
      )}

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
        {incomingKnock && (
          <PendingRequestToast
            icon={<LockFill size={13} className="text-amber-500" />}
            message={<><span className="font-medium">{incomingKnock.name}</span> is knocking to enter the locked room</>}
            onAccept={() => { emitKnockAdmit(incomingKnock.userId); useGameStore.getState().setIncomingKnock(null); }}
            onDecline={() => { useGameStore.getState().setIncomingKnock(null); }}
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
      </div>

      <AwayReasonModal open={awayPromptOpen} onResolve={resolveAwayPrompt} />

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
        manualStatus={manualStatus}
        onPickPresence={handlePresencePick}
        isAdmin={isAdmin}
        onOpenRoomEditor={() => window.open(`/?roomEditor=${encodeURIComponent(roomSlug)}`, '_blank', 'noopener')}
        canTeleport={roleAtLeast(localRole, 'member')}
        showTeleportPanel={showTeleportPanel}
        onToggleTeleport={() => openPanel('teleport')}
        hasMySeat={hasMySeat}
        onMySeat={handleMySeat}
        meetingViewActive={meetingViewActive}
        onToggleMeetingView={() => openPanel('meeting')}
        roomLocked={roomLocked}
        canLock={isAdmin}
        onToggleLock={() => emitRoomLock(!roomLocked)}
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
        dailyTaskActive={dailyTaskActive}
        leaveActive={leaveActive}
        onToggleLeave={() => openPanel('leave')}
        calendarViewActive={calendarViewActive}
        onToggleCalendarView={() => openPanel('calendar')}
        attendanceViewActive={attendanceViewActive}
        onToggleAttendanceView={() => openPanel('attendance')}
        larkAttendanceActive={larkAttendanceActive}
        onToggleLarkAttendance={() => openPanel('larkAttendance')}
        messengerViewActive={messengerViewActive}
        onToggleMessengerView={() => openPanel('messenger')}
        joinQueueActive={joinQueueActive}
        onToggleJoinQueue={() => openPanel('joinQueue')}
        pendingJoinCount={pendingJoinCount}
        isWorkspaceAdmin={currentUser.workspaceRole === 'admin'}
        adminViewActive={adminViewActive}
        onToggleAdminView={() => openPanel('adminConsole')}
        onToggleDailyTask={() => openPanel('dailyTask')}
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


      {/* Lark Base (database) module — full-screen in-room panel, same z-40
          layer as Meeting View; the room's Sidebar rail (z-50) stays reachable
          and the launcher offsets itself by pl-14 to clear it. */}
      {dailyTaskActive && <DailyTaskPanel onClose={closePanel} />}
      {leaveActive && <LeavePanel onClose={closePanel} />}
      {adminViewActive && <AdminConsole currentUser={currentUser} onClose={closePanel} />}
      {attendanceViewActive && <AttendanceApp onClose={closePanel} />}
      {larkAttendanceActive && <LarkAttendancePanel onClose={closePanel} />}
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

      {showEditor && (
        <AvatarSetup
          initialConfig={savedConfig}
          onSave={handleAvatarSave}
          onClose={() => setShowEditor(false)}
          localUserId={localUserId}
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
          exiting Meeting View first.

          Hidden while a SUITE module is open (moduleOpen). Meeting View is
          deliberately NOT part of moduleOpen, so the "stay reachable over
          Meeting View" behaviour above is untouched — but a full-screen
          module is a different thing: the bar lands squarely on the
          messenger's composer, covering the input you're trying to type in. */}
      {/* Potong 6 — area background-music control (only while inside a BGM area). */}
      {!moduleOpen && bgm.inAreaName && (
        <div className="absolute bottom-20 right-4 z-50 flex items-center gap-2 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-200 dark:border-gray-600 rounded-full px-3 py-1.5 shadow-sm pointer-events-auto text-xs text-gray-700 dark:text-gray-200">
          <span>🎵 {bgm.inAreaName}</span>
          {bgm.needsUnlock ? (
            <button onClick={bgm.playNow} className="text-purple-600 dark:text-purple-300 font-medium cursor-pointer">🔊 Putar musik</button>
          ) : (
            <button onClick={() => bgm.setMuted(!bgm.muted)} className="cursor-pointer" title={bgm.muted ? 'Bunyikan' : 'Bisukan'}>{bgm.muted ? '🔇' : '🔉'}</button>
          )}
        </div>
      )}
      {!moduleOpen && (
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-2 z-50">
        <MicButton muted={isMicMuted} onToggle={handleMicToggle} />
        <DeviceMenu kind="audio" />
        <CameraButton enabled={isCameraOn} onToggle={handleCameraToggle} />
        <DeviceMenu kind="video" />
        <HandButton raised={!!localPlayer.handRaised} onToggle={handleHandToggle} />
        <ScreenShareButton sharing={isScreenSharing} onToggle={handleScreenShareToggle} />
        <NotificationSettings />
      </div>
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

      {lockedDeniedOverlay}

      {/* Everyone in a locked room sees this pill so the closed state is
          obvious (not just the admin who toggled it). Hidden in Simplified
          View, same as the notice banner below. */}
      {roomLocked && !simplifiedView && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-40 pointer-events-none flex items-center gap-1.5 bg-amber-500/95 text-white text-xs font-medium px-3 py-1 rounded-full shadow-sm">
          <LockFill size={11} /> Room locked
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
          toast={zoneLock.toast}
          onKnock={() => zoneLock.deniedZoneId && zoneLock.knock(zoneLock.deniedZoneId, zones.find((z) => z.id === zoneLock.deniedZoneId)?.name)}
          onDecide={zoneLock.decide}
        />
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
        onLoadOlder={channelChat.loadOlder}
        onCreateChannel={channelChat.createChannel}
      />
      )}

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

function MainApp() {
  const { user, loading, error, sessionExpiredMessage, login, register, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [roomSlug, setRoomSlug] = useState<string | null>(null);
  // Room join approval (see server/src/lib/roomMembership.ts). The socket
  // gate denies the join for a room that needs approval, so entry is checked
  // BEFORE rendering the room — otherwise the user stares at a room that
  // never loads and has no idea a decision is pending on them.
  const [entryBlock, setEntryBlock] = useState<{ slug: string; reason: string } | null>(null);
  const [entryChecking, setEntryChecking] = useState(false);

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
    setEntryChecking(true);
    api.getMembership(roomSlug)
      .then((m) => {
        if (cancelled) return;
        setEntryBlock(m.allowed ? null : { slug: roomSlug, reason: m.reason });
      })
      // A failed check must not lock someone out of a room they can enter —
      // the socket gate is the real enforcement, so fall through to it.
      .catch(() => { if (!cancelled) setEntryBlock(null); })
      .finally(() => { if (!cancelled) setEntryChecking(false); });
    return () => { cancelled = true; };
  }, [roomSlug, user]);

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
  if (roomSlug && entryChecking) {
    return (
      <div className="w-screen h-screen bg-gradient-to-br from-white to-purple-50 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center">
        <p className="text-gray-500 text-sm">Memeriksa akses room...</p>
      </div>
    );
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
  return <Game key={roomSlug} roomSlug={roomSlug} onLeave={() => setRoomSlug(null)} onLogout={logout} onPortalTravel={setRoomSlug} authDisplayName={user.displayName} authUserId={user.id} currentUser={toCurrentUser(user)} theme={theme} onToggleTheme={toggleTheme} />;
}

// ZEP Room Editor opens in its own tab as /?roomEditor=<slug> (a query param on
// the root path so the SPA index.html always loads — same scheme as ?join, no
// nginx SPA-fallback dependency). The tab shares localStorage, so it's the SAME
// session as the main tab (no new login, no single-device supersede). A tiny
// wrapper picks the page WITHOUT conditional hooks in either component.
export default function App() {
  const editorSlug = new URLSearchParams(window.location.search).get('roomEditor');
  if (editorSlug) return <RoomEditorPage slug={editorSlug} />;
  return <MainApp />;
}
