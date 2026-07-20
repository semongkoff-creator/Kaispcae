import { SERVER_URL } from '@/services/serverUrl';
import { BaseOp, BaseRole } from '@virtualmeet/shared';
import { Field, View, BaseRecord } from './types';

const API = `${SERVER_URL}/api`;

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('vm_token');
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export interface BaseSummary { id: string; name: string; role: BaseRole; updatedAt: string }
export interface BaseMemberDto { userId: string; name: string; email?: string; role: BaseRole }
export interface ServerTable { id: string; name: string; icon?: string; fields: Field[]; views: View[] }
export interface BaseDetail { id: string; name: string; ownerId: string; myRole: BaseRole; tables: ServerTable[]; members: BaseMemberDto[] }
export interface ServerRecord { id: string; tableId: string; cells: BaseRecord['cells']; createdById?: string; updatedById?: string; createdAt: string; updatedAt: string; commentCount?: number }
export interface CommentDto { id: string; authorId: string; authorName: string; body: string; mentions: string[]; parentId?: string; resolved: boolean; createdAt: number }
export interface NotificationDto { id: string; kind: string; body: string; recordId?: string; baseId?: string; read: boolean; createdAt: number }
export interface HistoryDto { id: string; fieldId: string; oldValue: unknown; newValue: unknown; actorId: string; actorName: string; createdAt: number }
export interface ShareLinkDto { token: string; viewId: string; role: BaseRole; hasPassword: boolean; allowCopy: boolean; expiresAt: number | null; lastOpenedAt: number | null; createdAt: number }
export interface SharePayload { baseName: string; role: BaseRole; allowCopy: boolean; table: ServerTable; records: { id: string; cells: BaseRecord['cells'] }[] }

export const baseApi = {
  listBases: () => req<{ bases: BaseSummary[] }>('GET', '/bases'),
  // A new base is always EMPTY (blank starter table, no sample content).
  createBase: (name: string) => req<{ id: string; name: string }>('POST', '/bases', { name }),
  getBase: (baseId: string) => req<BaseDetail>('GET', `/bases/${baseId}`),
  renameBase: (baseId: string, name: string) => req<{ id: string; name: string }>('PATCH', `/bases/${baseId}`, { name }),
  getRecords: (baseId: string, tableId?: string) => req<{ records: ServerRecord[] }>('GET', `/bases/${baseId}/records${tableId ? `?tableId=${tableId}` : ''}`),
  mutate: (baseId: string, ops: BaseOp[], clientId: string) => req<{ applied: BaseOp[]; rejected: { op: BaseOp; reason: string }[] }>('POST', `/bases/${baseId}/mutations`, { ops, clientId }),
  getMembers: (baseId: string) => req<{ members: BaseMemberDto[] }>('GET', `/bases/${baseId}/members`),
  addMember: (baseId: string, email: string, role: BaseRole) => req<{ userId: string; role: BaseRole }>('POST', `/bases/${baseId}/members`, { email, role }),
  updateMember: (baseId: string, userId: string, role: BaseRole) => req<{ userId: string; role: BaseRole }>('PATCH', `/bases/${baseId}/members/${userId}`, { role }),
  removeMember: (baseId: string, userId: string) => req<{ success: boolean }>('DELETE', `/bases/${baseId}/members/${userId}`),
  transfer: (baseId: string, toUserId: string) => req<{ success: boolean; ownerId: string }>('POST', `/bases/${baseId}/transfer`, { toUserId }),

  // comments + notifications (Fase B-1)
  getComments: (recordId: string) => req<{ comments: CommentDto[] }>('GET', `/records/${recordId}/comments`),
  addComment: (recordId: string, body: string, mentions: string[], parentId?: string) => req<CommentDto>('POST', `/records/${recordId}/comments`, { body, mentions, parentId }),
  editComment: (id: string, patch: { body?: string; resolved?: boolean }) => req<{ success: boolean }>('PATCH', `/comments/${id}`, patch),
  deleteComment: (id: string) => req<{ success: boolean }>('DELETE', `/comments/${id}`),
  getHistory: (recordId: string) => req<{ history: HistoryDto[] }>('GET', `/records/${recordId}/history`),
  getNotifications: () => req<{ notifications: NotificationDto[] }>('GET', '/notifications'),
  markNotifRead: (id?: string) => req<{ success: boolean }>('POST', '/notifications/read', id ? { id } : {}),

  // share links (Fase B-3)
  createShareLink: (baseId: string, opts: { viewId: string; role: BaseRole; expiresAt?: number; password?: string; allowCopy?: boolean }) => req<{ token: string }>('POST', `/bases/${baseId}/share-links`, opts),
  listShareLinks: (baseId: string) => req<{ links: ShareLinkDto[] }>('GET', `/bases/${baseId}/share-links`),
  revokeShareLink: (token: string) => req<{ success: boolean }>('DELETE', `/share-links/${token}`),
};

// Public share viewer — no auth. Returns the payload, or throws an Error with
// `.status` (404 revoked, 410 expired) / `.code` ('password_required'|'password_wrong').
export async function openShare(token: string, password?: string): Promise<SharePayload> {
  const q = password ? `?password=${encodeURIComponent(password)}` : '';
  const res = await fetch(`${API}/share/${token}${q}`);
  if (!res.ok) {
    let code = ''; let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); code = j.error || ''; msg = j.error || msg; } catch { /* ignore */ }
    const err = new Error(msg) as Error & { status?: number; code?: string };
    err.status = res.status; err.code = code;
    throw err;
  }
  return res.json() as Promise<SharePayload>;
}

// Public form submission (no auth) — one submit = one new record. The server
// only accepts cells for fields the form actually asks for.
export async function submitShareForm(token: string, cells: Record<string, unknown>, password?: string): Promise<void> {
  const res = await fetch(`${API}/share/${token}/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cells, password }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
}
