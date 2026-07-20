// The one mutation vocabulary for Lark Base. The client applies these
// optimistically and POSTs them to /api/bases/:id/mutations; the server
// re-checks permissions, applies them (per-cell last-write-wins), and
// re-broadcasts them over WS; incoming WS ops re-enter the client through the
// exact same reducer. One shape, one path — no side doors.

export type BaseCellValue = string | number | boolean | string[] | null;

export type BaseOp =
  | { type: 'setCell'; tableId: string; recordId: string; fieldId: string; value: BaseCellValue; at: number }
  | { type: 'addRecord'; tableId: string; recordId: string; cells?: Record<string, BaseCellValue>; orderIndex?: number; at: number }
  | { type: 'deleteRecord'; tableId: string; recordId: string; at: number }
  | { type: 'addField'; tableId: string; field: unknown; index?: number; at: number }
  | { type: 'updateField'; tableId: string; fieldId: string; patch: Record<string, unknown>; at: number }
  | { type: 'deleteField'; tableId: string; fieldId: string; at: number }
  | { type: 'addView'; tableId: string; view: unknown; at: number }
  | { type: 'updateView'; tableId: string; viewId: string; patch: Record<string, unknown>; at: number }
  | { type: 'deleteView'; tableId: string; viewId: string; at: number }
  | { type: 'addTable'; table: unknown; at: number }
  | { type: 'deleteTable'; tableId: string; at: number };

export type BaseOpType = BaseOp['type'];

// Which permission action each op requires (server enforces; client hides UI).
import type { BaseAction } from './basePermissions';
export const OP_ACTION: Record<BaseOpType, BaseAction> = {
  setCell: 'record:update',
  addRecord: 'record:create',
  deleteRecord: 'record:delete',
  addField: 'field:create',
  updateField: 'field:update',
  deleteField: 'field:delete',
  addView: 'view:create',
  updateView: 'view:editConfig',
  deleteView: 'view:editConfig',
  addTable: 'field:create', // creating a table is an editor-level structural change
  deleteTable: 'field:delete',
};

export interface MutationRequest { ops: BaseOp[]; clientId: string }
export interface WsOpsMessage { type: 'ops'; ops: BaseOp[]; byUserId: string }
export interface WsPresenceMessage { type: 'presence'; users: PresenceUser[] }
export interface PresenceUser { userId: string; name: string; viewId?: string; cursor?: { recordId: string; fieldId: string } }
