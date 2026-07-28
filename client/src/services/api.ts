import { TeleportLocation, OwnerBookmark, Recording, RoomTemplateId, Channel, ChannelMessage, DirectConversationSummary, WorkspaceRole } from '@virtualmeet/shared';

const API_BASE = '/api';

// Thrown for non-2xx HTTP responses — carries the status code so callers can
// tell "the server said no" (bad credentials, expired token) apart from a
// plain network failure (offline, server down), where fetch() itself throws
// a status-less TypeError instead. useAuth.ts uses this distinction to only
// show "session expired" for an actual 401/403/404, not a network blip.
// A12 — today's Lark attendance status for the current user.
export interface AttendanceStatus {
  isLarkUser: boolean;
  checkedIn: boolean;
  checkInTime: number | null; // epoch seconds
  checkedOut: boolean;
  checkOutTime: number | null;
  totalHours: number | null;
}

// A5 — a recorded meeting (Lark VC) for the Meeting History panel.
export interface LarkChatSummary {
  chatId: string;
  name: string;
}

// A7 — Daily Task (backed by a Lark Base table).
export interface DailyTask {
  recordId: string;
  task: string;
  workstream: string | null;
  priority: string | null;
  status: string | null;
  notes: string | null;
  dueDate: number | null;
  project: { recordId: string; name: string } | null;
}

export interface TaskOptions {
  workstream: string[];
  priority: string[];
  status: string[];
  projects: { recordId: string; name: string }[];
}

export interface CreateTaskBody {
  task: string;
  workstream?: string;
  priority?: string;
  status?: string;
  notes?: string;
  dueDate?: number;
  projectRecordId?: string;
}

export interface MomRecord {
  id: string;
  roomId: string;
  zoneId: string;
  startedBy: string;
  startTime: string;
  endTime: string | null;
  larkMeetingNo: string | null;
  recordingStatus: string;
  recordingUrl: string | null;
  summary: string | null;
}

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
  // Global, account-level role (see shared/permissions.ts's AccountRole) —
  // 'admin' accounts can create rooms; everyone else can only join existing
  // ones (see routes/rooms.ts's POST /rooms gate).
  accountRole?: 'admin' | 'user';
  // Workspace (organisation) role — a SEPARATE layer from accountRole above:
  // this one gates /admin and every /api/admin/* route. See
  // shared/workspacePermissions.ts. Cosmetic on the client; the server
  // re-checks it from the DB on every request.
  workspaceRole?: WorkspaceRole;
  // IANA zone, e.g. "Asia/Jakarta". Times are stored UTC and rendered here.
  timezone?: string;
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
  // Zoom-style meeting lock (in-memory, see server roomHandler.isRoomLocked) —
  // drives the 🔒 badge on the Lobby room card.
  locked?: boolean;
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

  // Lark OAuth: swap the single-use code the callback put in the URL for the
  // real JWT (kept out of the URL on purpose). The token is then stored and
  // used exactly like a manual-login token — see useAuth.
  exchangeLarkCode: (code: string) =>
    request<{ token: string }>('/auth/lark/exchange', { method: 'POST', body: JSON.stringify({ code }) }),

  // Clears the HttpOnly upload-session cookie server-side — JS can't touch it
  // itself. Not routed through request(): the server answers 204 with no
  // body, which res.json() would choke on.
  logout: () => fetch(`${API_BASE}/auth/logout`, { method: 'POST' }),

  // ── Profile photo (chat avatar) — stored base64-in-DB, see
  // server/src/routes/users.ts. The photo is a data-URL the caller has already
  // resized+compressed (see utils/processProfilePhoto.ts).
  uploadProfilePhoto: (photo: string) =>
    request<{ ok: true }>('/users/me/profile-photo', { method: 'PUT', body: JSON.stringify({ photo }) }),
  deleteProfilePhoto: () =>
    request<{ ok: true }>('/users/me/profile-photo', { method: 'DELETE' }),
  // Batch — one call for every sender currently in view, never per-message
  // (that would be an N+1 on scrollback).
  getProfilePhotos: (ids: string[]) =>
    request<{ photos: { id: string; photo: string }[] }>(
      `/users/profile-photos?ids=${encodeURIComponent(ids.join(','))}`,
    ),

  // A12 — Lark attendance status (source of truth = Lark) + checkout.
  getAttendanceStatus: () => request<AttendanceStatus>('/attendance/status'),
  checkOutAttendance: () => request<AttendanceStatus>('/attendance/checkout', { method: 'POST' }),

  // A5 — recorded meetings (Lark VC).
  startMeeting: (roomId: string, zoneId: string) =>
    request<{ momRecordId: string; url: string; meetingNo: string }>('/meeting/start', { method: 'POST', body: JSON.stringify({ roomId, zoneId }) }),
  endMeeting: (momRecordId: string) =>
    request<{ ok: boolean; recordingStatus?: string }>('/meeting/end', { method: 'POST', body: JSON.stringify({ momRecordId }) }),
  getMeetingHistory: (roomId: string) =>
    request<{ meetings: MomRecord[] }>(`/meeting/history?roomId=${encodeURIComponent(roomId)}`),

  // Bagian 4 — Lark ↔ MeetKai chat sync mapping (room admins only).
  getLarkChatMap: (slug: string) =>
    request<{ map: { chatId: string; chatName: string | null } | null; chats: LarkChatSummary[] }>(
      `/rooms/${slug}/lark-map`,
    ),
  setLarkChatMap: (slug: string, chatId: string | null, chatName?: string | null) =>
    request<{ map: { chatId: string; chatName: string | null } | null }>(`/rooms/${slug}/lark-map`, {
      method: 'PUT',
      body: JSON.stringify({ chatId, chatName }),
    }),

  // A7 — Daily Task (reads/writes the Lark Base table directly).
  getTodayTasks: () => request<{ tasks: DailyTask[] }>('/tasks/today'),
  getTaskOptions: () => request<TaskOptions>('/tasks/options'),
  createTask: (body: CreateTaskBody) => request<{ task: DailyTask }>('/tasks', { method: 'POST', body: JSON.stringify(body) }),
  updateTaskStatus: (recordId: string, status: string) =>
    request<{ ok: boolean }>(`/tasks/${encodeURIComponent(recordId)}`, { method: 'PATCH', body: JSON.stringify({ status }) }),

  getRooms: () => request<{ rooms: RoomInfo[] }>('/rooms'),

  // ── Room join approval (see server/src/lib/roomMembership.ts) ──────
  // What the client checks BEFORE trying to enter: a room that requires
  // approval denies the socket join outright, so walking in and discovering
  // that from a denial event would flash a broken room first.
  getMembership: (slug: string) =>
    request<{ allowed: boolean; reason: string; requiresApproval: boolean }>(`/rooms/${slug}/membership`),

  requestJoin: (slug: string) =>
    request<{ status: 'active' | 'pending' | 'rejected' }>(`/rooms/${slug}/join-request`, { method: 'POST' }),

  getJoinRequests: (slug: string) =>
    request<{ requests: { userId: string; displayName: string; email: string; requestedAt: number }[] }>(
      `/rooms/${slug}/join-requests`,
    ),

  // Room members + group participants — the "add to group like WhatsApp"
  // flow: pick from people already approved into the room.
  getRoomMembers: (slug: string) =>
    request<{ members: { id: string; displayName: string; email: string; role: string }[] }>(`/rooms/${slug}/members`),

  getChannelParticipants: (channelId: string) =>
    request<{ participants: { id: string; displayName: string; email: string }[] }>(`/channels/${channelId}/participants`),

  addChannelParticipants: (channelId: string, userIds: string[]) =>
    request<{ added: string[]; rejected: string[] }>(`/channels/${channelId}/participants`, {
      method: 'POST',
      body: JSON.stringify({ userIds }),
    }),

  decideJoinRequest: (slug: string, userId: string, decision: 'approve' | 'reject') =>
    request<{ status: string }>(`/rooms/${slug}/join-requests/${userId}`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),

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

  // Persisted Channel/DM/Thread chat (see server/src/routes/chat.ts). Message
  // *sending* goes over the socket (channelChatHandler.ts) for live delivery —
  // these REST calls are for channel/DM management and loading history.
  getChannels: (slug: string) => request<{ channels: Channel[] }>(`/rooms/${slug}/channels`),

  createChannel: (slug: string, name: string) =>
    request<{ channel: Channel }>(`/rooms/${slug}/channels`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  deleteChannel: (slug: string, channelId: string) =>
    request<{ success: boolean }>(`/rooms/${slug}/channels/${channelId}`, { method: 'DELETE' }),

  getChannelMessages: (slug: string, channelId: string, before?: string) =>
    request<{ messages: ChannelMessage[] }>(
      `/rooms/${slug}/channels/${channelId}/messages${before ? `?before=${before}` : ''}`
    ),

  getReplies: (messageId: string, before?: string) =>
    request<{ replies: ChannelMessage[] }>(`/messages/${messageId}/replies${before ? `?before=${before}` : ''}`),

  getDMs: (slug: string) => request<{ conversations: DirectConversationSummary[] }>(`/rooms/${slug}/dms`),

  startDM: (slug: string, otherUserId: string) =>
    request<{ conversation: DirectConversationSummary }>(`/rooms/${slug}/dms`, {
      method: 'POST',
      body: JSON.stringify({ otherUserId }),
    }),

  getDMMessages: (conversationId: string, before?: string) =>
    request<{ messages: ChannelMessage[] }>(`/dms/${conversationId}/messages${before ? `?before=${before}` : ''}`),
};
