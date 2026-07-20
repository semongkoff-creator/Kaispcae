import { BaseOp } from '@virtualmeet/shared';
import { Field, SELECT_COLOR_KEYS, uid } from './types';
import { op } from './opsClient';
import { ViewMutations } from './views/shared';

// Builds the per-table mutations bridge handed to views. Each call constructs
// an Op and dispatches it (optimistic local apply + server POST live in the
// store's dispatch). `tableFields()` reads the current field list so option
// adds and type changes compute against fresh state.
export function makeViewMutations(
  tableId: string,
  dispatch: (ops: BaseOp | BaseOp[]) => void,
  tableFields: () => Field[],
): ViewMutations {
  return {
    setCell: (recordId, fieldId, value) => dispatch(op.setCell(tableId, recordId, fieldId, value)),
    addRecord: (cells = {}) => dispatch(op.addRecord(tableId, cells)),
    deleteRecords: (ids) => dispatch([...ids].map((id) => op.deleteRecord(tableId, id))),
    changeFieldType: (field, patch) => dispatch(op.updateField(tableId, field.id, patch)),
    insertField: (atIndex, type = 'text') => {
      const field: Field = { id: uid('fld'), name: 'Kolom baru', type, width: 160, options: type === 'select' || type === 'multiSelect' ? [] : undefined, formula: type === 'formula' ? '' : undefined };
      dispatch(op.addField(tableId, field, atIndex));
    },
    deleteField: (fieldId) => dispatch(op.deleteField(tableId, fieldId)),
    setFieldWidth: (fieldId, width) => dispatch(op.updateField(tableId, fieldId, { width: Math.max(80, Math.round(width)) })),
    addOption: (fieldId, name) => {
      const optionId = uid('opt');
      const field = tableFields().find((f) => f.id === fieldId);
      const existing = field?.options ?? [];
      const options = [...existing, { id: optionId, name, color: SELECT_COLOR_KEYS[existing.length % SELECT_COLOR_KEYS.length] }];
      dispatch(op.updateField(tableId, fieldId, { options }));
      return optionId;
    },
    addView: (view) => dispatch(op.addView(tableId, view)),
    updateView: (viewId, patch) => dispatch(op.updateView(tableId, viewId, patch)),
    deleteView: (viewId) => dispatch(op.deleteView(tableId, viewId)),
  };
}
