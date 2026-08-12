import { WorkspaceRole } from '@kaispace/shared';

const API_BASE = '/api';

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('vm_token');
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...((options.headers as Record<string, string>) || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Gagal: ${res.status}`);
  }
  return res.json();
}

export interface AdminMember {
  id: string;
  email: string;
  displayName: string;
  workspaceRole: WorkspaceRole;
  timezone: string;
  active: boolean;
  createdAt: string;
  department: { id: string; name: string } | null;
  manager: { id: string; displayName: string } | null;
}

export interface AdminDepartment { id: string; name: string; memberCount: number }

export interface AdminOrgInvite {
  id: string;
  email: string;
  role: string;
  status?: 'pending' | 'accepted' | 'revoked';
  token?: string; // only present on the create response
  expiresAt: string;
  acceptedAt?: string | null;
  createdAt?: string;
}

export interface WorkspacePolicy {
  basePublicLinksAllowed: boolean;
  baseExportAllowed: boolean;
  docsPublicLinksAllowed: boolean;
  docsLinkPasswordRequired: boolean;
  maxShareLinkDays: number | null;
}

export interface AuditEntry {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  meta: Record<string, unknown> | null;
  reason: string | null;
  ip: string | null;
  createdAt: string;
  actor: { id: string; displayName: string };
  targetUser: { id: string; displayName: string } | null;
}

export interface AuditFilter {
  actorId?: string;
  targetUserId?: string;
  action?: string;
  from?: string;
  to?: string;
}

export const adminApi = {
  getMembers: () => req<{ members: AdminMember[] }>('/admin/members'),

  // Pending room-join requests across the whole workspace (see
  // server/src/routes/roomMembers.ts). Unwrapped to the array here because
  // every caller wants the list, not the envelope.
  listRoomsApproval: () =>
    req<{ rooms: { slug: string; name: string; requiresApproval: boolean; isPublic: boolean; restrictedAccess: boolean; restrictedMinRole: string; queueEnabled: boolean }[] }>('/admin/rooms-approval')
      .then((r) => r.rooms),

  setRoomApproval: (slug: string, requiresApproval: boolean) =>
    req<{ slug: string; requiresApproval: boolean }>(`/rooms/${slug}/approval`, {
      method: 'PATCH',
      body: JSON.stringify({ requiresApproval }),
    }),

  // QA (Akses ruang checklist item 1, "Ruang sensitif terkontrol") — see
  // server/src/routes/roomMembers.ts's own doc comments on each endpoint.
  setRoomRestricted: (slug: string, restrictedAccess: boolean) =>
    req<{ slug: string; restrictedAccess: boolean; restrictedMinRole: string; queueEnabled: boolean }>(`/rooms/${slug}/restricted`, {
      method: 'PATCH',
      body: JSON.stringify({ restrictedAccess }),
    }),

  // "Ngobrol dengan CEO" queue toggle — same endpoint as setRoomRestricted
  // above (see server/src/routes/roomMembers.ts's own comment on why).
  setRoomQueueEnabled: (slug: string, restrictedAccess: boolean, queueEnabled: boolean) =>
    req<{ slug: string; restrictedAccess: boolean; restrictedMinRole: string; queueEnabled: boolean }>(`/rooms/${slug}/restricted`, {
      method: 'PATCH',
      body: JSON.stringify({ restrictedAccess, queueEnabled }),
    }),

  getRoomQueue: (slug: string, zoneId?: string) =>
    req<{
      queueEnabled: boolean;
      entries: {
        id: string; userId: string; name: string; topic: string | null; durationMin: number;
        status: 'waiting' | 'called' | 'active'; mode: 'quick' | 'booking';
        bookingStart: number | null; bookingEnd: number | null;
        requestedAt: number; calledAt: number | null; endsAt: number | null;
      }[];
    }>(`/rooms/${slug}/queue${zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : ''}`),

  skipQueueEntry: (slug: string, entryId: string) =>
    req<{ ok: true }>(`/rooms/${slug}/queue/${entryId}/skip`, { method: 'POST' }),

  approveQueueEntry: (slug: string, entryId: string) =>
    req<{ ok: true }>(`/rooms/${slug}/queue/${entryId}/approve`, { method: 'POST' }),

  // "Ngobrol dengan CEO" queue, zone-level (see server/src/lib/zoneMembership.ts)
  // — "ruang CEO" turned out to be a zone inside the shared office, not a
  // separate Room, so restricting it is configured per-zone rather than via
  // setRoomRestricted above.
  getZoneRestrictions: (slug: string) =>
    req<{
      zones: { id: string; name: string }[];
      restrictions: { zoneId: string; minRole: string; queueEnabled: boolean; bookingMode: boolean }[];
    }>(`/rooms/${slug}/zone-restrictions`),

  setZoneRestriction: (slug: string, zoneId: string, patch: { enabled: boolean; minRole?: string; queueEnabled?: boolean; bookingMode?: boolean }) =>
    req<{ ok: true }>(`/rooms/${slug}/zones/${encodeURIComponent(zoneId)}/restriction`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  getRoomAccessList: (slug: string) =>
    req<{ members: { userId: string; displayName: string; email: string; role: string; status: string }[] }>(`/rooms/${slug}/access-list`)
      .then((r) => r.members),

  grantRoomAccess: (slug: string, userId: string, role: 'staff' | 'admin') =>
    req<{ ok: true; userId: string; displayName: string; role: string }>(`/rooms/${slug}/access-grant`, {
      method: 'POST',
      body: JSON.stringify({ userId, role }),
    }),

  revokeRoomAccess: (slug: string, userId: string) =>
    req<{ ok: true }>(`/rooms/${slug}/access-revoke`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  listJoinRequests: () =>
    req<{ requests: { userId: string; displayName: string; email: string; roomSlug: string; roomName: string; requestedAt: number }[] }>(
      '/admin/join-requests',
    ).then((r) => r.requests),
  updateMember: (userId: string, patch: Partial<{ workspaceRole: WorkspaceRole; active: boolean; departmentId: string | null; managerId: string | null }>) =>
    req<Record<string, unknown>>(`/admin/members/${userId}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // Fase 5 (org-resolution) — invite a new member by email; they land in
  // THIS org (not the single default every signup used to hardcode) once
  // they open the link and set a password. No email-sending infra exists
  // in this codebase, so `token` is returned bare and the caller builds a
  // copyable link client-side, same convention as createGuestInvite.
  createOrgInvite: (email: string, role: 'admin' | 'member') =>
    req<AdminOrgInvite>('/admin/org-invites', { method: 'POST', body: JSON.stringify({ email, role }) }),
  getOrgInvites: () => req<{ invites: AdminOrgInvite[] }>('/admin/org-invites').then((r) => r.invites),
  revokeOrgInvite: (id: string) => req<{ ok: boolean }>(`/admin/org-invites/${id}`, { method: 'DELETE' }),

  getDepartments: () => req<{ departments: AdminDepartment[] }>('/admin/departments'),
  createDepartment: (name: string) => req<AdminDepartment>('/admin/departments', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteDepartment: (id: string) => req<{ success: boolean }>(`/admin/departments/${id}`, { method: 'DELETE' }),

  getPolicy: () => req<{ policy: WorkspacePolicy }>('/workspace/policy'),
  updatePolicy: (patch: Partial<WorkspacePolicy>) => req<{ policy: WorkspacePolicy }>('/admin/policy', { method: 'PATCH', body: JSON.stringify(patch) }),

  takeoverBase: (baseId: string, reason: string) =>
    req<{ success: boolean }>(`/admin/bases/${baseId}/takeover`, { method: 'POST', body: JSON.stringify({ reason }) }),

  getAudit: (filter: AuditFilter = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) qs.set(k, v);
    const q = qs.toString();
    return req<{ entries: AuditEntry[]; actions: string[] }>(`/admin/audit${q ? `?${q}` : ''}`);
  },
};
