import { ReactNode, useState } from 'react';
import { List, XLg, Tools, GeoAltFill, ImageFill, BoxArrowRight, HouseDoorFill, SunFill, MoonFill, Grid3x3GapFill, EyeFill, EyeSlashFill, PipFill, RecordCircleFill, LockFill, UnlockFill, Table as TableIcon, ShieldLock, CalendarEvent, ClockHistory, ChatDotsFill, PersonCheck, Airplane, ArrowLeftRight, DoorOpenFill, DoorClosedFill, Link45deg, VolumeUpFill, QuestionCircleFill, PeopleFill, BarChartFill } from 'react-bootstrap-icons';
import { AvatarEditorButton } from '../avatar/AvatarEditorButton';
import { PresenceButton } from '../avatar/PresenceButton';
import { RecordingControl } from './RecordingControl';
import { NotificationSettings } from './NotificationSettings';
import { ActiveRecordingInfo } from '@/stores/gameStore';
import { Theme } from '@/hooks/useTheme';
import { ManualStatus } from '@/data/presence';
import { Role } from '@virtualmeet/shared';

// A2 — the MeetKai-native attendance UI is retired in favour of automatic Lark
// Attendance check-in (see server lib/larkAttendance.ts). Flip to true only to
// temporarily bring the old manual UI back; the component & historical data
// were deliberately kept, not deleted.
const ATTENDANCE_MENU_ENABLED = false;

interface SidebarProps {
  onEditAvatar: () => void;
  // QA #1/#6/#7 — reopens the first-run walkthrough (App.tsx's TutorialModal,
  // shown once automatically on entry) on demand.
  onOpenTutorial: () => void;
  // QA (Presence checklist item #8, "Member list akurat") — opens the
  // workspace-wide member list (App.tsx's MemberListPanel). Not offered to
  // guests (see the row's own isGuest gate below) — they have no User row
  // and can't appear in that roster themselves either.
  onOpenMemberList: () => void;
  // TEMPORARY — only for the debug line at the bottom of this menu, see its
  // own comment. Remove alongside it.
  localRole: Role;
  // Fitur 3B / A11 — manual presence picker (Available/WFH/Focus/In a
  // meeting/Lunch/Break/Away). 'away' opens the Away-reason popup upstream
  // (see App.tsx's handlePresencePick) rather than applying immediately,
  // unlike the others.
  manualStatus: ManualStatus;
  onPickPresence: (status: ManualStatus) => void;

  isAdmin: boolean;
  // ZEP Room Editor — opens the full-page editor in a new tab. The old overlay
  // editor was retired in Potong 7; this is the only edit path now.
  onOpenRoomEditor: () => void;

  canTeleport: boolean;
  showTeleportPanel: boolean;
  onToggleTeleport: () => void;

  // "My Seat" — only shown once the local player has a furniture item
  // assigned to them in this room (see Furniture.assignedToUserId and
  // App.tsx's handleMySeat). One click, no panel — unlike Teleport this
  // isn't a list to pick from, there's only ever one meaningful answer.
  // Kept in the always-visible top of the rail, not the features menu: it's
  // the one action worth reaching without an extra click to open anything.
  hasMySeat: boolean;
  onMySeat: () => void;

  meetingViewActive: boolean;
  onToggleMeetingView: () => void;

  // Akses & Password Pintu audit item #9 — emergency door override
  // (canDoorOverride gates it to admins/owner; doorOverride reflects the
  // current state).
  doorOverride: boolean;
  canDoorOverride: boolean;
  onToggleDoorOverride: () => void;

  // Guest Link & Ruang Tunggu — admin-only, prompt-based (see App.tsx's
  // handleCreateGuestLink). No "current state" to reflect here (unlike Lock
  // Room/Door Override above) — this just fires an action, it isn't a toggle.
  canManageGuests: boolean;
  onCreateGuestLink: () => void;

  // QA #9/#10 — CEO/admin-only text broadcast ("Hanya CEO/admin bisa
  // broadcast"). Same "one-shot action, no current-state to reflect" shape
  // as Guest Link above, not a toggle.
  canBroadcast: boolean;
  onBroadcast: () => void;
  // Guest Link & Ruang Tunggu — hides every workspace/internal-only row
  // (Messenger chat, Daily Task, Kalender, Cuti, Absensi) for a guest
  // session: all of them require a real account server-side and would just
  // fail if clicked, and internal chat specifically is an explicit
  // restriction (a guest gets room-scoped chat only, via ChatPanel, never
  // channels/DM).
  isGuest?: boolean;

  // Zone-aware lock: shown only while standing inside a zone, locks THAT
  // zone. Anyone in the zone may lock it and becomes its keyholder — unlike
  // a room-wide gate, this isn't admin-only.
  currentZoneName: string | null;
  zoneLocked: boolean;
  zoneLockedByName: string | null;
  canToggleZoneLock: boolean;
  onToggleZoneLock: () => void;

  simplifiedView: boolean;
  onToggleSimplifiedView: () => void;

  // Daily Task widget (Lark Base-backed) — opens as a full-screen in-room panel.
  dailyTaskActive: boolean;
  onToggleDailyTask: () => void;

  // A9 — Cuti (leave request via Lark Approval) full-screen in-room panel.
  leaveActive: boolean;
  onToggleLeave: () => void;

  // Workspace admin console. `isWorkspaceAdmin` is cosmetic only — every
  // /api/admin/* route re-checks the role from the DB (see
  // server/src/lib/workspace.ts). The row is HIDDEN, not disabled, for
  // members, per the suite's permission rules.
  // Calendar module — same pattern again.
  calendarViewActive: boolean;
  onToggleCalendarView: () => void;

  // Attendance module.
  attendanceViewActive: boolean;
  onToggleAttendanceView: () => void;
  // A12 — the new Lark-backed attendance panel (separate from the retired
  // MeetKai-native one above).
  larkAttendanceActive: boolean;
  onToggleLarkAttendance: () => void;

  // Bagian 4 — admin-only picker binding this room's #general channel to a
  // Lark group (see LarkSyncPanel.tsx). Same isAdmin gate as the join-queue
  // entry above, not isWorkspaceAdmin — this is a per-room setting.
  larkSyncActive: boolean;
  onToggleLarkSync: () => void;

  // Messenger — the full-screen chat surface. The floating ChatPanel stays
  // for chatting while walking around; this is the one you sit down in.
  messengerViewActive: boolean;
  onToggleMessengerView: () => void;

  // Room join approval queue — admin+ only, and hidden entirely (not
  // disabled) for everyone else, same convention as the admin console row.
  joinQueueActive: boolean;
  onToggleJoinQueue: () => void;
  pendingJoinCount: number;

  isWorkspaceAdmin: boolean;
  adminViewActive: boolean;
  onToggleAdminView: () => void;

  // Productivity Analytics — Individual tier, open to every real employee
  // (not gated by isWorkspaceAdmin, see the MenuRow's own comment).
  myAnalyticsActive: boolean;
  onToggleMyAnalytics: () => void;

  miniModeSupported: boolean;
  miniModeActive: boolean;
  onToggleMiniMode: () => void;

  showAddMediaPanel: boolean;
  onToggleAddMedia: () => void;

  canRecord: boolean;
  recordingTargets: { userId: string; name: string }[];
  activeRecording: ActiveRecordingInfo | null;
  isRecordingMine: boolean;
  recordingUploading: boolean;
  roomSlug: string;
  onStartRecording: (targetUserId: string, title: string) => void;
  onStopRecording: () => void;

  // Back to the room list (Lobby) without logging out — distinct from
  // onLogout below, which clears the session entirely.
  onLeaveRoom: () => void;
  onLogout: () => void;

  // Ghost mode — moved here from the meeting toolbar's bottom-center HUD
  // bar (was HiddenButton, App.tsx); same handleHiddenToggle/localPlayer.hidden
  // wiring, only the render location changed. canToggleHidden mirrors the
  // exact roleAtLeast(localRole, 'admin') check that gated it before.
  hiddenActive: boolean;
  canToggleHidden: boolean;
  onToggleHidden: () => void;

  theme: Theme;
  onToggleTheme: () => void;
}

// ZEP-style left icon rail. Kept deliberately SHORT — only identity (avatar,
// status) and the one seat-jump shortcut live here permanently. Everything
// else (view-mode toggles, room management, recording) used to each be its
// own icon stacked in this same rail, which read as cluttered once enough
// features landed in the same session; they now live inside the hamburger
// "Room Features" menu instead, one labeled row each, opening to the right
// — same flyout convention Teleport/Add Media already used, just with text
// labels since a whole LIST of features (unlike one single-purpose icon)
// needs them to stay scannable.
//
// z-50 — above MeetingView's z-40 full-screen overlay, so the rail (or its
// collapsed form below) stays reachable even while Meeting View is active;
// there'd otherwise be no way to mute/exit without leaving that view first.
export function Sidebar({
  onEditAvatar,
  onOpenTutorial,
  onOpenMemberList,
  localRole,
  manualStatus,
  onPickPresence,
  isAdmin,
  onOpenRoomEditor,
  canTeleport,
  showTeleportPanel,
  onToggleTeleport,
  hasMySeat,
  onMySeat,
  meetingViewActive,
  onToggleMeetingView,
  doorOverride,
  canDoorOverride,
  onToggleDoorOverride,
  canManageGuests,
  onCreateGuestLink,
  canBroadcast,
  onBroadcast,
  isGuest,
  currentZoneName,
  zoneLocked,
  zoneLockedByName,
  canToggleZoneLock,
  onToggleZoneLock,
  simplifiedView,
  onToggleSimplifiedView,
  dailyTaskActive,
  onToggleDailyTask,
  leaveActive,
  onToggleLeave,
  calendarViewActive,
  onToggleCalendarView,
  attendanceViewActive,
  onToggleAttendanceView,
  larkAttendanceActive,
  onToggleLarkAttendance,
  larkSyncActive,
  onToggleLarkSync,
  messengerViewActive,
  onToggleMessengerView,
  joinQueueActive,
  onToggleJoinQueue,
  pendingJoinCount,
  isWorkspaceAdmin,
  adminViewActive,
  onToggleAdminView,
  myAnalyticsActive,
  onToggleMyAnalytics,
  miniModeSupported,
  miniModeActive,
  onToggleMiniMode,
  showAddMediaPanel,
  onToggleAddMedia,
  canRecord,
  recordingTargets,
  activeRecording,
  isRecordingMine,
  recordingUploading,
  roomSlug,
  onStartRecording,
  onStopRecording,
  onLeaveRoom,
  onLogout,
  hiddenActive,
  canToggleHidden,
  onToggleHidden,
  theme,
  onToggleTheme,
}: SidebarProps) {
  const [showFeaturesMenu, setShowFeaturesMenu] = useState(false);

  // Simplified View intentionally still hides everything ELSE (room-meta
  // text, participant list, minimap — see App.tsx), but the rail can no
  // longer disappear along with it now that Simplify's own toggle lives
  // inside it — collapsing to just that one icon is the escape hatch back,
  // in the same spot a user would already be looking.
  if (simplifiedView) {
    return (
      <div className="absolute left-0 top-0 h-full w-12 z-50 flex flex-col items-center py-3 pointer-events-none">
        <SidebarIcon title="Show UI" onClick={onToggleSimplifiedView} className="pointer-events-auto bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-800 shadow-sm border border-purple-100 dark:border-gray-700">
          <EyeFill size={14} />
        </SidebarIcon>
      </div>
    );
  }

  const closeAnd = (action: () => void) => () => {
    action();
    setShowFeaturesMenu(false);
  };

  return (
    <div className="absolute left-0 top-0 h-full w-12 z-50 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm border-r border-purple-100 dark:border-gray-700 shadow-sm flex flex-col items-center py-3 gap-0.5 pointer-events-auto">
      <div className="relative">
        <SidebarIcon title="Room Features" active={showFeaturesMenu} onClick={() => setShowFeaturesMenu((v) => !v)}>
          <List size={16} />
        </SidebarIcon>

        {showFeaturesMenu && (
          <div
            className="absolute top-0 left-full ml-2 w-64 max-h-[85vh] overflow-y-auto bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-purple-100 dark:border-gray-700 p-2 z-50"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-2 py-1.5 mb-1">
              <span className="text-gray-900 dark:text-gray-100 text-sm font-semibold">Room Features</span>
              <button onClick={() => setShowFeaturesMenu(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
                <XLg size={14} />
              </button>
            </div>

            {/* QA #1/#6/#7 — reopens the first-run walkthrough (auto-shown
                once before entering, see App.tsx's TutorialModal gate).
                Always first in the list and always visible (no isGuest/
                isAdmin gate) — this is the one thing anyone stuck should be
                able to find without already knowing where anything else is. */}
            <MenuRow icon={<QuestionCircleFill size={15} />} label="Panduan" onClick={closeAnd(onOpenTutorial)} />
            {/* QA (Presence checklist item #8, "Member list akurat") — a
                guest has no User row (see server/src/routes/guestInvite.ts),
                so they can't appear in api.getWorkspacePeople() and gain
                nothing from opening this either. */}
            {!isGuest && (
              <MenuRow icon={<PeopleFill size={15} />} label="Member" onClick={closeAnd(onOpenMemberList)} />
            )}
            <MenuDivider />
            {/* Always available, even with camera/mic off — MeetingView
                itself shows a friendly "nobody's on camera" placeholder
                rather than an empty/broken grid, so there's no need to hide
                the entry point until someone's actually streaming. */}
            <MenuRow icon={<Grid3x3GapFill size={15} />} label={meetingViewActive ? 'Exit Meeting View' : 'Meeting View'} active={meetingViewActive} onClick={closeAnd(onToggleMeetingView)} />
            {!miniModeActive && (
              <MenuRow
                icon={<PipFill size={15} />}
                label="Mini Mode"
                onClick={closeAnd(onToggleMiniMode)}
                // Not actually disabled — a truly disabled button gives zero
                // feedback on click (no error, no window, nothing), which
                // read exactly like "the feature is broken" rather than
                // "unsupported here". It stays clickable; onToggleMiniMode
                // itself checks support and shows a clear message when it
                // isn't, same code path as any other failure to open.
                title={miniModeSupported ? undefined : 'May not be supported in this browser — needs Chrome or Edge 116+'}
              />
            )}
            {/* QA (Kompat checklist item 7, "Low-spec") — used to be purely
                cosmetic (hide HUD panels only); now also caps rendering
                cost (GameCanvas.tsx's lowSpecMode: no retina scaling,
                ~30fps cap) for a low-RAM/integrated-GPU device. */}
            <MenuRow icon={<EyeFill size={15} />} label="Simplify" onClick={closeAnd(onToggleSimplifiedView)} title="Sembunyikan panel HUD dan kurangi beban render — cocok untuk perangkat low-spec" />
            {!isGuest && (
              <MenuRow icon={<TableIcon size={15} />} label={dailyTaskActive ? 'Tutup Daily Task' : 'Daily Task'} active={dailyTaskActive} onClick={closeAnd(onToggleDailyTask)} />
            )}
            {!isGuest && (
              <MenuRow icon={<ChatDotsFill size={15} />} label={messengerViewActive ? 'Tutup Chat' : 'Chat'} active={messengerViewActive} onClick={closeAnd(onToggleMessengerView)} />
            )}
            {isAdmin && (
              <MenuRow
                icon={<PersonCheck size={15} />}
                label={pendingJoinCount > 0 ? `Permintaan bergabung (${pendingJoinCount})` : 'Permintaan bergabung'}
                active={joinQueueActive}
                onClick={closeAnd(onToggleJoinQueue)}
              />
            )}
            {!isGuest && (
              <MenuRow icon={<CalendarEvent size={15} />} label={calendarViewActive ? 'Tutup Kalender' : 'Kalender'} active={calendarViewActive} onClick={closeAnd(onToggleCalendarView)} />
            )}
            {!isGuest && (
              <MenuRow icon={<Airplane size={15} />} label={leaveActive ? 'Tutup Cuti' : 'Cuti'} active={leaveActive} onClick={closeAnd(onToggleLeave)} />
            )}
            {/* A2 — Absensi kini otomatis lewat Lark Attendance (check-in dipicu
                di /auth/me). Menu MeetKai lama disembunyikan (flag false) supaya
                tak ada pencatatan manual baru; komponen AttendanceApp & data
                historis sengaja TIDAK dihapus — cukup ubah flag utk kembalikan. */}
            {ATTENDANCE_MENU_ENABLED && (
              <MenuRow icon={<ClockHistory size={15} />} label={attendanceViewActive ? 'Tutup Absensi' : 'Absensi'} active={attendanceViewActive} onClick={closeAnd(onToggleAttendanceView)} />
            )}
            {/* A12 — new Lark-backed attendance panel (check-in auto on login,
                checkout here or in the Lark app). */}
            {!isGuest && (
              <MenuRow icon={<ClockHistory size={15} />} label={larkAttendanceActive ? 'Tutup Absensi' : 'Absensi'} active={larkAttendanceActive} onClick={closeAnd(onToggleLarkAttendance)} />
            )}
            {/* Productivity Analytics — every real employee's own "cermin
                evaluasi diri" (see PanelId's doc comment in gameStore.ts for
                why this is NOT nested inside the admin-only Konsol Admin). */}
            {!isGuest && (
              <MenuRow icon={<BarChartFill size={15} />} label={myAnalyticsActive ? 'Tutup Analitik Saya' : 'Analitik Saya'} active={myAnalyticsActive} onClick={closeAnd(onToggleMyAnalytics)} />
            )}
            {isAdmin && (
              <MenuRow icon={<ArrowLeftRight size={15} />} label={larkSyncActive ? 'Tutup Lark Sync' : 'Lark Sync'} active={larkSyncActive} onClick={closeAnd(onToggleLarkSync)} />
            )}
            {isWorkspaceAdmin && (
              <MenuRow icon={<ShieldLock size={15} />} label={adminViewActive ? 'Tutup Konsol Admin' : 'Konsol Admin'} active={adminViewActive} onClick={closeAnd(onToggleAdminView)} />
            )}

            {(isAdmin || canTeleport) && <MenuDivider />}
            {/* Standing in a zone → this locks the ZONE (Meeting Room B, …).
                Anyone inside may lock it and becomes its keyholder; people who
                walk in afterwards must knock and be admitted BY THEM. */}
            {/* QA (Akses tamu checklist item 2) — already a dead end for a
                guest (zoneLock.ts isn't registered for guest sockets),
                just never hidden. */}
            {currentZoneName && !isGuest && (
              <MenuRow
                icon={zoneLocked ? <LockFill size={15} /> : <UnlockFill size={15} />}
                label={zoneLocked ? `Buka ${currentZoneName}` : `Kunci ${currentZoneName}`}
                active={zoneLocked}
                onClick={canToggleZoneLock ? closeAnd(onToggleZoneLock) : () => {}}
                title={
                  zoneLocked && !canToggleZoneLock
                    ? `Dikunci ${zoneLockedByName ?? 'orang lain'} — hanya dia yang bisa membuka`
                    : zoneLocked
                      ? 'Buka zona ini supaya siapa pun bisa masuk lagi'
                      : 'Kunci zona ini — orang lain harus ketuk dan kamu yang mengizinkan'
                }
              />
            )}
            {/* Akses & Password Pintu audit item #9 — emergency override:
                unlocks EVERY password door in the room at once, bypassing
                doorLock.ts's normal per-socket unlock entirely. */}
            {canDoorOverride && (
              <MenuRow
                icon={doorOverride ? <DoorOpenFill size={15} /> : <DoorClosedFill size={15} />}
                label={doorOverride ? 'Matikan Mode Darurat Pintu' : 'Buka Semua Pintu (Darurat)'}
                active={doorOverride}
                onClick={closeAnd(onToggleDoorOverride)}
                title={doorOverride ? 'Matikan override — pintu berpassword kembali terkunci seperti biasa' : 'Buka semua pintu berpassword di room ini untuk semua orang (keadaan darurat)'}
              />
            )}
            {/* Guest Link & Ruang Tunggu — admin generates a room-scoped
                invite link for an external, unauthenticated visitor (see
                App.tsx's handleCreateGuestLink). No active/current-state
                indicator — this is a one-shot action, not a toggle. */}
            {canManageGuests && (
              <MenuRow icon={<Link45deg size={15} />} label="Buat Guest Link" onClick={closeAnd(onCreateGuestLink)} title="Buat link undangan untuk tamu (tanpa akun) masuk ke room ini" />
            )}
            {/* QA #9/#10 — CEO/admin-only text broadcast, the text
                counterpart to Spotlight (voice). One-shot action like Guest
                Link above — App.tsx's handleBroadcast prompts for the text. */}
            {canBroadcast && (
              <MenuRow icon={<VolumeUpFill size={15} />} label="Broadcast" onClick={closeAnd(onBroadcast)} title="Kirim pengumuman teks ke semua orang di room ini (tersinkron ke Lark)" />
            )}
            {isAdmin && (
              <MenuRow icon={<Tools size={15} />} label="Edit Room" onClick={closeAnd(onOpenRoomEditor)} />
            )}
            {canTeleport && (
              <MenuRow icon={<GeoAltFill size={15} />} label="Teleport" active={showTeleportPanel} onClick={closeAnd(onToggleTeleport)} />
            )}

            <MenuDivider />
            {/* QA (Akses tamu checklist item 2, "Guest terbatas") — was
                already a dead end for a guest (mediaHandler.ts/noteHandler.ts
                aren't registered for guest sockets at all), just never hidden. */}
            {!isGuest && (
              <MenuRow icon={<ImageFill size={15} />} label="Add Media" active={showAddMediaPanel} onClick={closeAnd(onToggleAddMedia)} />
            )}

            {canRecord && (
              <div className="flex items-center gap-3 px-3 py-2">
                <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-purple-50 dark:bg-gray-700 text-purple-600 dark:text-purple-300">
                  <RecordCircleFill size={15} />
                </span>
                <span className="flex-1 text-sm text-gray-700 dark:text-gray-200">Recording</span>
                <div className="flex items-center gap-1 shrink-0">
                  <RecordingControl
                    variant="sidebar"
                    recordingTargets={recordingTargets}
                    activeRecording={activeRecording}
                    isRecordingMine={isRecordingMine}
                    uploading={recordingUploading}
                    roomSlug={roomSlug}
                    onStart={onStartRecording}
                    onStop={onStopRecording}
                  />
                </div>
              </div>
            )}

            {/* TEMPORARY DIAGNOSTIC — remove once the "guest still sees
                Member" report (reported 3x, unreproduced from code review —
                both isGuest-only and the isGuest||localRole==='guest'
                hardening were independently verified present in the
                deployed bundle) is root-caused. Shows exactly what THIS
                client believes about its own session so a screenshot from
                whoever's still seeing the bug tells us immediately whether
                it's a real client-side desync (isGuest=false, role=guest
                would be the smoking gun) or a test-methodology mismatch
                (isGuest=false, role=member — not actually a guest session
                by this feature's definition). */}
            <p className="px-2 py-1 mt-1 text-[9px] text-gray-300 dark:text-gray-600 border-t border-gray-100 dark:border-gray-800">
              debug: isGuest={String(isGuest)} role={localRole}
            </p>
          </div>
        )}
      </div>

      {hasMySeat && (
        <SidebarIcon title="Go to My Seat" onClick={onMySeat}>
          <span className="text-xs leading-none">🪑</span>
        </SidebarIcon>
      )}

      <SidebarDivider />

      {/* QA (Akses tamu checklist item 2) — a guest's avatar edits already
          never persisted (PUT /users/me/avatar 401s and is swallowed, see
          App.tsx's persistAvatar) since they have no User row to save to —
          offering the editor at all was misleading, not just extraneous. */}
      {!isGuest && <AvatarEditorButton onClick={onEditAvatar} variant="sidebar" />}
      <PresenceButton manualStatus={manualStatus} onPick={onPickPresence} variant="sidebar" />

      {/* Ghost mode + Notification Settings — moved here from the meeting
          toolbar (previously HiddenButton/NotificationSettings in App.tsx's
          bottom-center HUD bar) so that bar stays to the 8 core meeting
          controls. Same handlers/state as before, only the render location
          changed. */}
      {canToggleHidden && (
        <SidebarIcon
          title={hiddenActive ? 'Tampilkan diri' : 'Sembunyikan diri'}
          active={hiddenActive}
          onClick={onToggleHidden}
        >
          {hiddenActive ? <EyeSlashFill size={14} /> : <EyeFill size={14} />}
        </SidebarIcon>
      )}
      <NotificationSettings />

      <SidebarIcon
        title="Back to room list"
        onClick={onLeaveRoom}
        className="mt-auto text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-800"
      >
        <HouseDoorFill size={14} />
      </SidebarIcon>
      <SidebarIcon
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        onClick={onToggleTheme}
        className="text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-800"
      >
        {theme === 'dark' ? <SunFill size={14} /> : <MoonFill size={14} />}
      </SidebarIcon>
      <SidebarIcon title="Logout" onClick={onLogout} className="text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-500">
        <BoxArrowRight size={14} />
      </SidebarIcon>
    </div>
  );
}

function SidebarDivider() {
  return <div className="w-6 border-t border-purple-100 dark:border-gray-700 my-0.5" />;
}

function MenuDivider() {
  return <div className="my-1.5 border-t border-purple-100 dark:border-gray-700" />;
}

// One row inside the "Room Features" flyout — icon-in-a-box + label, same
// shape as ZEP's own User Guide list (see the reference screenshot this
// redesign was modeled on), so a list of several features stays scannable
// instead of needing a separate icon meaning memorized per row.
function MenuRow({
  icon,
  label,
  active,
  onClick,
  disabled,
  title,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  // Rendered greyed-out with `title` as a tooltip instead of not rendering
  // at all — e.g. Mini Mode when the browser lacks the Document
  // Picture-in-Picture API (see isMiniModeSupported). A row that just
  // silently doesn't exist reads as "the feature vanished/is broken"; a
  // disabled row with an explanation reads as "not available here, and
  // here's why" — much easier to diagnose from a bug report.
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      className={`w-full flex items-center gap-3 px-2 py-2 rounded-lg text-sm transition-all ${
        disabled
          ? 'text-gray-400 dark:text-gray-500 cursor-not-allowed opacity-60'
          : `cursor-pointer ${active ? 'bg-purple-600 text-white' : 'text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700'}`
      }`}
    >
      <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${active && !disabled ? 'bg-white/20' : 'bg-purple-50 dark:bg-gray-700 text-purple-600 dark:text-purple-300'} ${disabled ? 'opacity-60' : ''}`}>
        {icon}
      </span>
      <span className="flex-1 text-left truncate">{label}</span>
      {active && !disabled && <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80 shrink-0">On</span>}
    </button>
  );
}

export function SidebarIcon({
  title,
  active,
  onClick,
  children,
  className,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
        className || (active ? 'bg-purple-600 text-white' : 'text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-800')
      }`}
    >
      {children}
    </button>
  );
}
