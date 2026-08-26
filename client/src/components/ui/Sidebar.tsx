import { ReactNode } from 'react';
import { List, XLg, XCircleFill, Tools, GeoAltFill, ImageFill, BoxArrowRight, HouseDoorFill, SunFill, MoonFill, EyeFill, EyeSlashFill, PipFill, RecordCircleFill, LockFill, UnlockFill, ShieldLock, Buildings, CalendarEvent, ClockHistory, ChatDotsFill, PersonCheck, DoorOpenFill, DoorClosedFill, Link45deg, VolumeUpFill, QuestionCircleFill, PeopleFill, BarChartFill, GearFill, HourglassSplit } from 'react-bootstrap-icons';
import { AvatarEditorButton } from '../avatar/AvatarEditorButton';
import { PresenceButton } from '../avatar/PresenceButton';
import { RecordingControl } from './RecordingControl';
import { ActiveRecordingInfo } from '@/stores/gameStore';
import { Theme } from '@/hooks/useTheme';
import { ManualStatus } from '@/data/presence';
import { Role } from '@kaispace/shared';
import { Tooltip } from '@/components/ui/Tooltip';

interface SidebarProps {
  // Fix panel numpuk — the "Room Features" dropdown is now one of the
  // mutually-exclusive panels (activePanel === 'roomFeatures' in
  // gameStore.ts), not its own independent boolean, so it can never stay
  // open behind (or on top of) Teleport/Kalender/etc. onCloseRoomFeatures is
  // guarded (only clears activePanel if this menu is still the one open) —
  // used after a menu item's own action runs, so closing this menu never
  // clobbers a panel that action just opened (e.g. clicking "Teleport"
  // itself opens Teleport via activePanel, and closing this menu afterward
  // must not immediately null that back out).
  roomFeaturesActive: boolean;
  onToggleRoomFeatures: () => void;
  onCloseRoomFeatures: () => void;

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
  // Bug panel numpuk — same fix shape as roomFeaturesActive above: the
  // Status dropdown (PresenceButton) is now one of the mutually-exclusive
  // panels (activePanel === 'status') instead of its own independent
  // useState, so it can never stay open behind/alongside Room Features (or
  // vice versa).
  statusPickerOpen: boolean;
  onToggleStatusPicker: () => void;

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
  // QA (Akses tamu checklist item 7, "Revoke") — targets only the most
  // recently created link (App.tsx's lastGuestInviteId ref); handler itself
  // alerts if none exists yet this session.
  onRevokeLastGuestLink: () => void;

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

  // Workspace admin console. `isWorkspaceAdmin` is cosmetic only — every
  // /api/admin/* route re-checks the role from the DB (see
  // server/src/lib/workspace.ts). The row is HIDDEN, not disabled, for
  // members, per the suite's permission rules.
  // Calendar module — same pattern again.
  calendarViewActive: boolean;
  onToggleCalendarView: () => void;

  // Attendance module — also hosts Cuti (leave) as a tab inside it.
  attendanceViewActive: boolean;
  onToggleAttendanceView: () => void;

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

  // Deployment operator's cross-org organization list — a DIFFERENT gate
  // from isWorkspaceAdmin above (org-scoped workspace admin vs. the one
  // person operating this whole deployment). See
  // specs/2026-08-12-operator-org-list-design.md.
  isOperator: boolean;
  operatorConsoleActive: boolean;
  onToggleOperatorConsole: () => void;

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
  isRecordingPaused: boolean;
  onPauseRecording: () => void;
  onResumeRecording: () => void;

  // Back to the room list (Lobby) without logging out — distinct from
  // onLogout below, which clears the session entirely.
  onLeaveRoom: () => void;
  onLogout: () => void;
  onOpenSettings: () => void;

  // QA (Booking popup close button) — shown whenever this user has an
  // active "Ngobrol dengan CEO" booking (see App.tsx's zoneLock.zoneQueueTicket),
  // regardless of whether its ZoneLockBar notice card is currently
  // dismissed. Doubles as the reopen affordance: clicking it always shows
  // the card again (harmless if it's already showing).
  hasActiveBooking: boolean;
  onReopenBookingNotice: () => void;

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
// else (view-mode toggles, room management) used to each be its own icon
// stacked in this same rail, which read as cluttered once enough features
// landed in the same session; they now live inside the hamburger "Room
// Features" menu instead, one labeled row each, opening to the right — same
// flyout convention Teleport/Add Media already used, just with text labels
// since a whole LIST of features (unlike one single-purpose icon) needs
// them to stay scannable. (Recording briefly moved out to its own
// standalone top-of-screen control and back — see this file's own
// Recording row further below, and commit 829cd166.)
//
// z-50 — above MeetingView's z-40 full-screen overlay, so the rail (or its
// collapsed form below) stays reachable even while Meeting View is active;
// there'd otherwise be no way to mute/exit without leaving that view first.
export function Sidebar({
  roomFeaturesActive,
  onToggleRoomFeatures,
  onCloseRoomFeatures,
  onEditAvatar,
  onOpenTutorial,
  onOpenMemberList,
  localRole,
  manualStatus,
  onPickPresence,
  statusPickerOpen,
  onToggleStatusPicker,
  isAdmin,
  onOpenRoomEditor,
  canTeleport,
  showTeleportPanel,
  onToggleTeleport,
  hasMySeat,
  onMySeat,
  doorOverride,
  canDoorOverride,
  onToggleDoorOverride,
  canManageGuests,
  onCreateGuestLink,
  onRevokeLastGuestLink,
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
  calendarViewActive,
  onToggleCalendarView,
  attendanceViewActive,
  onToggleAttendanceView,
  messengerViewActive,
  onToggleMessengerView,
  joinQueueActive,
  onToggleJoinQueue,
  pendingJoinCount,
  isWorkspaceAdmin,
  adminViewActive,
  onToggleAdminView,
  isOperator,
  operatorConsoleActive,
  onToggleOperatorConsole,
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
  isRecordingPaused,
  onPauseRecording,
  onResumeRecording,
  onLeaveRoom,
  onLogout,
  onOpenSettings,
  hasActiveBooking,
  onReopenBookingNotice,
  hiddenActive,
  canToggleHidden,
  onToggleHidden,
  theme,
  onToggleTheme,
}: SidebarProps) {
  // Simplified View intentionally still hides everything ELSE (room-meta
  // text, participant list, minimap — see App.tsx), but the rail can no
  // longer disappear along with it now that Simplify's own toggle lives
  // inside it — collapsing to just that one icon is the escape hatch back,
  // in the same spot a user would already be looking.
  if (simplifiedView) {
    return (
      <div className="absolute left-0 top-0 h-full w-12 z-50 flex flex-col items-center py-3 pointer-events-none">
        <Tooltip label="Tampilkan UI" detail="Munculkan lagi panel HUD yang disembunyikan." side="right">
          <SidebarIcon onClick={onToggleSimplifiedView} className="pointer-events-auto bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-800 shadow-sm border border-purple-100 dark:border-gray-700">
            <EyeFill size={14} />
          </SidebarIcon>
        </Tooltip>
      </div>
    );
  }

  const closeAnd = (action: () => void) => () => {
    action();
    onCloseRoomFeatures();
  };

  return (
    <div className="absolute left-0 top-0 h-full w-12 z-50 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm border-r border-purple-100 dark:border-gray-700 shadow-sm flex flex-col items-center py-3 gap-0.5 pointer-events-auto">
      <div className="relative">
        <Tooltip label="Room Features" detail="Buka menu pengaturan & kontrol room." side="right">
          <SidebarIcon active={roomFeaturesActive} onClick={onToggleRoomFeatures}>
            <List size={16} />
          </SidebarIcon>
        </Tooltip>

        {roomFeaturesActive && (
          <div
            className="absolute top-0 left-full ml-2 w-64 max-h-[85vh] overflow-y-auto bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-purple-100 dark:border-gray-700 p-2 z-50"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-2 py-1.5 mb-1">
              <span className="text-gray-900 dark:text-gray-100 text-sm font-semibold">Room Features</span>
              <Tooltip label="Tutup" detail="Tutup panel Room Features." side="right">
                <button onClick={onCloseRoomFeatures} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
                  <XLg size={14} />
                </button>
              </Tooltip>
            </div>

            {/* Opens the ZEP-style User Guide (App.tsx's UserGuidePanel) —
                distinct from the mandatory first-run TutorialModal (shown
                once automatically before entering, never reachable from
                here). Always first in the list and always visible (no
                isGuest/isAdmin gate) — this is the one thing anyone stuck
                should be able to find without already knowing where
                anything else is. */}
            <Tooltip label="Panduan" detail="Buka panduan cara pakai KaiSpace." side="right" wrapperClassName="w-full">
              <MenuRow icon={<QuestionCircleFill size={15} />} label="Panduan" onClick={closeAnd(onOpenTutorial)} />
            </Tooltip>
            {/* QA (Presence checklist item #8, "Member list akurat") — a
                guest has no User row (see server/src/routes/guestInvite.ts),
                so they can't appear in api.getWorkspacePeople() and gain
                nothing from opening this either. */}
            {!isGuest && (
              <Tooltip label="Daftar Member" detail="Lihat semua member terdaftar di room ini." side="right" wrapperClassName="w-full">
                <MenuRow icon={<PeopleFill size={15} />} label="Member" onClick={closeAnd(onOpenMemberList)} />
              </Tooltip>
            )}
            <MenuDivider />
            {/* Meeting View entry moved to VideoGrid.tsx (next to the
                hide/show camera-tiles toggle) — no longer listed here. */}
            {!miniModeActive && (
              <Tooltip
                label="Mini Mode"
                detail={
                  miniModeSupported
                    ? 'Ciutkan KaiSpace jadi jendela kecil mengambang (picture-in-picture).'
                    : 'Ciutkan KaiSpace jadi jendela kecil mengambang (picture-in-picture). May not be supported in this browser — needs Chrome or Edge 116+.'
                }
                side="right"
                wrapperClassName="w-full"
              >
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
                />
              </Tooltip>
            )}
            {/* QA (Kompat checklist item 7, "Low-spec") — used to be purely
                cosmetic (hide HUD panels only); now also caps rendering
                cost (GameCanvas.tsx's lowSpecMode: no retina scaling,
                ~30fps cap) for a low-RAM/integrated-GPU device. */}
            <Tooltip label="Simplify" detail="Sembunyikan panel HUD untuk tampilan yang lebih bersih." side="right" wrapperClassName="w-full">
              <MenuRow icon={<EyeFill size={15} />} label="Simplify" onClick={closeAnd(onToggleSimplifiedView)} />
            </Tooltip>
            {!isGuest && (
              <Tooltip label="Chat" detail="Buka tampilan pesan gaya messenger." side="right" wrapperClassName="w-full">
                <MenuRow icon={<ChatDotsFill size={15} />} label={messengerViewActive ? 'Tutup Chat' : 'Chat'} active={messengerViewActive} onClick={closeAnd(onToggleMessengerView)} />
              </Tooltip>
            )}
            {isAdmin && (
              <Tooltip label="Permintaan Bergabung" detail="Lihat & proses permintaan masuk yang menunggu. (Khusus admin.)" side="right" wrapperClassName="w-full">
                <MenuRow
                  icon={<PersonCheck size={15} />}
                  label={pendingJoinCount > 0 ? `Permintaan bergabung (${pendingJoinCount})` : 'Permintaan bergabung'}
                  active={joinQueueActive}
                  onClick={closeAnd(onToggleJoinQueue)}
                />
              </Tooltip>
            )}
            {!isGuest && (
              <Tooltip label="Kalender" detail="Buka kalender jadwal tim." side="right" wrapperClassName="w-full">
                <MenuRow icon={<CalendarEvent size={15} />} label={calendarViewActive ? 'Tutup Kalender' : 'Kalender'} active={calendarViewActive} onClick={closeAnd(onToggleCalendarView)} />
              </Tooltip>
            )}
            {/* Absensi + Cuti keduanya hidup di AttendanceApp (Cuti adalah tab
                di dalamnya, lihat components/Attendance/AttendanceApp.tsx), jadi
                satu baris menu ini membuka dua-duanya — tak ada baris "Cuti"
                terpisah. */}
            {!isGuest && (
              <Tooltip label="Absensi" detail="Lihat riwayat & status absensimu, termasuk pengajuan cuti." side="right" wrapperClassName="w-full">
                <MenuRow icon={<ClockHistory size={15} />} label={attendanceViewActive ? 'Tutup Absensi' : 'Absensi'} active={attendanceViewActive} onClick={closeAnd(onToggleAttendanceView)} />
              </Tooltip>
            )}
            {/* Productivity Analytics — every real employee's own "cermin
                evaluasi diri" (see PanelId's doc comment in gameStore.ts for
                why this is NOT nested inside the admin-only Konsol Admin). */}
            {!isGuest && (
              <Tooltip label="Analitik Saya" detail="Lihat ringkasan aktivitas & produktivitasmu." side="right" wrapperClassName="w-full">
                <MenuRow icon={<BarChartFill size={15} />} label={myAnalyticsActive ? 'Tutup Analitik Saya' : 'Analitik Saya'} active={myAnalyticsActive} onClick={closeAnd(onToggleMyAnalytics)} />
              </Tooltip>
            )}
            {isWorkspaceAdmin && (
              <Tooltip label="Konsol Admin" detail="Buka panel pengelolaan workspace. (Khusus admin.)" side="right" wrapperClassName="w-full">
                <MenuRow icon={<ShieldLock size={15} />} label={adminViewActive ? 'Tutup Konsol Admin' : 'Konsol Admin'} active={adminViewActive} onClick={closeAnd(onToggleAdminView)} />
              </Tooltip>
            )}
            {isOperator && (
              <MenuRow icon={<Buildings size={15} />} label={operatorConsoleActive ? 'Tutup Semua Organisasi' : 'Semua Organisasi'} active={operatorConsoleActive} onClick={closeAnd(onToggleOperatorConsole)} />
            )}

            {(isAdmin || canTeleport) && <MenuDivider />}
            {/* Standing in a zone → this locks the ZONE (Meeting Room B, …).
                Anyone inside may lock it and becomes its keyholder; people who
                walk in afterwards must knock and be admitted BY THEM. */}
            {/* QA (Akses tamu checklist item 2) — already a dead end for a
                guest (zoneLock.ts isn't registered for guest sockets),
                just never hidden. */}
            {currentZoneName && !isGuest && (
              <Tooltip
                label={zoneLocked ? `Buka ${currentZoneName}` : `Kunci ${currentZoneName}`}
                detail={
                  zoneLocked && !canToggleZoneLock
                    ? `Dikunci ${zoneLockedByName ?? 'orang lain'} — hanya dia yang bisa membuka.`
                    : zoneLocked
                      ? 'Buka zona ini supaya siapa pun bisa masuk lagi.'
                      : 'Kunci area ini supaya orang lain harus mengetuk dulu sebelum masuk.'
                }
                side="right"
                wrapperClassName="w-full"
              >
                <MenuRow
                  icon={zoneLocked ? <LockFill size={15} /> : <UnlockFill size={15} />}
                  label={zoneLocked ? `Buka ${currentZoneName}` : `Kunci ${currentZoneName}`}
                  active={zoneLocked}
                  onClick={canToggleZoneLock ? closeAnd(onToggleZoneLock) : () => {}}
                />
              </Tooltip>
            )}
            {/* Akses & Password Pintu audit item #9 — emergency override:
                unlocks EVERY password door in the room at once, bypassing
                doorLock.ts's normal per-socket unlock entirely. */}
            {canDoorOverride && (
              <Tooltip
                label={doorOverride ? 'Matikan Mode Darurat Pintu' : 'Buka Semua Pintu (Darurat)'}
                detail={doorOverride ? 'Matikan override — pintu berpassword kembali terkunci seperti biasa.' : 'Buka paksa semua pintu berpassword di room ini untuk semua orang (keadaan darurat).'}
                side="right"
                wrapperClassName="w-full"
              >
                <MenuRow
                  icon={doorOverride ? <DoorOpenFill size={15} /> : <DoorClosedFill size={15} />}
                  label={doorOverride ? 'Matikan Mode Darurat Pintu' : 'Buka Semua Pintu (Darurat)'}
                  active={doorOverride}
                  onClick={closeAnd(onToggleDoorOverride)}
                />
              </Tooltip>
            )}
            {/* Guest Link & Ruang Tunggu — admin generates a room-scoped
                invite link for an external, unauthenticated visitor (see
                App.tsx's handleCreateGuestLink). No active/current-state
                indicator — this is a one-shot action, not a toggle. */}
            {canManageGuests && (
              <Tooltip label="Buat Guest Link" detail="Buat link undangan untuk tamu tanpa akun." side="right" wrapperClassName="w-full">
                <MenuRow icon={<Link45deg size={15} />} label="Buat Guest Link" onClick={closeAnd(onCreateGuestLink)} />
              </Tooltip>
            )}
            {/* QA (Akses tamu checklist item 7, "Revoke") — cabut link
                terakhir yang dibuat; server juga langsung mengeluarkan tamu
                yang sedang masuk lewat link itu (lihat DELETE handler). */}
            {canManageGuests && (
              <Tooltip label="Cabut Guest Link" detail="Nonaktifkan link tamu yang paling terakhir dibuat." side="right" wrapperClassName="w-full">
                <MenuRow icon={<XCircleFill size={15} />} label="Cabut Guest Link Terakhir" onClick={closeAnd(onRevokeLastGuestLink)} />
              </Tooltip>
            )}
            {/* QA #9/#10 — CEO/admin-only text broadcast, the text
                counterpart to Spotlight (voice). One-shot action like Guest
                Link above — App.tsx's handleBroadcast prompts for the text. */}
            {canBroadcast && (
              <Tooltip label="Broadcast" detail="Kirim pengumuman teks ke semua orang di room ini." side="right" wrapperClassName="w-full">
                <MenuRow icon={<VolumeUpFill size={15} />} label="Broadcast" onClick={closeAnd(onBroadcast)} />
              </Tooltip>
            )}
            {isAdmin && (
              <Tooltip label="Edit Room" detail="Buka Room Editor untuk mengubah tata letak. (Khusus admin.)" side="right" wrapperClassName="w-full">
                <MenuRow icon={<Tools size={15} />} label="Edit Room" onClick={closeAnd(onOpenRoomEditor)} />
              </Tooltip>
            )}
            {canTeleport && (
              <Tooltip label="Teleport" detail="Pindah cepat ke lokasi tersimpan." side="right" wrapperClassName="w-full">
                <MenuRow icon={<GeoAltFill size={15} />} label="Teleport" active={showTeleportPanel} onClick={closeAnd(onToggleTeleport)} />
              </Tooltip>
            )}

            <MenuDivider />
            {/* QA (Akses tamu checklist item 2, "Guest terbatas") — was
                already a dead end for a guest (mediaHandler.ts/noteHandler.ts
                aren't registered for guest sockets at all), just never hidden. */}
            {!isGuest && (
              <Tooltip label="Tambah Media" detail="Tempel gambar, video, atau file ke dalam room." side="right" wrapperClassName="w-full">
                <MenuRow icon={<ImageFill size={15} />} label="Add Media" active={showAddMediaPanel} onClick={closeAnd(onToggleAddMedia)} />
              </Tooltip>
            )}

            {/* Screen recording — restored here after a brief detour to a
                standalone top-of-screen control (commit 829cd166 moved it
                out; this reverts that). variant="sidebar" renders as a
                compact icon pair (Record, Recordings) anchored at the row's
                right edge, with its own flyout popovers portaled to
                document.body — see RecordingControl.tsx's own header
                comment for why the portal is needed specifically inside
                this scrollable dropdown. */}
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
                    isPaused={isRecordingPaused}
                    uploading={recordingUploading}
                    roomSlug={roomSlug}
                    onStart={onStartRecording}
                    onStop={onStopRecording}
                    onPause={onPauseRecording}
                    onResume={onResumeRecording}
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
        <Tooltip label="Ke Kursi Saya" detail="Teleport langsung ke kursi tetapmu di room ini." side="right">
          <SidebarIcon onClick={onMySeat}>
            <span className="text-xs leading-none">🪑</span>
          </SidebarIcon>
        </Tooltip>
      )}

      <SidebarDivider />

      {/* QA (Akses tamu checklist item 2) — a guest's avatar edits already
          never persisted (PUT /users/me/avatar 401s and is swallowed, see
          App.tsx's persistAvatar) since they have no User row to save to —
          offering the editor at all was misleading, not just extraneous. */}
      {!isGuest && <AvatarEditorButton onClick={onEditAvatar} variant="sidebar" />}
      <PresenceButton manualStatus={manualStatus} onPick={onPickPresence} open={statusPickerOpen} onToggle={onToggleStatusPicker} variant="sidebar" />

      {/* Ghost mode + Notification Settings — moved here from the meeting
          toolbar (previously HiddenButton/NotificationSettings in App.tsx's
          bottom-center HUD bar) so that bar stays to the 8 core meeting
          controls. Same handlers/state as before, only the render location
          changed. */}
      {canToggleHidden && (
        <Tooltip
          label={hiddenActive ? 'Tampilkan diri' : 'Sembunyikan diri'}
          detail="Sembunyikan dirimu dari tampilan orang lain di peta."
          side="right"
        >
          <SidebarIcon active={hiddenActive} onClick={onToggleHidden}>
            {hiddenActive ? <EyeSlashFill size={14} /> : <EyeFill size={14} />}
          </SidebarIcon>
        </Tooltip>
      )}
      {/* QA (Booking popup close button) — persistent "you have a CEO
          booking" indicator + reopen affordance for its ZoneLockBar notice
          card, which has no other way back once closed (X only hides it,
          see ZoneLockBar.tsx). Same icon (HourglassSplit) the card itself
          uses, so it reads as "that same booking" rather than a new signal. */}
      {hasActiveBooking && (
        <Tooltip label="Booking CEO Aktif" detail={'Buka lagi notifikasi booking "Ngobrol dengan CEO"-mu.'} side="right">
          <SidebarIcon onClick={onReopenBookingNotice}>
            <HourglassSplit size={14} />
          </SidebarIcon>
        </Tooltip>
      )}
      {/* The notification bell (browser-notif + sound toggles) was removed
          here in Tahap 4 — both toggles, plus new per-kind ones, now live in
          Settings' own "Notifikasi" section (see SettingsPanel.tsx), which
          reuses the exact same browserNotifications.ts functions rather than
          duplicating them. */}
      <Tooltip label="Pengaturan" detail="Buka pengaturan akun, notifikasi, dan tampilan." side="right">
        <SidebarIcon onClick={onOpenSettings}>
          <GearFill size={14} />
        </SidebarIcon>
      </Tooltip>

      <Tooltip label="Kembali ke Daftar Room" detail="Keluar dari room ini, kembali ke Lobby." side="right" wrapperClassName="mt-auto">
        <SidebarIcon
          onClick={onLeaveRoom}
          className="text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-800"
        >
          <HouseDoorFill size={14} />
        </SidebarIcon>
      </Tooltip>
      <Tooltip
        label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        detail="Beralih antara tampilan terang dan gelap."
        side="right"
      >
        <SidebarIcon
          onClick={onToggleTheme}
          className="text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-800"
        >
          {theme === 'dark' ? <SunFill size={14} /> : <MoonFill size={14} />}
        </SidebarIcon>
      </Tooltip>
      <Tooltip label="Logout" detail="Keluar dari akunmu." side="right">
        <SidebarIcon onClick={onLogout} className="text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-500">
          <BoxArrowRight size={14} />
        </SidebarIcon>
      </Tooltip>
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
  title?: string;
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
