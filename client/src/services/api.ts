const API_BASE = '/api';

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
    throw new Error((body as any).error || `Request failed: ${res.status}`);
  }

  return res.json();
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

  getMe: () => request<{ user: UserProfile }>('/auth/me'),

  getRooms: () => request<{ rooms: RoomInfo[] }>('/rooms'),

  getRoom: (slug: string) => request<RoomInfo>(`/rooms/${slug}`),

  createRoom: (name: string, maxPlayers?: number, isPublic?: boolean) =>
    request<RoomInfo>('/rooms', {
      method: 'POST',
      body: JSON.stringify({ name, maxPlayers, isPublic }),
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
};
