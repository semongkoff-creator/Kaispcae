import { TeleportLocation, OwnerBookmark, Recording, RoomTemplateId, Channel, ChannelMessage, DirectConversationSummary, WorkspaceRole, LayerData, SoundboardSoundData } from '@virtualmeet/shared';

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

// A9 — leave (Cuti) request via Lark Approval.
export interface LeaveRecord {
  instanceCode: string;
  status: string; // PENDING | APPROVED | REJECTED | CANCELED | ...
  name: string | null;
  start: string | null;
  end: string | null;
  unit: string | null;
  reason: string | null;
  submittedAt: number | null;
}

export interface CreateLeaveBody {
  name: string;
  start: string; // ISO UTC
  end: string; // ISO UTC
  unit: string; // DAY | HALF_DAY | HOUR
  interval: number;
  reason: string;
  timezoneOffset: number;
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
    // Bug 1 — single active session: this token was superseded by a newer
    // login elsewhere. Drop it and broadcast so useAuth can redirect to login
    // with a clear message, from wherever the failing request originated.
    if ((body as any).error === 'SESSION_SUPERSEDED') {
      localStorage.removeItem('vm_token');
      window.dispatchEvent(new CustomEvent('vm-session-superseded', { detail: (body as any).message }));
    }
    throw new ApiError((body as any).error || `Request failed: ${res.status}`, res.status);
  }

  return res.json();
}

// §6 — Add Media (Image/File upload). Separate from request() because it
// must NOT set Content-Type: application/json — the browser needs to set
// its own multipart/form-data boundary for a FormData body.
async function uploadFile(path: string, file: File, roomSlugOverride?: string): Promise<{ url: string; fileName: string }> {
  const token = localStorage.getItem('vm_token');
  const form = new FormData();
  form.append('file', file);
  // A8 — tell the server which room this upload belongs to, so it lands in that
  // room's Lark Drive folder. Prefer an explicit slug (the Room Editor edits a
  // room that may differ from the last one entered); else the last room.
  const roomSlug = roomSlugOverride || localStorage.getItem('vm_last_room_slug');
  if (roomSlug) form.append('roomSlug', roomSlug);
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
  // A8 — route the recording into the room's Lark Drive folder.
  const roomSlug = localStorage.getItem('vm_last_room_slug');
  if (roomSlug) form.append('roomSlug', roomSlug);
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

// Soundboard custom upload — its own function (not uploadFile above) because
// it also needs to send `name`/`durationMs` alongside the file, and posts to
// a per-room endpoint rather than the generic /uploads one (see
// routes/rooms.ts's dedicated multer instance + validation).
async function uploadSoundboardSoundFile(slug: string, file: File, name: string, durationMs: number): Promise<SoundboardSoundData> {
  const token = localStorage.getItem('vm_token');
  const form = new FormData();
  form.append('file', file);
  form.append('name', name);
  form.append('durationMs', String(Math.round(durationMs)));
  const res = await fetch(`${API_BASE}/rooms/${slug}/soundboard`, {
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
  // QA #1/#6 — first-run tutorial gate (App.tsx). Null/undefined = never
  // completed, so a brand-new (or pre-existing, pre-feature) account still
  // sees it once.
  tutorialCompletedAt?: string | null;
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

  // Lark OAuth: swap the single-use code the callback put in the URL for the
  // real JWT (kept out of the URL on purpose). The token is then stored and
  // used exactly like a manual-login token — see useAuth.
  exchangeLarkCode: (code: string) =>
    request<{ token: string }>('/auth/lark/exchange', { method: 'POST', body: JSON.stringify({ code }) }),

  // Clears the HttpOnly upload-session cookie server-side — JS can't touch it
  // itself. Not routed through request(): the server answers 204 with no
  // body, which res.json() would choke on. The token, if still available
  // (see useAuth.ts's logout — it's captured before localStorage is
  // cleared), lets the server also invalidate the session itself, not just
  // the cookie, so a copied/leaked token stops working the instant someone
  // actually logs out.
  logout: (token?: string | null) =>
    fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }),

  // ── Profile photo (chat avatar) — stored base64-in-DB, see
  // server/src/routes/users.ts. The photo is a data-URL the caller has already
  // resized+compressed (see utils/processProfilePhoto.ts).
  uploadProfilePhoto: (photo: string) =>
    request<{ ok: true }>('/users/me/profile-photo', { method: 'PUT', body: JSON.stringify({ photo }) }),
  deleteProfilePhoto: () =>
    request<{ ok: true }>('/users/me/profile-photo', { method: 'DELETE' }),
  // QA #1/#6 — persist first-run tutorial completion so it never shows again.
  markTutorialCompleted: () =>
    request<{ ok: true }>('/users/me/tutorial-completed', { method: 'POST' }),
  // Batch identity lookup — one call for every sender currently in view, never
  // per-message (that would be an N+1 on scrollback). Returns each user's
  // CURRENT displayName + photo so chat renders live identity (Bug 8). `photo`
  // is null when unset (chat falls back to initials).
  getProfiles: (ids: string[]) =>
    request<{ profiles: { id: string; name: string; photo: string | null }[] }>(
      `/users/profile-photos?ids=${encodeURIComponent(ids.join(','))}`,
    ),

  // QA (Presence checklist item #8, "Member list akurat") — full workspace
  // roster (id + name only, active accounts, capped 500 — see
  // server/src/routes/admin.ts's GET /workspace/people). Any authenticated
  // user, not admin-only. The client cross-references this against the
  // live online/room state delivered over the socket (ROSTER_SNAPSHOT/
  // ROSTER_UPDATED) — this REST call alone doesn't know who's online.
  getWorkspacePeople: () => request<{ people: { id: string; displayName: string }[] }>('/workspace/people'),

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

  // A9 — Cuti (leave) via Lark Approval.
  getLeaveOptions: () => request<{ leaveTypes: string[] }>('/leave/options'),
  getMyLeaves: () => request<{ leaves: LeaveRecord[] }>('/leave/mine'),
  createLeave: (body: CreateLeaveBody) => request<{ instanceCode: string }>('/leave', { method: 'POST', body: JSON.stringify(body) }),

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

  // ── "Ngobrol dengan CEO" queue (see server/src/lib/roomQueue.ts) ──
  // `zoneId` absent = a room-level queue; present = scoped to one zone
  // within the room (see server/src/lib/zoneMembership.ts).
  joinQueue: (slug: string, durationMin: number, topic?: string, zoneId?: string) =>
    request<{ status: string; id: string }>(`/rooms/${slug}/queue/join`, {
      method: 'POST',
      body: JSON.stringify({ durationMin, topic, zoneId }),
    }),

  getMyQueueStatus: (slug: string, zoneId?: string) =>
    request<{
      entry: {
        id: string;
        status: 'waiting' | 'called' | 'active';
        durationMin: number;
        position: number | null;
        calledAt: number | null;
        endsAt: number | null;
      } | null;
    }>(`/rooms/${slug}/queue/mine${zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : ''}`),

  cancelQueue: (slug: string, zoneId?: string) =>
    request<{ ok: true }>(`/rooms/${slug}/queue/cancel`, { method: 'POST', body: JSON.stringify({ zoneId }) }),

  // Item 13, "Panic/report user" — see server/src/routes/users.ts's own
  // doc comment. Open to every real member; the server re-checks (not
  // yourself, non-empty reason, rate-limited).
  reportUser: (userId: string, reason: string, roomSlug?: string) =>
    request<{ ok: true }>(`/users/${userId}/report`, { method: 'POST', body: JSON.stringify({ reason, roomSlug }) }),

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

  // ── Guest Link & Ruang Tunggu ────────────────────────────────────
  // Admin-only: mint a room-scoped invite link. Both params optional —
  // omitted means "no expiry" / "unlimited uses" respectively.
  createGuestInvite: (slug: string, opts: { expiresInHours?: number; maxUses?: number }) =>
    request<{ token: string; expiresAt: string | null; maxUses: number | null }>(`/rooms/${slug}/guest-invites`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  revokeGuestInvite: (slug: string, id: string) =>
    request<{ ok: boolean }>(`/rooms/${slug}/guest-invites/${id}`, { method: 'DELETE' }),

  // PUBLIC — no account required. Exchanges an invite token + a display name
  // for a short-lived guest session token (see GuestEntry.tsx). request()
  // still runs fine unauthenticated: it only ever ATTACHES a Bearer header
  // when one happens to be cached, and this route never checks it either way.
  guestJoin: (token: string, name: string) =>
    request<{ token: string; roomSlug: string; roomName: string; name: string }>('/guest/join', {
      method: 'POST',
      body: JSON.stringify({ token, name }),
    }),

  // ZEP Room Editor (opened in its own tab) — admin-gated on the server. Returns
  // the room's stored map as-is (read-only). tilemapData is the raw 2D tile grid
  // (rows of tile objects); the editor normalizes it to RoomTile[][] on the
  // client, same shape the game view uses. 403 → caller isn't a room admin.
  getRoomEditorData: (slug: string) =>
    request<{
      id: string;
      name: string;
      slug: string;
      theme: string;
      // Potong 1 — the new layered format (source of truth once converted).
      // Null only if the room couldn't be proven-lossless converted, in which
      // case the editor falls back to the legacy fields below.
      layerData: LayerData | null;
      tilemapData: unknown[][] | null;
      furniture: unknown[];
      zones: unknown[];
    }>(`/rooms/${slug}/editor-data`),

  // Potong 2/3 — persist layered edits: floor + wall per-tile changes, and
  // full objects/topObjects arrays when they changed. Admin-gated server side;
  // the server broadcasts ROOM_UPDATED so game clients update live.
  saveRoomLayers: (
    slug: string,
    payload: {
      floorChanges?: { x: number; y: number; value: string | null }[];
      // Fitur 15 — paletteId alongside the boolean, only present when a
      // custom wall skin was painted/erased at that tile.
      wallChanges?: { x: number; y: number; value: boolean; paletteId?: string | null }[];
      objects?: unknown[];
      topObjects?: unknown[];
      tileEffects?: unknown[];
      areas?: unknown[];
      customAssets?: unknown[];
      // Resize (Potong 5): full grids + new dimensions.
      width?: number;
      height?: number;
      floor?: (string | null)[][];
      wall?: boolean[][];
      wallPaletteId?: (string | null)[][];
    },
  ) => request<{ ok: true }>(`/rooms/${slug}/editor/layers`, { method: 'PUT', body: JSON.stringify(payload) }),

  createRoom: (name: string, maxPlayers?: number, isPublic?: boolean, theme?: 'modern-interiors' | 'scifi-office', template?: RoomTemplateId) =>
    request<RoomInfo>('/rooms', {
      method: 'POST',
      body: JSON.stringify({ name, maxPlayers, isPublic, theme, template }),
    }),

  saveAvatar: (config: any) =>
    request<{ success: boolean }>('/users/me/avatar', {
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
  uploadMedia: (file: File, roomSlug?: string) => uploadFile('/uploads', file, roomSlug),

  // Potong 6 — media effects authored from the Room Editor (admin-gated REST,
  // reuses the MapMediaObject system + broadcast).
  getRoomMedia: (slug: string) => request<{ mediaObjects: unknown[] }>(`/rooms/${slug}/editor/media`),
  addRoomMedia: (slug: string, body: { type: string; x: number; y: number; payload: unknown }) =>
    request<unknown>(`/rooms/${slug}/editor/media`, { method: 'POST', body: JSON.stringify(body) }),
  deleteRoomMedia: (slug: string, id: string) =>
    request<{ ok: true }>(`/rooms/${slug}/editor/media/${id}`, { method: 'DELETE' }),

  // §7 — Screen Recording.
  uploadRecording: (blob: Blob) => uploadRecordingBlob(blob),

  getRecordings: (slug: string) => request<{ recordings: Recording[] }>(`/rooms/${slug}/recordings`),

  downloadRecording: (id: string, filename: string) => downloadRecordingBlob(id, filename),

  // Soundboard — GET is a fallback/refresh path; the live list normally
  // arrives via SOUNDBOARD_LIST right after room:state (see useSocket.ts).
  getSoundboardSounds: (slug: string) => request<{ sounds: SoundboardSoundData[] }>(`/rooms/${slug}/soundboard`),
  uploadSoundboardSound: (slug: string, file: File, name: string, durationMs: number) =>
    uploadSoundboardSoundFile(slug, file, name, durationMs),
  deleteSoundboardSound: (slug: string, soundId: string) =>
    request<{ success: boolean }>(`/rooms/${slug}/soundboard/${soundId}`, { method: 'DELETE' }),

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
