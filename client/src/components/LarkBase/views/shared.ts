import type { BaseRole } from '@virtualmeet/shared';
import { Table, View, Field, BaseRecord, CellValue, FieldType } from '../types';

// Mutations a view can perform, each of which builds + dispatches an Op
// through the single server-backed pipeline (see viewMutations.ts). Names
// mirror the old in-memory helpers so view call-sites stay tiny.
export interface ViewMutations {
  setCell: (recordId: string, fieldId: string, value: CellValue) => void;
  addRecord: (cells?: Record<string, CellValue>) => void;
  deleteRecords: (ids: Set<string>) => void;
  changeFieldType: (field: Field, patch: Partial<Field>) => void;
  insertField: (atIndex: number, type?: FieldType) => void;
  deleteField: (fieldId: string) => void;
  setFieldWidth: (fieldId: string, width: number) => void;
  addOption: (fieldId: string, name: string) => string;
  addView: (view: View) => void;
  updateView: (viewId: string, patch: Partial<View>) => void;
  deleteView: (viewId: string) => void;
}

export interface ViewProps {
  table: Table;
  view: View;
  fields: Field[];
  visibleFields: Field[];
  rows: BaseRecord[];
  m: ViewMutations;
  canEdit: boolean; // editor+; views HIDE edit affordances when false
  myRole?: BaseRole; // for per-field read-only checks (see canEditField)
  members?: { userId: string; name: string }[]; // person-field picker + avatars
  commentCounts?: Record<string, number>; // recordId → comment count (badge)
  openRecord: (recordId: string) => void;
  patchView: (patch: Partial<View>) => void;
  onCursor?: (recordId: string, fieldId: string) => void; // presence
}

export type { CellValue };
