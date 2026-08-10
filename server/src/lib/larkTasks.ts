import { getConfig } from '../config';
import { getTenantToken, LARK_OPENAPI_BASE } from './larkToken';

// A7 — Daily Task, backed DIRECTLY by a Lark Base (Bitable) table (no Postgres
// copy). The table IS the source of truth: every read queries Lark, every write
// posts to Lark. All calls use the bot's tenant token (the app already has
// bitable access to this base — verified). Field names/formats were confirmed
// empirically against the live table:
//   Task           Text            string
//   Workstream     SingleSelect    option-name string
//   Priority       SingleSelect    option-name string
//   Status         SingleSelect    option-name string
//   Notes          Text            string
//   Due Date       DateTime        epoch ms (number)
//   Owner          User            [{ id: open_id, name, ... }]
//   Related Project Link           [{ record_ids:[..], text_arr:[..] }] (write: [record_id])
// Every function throws on failure; the route layer turns that into a clear
// error for the widget (never a silent-empty).

export interface DailyTask {
  recordId: string;
  task: string;
  workstream: string | null;
  priority: string | null;
  status: string | null;
  notes: string | null;
  dueDate: number | null;
  project: { recordId: string; name: string } | null;
  // Productivity Analytics — the Owner field's open_id(s), needed to resolve
  // each task to a local User (via User.larkOpenId) for
  // TaskCompletionSnapshot. Not used by the existing Daily Task widget,
  // which already knows its own caller's open_id going in.
  ownerOpenIds: string[];
}

export interface TaskOptions {
  workstream: string[];
  priority: string[];
  status: string[];
  projects: { recordId: string; name: string }[];
}

export interface CreateTaskInput {
  task: string;
  workstream?: string;
  priority?: string;
  status?: string;
  notes?: string;
  dueDate?: number;
  projectRecordId?: string;
}

function ids() {
  const c = getConfig();
  return { app: c.LARK_TASK_APP_TOKEN, table: c.LARK_TASK_TABLE_ID, project: c.LARK_TASK_PROJECT_TABLE_ID };
}

async function token(): Promise<string> {
  const t = await getTenantToken();
  if (!t) throw new Error('lark-unavailable');
  return t;
}

// Bitable Text fields usually come back as a plain string, but can be segment
// arrays ([{ text, type }]) — collapse both to a string.
function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((s: any) => s?.text ?? '').join('');
  return '';
}

function mapRecord(r: any): DailyTask {
  const f = r.fields ?? {};
  const link = Array.isArray(f['Related Project']) ? f['Related Project'][0] : null;
  const project = link?.record_ids?.[0]
    ? { recordId: link.record_ids[0], name: link.text_arr?.[0] ?? link.text ?? '' }
    : null;
  return {
    recordId: r.record_id,
    task: asText(f.Task),
    workstream: typeof f.Workstream === 'string' ? f.Workstream : null,
    priority: typeof f.Priority === 'string' ? f.Priority : null,
    status: typeof f.Status === 'string' ? f.Status : null,
    notes: asText(f.Notes) || null,
    dueDate: typeof f['Due Date'] === 'number' ? f['Due Date'] : null,
    project,
    ownerOpenIds: Array.isArray(f.Owner) ? f.Owner.map((o: any) => o?.id).filter(Boolean) : [],
  };
}

// Today's tasks OWNED by this user. Due Date is filtered by Lark's search API
// (server-side "is Today"); the Owner (User field) match is done here since the
// day's result set is small — keeps us off unverified User-field filter syntax.
export async function listTodayTasks(ownerOpenId: string): Promise<DailyTask[]> {
  const t = await token();
  const { app, table } = ids();
  const res = await fetch(
    `${LARK_OPENAPI_BASE}/bitable/v1/apps/${app}/tables/${table}/records/search?page_size=200`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: { conjunction: 'and', conditions: [{ field_name: 'Due Date', operator: 'is', value: ['Today'] }] },
      }),
    },
  );
  const j: any = await res.json();
  if (j.code !== 0) throw new Error(`lark-search-failed:${j.code}:${j.msg}`);
  const raw: any[] = j.data?.items ?? [];
  return raw
    .filter((r) => Array.isArray(r.fields?.Owner) && r.fields.Owner.some((o: any) => o?.id === ownerOpenId))
    .map(mapRecord);
}

// Productivity Analytics — company-wide, NOT scoped to one owner (unlike
// listTodayTasks above). No date-range filter is sent to Lark's search API —
// listTodayTasks's own comment already explains why this codebase stays off
// unverified filter syntax (the User-field Owner match); a Due-Date-range
// operator was never confirmed against the live Base either, so filtering
// happens locally instead. Paginated (listTodayTasks never needed to be —
// "Today" is always a small slice; a full-range query over a busy Base can
// exceed one page).
// Hard ceiling on pagination — 50 pages * 200/page = 10,000 records is far
// beyond any real Daily Task board at this company's scale. A genuine
// runaway (a buggy/looping page_token from Lark's side, however unlikely)
// stops here instead of growing `all` and this function's caller
// (analyticsSweep.ts's every-15-minute sync) unbounded.
const MAX_PAGES = 50;

export async function listTasksInRange(startMs: number, endMs: number): Promise<DailyTask[]> {
  const t = await token();
  const { app, table } = ids();
  const all: any[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const res = await fetch(
      `${LARK_OPENAPI_BASE}/bitable/v1/apps/${app}/tables/${table}/records/search?page_size=200`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(pageToken ? { page_token: pageToken } : {}),
      },
    );
    const j: any = await res.json();
    if (j.code !== 0) throw new Error(`lark-search-failed:${j.code}:${j.msg}`);
    all.push(...(j.data?.items ?? []));
    pages += 1;
    pageToken = j.data?.has_more ? j.data?.page_token : undefined;
    if (pageToken && pages >= MAX_PAGES) {
      console.warn(`[larkTasks] listTasksInRange hit the ${MAX_PAGES}-page cap — truncating, results may be incomplete`);
      break;
    }
  } while (pageToken);

  return all
    .map(mapRecord)
    .filter((task) => typeof task.dueDate === 'number' && task.dueDate >= startMs && task.dueDate <= endMs);
}

export async function getTaskOptions(): Promise<TaskOptions> {
  const t = await token();
  const { app, table, project } = ids();

  const fr = await fetch(`${LARK_OPENAPI_BASE}/bitable/v1/apps/${app}/tables/${table}/fields?page_size=100`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  const fj: any = await fr.json();
  if (fj.code !== 0) throw new Error(`lark-fields-failed:${fj.code}:${fj.msg}`);
  const optionsOf = (name: string): string[] =>
    (fj.data?.items?.find((f: any) => f.field_name === name)?.property?.options ?? []).map((o: any) => o.name);

  const pr = await fetch(`${LARK_OPENAPI_BASE}/bitable/v1/apps/${app}/tables/${project}/records?page_size=200`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  const pj: any = await pr.json();
  if (pj.code !== 0) throw new Error(`lark-projects-failed:${pj.code}:${pj.msg}`);
  const projects = (pj.data?.items ?? [])
    .map((r: any) => ({ recordId: r.record_id, name: asText(r.fields?.['Name project']) || asText(r.fields?.['Project ID / Code']) }))
    .filter((p: any) => p.name);

  return {
    workstream: optionsOf('Workstream'),
    priority: optionsOf('Priority'),
    status: optionsOf('Status'),
    projects,
  };
}

export async function createTask(input: CreateTaskInput, ownerOpenId: string): Promise<DailyTask> {
  const t = await token();
  const { app, table } = ids();
  const fields: Record<string, unknown> = { Task: input.task };
  if (input.workstream) fields.Workstream = input.workstream;
  if (input.priority) fields.Priority = input.priority;
  if (input.status) fields.Status = input.status;
  if (input.notes) fields.Notes = input.notes;
  if (typeof input.dueDate === 'number') fields['Due Date'] = input.dueDate;
  if (input.projectRecordId) fields['Related Project'] = [input.projectRecordId];
  if (ownerOpenId) fields.Owner = [{ id: ownerOpenId }];

  const res = await fetch(`${LARK_OPENAPI_BASE}/bitable/v1/apps/${app}/tables/${table}/records`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  const j: any = await res.json();
  if (j.code !== 0) throw new Error(`lark-create-failed:${j.code}:${j.msg}`);
  return mapRecord(j.data.record);
}

export async function updateTaskStatus(recordId: string, status: string): Promise<void> {
  const t = await token();
  const { app, table } = ids();
  const res = await fetch(`${LARK_OPENAPI_BASE}/bitable/v1/apps/${app}/tables/${table}/records/${recordId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { Status: status } }),
  });
  const j: any = await res.json();
  if (j.code !== 0) throw new Error(`lark-update-failed:${j.code}:${j.msg}`);
}
