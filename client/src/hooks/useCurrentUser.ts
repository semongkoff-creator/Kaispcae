import { UserProfile } from '@/services/api';
import { WorkspaceAction, WorkspaceRole, canWorkspace } from '@virtualmeet/shared';

// The shared identity shape the suite modules (Base / Calendar / Attendance /
// Docs) read. This app holds the session in App.tsx's useAuth() and passes it
// down by prop — there is no user Context in this repo — so this is a plain
// adapter over that profile rather than a second, competing source of truth.
export interface CurrentUser {
  id: string;
  name: string;
  avatarUrl?: string;
  workspaceRole: WorkspaceRole;
  timezone: string;
}

export function toCurrentUser(user: UserProfile): CurrentUser {
  return {
    id: user.id,
    name: user.displayName,
    workspaceRole: user.workspaceRole ?? 'member',
    // Fall back to the browser's zone if the profile somehow lacks one, so
    // times are never silently rendered in the wrong zone.
    timezone: user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta',
  };
}

// Cosmetic gate for workspace-level UI. The server re-checks every request
// from the DB — this only decides what to render.
export function useCan(user: CurrentUser | null) {
  return (action: WorkspaceAction): boolean => canWorkspace(action, { workspaceRole: user?.workspaceRole });
}
