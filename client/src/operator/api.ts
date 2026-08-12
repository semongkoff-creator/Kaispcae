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

export interface OperatorOrgAdmin {
  displayName: string;
  email: string;
}

export interface OperatorOrganization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  admins: OperatorOrgAdmin[];
}

export const operatorApi = {
  getOrganizations: () => req<{ organizations: OperatorOrganization[] }>('/operator/organizations'),
};
