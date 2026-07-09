import { ReactNode } from 'react';
import { Tools, GeoAltFill, ImageFill, BoxArrowRight } from 'react-bootstrap-icons';
import { AvatarEditorButton } from '../avatar/AvatarEditorButton';
import { StatusButton } from '../avatar/StatusButton';
import { RecordingControl } from './RecordingControl';
import { ActiveRecordingInfo } from '@/stores/gameStore';

interface SidebarProps {
  onEditAvatar: () => void;
  status: string;
  onSaveStatus: (status: string) => void;

  isAdmin: boolean;
  editorMode: boolean;
  onToggleEditorMode: () => void;

  canTeleport: boolean;
  showTeleportPanel: boolean;
  onToggleTeleport: () => void;

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

  onLogout: () => void;
}

// ZEP-style left icon rail — every room-level feature lives here as one
// icon per row instead of a growing horizontal row of labeled buttons at
// the bottom (which is what this replaces: it was overflowing/wrapping
// once Teleport/Summon/Add Media/Record all landed in the same session).
// Each item's own popover/panel opens to the RIGHT of this rail, never
// above/below it, so they read as "flyouts off the sidebar" consistently
// regardless of which icon triggered them.
export function Sidebar({
  onEditAvatar,
  status,
  onSaveStatus,
  isAdmin,
  editorMode,
  onToggleEditorMode,
  canTeleport,
  showTeleportPanel,
  onToggleTeleport,
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
  onLogout,
}: SidebarProps) {
  return (
    <div className="absolute left-0 top-0 h-full w-14 z-30 bg-white/90 backdrop-blur-sm border-r border-purple-100 shadow-sm flex flex-col items-center py-4 gap-1 pointer-events-auto">
      <AvatarEditorButton onClick={onEditAvatar} variant="sidebar" />
      <StatusButton status={status} onSave={onSaveStatus} variant="sidebar" />

      {isAdmin && (
        <>
          <SidebarDivider />
          <SidebarIcon
            title={editorMode ? 'Editing...' : 'Edit Room'}
            active={editorMode}
            onClick={onToggleEditorMode}
          >
            <Tools size={16} />
          </SidebarIcon>
        </>
      )}

      {canTeleport && <SidebarDivider />}

      {canTeleport && (
        <SidebarIcon title="Teleport" active={showTeleportPanel} onClick={onToggleTeleport}>
          <GeoAltFill size={16} />
        </SidebarIcon>
      )}

      <SidebarDivider />

      <SidebarIcon title="Add Media" active={showAddMediaPanel} onClick={onToggleAddMedia}>
        <ImageFill size={16} />
      </SidebarIcon>

      {canRecord && (
        <>
          <SidebarDivider />
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
        </>
      )}

      <SidebarIcon title="Logout" onClick={onLogout} className="mt-auto text-red-400 hover:bg-red-50 hover:text-red-500">
        <BoxArrowRight size={16} />
      </SidebarIcon>
    </div>
  );
}

function SidebarDivider() {
  return <div className="w-8 border-t border-purple-100 my-1" />;
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
      className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
        className || (active ? 'bg-purple-600 text-white' : 'text-purple-700 hover:bg-purple-50')
      }`}
    >
      {children}
    </button>
  );
}
