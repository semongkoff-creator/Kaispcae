import { PrismaClient, Prisma } from '@prisma/client';
import { BaseOp, BaseRole, OP_ACTION, can, canViewField, canEditField, canEditRecord, FieldAccess, RecordEditRule } from '@virtualmeet/shared';

// Applies a batch of ops to a base, enforcing the caller's role per op. Ops
// that fail the permission check are rejected (surfaced to the caller so it
// can 403 / rollback) — never silently dropped. Returns the ops that actually
// applied so the caller can broadcast exactly those over WS.
//
// Per-cell last-write-wins: setCell uses jsonb_set to patch ONE key of the
// record's `cells` JSON, so two people editing two different columns of the
// same row never clobber each other (finish criterion #9).

export interface ApplyResult { applied: BaseOp[]; rejected: { op: BaseOp; reason: string }[] }

export async function applyOps(
  prisma: PrismaClient,
  baseId: string,
  userId: string,
  role: BaseRole,
  ops: BaseOp[],
): Promise<ApplyResult> {
  const applied: BaseOp[] = [];
  const rejected: { op: BaseOp; reason: string }[] = [];

  // All tables belong to this base — validate every op's tableId is in-base
  // so a member of base X can't mutate base Y by guessing ids.
  const tables = await prisma.baseTable.findMany({ where: { baseId }, select: { id: true, fields: true, recordRule: true } });
  const tableIds = new Set(tables.map((t) => t.id));
  // fieldId → access, for per-field write checks (#11).
  const fieldAccess = new Map<string, FieldAccess | undefined>();
  for (const t of tables) for (const f of ((t.fields as unknown as { id: string; access?: FieldAccess }[]) ?? [])) fieldAccess.set(f.id, f.access);
  // tableId → per-record edit rule (7d): "editors may only touch records whose
  // person field is themselves". Owner bypasses; see shared/basePermissions.ts.
  const recordRules = new Map<string, RecordEditRule | undefined>();
  for (const t of tables) recordRules.set(t.id, (t.recordRule as unknown as RecordEditRule | null) ?? undefined);

  for (const op of ops) {
    // View ops need view-specific checks (personal/locked), not just the role
    // gate — e.g. a viewer MAY edit their own personal view.
    const isViewOp = op.type === 'addView' || op.type === 'updateView' || op.type === 'deleteView';
    if (!isViewOp && !can(OP_ACTION[op.type], { role })) { rejected.push({ op, reason: 'forbidden' }); continue; }
    if (isViewOp && !(await canDoViewOp(prisma, op, role, userId))) { rejected.push({ op, reason: 'forbidden' }); continue; }
    const opTableId = op.type === 'addTable' ? undefined : op.tableId;
    if (opTableId && !tableIds.has(opTableId)) { rejected.push({ op, reason: 'table not in base' }); continue; }
    // Per-field permission: a field you can't SEE or can't EDIT can't be written.
    if (op.type === 'setCell') {
      const access = fieldAccess.get(op.fieldId);
      if (!canViewField(access, role) || !canEditField(access, role)) { rejected.push({ op, reason: 'forbidden' }); continue; }
    }
    // Per-record permission (7d). Checked against the cells CURRENTLY IN THE
    // DB, never against anything the client sent — otherwise an editor could
    // claim a record is theirs in the same batch that edits it. For setCell
    // we also block reassigning the ownership field itself away from oneself.
    if (op.type === 'setCell' || op.type === 'deleteRecord') {
      const rule = recordRules.get(op.tableId);
      if (rule) {
        const rec = await prisma.baseRecord.findUnique({ where: { id: op.recordId }, select: { cells: true } });
        const cells = (rec?.cells as Record<string, unknown>) ?? {};
        if (!canEditRecord(rule, role, userId, cells)) { rejected.push({ op, reason: 'forbidden' }); continue; }
      }
    }
    try {
      await applyOne(prisma, baseId, userId, op);
      applied.push(op);
      if (op.type === 'addTable') { const t = op.table as { id?: string }; if (t?.id) tableIds.add(t.id); }
    } catch (e) {
      rejected.push({ op, reason: e instanceof Error ? e.message : 'error' });
    }
  }
  return { applied, rejected };
}

interface StoredView { id: string; mode?: 'collaborative' | 'locked' | 'personal'; ownerId?: string; lockedById?: string }

// Who may create/change/delete a view:
//  personal      → only its owner (any role — a viewer keeps private filters)
//  locked        → the base owner, or whoever locked it
//  collaborative → the normal editor+ gate
async function canDoViewOp(prisma: PrismaClient, op: BaseOp, role: BaseRole, userId: string): Promise<boolean> {
  if (op.type === 'addView') {
    const v = op.view as StoredView;
    return v?.mode === 'personal' ? can('view:createPersonal', { role }) : can('view:create', { role });
  }
  if (op.type !== 'updateView' && op.type !== 'deleteView') return true;
  const { views } = await loadTableJson(prisma, op.tableId);
  const view = (views as StoredView[]).find((v) => v.id === op.viewId);
  if (!view) return can('view:editConfig', { role });
  if (view.mode === 'personal') return view.ownerId === userId;
  if (view.mode === 'locked') return role === 'owner' || view.lockedById === userId;
  return can('view:editConfig', { role });
}

async function loadTableJson(prisma: PrismaClient, tableId: string): Promise<{ fields: any[]; views: any[] }> {
  const t = await prisma.baseTable.findUnique({ where: { id: tableId }, select: { fields: true, views: true } });
  if (!t) throw new Error('table not found');
  return { fields: (t.fields as any[]) ?? [], views: (t.views as any[]) ?? [] };
}

async function applyOne(prisma: PrismaClient, baseId: string, userId: string, op: BaseOp): Promise<void> {
  switch (op.type) {
    case 'setCell': {
      // Read the OLD cell value first (for history), then jsonb_set the new
      // one (per-cell LWW). Not a transaction — the history's "old" is
      // best-effort under concurrency, which is fine for an audit trail.
      const rows = await prisma.$queryRaw<{ old: unknown }[]>`SELECT "cells"->${op.fieldId} AS old FROM "BaseRecord" WHERE "id" = ${op.recordId} AND "tableId" = ${op.tableId}`;
      const oldValue = rows[0]?.old ?? null;
      await prisma.$executeRaw`
        UPDATE "BaseRecord"
        SET "cells" = jsonb_set(COALESCE("cells", '{}'::jsonb), ${'{' + op.fieldId + '}'}::text[], ${JSON.stringify(op.value ?? null)}::jsonb, true),
            "updatedById" = ${userId}, "updatedAt" = now()
        WHERE "id" = ${op.recordId} AND "tableId" = ${op.tableId}`;
      const newValue = op.value ?? null;
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        await prisma.recordHistory.create({
          data: {
            recordId: op.recordId, actorId: userId, fieldId: op.fieldId,
            oldValue: oldValue === null ? Prisma.JsonNull : (oldValue as Prisma.InputJsonValue),
            newValue: newValue === null ? Prisma.JsonNull : (newValue as Prisma.InputJsonValue),
          },
        });
      }
      return;
    }
    case 'addRecord': {
      await prisma.baseRecord.create({
        data: {
          id: op.recordId, tableId: op.tableId,
          cells: (op.cells ?? {}) as Prisma.InputJsonValue,
          orderIndex: op.orderIndex ?? Date.now(),
          createdById: userId, updatedById: userId,
        },
      });
      return;
    }
    case 'deleteRecord': {
      await prisma.baseRecord.deleteMany({ where: { id: op.recordId, tableId: op.tableId } });
      return;
    }
    case 'addField': {
      const { fields, views } = await loadTableJson(prisma, op.tableId);
      const idx = op.index ?? fields.length;
      const next = fields.slice(); next.splice(idx, 0, op.field);
      await prisma.baseTable.update({ where: { id: op.tableId }, data: { fields: next as Prisma.InputJsonValue, views: views as Prisma.InputJsonValue } });
      return;
    }
    case 'updateField': {
      const { fields } = await loadTableJson(prisma, op.tableId);
      const next = fields.map((f) => (f.id === op.fieldId ? { ...f, ...op.patch } : f));
      await prisma.baseTable.update({ where: { id: op.tableId }, data: { fields: next as Prisma.InputJsonValue } });
      return;
    }
    case 'deleteField': {
      const { fields, views } = await loadTableJson(prisma, op.tableId);
      const nextFields = fields.filter((f) => f.id !== op.fieldId);
      const nextViews = views.map((v) => scrubViewRefs(v, op.fieldId));
      await prisma.baseTable.update({ where: { id: op.tableId }, data: { fields: nextFields as Prisma.InputJsonValue, views: nextViews as Prisma.InputJsonValue } });
      return;
    }
    case 'addView': {
      const { views } = await loadTableJson(prisma, op.tableId);
      // A personal view's owner is whoever created it — set server-side so a
      // client can't claim someone else's personal view.
      const incoming = op.view as StoredView;
      const view = incoming?.mode === 'personal' ? { ...incoming, ownerId: userId } : incoming;
      await prisma.baseTable.update({ where: { id: op.tableId }, data: { views: [...views, view] as Prisma.InputJsonValue } });
      return;
    }
    case 'updateView': {
      const { views } = await loadTableJson(prisma, op.tableId);
      // Turning a view personal always binds it to the CALLER — a client
      // can't hand someone else's id in the patch.
      const patch = (op.patch as { mode?: string }).mode === 'personal' ? { ...op.patch, ownerId: userId } : op.patch;
      const next = views.map((v) => (v.id === op.viewId ? { ...v, ...patch } : v));
      await prisma.baseTable.update({ where: { id: op.tableId }, data: { views: next as Prisma.InputJsonValue } });
      return;
    }
    case 'deleteView': {
      const { views } = await loadTableJson(prisma, op.tableId);
      if (views.length <= 1) return; // keep at least one view
      await prisma.baseTable.update({ where: { id: op.tableId }, data: { views: views.filter((v) => v.id !== op.viewId) as Prisma.InputJsonValue } });
      return;
    }
    case 'addTable': {
      const t = op.table as { id: string; name: string; icon?: string; fields: unknown[]; views: unknown[] };
      const count = await prisma.baseTable.count({ where: { baseId } });
      await prisma.baseTable.create({
        data: { id: t.id, baseId, name: t.name, icon: t.icon ?? null, orderIndex: count, fields: t.fields as Prisma.InputJsonValue, views: t.views as Prisma.InputJsonValue },
      });
      return;
    }
    case 'deleteTable': {
      const count = await prisma.baseTable.count({ where: { baseId } });
      if (count <= 1) return; // never leave a base with zero tables
      await prisma.baseTable.delete({ where: { id: op.tableId } });
      return;
    }
  }
}

// Drop a field's references from a view definition (filters/sorts/groupBy/
// hidden/stackField/dateField) — mirrors the client's deleteField cleanup so
// finish criterion #6 holds server-side too.
function scrubViewRefs(v: any, fieldId: string): any {
  return {
    ...v,
    filters: Array.isArray(v.filters) ? v.filters.filter((f: any) => f.fieldId !== fieldId) : [],
    sorts: Array.isArray(v.sorts) ? v.sorts.filter((s: any) => s.fieldId !== fieldId) : [],
    groupBy: v.groupBy === fieldId ? undefined : v.groupBy,
    hidden: Array.isArray(v.hidden) ? v.hidden.filter((h: string) => h !== fieldId) : [],
    stackField: v.stackField === fieldId ? undefined : v.stackField,
    dateField: v.dateField === fieldId ? undefined : v.dateField,
  };
}
