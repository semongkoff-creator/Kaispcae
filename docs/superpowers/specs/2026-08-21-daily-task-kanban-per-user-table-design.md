# Daily Task Kanban View + Per-User Lark Base Table — Design

## Goal

Daily Task currently has one view (a vertical checklist) and pulls from a single, organization-wide Lark Base table. Add a second view — a Kanban board — and let a user optionally bind their OWN Lark Base table (a different app/table than the org default) to Daily Task, since in this organization work is split across many teams/systems (comparable to separate modules in an ERP like Odoo), each often tracking tasks in its own Lark Base table rather than one shared one.

## Context

Direct codebase checks (not assumptions) found:

- **Daily Task today**: `client/src/components/ui/DailyTaskPanel.tsx`, opened as a full-screen overlay from `App.tsx`. It's a vertical checklist (not an actual grid) with an inline "Add Task" form. No view-mode toggle exists anywhere in the client.
- **No local `Task` table.** `server/src/routes/tasks.ts` is a thin bridge; the Lark Base Bitable table is the sole source of truth for every read/write, via `server/src/lib/larkTasks.ts`.
- **Per-org, not per-user, table binding today.** `larkTasks.ts`'s `ids()` resolves one `app_token`/`table_id` pair per organization (an admin sets this once for the whole org via Integrasi). Every task function resolves through this.
- **Per-user filtering already exists, but only for "today."** `listTodayTasks(ownerOpenId, organizationId)` queries Lark's `/records/search` filtered server-side by "Due Date is Today," then filters client-side by matching the `Owner` field's open_id against the caller's own `larkOpenId`. There's no existing "all of my tasks, any date" function — `listTasksInRange` exists but is org-wide (unfiltered by owner), used only by the analytics sweep.
- **`User.larkOpenId` is the existing user↔Lark binding** (`schema.prisma`, `@unique`) — routes already 409 with `no-lark` if it's unset, and the client already shows a "connect Lark" prompt in that case. This design reuses that mechanism unchanged.
- **No Kanban/board UI or drag-and-drop library exists anywhere in this codebase.** This is being built from scratch.

## Scope (confirmed with user)

- The per-user table override is **App Token + Table ID together** (not just a table ID) — a user's own binding can point at an entirely different Lark Base (workspace), not just a different table within the org's existing Base.
- **Fallback**: a user who has never set their own App Token/Table ID keeps using the org-wide default table — nothing changes for them.
- **Where it's configured**: a small "Hubungkan tabel saya" affordance inside `DailyTaskPanel` itself opens a form to paste App Token + Table ID — not a separate Settings page.
- **Kanban scope**: shows ALL of the user's own tasks (not date-restricted), unlike the existing List view which stays scoped to today only.
- **Kanban columns**: derived dynamically from whatever Status options exist in the resolved table (the same options source the List view's dropdowns already use) — not manually nameable/reorderable columns.
- **Drag-and-drop writes through**: moving a card to a different column immediately updates that task's Status in Lark Base (same effect as the List view's existing checkbox/status controls).
- **Add Task from Kanban too**: the same task-creation form is also reachable from the Kanban view (as a modal), not List-view-only.
- **View toggle (List ↔ Kanban) is manual and NOT persisted** — it resets to List every time the panel is opened. (Flagged during design review; the user did not ask for it to be remembered, and this keeps the first version simpler — easy to revisit later if it turns out people want it remembered.)
- **Drag-and-drop implementation**: `@hello-pangea/dnd` (a maintained fork of `react-beautiful-dnd`) — chosen over a hand-rolled native-HTML5-drag-events implementation for touch/mobile reliability and to avoid re-solving well-known drag-and-drop edge cases from scratch.

## Design

### Data model

Two new nullable columns on `User`, additive, same shape/spirit as `avatarConfig`/`roomDisplayName`:

```prisma
model User {
  // ...
  larkTaskAppToken String?
  larkTaskTableId  String?
  // ...
}
```

Both null or both set — never one without the other (enforced at the save endpoint, not the schema). No backfill; existing accounts get `NULL` and keep using the org default until they set their own.

### Server (`server/src/lib/larkTasks.ts`)

- `ids(organizationId)` (or its equivalent internal resolution point) is widened so every task function can accept an optional `{ appToken, tableId }` override, checked first; falls back to the existing per-org resolution when the override is absent. This keeps every existing call site (analytics sweep, org-wide `listTasksInRange`) untouched — they simply never pass an override.
- New function: list ALL of a user's own tasks, any due date — same Owner-open_id-filter-after-fetch posture `listTodayTasks` already uses, just without the "Due Date is Today" search constraint.
- `routes/tasks.ts`'s existing handlers (`GET /tasks/today`, `GET /tasks/options`, `POST /tasks`, `PATCH /tasks/:recordId`) each resolve the requesting user's `larkTaskAppToken`/`larkTaskTableId` (if set) and pass them through as the override — transparent to the client, which keeps calling the same endpoints it already does.
- New route: `GET /tasks/all` (or equivalent) for the Kanban view's full task list.
- New route: save/validate the user's own App Token + Table ID. Validation performs a real Lark API call against the given ids (e.g., resolving field/option metadata) before persisting — a wrong or inaccessible id is rejected with a clear error, never silently stored.

### Client

- `DailyTaskPanel.tsx` gains local view-mode state (`'list' | 'kanban'`, default `'list'`, not persisted) and a toggle control.
- New component for the Kanban board: columns built from the current table's Status options (fetched via the same options mechanism the List view's dropdowns use, so it naturally reflects whichever table — org default or the user's own — is active), each column populated by grouping the "all tasks" fetch by Status. Built with `@hello-pangea/dnd`'s `DragDropContext`/`Droppable`/`Draggable`.
- Dropping a card into a different column: optimistic move in the UI, paired with a call to the existing task-update endpoint carrying the new Status. On failure, the card reverts to its original column and an error is shown — never left showing a state that didn't actually get written to Lark Base.
- "+ Tambah Task" reachable from the Kanban view too, opening the existing add-task form as a modal; the new task lands in whichever column matches its Status once created.
- "Hubungkan tabel saya": a small link/button inside `DailyTaskPanel` opening a two-field form (App Token, Table ID) + Save, calling the new save/validate endpoint.

## Error handling

- Saving an invalid/inaccessible App Token or Table ID: rejected with a clear error before anything is persisted (validated against Lark's own API first).
- A previously-saved table becoming invalid later (table deleted, access revoked): Daily Task fetches fail gracefully with a clear error message, not a crash — pointing the user back to the "Hubungkan tabel saya" form to fix it.
- A drag-and-drop status update that fails (network blip, Lark API error): the card reverts to its original column; the write is never assumed to have succeeded client-side without confirmation.
- No `larkOpenId` at all: unchanged — the existing "connect Lark" prompt/409 `no-lark` behavior still applies before any of the above is reachable.

## Out of scope

- Manually nameable/reorderable Kanban columns — columns always mirror the resolved table's actual Status options.
- Per-room or per-team shared table bindings — this is a single override per USER account, not a group-level setting.
- Persisting which view (List/Kanban) was last used — resets to List on every panel open.
- Any change to the existing "today" List view's own scope/behavior, or to the org-wide default table mechanism (`isDailyTaskAvailable`, Integrasi's admin-set Bitable config) — both stay exactly as they are today for anyone who hasn't set a personal override.
