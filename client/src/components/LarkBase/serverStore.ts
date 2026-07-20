import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import { SERVER_URL } from '@/services/serverUrl';
import { BaseOp, BaseRole, PresenceUser, WsOpsMessage, WsPresenceMessage } from '@virtualmeet/shared';
import { Table, uid } from './types';
import { baseApi, BaseMemberDto, NotificationDto } from './api';
import { applyOpToTables } from './opsClient';

export type SaveState = 'saved' | 'saving' | 'error' | 'offline';
export interface CurrentUser { id: string; name: string }

interface ServerBaseStore {
  currentUser: CurrentUser | null;
  baseId: string;
  baseName: string;
  ownerId: string;
  myRole: BaseRole | null;
  tables: Table[];
  members: BaseMemberDto[];
  presence: PresenceUser[];
  notifications: NotificationDto[];
  commentCounts: Record<string, number>;
  lastCommentEvent: { recordId: string; at: number } | null;
  activeTableId: string;
  activeViewId: string;
  loading: boolean;
  error: string | null;
  saveState: SaveState;

  loadBase: (baseId: string, user: CurrentUser) => Promise<void>;
  teardown: () => void;
  setActiveTable: (tableId: string) => void;
  setActiveView: (viewId: string) => void;
  dispatch: (input: BaseOp | BaseOp[]) => void;
  ingestRemoteOps: (ops: BaseOp[]) => void;
  setMembers: (m: BaseMemberDto[]) => void;
  refreshMembers: () => Promise<void>;
  renameBase: (name: string) => Promise<void>;
  refreshNotifications: () => Promise<void>;
  markNotifRead: (id?: string) => Promise<void>;
  noteLocalComment: (recordId: string) => void;
  sendCursor: (viewId?: string, recordId?: string, fieldId?: string) => void;
}

// Module-scope handles (not in React state): the WS socket, the offline op
// queue, and flush guards. Kept here so the single store instance owns them.
let socket: Socket | null = null;
let queue: BaseOp[] = [];
let flushing = false;
let onlineHandler: (() => void) | null = null;
const clientId = uid('cli');

function mergeRecords(tables: { id: string; name: string; icon?: string; fields: Table['fields']; views: Table['views'] }[], records: { id: string; tableId: string; cells: Table['records'][number]['cells']; createdById?: string; updatedById?: string; createdAt?: string; updatedAt?: string }[]): Table[] {
  return tables.map((t) => ({
    ...t,
    records: records.filter((r) => r.tableId === t.id).map((r) => ({
      id: r.id, cells: r.cells, createdById: r.createdById, updatedById: r.updatedById,
      createdAt: r.createdAt ? new Date(r.createdAt).getTime() : undefined,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).getTime() : undefined,
    })),
  }));
}

export const useServerBase = create<ServerBaseStore>((set, get) => ({
  currentUser: null,
  baseId: '',
  baseName: '',
  ownerId: '',
  myRole: null,
  tables: [],
  members: [],
  presence: [],
  notifications: [],
  commentCounts: {},
  lastCommentEvent: null,
  activeTableId: '',
  activeViewId: '',
  loading: true,
  error: null,
  saveState: 'saved',

  loadBase: async (baseId, user) => {
    set({ loading: true, error: null, currentUser: user, baseId });
    try {
      const [detail, recs, notif] = await Promise.all([baseApi.getBase(baseId), baseApi.getRecords(baseId), baseApi.getNotifications().catch(() => ({ notifications: [] }))]);
      const tables = mergeRecords(detail.tables, recs.records);
      const commentCounts: Record<string, number> = {};
      for (const r of recs.records) if (r.commentCount) commentCounts[r.id] = r.commentCount;
      const t0 = tables[0];
      set({
        baseName: detail.name, ownerId: detail.ownerId, myRole: detail.myRole, members: detail.members,
        tables, commentCounts, notifications: notif.notifications, activeTableId: t0?.id ?? '', activeViewId: t0?.views[0]?.id ?? '', loading: false, saveState: 'saved',
      });

      // ── realtime ──
      queue = []; flushing = false;
      socket = io(SERVER_URL, { transports: ['websocket', 'polling'], auth: { token: localStorage.getItem('vm_token') || undefined } });
      socket.on('connect', () => socket?.emit('base:join', baseId));
      socket.on('base:ops', (msg: WsOpsMessage) => { if (msg?.ops) get().ingestRemoteOps(msg.ops); });
      socket.on('base:presence', (msg: WsPresenceMessage) => set({ presence: msg.users ?? [] }));
      socket.on('base:notif', () => get().refreshNotifications());
      socket.on('base:renamed', (msg: { name: string }) => { if (msg?.name) set({ baseName: msg.name }); });
      socket.on('base:comment', (msg: { recordId: string }) => {
        if (!msg?.recordId) return;
        set((st) => ({ commentCounts: { ...st.commentCounts, [msg.recordId]: (st.commentCounts[msg.recordId] ?? 0) + 1 }, lastCommentEvent: { recordId: msg.recordId, at: Date.now() } }));
      });

      onlineHandler = () => flush(set, get);
      window.addEventListener('online', onlineHandler);
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Gagal memuat base' });
    }
  },

  teardown: () => {
    if (socket) { try { socket.emit('base:leave', get().baseId); } catch { /* ignore */ } socket.disconnect(); socket = null; }
    if (onlineHandler) { window.removeEventListener('online', onlineHandler); onlineHandler = null; }
    queue = []; flushing = false;
    set({ baseId: '', tables: [], members: [], presence: [], myRole: null, loading: true, error: null, saveState: 'saved' });
  },

  setActiveTable: (tableId) => set((s) => { const t = s.tables.find((x) => x.id === tableId); return { activeTableId: tableId, activeViewId: t?.views[0]?.id ?? '' }; }),
  setActiveView: (viewId) => set({ activeViewId: viewId }),

  dispatch: (input) => {
    const ops = Array.isArray(input) ? input : [input];
    if (ops.length === 0) return;
    // optimistic local apply
    set((s) => ({ tables: ops.reduce(applyOpToTables, s.tables) }));
    queue.push(...ops);
    flush(set, get);
  },

  ingestRemoteOps: (ops) => set((s) => ({ tables: ops.reduce(applyOpToTables, s.tables) })),

  setMembers: (members) => set({ members }),
  refreshMembers: async () => { try { const { members } = await baseApi.getMembers(get().baseId); set({ members }); } catch { /* ignore */ } },
  renameBase: async (name) => {
    const prev = get().baseName;
    set({ baseName: name }); // optimistic
    try { await baseApi.renameBase(get().baseId, name); } catch { set({ baseName: prev }); }
  },
  refreshNotifications: async () => { try { const { notifications } = await baseApi.getNotifications(); set({ notifications }); } catch { /* ignore */ } },
  markNotifRead: async (id) => { try { await baseApi.markNotifRead(id); set((st) => ({ notifications: st.notifications.map((n) => (!id || n.id === id ? { ...n, read: true } : n)) })); } catch { /* ignore */ } },
  noteLocalComment: (recordId) => set((st) => ({ commentCounts: { ...st.commentCounts, [recordId]: (st.commentCounts[recordId] ?? 0) + 1 } })),

  sendCursor: (viewId, recordId, fieldId) => socket?.emit('base:cursor', { baseId: get().baseId, viewId, recordId, fieldId }),
}));

// Drain the offline queue to the server. Optimistic writes already landed
// locally; on rejection we reconcile by reloading authoritative state, on
// network error we requeue and wait for reconnect/online.
function flush(set: (partial: Partial<ServerBaseStore>) => void, get: () => ServerBaseStore): void {
  if (flushing || queue.length === 0) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) { set({ saveState: 'offline' }); return; }
  const batch = queue; queue = []; flushing = true;
  set({ saveState: 'saving' });
  baseApi.mutate(get().baseId, batch, clientId)
    .then(async ({ rejected }) => {
      flushing = false;
      if (rejected && rejected.length) {
        // Server refused some ops → our optimistic state is now wrong; pull
        // the authoritative records/tables back.
        set({ saveState: 'error' });
        try {
          const [detail, recs] = await Promise.all([baseApi.getBase(get().baseId), baseApi.getRecords(get().baseId)]);
          set({ tables: mergeRecords(detail.tables, recs.records), myRole: detail.myRole });
        } catch { /* ignore */ }
      } else {
        set({ saveState: 'saved' });
      }
      if (queue.length) flush(set, get);
    })
    .catch(() => {
      flushing = false;
      queue = [...batch, ...queue]; // requeue for retry
      set({ saveState: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error' });
    });
}
