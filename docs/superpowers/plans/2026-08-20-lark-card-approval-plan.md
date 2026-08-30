# Lark Interactive Card Approval for Leave Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain-text Lark DM admins get when a leave/izin request is submitted with an interactive Lark card carrying real Acc/Tolak buttons, so a click runs the exact same decide logic KaiSpace's in-app approval already uses — never touching Lark's native Cuti/Approval feature.

**Architecture:** A new per-org HTTP endpoint (`POST /api/lark/card-callback/:organizationId`) receives Lark's card-button-click callback via the SDK's `CardActionHandler`/`adaptExpress` (a genuinely separate transport from `larkWs.ts`'s existing persistent-connection event stream, which cannot carry this event type — see the approved design spec). The existing `POST /attendance/leaves/:id/decide` route's logic is extracted into a shared `decideLeaveRequest()` function so both entry points run identical approve/reject logic. Two new nullable `OrgIntegration` columns hold the per-org Lark app's Verification Token / Encrypt Key needed to validate the callback.

**Tech Stack:** Express, Prisma, `@larksuiteoapi/node-sdk` (`CardActionHandler`, `adaptExpress`, `InteractiveCard`).

## Global Constraints

- The existing `larkWs.ts` WS channel and its `im.message.receive_v1` handling must NOT be touched — this feature adds a wholly separate HTTP endpoint.
- The new `POST /api/lark/card-callback/:organizationId` route resolves org directly from the URL path (no ambiguity, no trying multiple orgs' tokens).
- `decideLeaveRequest` must be extracted so both the existing HTTP decide route and the new card callback handler call the identical logic (no behavior change to the existing route, same response shape).
- The new `sendLeaveApprovalCard` function fully REPLACES the existing `sendUserDm` call in the leave-create route's admin fan-out (nothing sends both card and plain text).
- `canDecide` per-recipient excludes the requester themselves even if they're an admin (card sent without buttons in that case).
- After a decide, the clicked card re-renders in place showing the result (no separate "update message" API call, per the SDK's response-based card update).
- A stale second click hits the existing 409 "sudah diproses" guard, and the response card must show the real current state, never a generic OK.
- The 2 new `OrgIntegration` columns (`larkVerificationToken`, `larkEncryptKey`) are nullable, added via hand-authored SQL migration (no local Postgres access this session).
- No new admin UI for these 2 fields in this iteration — they're set via direct DB write, documented as a manual step, not built as a UI task in this plan.
- This session has no working local dev server — `npm run typecheck --workspace=server` after every task is the verification gate. Live smoke-testing (a real Lark button click) can only happen after deploy AND after the room admin manually configures the org's Lark Console callback URL — see "Manual Testing After Deploy" at the end of this plan.

---

## File Structure

- `server/prisma/schema.prisma` + a new migration — 2 new nullable columns on `OrgIntegration`.
- `server/src/routes/attendanceAdmin.ts` — extract `decideLeaveRequest()` (exported) out of the existing decide route; the route becomes a thin wrapper. Leave-create route's admin fan-out swaps `sendUserDm` for `sendLeaveApprovalCard`.
- `server/src/lib/larkIm.ts` — new `sendLeaveApprovalCard()`, `buildLeaveApprovalCard()`, `buildLeaveResultCard()`, `LeaveApprovalCardInput` interface.
- `server/src/routes/larkCardCallback.ts` (new) — the card-button-click HTTP endpoint.
- `server/src/index.ts` — mount the new route.

---

### Task 1: OrgIntegration schema — add larkVerificationToken/larkEncryptKey

**Files:**
- Modify: `server/prisma/schema.prisma:376-399` (the `OrgIntegration` model)
- Create: `server/prisma/migrations/20260820120000_add_org_integration_lark_card/migration.sql`

**Interfaces:**
- Produces: `OrgIntegration.larkVerificationToken: string | null`, `OrgIntegration.larkEncryptKey: string | null` (nullable columns, consumed by Task 4).

- [ ] **Step 1: Edit the OrgIntegration model**

Current (`server/prisma/schema.prisma:376-399`):

```prisma
model OrgIntegration {
  organizationId  String
  provider        String // 'lark' | 'google'
  clientId        String?
  clientSecretEnc String?
  redirectUri     String?
  connectedAt     DateTime?
  connectedBy     String?
  // Daily Task's Lark Base (Bitable) source — provider='lark' only, both
  // required together (Bitable's own API needs the Base's app_token AND a
  // specific table_id within it, see lib/larkTasks.ts's ids()). Not a
  // secret (Lark Base access is already gated by the same app credentials
  // above), so no encryption needed. NULL means "use this org's env-var
  // default" for org_kaitech_default only, or "Daily Task unavailable" for
  // any other org, mirroring clientId/clientSecretEnc's own env-fallback-
  // for-the-default-org-only convention.
  bitableAppToken String?
  bitableTableId  String?
  updatedAt       DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@id([organizationId, provider])
}
```

Replace with:

```prisma
model OrgIntegration {
  organizationId  String
  provider        String // 'lark' | 'google'
  clientId        String?
  clientSecretEnc String?
  redirectUri     String?
  connectedAt     DateTime?
  connectedBy     String?
  // Daily Task's Lark Base (Bitable) source — provider='lark' only, both
  // required together (Bitable's own API needs the Base's app_token AND a
  // specific table_id within it, see lib/larkTasks.ts's ids()). Not a
  // secret (Lark Base access is already gated by the same app credentials
  // above), so no encryption needed. NULL means "use this org's env-var
  // default" for org_kaitech_default only, or "Daily Task unavailable" for
  // any other org, mirroring clientId/clientSecretEnc's own env-fallback-
  // for-the-default-org-only convention.
  bitableAppToken String?
  bitableTableId  String?
  // Lark card-button-click callback (specs/2026-08-20-lark-card-approval-
  // design.md) — provider='lark' only. Every Lark app already has these
  // generated in its own Console (Credentials & Security Settings); they
  // are copied in here, not newly created. Not routed through the
  // clientSecretEnc encryption helper: unlike the app secret, these values
  // only ever validate an inbound webhook signature, and there is no
  // admin UI to submit them yet (see routes/larkCardCallback.ts's doc
  // comment) — set via a direct DB write. NULL means the callback route
  // rejects requests for that org (feature simply off).
  larkVerificationToken String?
  larkEncryptKey        String?
  updatedAt       DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@id([organizationId, provider])
}
```

- [ ] **Step 2: Write the migration**

Create `server/prisma/migrations/20260820120000_add_org_integration_lark_card/migration.sql`:

```sql
-- Lark card-button-click callback credentials, per org (see
-- specs/2026-08-20-lark-card-approval-design.md). Nullable, no backfill:
-- every org simply has NULL (callback route stays off for that org) until
-- someone copies the values from that org's own Lark App Console.

ALTER TABLE "OrgIntegration" ADD COLUMN "larkVerificationToken" TEXT;
ALTER TABLE "OrgIntegration" ADD COLUMN "larkEncryptKey" TEXT;
```

- [ ] **Step 3: Regenerate the Prisma client and typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS (the client regenerates from the updated schema as part of `prisma generate`, normally wired into the server's `postinstall`/`typecheck` script already used by this repo's other schema-change tasks this session — if `npm run typecheck --workspace=server` doesn't pick up the new fields, run `npx prisma generate --schema=server/prisma/schema.prisma` first, then re-run typecheck).

- [ ] **Step 4: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260820120000_add_org_integration_lark_card
git commit -m "feat: add larkVerificationToken/larkEncryptKey to OrgIntegration"
```

---

### Task 2: Extract decideLeaveRequest shared function

**Files:**
- Modify: `server/src/routes/attendanceAdmin.ts:378-422` (the `canApprove` helper and the `POST /attendance/leaves/:id/decide` route)

**Interfaces:**
- Consumes: nothing new (uses existing `getPrisma`, `writeAudit`, `clientIp`, already imported in this file).
- Produces: `export type DecideLeaveOutcome = { ok: true; leave: Leave; typeName: string } | { ok: false; status: number; error: string }` and `export async function decideLeaveRequest(prisma: ReturnType<typeof getPrisma>, params: { leaveId: string; organizationId: string; approverId: string; decision: 'approved' | 'rejected'; note?: string | null; ip?: string | null }): Promise<DecideLeaveOutcome>` from `server/src/routes/attendanceAdmin.ts` — consumed by Task 4.

- [ ] **Step 1: Add the Leave type import**

Modify the top of `server/src/routes/attendanceAdmin.ts` — current imports (lines 1-9):

```ts
import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { ShiftDef, computeTotals, finalStatus, canViewAttendanceOf } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireWorkspace, resolveWorkspaceRole } from '../lib/workspace';
import { writeAudit, clientIp } from '../lib/audit';
import { rateLimit } from '../middleware/rateLimit';
import { findUserInOrg, findShiftInOrg, findLeaveTypeInOrg } from '../lib/orgScope';
import { sendUserDm } from '../lib/larkIm';
```

Replace with:

```ts
import { Router, Response } from 'express';
import type { Leave } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { ShiftDef, computeTotals, finalStatus, canViewAttendanceOf } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireWorkspace, resolveWorkspaceRole } from '../lib/workspace';
import { writeAudit, clientIp } from '../lib/audit';
import { rateLimit } from '../middleware/rateLimit';
import { findUserInOrg, findShiftInOrg, findLeaveTypeInOrg } from '../lib/orgScope';
import { sendUserDm } from '../lib/larkIm';
```

(Only the `Leave` type import is added here. The `sendUserDm` → `sendLeaveApprovalCard` swap on this same import line is Task 3's job, at its own Step 1 — this task's `sendUserDm` import stays unused-but-present in between, which is fine since Task 3 lands right after and removes it; keeping this task's diff scoped only to what it needs means Task 2 typechecks cleanly on its own.)

- [ ] **Step 2: Replace canApprove + the decide route with the extracted function**

Current (`server/src/routes/attendanceAdmin.ts:378-422`):

```ts
// Approve/reject — admin OR the requester's direct manager.
async function canApprove(prisma: ReturnType<typeof getPrisma>, approverId: string, subjectId: string): Promise<boolean> {
  const role = await resolveWorkspaceRole(prisma, approverId);
  if (role === 'admin') return true;
  const subject = await prisma.user.findUnique({ where: { id: subjectId }, select: { managerId: true } });
  return subject?.managerId === approverId;
}

aa.post('/attendance/leaves/:id/decide', authenticateToken, mutationLimit, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    // Multi-tenant Fase 2 — Leave has no organizationId of its own, but
    // userId is a real relation to User (which does); a wrong-org leave
    // reads as "not found". (WorkspaceRole itself isn't org-scoped yet —
    // that's Fase 3 — but this at least stops an admin from touching a
    // stranger-org leave regardless of how they got gated in.)
    const leave = await prisma.leave.findUnique({
      where: { id: req.params.id },
      include: { type: true, user: { select: { organizationId: true } } },
    });
    if (!leave || leave.user.organizationId !== req.organizationId) return res.status(404).json({ error: 'Pengajuan tidak ditemukan' });
    // Two admins racing to decide the same request — the second one in
    // loses with a clear 409 instead of silently overwriting the first
    // decision (approverId/decidedAt/status all get clobbered otherwise).
    if (leave.status !== 'pending') return res.status(409).json({ error: 'Pengajuan ini sudah diproses sebelumnya' });
    if (leave.userId === req.userId) return res.status(403).json({ error: 'Tidak boleh menyetujui pengajuanmu sendiri' });
    if (!(await canApprove(prisma, req.userId!, leave.userId))) return res.status(403).json({ error: 'Kamu bukan approver untuk orang ini' });
    const status = req.body?.status === 'approved' ? 'approved' : req.body?.status === 'rejected' ? 'rejected' : null;
    if (!status) return res.status(400).json({ error: 'Status tidak valid' });

    const updated = await prisma.leave.update({
      where: { id: leave.id },
      data: { status, approverId: req.userId!, decidedAt: new Date(), decisionNote: req.body?.note ? String(req.body.note).slice(0, 300) : null },
    });
    await writeAudit(prisma, {
      actorId: req.userId!, action: 'attendance:approve', targetType: 'leave', targetId: leave.id,
      targetUserId: leave.userId, meta: { before: { status: leave.status }, after: { status } }, ip: clientIp(req),
    });
    await prisma.notification.create({
      data: { recipientId: leave.userId, kind: 'workspace', body: `Pengajuan ${leave.type.name} kamu ${status === 'approved' ? 'disetujui' : 'ditolak'}.` },
    });
    return res.json({ leave: updated });
  } catch (err) { console.error('[attendance] decide leave error:', err); return res.status(500).json({ error: 'Gagal memutuskan' }); }
});
```

Replace with:

```ts
// Approve/reject — admin OR the requester's direct manager.
async function canApprove(prisma: ReturnType<typeof getPrisma>, approverId: string, subjectId: string): Promise<boolean> {
  const role = await resolveWorkspaceRole(prisma, approverId);
  if (role === 'admin') return true;
  const subject = await prisma.user.findUnique({ where: { id: subjectId }, select: { managerId: true } });
  return subject?.managerId === approverId;
}

// Shared decide logic — called by BOTH the HTTP route below AND the Lark
// card-button callback (routes/larkCardCallback.ts), so a click in Lark
// and a click in KaiSpace's own member list run the exact same checks and
// can never drift apart. All the validation/side-effects the HTTP route
// used to inline live here now; the route becomes a thin wrapper that maps
// this result onto an HTTP response.
export type DecideLeaveOutcome =
  | { ok: true; leave: Leave; typeName: string }
  | { ok: false; status: number; error: string };

export async function decideLeaveRequest(
  prisma: ReturnType<typeof getPrisma>,
  params: {
    leaveId: string;
    organizationId: string;
    approverId: string;
    decision: 'approved' | 'rejected';
    note?: string | null;
    ip?: string | null;
  },
): Promise<DecideLeaveOutcome> {
  // Multi-tenant Fase 2 — Leave has no organizationId of its own, but
  // userId is a real relation to User (which does); a wrong-org leave
  // reads as "not found".
  const leave = await prisma.leave.findUnique({
    where: { id: params.leaveId },
    include: { type: true, user: { select: { organizationId: true } } },
  });
  if (!leave || leave.user.organizationId !== params.organizationId) {
    return { ok: false, status: 404, error: 'Pengajuan tidak ditemukan' };
  }
  // Two admins (or an admin + a Lark card click) racing to decide the same
  // request — the second one in loses with a clear 409 instead of silently
  // overwriting the first decision.
  if (leave.status !== 'pending') {
    return { ok: false, status: 409, error: 'Pengajuan ini sudah diproses sebelumnya' };
  }
  if (leave.userId === params.approverId) {
    return { ok: false, status: 403, error: 'Tidak boleh menyetujui pengajuanmu sendiri' };
  }
  if (!(await canApprove(prisma, params.approverId, leave.userId))) {
    return { ok: false, status: 403, error: 'Kamu bukan approver untuk orang ini' };
  }

  const updated = await prisma.leave.update({
    where: { id: leave.id },
    data: {
      status: params.decision,
      approverId: params.approverId,
      decidedAt: new Date(),
      decisionNote: params.note ? String(params.note).slice(0, 300) : null,
    },
  });
  await writeAudit(prisma, {
    actorId: params.approverId, action: 'attendance:approve', targetType: 'leave', targetId: leave.id,
    targetUserId: leave.userId, meta: { before: { status: leave.status }, after: { status: params.decision } }, ip: params.ip ?? null,
  });
  await prisma.notification.create({
    data: { recipientId: leave.userId, kind: 'workspace', body: `Pengajuan ${leave.type.name} kamu ${params.decision === 'approved' ? 'disetujui' : 'ditolak'}.` },
  });
  return { ok: true, leave: updated, typeName: leave.type.name };
}

aa.post('/attendance/leaves/:id/decide', authenticateToken, mutationLimit, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const status = req.body?.status === 'approved' ? 'approved' : req.body?.status === 'rejected' ? 'rejected' : null;
    if (!status) return res.status(400).json({ error: 'Status tidak valid' });
    const result = await decideLeaveRequest(prisma, {
      leaveId: req.params.id,
      organizationId: req.organizationId,
      approverId: req.userId!,
      decision: status,
      note: req.body?.note,
      ip: clientIp(req),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ leave: result.leave });
  } catch (err) { console.error('[attendance] decide leave error:', err); return res.status(500).json({ error: 'Gagal memutuskan' }); }
});
```

Note: this route's response shape is unchanged — `{ leave: <updated row> }` on success, `{ error: <message> }` with the same status codes (404/409/403/400) on failure — so nothing that calls this route (the in-app Acc/Tolak buttons) needs any change.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/attendanceAdmin.ts
git commit -m "refactor: extract decideLeaveRequest from the leave decide route"
```

---

### Task 3: sendLeaveApprovalCard + card builders in larkIm.ts, wire into leave-create fan-out

**Files:**
- Modify: `server/src/lib/larkIm.ts` (add imports + 3 new exports)
- Modify: `server/src/routes/attendanceAdmin.ts:264-278` (the Lark DM fan-out inside `POST /attendance/leaves`)

**Interfaces:**
- Consumes: nothing from Tasks 1/2.
- Produces (from `server/src/lib/larkIm.ts`): `export interface LeaveApprovalCardInput { leaveId: string; requesterName: string; typeName: string; rangeLabel: string; reason: string; canDecide: boolean }`, `export function buildLeaveApprovalCard(input: LeaveApprovalCardInput): Lark.InteractiveCard`, `export function buildLeaveResultCard(input: { requesterName: string; typeName: string; rangeLabel: string; reason: string; status: 'approved' | 'rejected'; approverName: string }): Lark.InteractiveCard`, `export async function sendLeaveApprovalCard(openId: string, input: LeaveApprovalCardInput, organizationId: string): Promise<string | null>` — `buildLeaveApprovalCard` and `buildLeaveResultCard` are consumed directly by Task 4.

- [ ] **Step 1: Add the SDK import to larkIm.ts**

Current (`server/src/lib/larkIm.ts:1`):

```ts
import { getTenantToken, LARK_OPENAPI_BASE } from './larkToken';
```

Replace with:

```ts
import * as Lark from '@larksuiteoapi/node-sdk';
import { getTenantToken, LARK_OPENAPI_BASE } from './larkToken';
```

- [ ] **Step 2: Append the card builders and sendLeaveApprovalCard**

Add this at the end of `server/src/lib/larkIm.ts` (after the existing `getUserName` function):

```ts
// Leave-approval interactive card (specs/2026-08-20-lark-card-approval-
// design.md) — replaces the old plain-text sendUserDm notification for
// leave requests entirely. msg_type 'interactive' instead of 'text'.
// Buttons (when canDecide) encode {leaveId, decision} in their value, read
// back by the card callback handler (routes/larkCardCallback.ts) to run
// the same decide logic as KaiSpace's own in-app Acc/Tolak buttons.
export interface LeaveApprovalCardInput {
  leaveId: string;
  requesterName: string;
  typeName: string;
  rangeLabel: string;
  reason: string;
  canDecide: boolean;
}

export function buildLeaveApprovalCard(input: LeaveApprovalCardInput): Lark.InteractiveCard {
  const elements: Lark.InteractiveCardElement[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**Pengaju:** ${input.requesterName}\n**Jenis:** ${input.typeName}\n**Tanggal:** ${input.rangeLabel}\n**Alasan:** ${input.reason}`,
      },
    },
  ];
  // No buttons for the requester's own copy, even if they're an admin —
  // mirrors the in-app member list's own canDecide gating.
  if (input.canDecide) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Acc' },
          type: 'primary',
          value: { leaveId: input.leaveId, decision: 'approved' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Tolak' },
          type: 'danger',
          value: { leaveId: input.leaveId, decision: 'rejected' },
        },
      ],
    });
  }
  return {
    header: { title: { tag: 'plain_text', content: 'Pengajuan Cuti/Izin' }, template: 'orange' },
    elements,
  };
}

// The card the callback handler returns in place of the clicked card — the
// SDK sends whatever the handler returns back as the new message content,
// no separate "update message" API call needed. Also used to show a stale
// second click's REAL current state instead of a generic error.
export function buildLeaveResultCard(input: {
  requesterName: string;
  typeName: string;
  rangeLabel: string;
  reason: string;
  status: 'approved' | 'rejected';
  approverName: string;
}): Lark.InteractiveCard {
  const verb = input.status === 'approved' ? 'Disetujui' : 'Ditolak';
  const emoji = input.status === 'approved' ? '✅' : '❌';
  return {
    header: {
      title: { tag: 'plain_text', content: 'Pengajuan Cuti/Izin' },
      template: input.status === 'approved' ? 'green' : 'red',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**Pengaju:** ${input.requesterName}\n**Jenis:** ${input.typeName}\n**Tanggal:** ${input.rangeLabel}\n**Alasan:** ${input.reason}\n\n${emoji} **${verb} oleh ${input.approverName}**`,
        },
      },
    ],
  };
}

// Proactive 1:1 card DM to a specific admin, AS THE BOT — same
// receive_id_type=open_id shape as sendUserDm, just msg_type 'interactive'
// with a JSON card body instead of 'text'. Null-graceful like every other
// function here.
export async function sendLeaveApprovalCard(openId: string, input: LeaveApprovalCardInput, organizationId: string): Promise<string | null> {
  const token = await getTenantToken(organizationId);
  if (!token) return null;
  try {
    const res = await fetch(`${LARK_OPENAPI_BASE}/im/v1/messages?receive_id_type=open_id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: 'interactive',
        content: JSON.stringify(buildLeaveApprovalCard(input)),
      }),
    });
    const j: any = await res.json();
    if (j?.code !== 0) {
      console.error('[larkIm] sendLeaveApprovalCard failed:', j?.code, j?.msg);
      return null;
    }
    return j?.data?.message_id ?? null;
  } catch (e) {
    console.error('[larkIm] sendLeaveApprovalCard error:', e);
    return null;
  }
}
```

- [ ] **Step 3: Swap the leave-create route's fan-out**

Current (`server/src/routes/attendanceAdmin.ts:264-278`):

```ts
      // Per the room admin — the Lark DM always goes to EVERY workspace
      // admin, independent of `approvers` above (which is just the
      // manager when one is set). Fire-and-forget: never blocks/fails
      // leave creation; an admin with no larkOpenId linked is silently
      // excluded by the where clause itself, not caught after the fact.
      const larkAdmins = await prisma.user.findMany({
        where: { workspaceRole: 'admin', active: true, organizationId: req.organizationId, larkOpenId: { not: null } },
        select: { larkOpenId: true },
      });
      const fmt = (d: Date) => d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric' });
      const rangeLabel = startDate.getTime() === endDate.getTime() ? fmt(startDate) : `${fmt(startDate)} - ${fmt(endDate)}`;
      for (const a of larkAdmins) {
        void sendUserDm(a.larkOpenId!, `${me?.displayName ?? 'Seseorang'} mengajukan ${type.name} (${rangeLabel}). Buka MeetKai untuk approve/tolak.`, req.organizationId);
      }
```

Replace with:

```ts
      // Per the room admin — the Lark card always goes to EVERY workspace
      // admin, independent of `approvers` above (which is just the
      // manager when one is set). Fire-and-forget: never blocks/fails
      // leave creation; an admin with no larkOpenId linked is silently
      // excluded by the where clause itself, not caught after the fact.
      // canDecide excludes the requester themselves even if they're an
      // admin — that admin's own copy renders with no Acc/Tolak buttons.
      const larkAdmins = await prisma.user.findMany({
        where: { workspaceRole: 'admin', active: true, organizationId: req.organizationId, larkOpenId: { not: null } },
        select: { id: true, larkOpenId: true },
      });
      const fmt = (d: Date) => d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric' });
      const rangeLabel = startDate.getTime() === endDate.getTime() ? fmt(startDate) : `${fmt(startDate)} - ${fmt(endDate)}`;
      for (const a of larkAdmins) {
        void sendLeaveApprovalCard(a.larkOpenId!, {
          leaveId: leave.id,
          requesterName: me?.displayName ?? 'Seseorang',
          typeName: type.name,
          rangeLabel,
          reason,
          canDecide: a.id !== req.userId!,
        }, req.organizationId);
      }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/larkIm.ts server/src/routes/attendanceAdmin.ts
git commit -m "feat: send leave requests to admins as interactive Lark cards"
```

---

### Task 4: Card callback route + mount it

**Files:**
- Create: `server/src/routes/larkCardCallback.ts`
- Modify: `server/src/index.ts:41,280` (import + mount)

**Interfaces:**
- Consumes: `decideLeaveRequest`, `DecideLeaveOutcome` (Task 2, from `../routes/attendanceAdmin`); `buildLeaveApprovalCard`, `buildLeaveResultCard` (Task 3, from `../lib/larkIm`); `OrgIntegration.larkVerificationToken`/`larkEncryptKey` (Task 1).
- Produces: `POST /api/lark/card-callback/:organizationId`, default-exported Express `Router`, consumed only by `index.ts`'s mount.

- [ ] **Step 1: Write the route file**

Create `server/src/routes/larkCardCallback.ts`:

```ts
import { Router, Request, Response } from 'express';
import * as Lark from '@larksuiteoapi/node-sdk';
import { getPrisma } from '../lib/prisma';
import { decideLeaveRequest } from './attendanceAdmin';
import { buildLeaveApprovalCard, buildLeaveResultCard } from '../lib/larkIm';

const router = Router();

// POST /api/lark/card-callback/:organizationId — Lark's "Callback URL" for
// card-button clicks (card.action.trigger). Genuinely separate from
// larkWs.ts's persistent-connection event stream — that channel cannot
// deliver this event type at all (see
// specs/2026-08-20-lark-card-approval-design.md's Context section: the
// SDK's CardActionHandler is built for an HTTP webhook via adaptExpress,
// not WSClient). Org is resolved directly from the URL path — each org's
// own Lark Console is configured with this exact per-org URL, so there is
// no ambiguity and no need to try multiple orgs' tokens against one
// shared URL. Unauthenticated by design: Lark's servers call this
// directly (no MeetKai user session to check) — the verification token
// baked into the CardActionHandler instance below is what stops a forged
// request from an org that doesn't own this callback.
//
// A new CardActionHandler is constructed per request, using the specific
// org's own token/key looked up from the URL — this is intentional (see
// design doc): it keeps per-org credential resolution simple and correct
// with no cross-org cache-invalidation concern, at the cost of a cheap
// extra object per callback, which only fires on an admin's own button
// click (never a hot path).
router.post('/lark/card-callback/:organizationId', async (req: Request, res: Response) => {
  const organizationId = req.params.organizationId;
  const prisma = getPrisma();
  const row = await prisma.orgIntegration.findUnique({
    where: { organizationId_provider: { organizationId, provider: 'lark' } },
    select: { larkVerificationToken: true, larkEncryptKey: true },
  });
  if (!row?.larkVerificationToken) {
    console.error('[larkCardCallback] org has no larkVerificationToken configured:', organizationId);
    return res.status(404).json({ error: 'not configured' });
  }

  const handler = new Lark.CardActionHandler(
    { verificationToken: row.larkVerificationToken, encryptKey: row.larkEncryptKey ?? undefined },
    async (data: Lark.InteractiveCardActionEvent) => {
      const decision = data.action?.value?.decision;
      const leaveId = data.action?.value?.leaveId;
      if (decision !== 'approved' && decision !== 'rejected') return {};
      if (!leaveId || typeof leaveId !== 'string') return {};

      const user = await prisma.user.findUnique({
        where: { larkOpenId: data.open_id, organizationId },
        select: { id: true, displayName: true },
      });
      if (!user) {
        console.error('[larkCardCallback] no MeetKai user for open_id in org:', organizationId);
        return {};
      }

      const leaveBefore = await prisma.leave.findUnique({
        where: { id: leaveId },
        include: {
          type: true,
          user: { select: { displayName: true, organizationId: true } },
          approver: { select: { displayName: true } },
        },
      });
      if (!leaveBefore || leaveBefore.user.organizationId !== organizationId) return {};

      const fmt = (d: Date) => d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric' });
      const rangeLabel = leaveBefore.startDate.getTime() === leaveBefore.endDate.getTime()
        ? fmt(leaveBefore.startDate)
        : `${fmt(leaveBefore.startDate)} - ${fmt(leaveBefore.endDate)}`;

      // Already decided (by someone else, or an earlier click) before this
      // click reached us — show the real current state instead of calling
      // decideLeaveRequest just to receive its own 409.
      if (leaveBefore.status !== 'pending') {
        return buildLeaveResultCard({
          requesterName: leaveBefore.user.displayName,
          typeName: leaveBefore.type.name,
          rangeLabel,
          reason: leaveBefore.reason,
          status: leaveBefore.status as 'approved' | 'rejected',
          approverName: leaveBefore.approver?.displayName ?? 'admin lain',
        });
      }

      const outcome = await decideLeaveRequest(prisma, {
        leaveId, organizationId, approverId: user.id, decision, ip: null,
      });

      if (!outcome.ok) {
        if (outcome.status === 409) {
          // Narrow race: decided by someone else between the leaveBefore
          // fetch above and decideLeaveRequest's own fetch. Re-fetch once
          // more so the card still shows the true outcome.
          const fresh = await prisma.leave.findUnique({
            where: { id: leaveId },
            include: { approver: { select: { displayName: true } } },
          });
          return buildLeaveResultCard({
            requesterName: leaveBefore.user.displayName,
            typeName: leaveBefore.type.name,
            rangeLabel,
            reason: leaveBefore.reason,
            status: (fresh?.status as 'approved' | 'rejected') ?? 'approved',
            approverName: fresh?.approver?.displayName ?? 'admin lain',
          });
        }
        // 403 — self-approval or not-an-approver. The leave is still
        // pending; just re-render the same card (no buttons for this
        // clicker, since they turned out not to be a valid approver).
        return buildLeaveApprovalCard({
          leaveId,
          requesterName: leaveBefore.user.displayName,
          typeName: leaveBefore.type.name,
          rangeLabel,
          reason: leaveBefore.reason,
          canDecide: false,
        });
      }

      return buildLeaveResultCard({
        requesterName: leaveBefore.user.displayName,
        typeName: leaveBefore.type.name,
        rangeLabel,
        reason: leaveBefore.reason,
        status: outcome.leave.status as 'approved' | 'rejected',
        approverName: user.displayName,
      });
    },
  );

  // autoChallenge: true — Lark hits this URL with a one-time
  // { type: 'url_verification' } request when the Callback URL is first
  // saved in the Console; the SDK answers it automatically so the room
  // admin's manual setup (see the design doc) doesn't need this route to
  // special-case that request itself.
  const expressHandler = Lark.adaptExpress(handler, { autoChallenge: true });
  await expressHandler(req, res);
});

export default router;
```

- [ ] **Step 2: Mount the route in index.ts**

Current (`server/src/index.ts:41`):

```ts
import orgMembersRoutes from './routes/orgMembers';
```

Replace with:

```ts
import orgMembersRoutes from './routes/orgMembers';
import larkCardCallbackRoutes from './routes/larkCardCallback';
```

Current (`server/src/index.ts:280`):

```ts
app.use('/api', orgMembersRoutes);
```

Replace with:

```ts
app.use('/api', orgMembersRoutes);
app.use('/api', larkCardCallbackRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/larkCardCallback.ts server/src/index.ts
git commit -m "feat: add Lark card-button-click callback endpoint for leave approval"
```

---

## Final Verification

- [ ] Run `npm run typecheck --workspace=server` once more from a clean state (all 4 tasks applied) — expect PASS with zero errors.
- [ ] Run `npm run typecheck --workspace=client` — expect PASS (no client files touched by this plan, but confirms nothing else broke).
- [ ] `git log --oneline -4` — confirm the 4 commits above exist in order.

## Manual Testing After Deploy

This cannot be verified before deploy — it requires a real public HTTPS URL for Lark to call, which only exists once this branch is deployed.

1. Deploy (`./deploy/deploy.sh`), which runs the Task 1 migration automatically.
2. In the org's Lark App Console → Credentials & Security Settings, copy the app's existing **Verification Token** (and **Encrypt Key**, if message encryption is enabled for that app).
3. Write them into the database directly:
   ```sql
   UPDATE "OrgIntegration"
   SET "larkVerificationToken" = '<paste verification token>',
       "larkEncryptKey" = '<paste encrypt key, or leave NULL if unset>'
   WHERE "organizationId" = '<org id>' AND provider = 'lark';
   ```
4. In the same Lark App Console → Events & Callbacks → set the card-interaction "Request URL" (separate field from the existing event-subscription long-connection setting, which stays untouched) to `https://<domain>/api/lark/card-callback/<organizationId>`. Saving should succeed immediately — Lark's one-time verification request is answered automatically (`autoChallenge: true`).
5. As a non-admin test user, submit a test leave/izin request that requires approval.
6. Confirm each workspace admin's Lark DM now arrives as a **card** (title "Pengajuan Cuti/Izin", orange header) with Acc/Tolak buttons — not the old plain-text message.
7. Click **Acc** on one admin's card — confirm it updates in place to a green "✅ Disetujui oleh {nama}" card, buttons gone.
8. Open KaiSpace's member list — confirm that same request no longer shows a pending badge.
9. Self-approval case: if the requester is themselves an admin, confirm their own copy of the card has no buttons at all.
10. Race case: with 2 admins both viewing the same still-pending card, have one click Acc; then have the other click Tolak on their own (still-showing) copy — confirm the second admin's card updates to show "✅ Disetujui oleh {first admin}", not an error and not a second decision.
