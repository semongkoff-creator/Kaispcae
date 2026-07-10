import { TeleportLocation, OwnerBookmark, Recording, RoomTemplateId } from '@virtualmeet/shared';

const API_BASE = '/api';

// Thrown for non-2xx HTTP responses — carries the status code so callers can
// tell "the server said no" (bad credentials, expired token) apart from a
// plain network failure (offline, server down), where fetch() itself throws
// a status-less TypeError instead. useAuth.ts uses this distinction to only
// show "session expired" for an actual 401/403/404, not a network blip.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('vm_token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  console.log(`[api] ${options.method || 'GET'} ${API_BASE}${path} → ${res.status}`);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError((body as any).error || `Request failed: ${res.status}`, res.status);
  }

  return res.json();
}

// §6 — Add Media (Image/File upload). Separate from request() because it
// must NOT set Content-Type: application/json — the browser needs to set
// its own multipart/form-data boundary for a FormData body.
async function uploadFile(path: string, file: File): Promise<{ url: string; fileName: string }> {
  const token = localStorage.getItem('vm_token');
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError((body as any).error || `Upload failed: ${res.status}`, res.status);
  }
  return res.json();
}

// §7 — Screen Recording upload, separate endpoint/limit from uploadFile
// above (a recording can be far larger than an ordinary Add Media upload —
// see routes/uploads.ts's dedicated multer instance).
async function uploadRecordingBlob(blob: Blob): Promise<{ url: string }> {
  const token = localStorage.getItem('vm_token');
  const form = new FormData();
  form.append('file', blob, 'recording.webm');
  const res = await fetch(`${API_BASE}/uploads/recording`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError((body as any).error || `Upload failed: ${res.status}`, res.status);
  }
  return res.json();
}

// The download route requires an Authorization header (see
// routes/recordings.ts) to enforce the count/expiry gate against the right
// user — a plain <a href> navigation can't attach that header, so this
// fetches the bytes with the header attached and triggers the save via a
// throwaway object URL instead.
async function downloadRecordingBlob(id: string, filename: string): Promise<void> {
  const token = localStorage.getItem('vm_token');
  const res = await fetch(`${API_BASE}/recordings/${id}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError((body as any).error || `Download failed: ${res.status}`, res.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  avatarConfig?: any;
}

export interface RoomInfo {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  ownerDisplayName: string;
  playerCount: number;
  maxPlayers: number;
  isPublic: boolean;
  createdAt: string;
  theme?: 'modern-interiors' | 'scifi-office';
}

export const api = {
  register: (email: string, password: string, displayName: string) =>
    request<{ user: UserProfile; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    }),

  login: (email: string, password: string) =>
    request<{ user: UserProfile; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  // `token` is only present when the server decided this session is close
  // enough to expiry to hand back a freshly-signed replacement — see
  // server/src/routes/auth.ts and useAuth.ts, which persists it.
  getMe: () => request<{ user: UserProfile; token?: string }>('/auth/me'),

  getRooms: () => request<{ rooms: RoomInfo[] }>('/rooms'),

  getRoom: (slug: string) => request<RoomInfo>(`/rooms/${slug}`),

  createRoom: (name: string, maxPlayers?: number, isPublic?: boolean, theme?: 'modern-interiors' | 'scifi-office', template?: RoomTemplateId) =>
    request<RoomInfo>('/rooms', {
      method: 'POST',
      body: JSON.stringify({ name, maxPlayers, isPublic, theme, template }),
    }),

  saveAvatar: (config: any) =>
    request<{ success: boolean }>('/rooms/users/me/avatar', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  deleteRoom: (slug: string) =>
    request<{ success: boolean }>(`/rooms/${slug}`, {
      method: 'DELETE',
    }),

  // §4.1 — Teleport (Admin), shared team locations, staff+ only (server
  // re-validates independently, this just decides what to show/offer).
  getTeleportLocations: (slug: string) => request<{ locations: TeleportLocation[] }>(`/rooms/${slug}/teleport-locations`),

  addTeleportLocation: (slug: string, name: string, x: number, y: number, icon?: string) =>
    request<{ location: TeleportLocation }>(`/rooms/${slug}/teleport-locations`, {
      method: 'POST',
      body: JSON.stringify({ name, x, y, icon }),
    }),

  deleteTeleportLocation: (slug: string, id: string) =>
    request<{ success: boolean }>(`/rooms/${slug}/teleport-locations/${id}`, { method: 'DELETE' }),

  reorderTeleportLocations: (slug: string, orderedIds: string[]) =>
    request<{ success: boolean }>(`/rooms/${slug}/teleport-locations/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    }),

  // §4.2 — Teleport (Owner), personal bookmarks, owner-only.
  getBookmarks: (slug: string) => request<{ bookmarks: OwnerBookmark[] }>(`/rooms/${slug}/bookmarks`),

  addBookmark: (slug: string, label: string, x: number, y: number) =>
    request<{ bookmark: OwnerBookmark }>(`/rooms/${slug}/bookmarks`, {
      method: 'POST',
      body: JSON.stringify({ label, x, y }),
    }),

  deleteBookmark: (slug: string, id: string) =>
    request<{ success: boolean }>(`/rooms/${slug}/bookmarks/${id}`, { method: 'DELETE' }),

  renameBookmark: (slug: string, id: string, label: string) =>
    request<{ success: boolean }>(`/rooms/${slug}/bookmarks/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ label }),
    }),

  reorderBookmarks: (slug: string, orderedIds: string[]) =>
    request<{ success: boolean }>(`/rooms/${slug}/bookmarks/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    }),

  // §6 — Add Media (Image/File). Returns the url to hand to emitMediaAdd's
  // payload — the actual MapMediaObject row is created over the socket
  // (see mediaHandler.ts), not here; this endpoint only handles the binary.
  uploadMedia: (file: File) => uploadFile('/uploads', file),

  // §7 — Screen Recording.
  uploadRecording: (blob: Blob) => uploadRecordingBlob(blob),

  getRecordings: (slug: string) => request<{ recordings: Recording[] }>(`/rooms/${slug}/recordings`),

  downloadRecording: (id: string, filename: string) => downloadRecordingBlob(id, filename),
};
