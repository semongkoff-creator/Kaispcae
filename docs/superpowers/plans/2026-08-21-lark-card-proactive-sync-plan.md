# Proactive Lark Card Sync for Leave-Approval Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a leave/izin request is decided (from KaiSpace's in-app Acc/Tolak buttons OR any admin's Lark card), proactively push the decided-state card into every OTHER admin's own still-pending Lark card for that request, instead of leaving them stale until that admin personally interacts with theirs.

**Architecture:** Track every card sent (leaveId, recipient, Lark message_id) in a new `LeaveCardMessage` row at send time. Add one new fire-and-forget step inside `decideLeaveRequest()`'s existing success path — the single function both the in-app decide route and the Lark card callback already share — that looks up every tracked row for that leave and pushes the same result card (via a new `PATCH`-based Lark call) into each one.

**Tech Stack:** Express, Prisma, `@larksuiteoapi/node-sdk` (reusing the existing `InteractiveCard` type and `buildLeaveResultCard` builder).

## Global Constraints

- `LeaveCardMessage` rows are retained PERMANENTLY, never cleaned up (explicit room-admin decision) — do not add any deletion/archival logic.
- `pushedAt` starts NULL at row creation and is set to the current time only when a decision-update patch for that row succeeds — never touched otherwise.
- The sync step fires from INSIDE `decideLeaveRequest()`'s existing `{ ok: true }` success path (not duplicated into either caller) — both the in-app HTTP decide route and the Lark card-callback route trigger it identically with zero extra wiring at either call site.
- The sync step is fire-and-forget relative to `decideLeaveRequest()`'s own return — it must never delay or fail the actual decide action.
- Each recipient's patch attempt is isolated — one admin's failure must never block or affect any other admin's update.
- Every tracked `LeaveCardMessage` row for that leaveId is patched unconditionally, including whichever row belongs to a message that was just clicked (if the decision came from a Lark click at all) — patching an about-to-be-updated-anyway card is harmless.
- `decideLeaveRequest()` gets NO new parameter for "which message triggered this" — it stays exactly as unaware of its caller as it is today.
- No automatic retry logic for a failed patch, no admin-facing UI for the `LeaveCardMessage` audit data, no change to the card-callback route's own existing response-based update mechanism or its 409 stale-click guard.
- No local dev database/server this session — `npm run typecheck --workspace=server` is the verification gate for every task. Live end-to-end verification (does another admin's real Lark card actually update) can only happen after deploy — see "Manual Testing After Deploy" at the end.

---

## File Structure

- `server/prisma/schema.prisma` + a new migration — new `LeaveCardMessage` model, plus one new relation field each on `Leave` and `User`.
- `server/src/lib/larkIm.ts` — new `patchLeaveApprovalCard()`.
- `server/src/routes/attendanceAdmin.ts` — the leave-create route's fan-out loop starts tracking sent message IDs; `decideLeaveRequest()` gains the sync step.

---

### Task 1: LeaveCardMessage schema + migration

**Files:**
- Modify: `server/prisma/schema.prisma:120-121` (User's relation array fields) and `server/prisma/schema.prisma:528-547` (the `Leave` model)
- Create: `server/prisma/migrations/20260821120000_add_leave_card_message/migration.sql`

**Interfaces:**
- Produces: `prisma.leaveCardMessage.{create,findMany,update}` with fields `{ id: string, leaveId: string, recipientId: string, messageId: string, pushedAt: Date | null, createdAt: Date }` — consumed by Tasks 2 and 3.

- [ ] **Step 1: Add the User → LeaveCardMessage back-relation**

Current (`server/prisma/schema.prisma:120-121`):

```prisma
  leaves                  Leave[]                   @relation("LeaveUser")
  leavesApproved          Leave[]                   @relation("LeaveApprover")
```

Replace with:

```prisma
  leaves                  Leave[]                   @relation("LeaveUser")
  leavesApproved          Leave[]                   @relation("LeaveApprover")
  leaveCardMessages       LeaveCardMessage[]
```

- [ ] **Step 2: Add the Leave → LeaveCardMessage back-relation and the new model**

Current (`server/prisma/schema.prisma:528-547`):

```prisma
model Leave {
  id           String    @id @default(cuid())
  userId       String
  user         User      @relation("LeaveUser", fields: [userId], references: [id], onDelete: Cascade)
  typeId       String
  type         LeaveType @relation(fields: [typeId], references: [id], onDelete: Restrict)
  startDate    DateTime
  endDate      DateTime
  halfDay      Boolean   @default(false)
  reason       String
  status       String    @default("pending") // pending | approved | rejected
  approverId   String?
  approver     User?     @relation("LeaveApprover", fields: [approverId], references: [id], onDelete: SetNull)
  decidedAt    DateTime?
  decisionNote String?
  createdAt    DateTime  @default(now())

  @@index([userId, startDate])
  @@index([status])
}
```

Replace with:

```prisma
model Leave {
  id           String    @id @default(cuid())
  userId       String
  user         User      @relation("LeaveUser", fields: [userId], references: [id], onDelete: Cascade)
  typeId       String
  type         LeaveType @relation(fields: [typeId], references: [id], onDelete: Restrict)
  startDate    DateTime
  endDate      DateTime
  halfDay      Boolean   @default(false)
  reason       String
  status       String    @default("pending") // pending | approved | rejected
  approverId   String?
  approver     User?     @relation("LeaveApprover", fields: [approverId], references: [id], onDelete: SetNull)
  decidedAt    DateTime?
  decisionNote String?
  createdAt    DateTime  @default(now())

  cardMessages LeaveCardMessage[]

  @@index([userId, startDate])
  @@index([status])
}

// One row per admin who received a Lark approval card for a given leave
// (specs/2026-08-21-lark-card-proactive-sync-design.md) — lets a later
// decision (from ANY source: KaiSpace's UI or any other admin's own card
// click) proactively push the decided-state card into every recipient's
// message, instead of leaving them stale until each admin personally
// interacts with theirs. Retained PERMANENTLY (explicit room-admin
// decision) — never cleaned up, so this also doubles as a queryable audit
// trail: `pushedAt IS NULL` on an already-decided leave means that
// specific admin's card hasn't been confirmed updated yet.
model LeaveCardMessage {
  id          String    @id @default(cuid())
  leaveId     String
  leave       Leave     @relation(fields: [leaveId], references: [id], onDelete: Cascade)
  recipientId String
  recipient   User      @relation(fields: [recipientId], references: [id], onDelete: Cascade)
  messageId   String
  // NULL until a decision-update patch for THIS row succeeds. Never set at
  // creation time (a freshly-sent card is pending, not yet "pushed" with a
  // decision) and never reset once set — a leave can only be decided once.
  pushedAt    DateTime?
  createdAt   DateTime  @default(now())

  @@index([leaveId])
}
```

- [ ] **Step 3: Write the migration**

Create `server/prisma/migrations/20260821120000_add_leave_card_message/migration.sql`:

```sql
-- One row per admin who received a Lark approval card for a given leave
-- (specs/2026-08-21-lark-card-proactive-sync-design.md) — lets a later
-- decision proactively push the decided-state card into every recipient's
-- own message. Retained permanently, never cleaned up.

CREATE TABLE "LeaveCardMessage" (
    "id" TEXT NOT NULL,
    "leaveId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "pushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveCardMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LeaveCardMessage_leaveId_idx" ON "LeaveCardMessage"("leaveId");

ALTER TABLE "LeaveCardMessage" ADD CONSTRAINT "LeaveCardMessage_leaveId_fkey" FOREIGN KEY ("leaveId") REFERENCES "Leave"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveCardMessage" ADD CONSTRAINT "LeaveCardMessage_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 4: Regenerate the Prisma client and typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS. If the new model's types aren't picked up, run `npx prisma generate --schema=server/prisma/schema.prisma` first, then re-run typecheck.

- [ ] **Step 5: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260821120000_add_leave_card_message
git commit -m "feat: add LeaveCardMessage model for proactive Lark card sync"
```

---

### Task 2: patchLeaveApprovalCard + track initial card sends

**Files:**
- Modify: `server/src/lib/larkIm.ts` (append one new export)
- Modify: `server/src/routes/attendanceAdmin.ts` (the leave-create route's admin fan-out loop)

**Interfaces:**
- Consumes: `Lark.InteractiveCard` (already imported via `import * as Lark from '@larksuiteoapi/node-sdk'` in `larkIm.ts`); `prisma.leaveCardMessage.create` (Task 1).
- Produces: `export async function patchLeaveApprovalCard(messageId: string, card: Lark.InteractiveCard, organizationId: string): Promise<boolean>` from `server/src/lib/larkIm.ts` — consumed by Task 3.

- [ ] **Step 1: Add patchLeaveApprovalCard to larkIm.ts**

Add this at the end of `server/src/lib/larkIm.ts` (after the existing `sendLeaveApprovalCard` function):

```ts

// Proactively push updated content into an ALREADY-SENT card message —
// distinct from sendLeaveApprovalCard above, which only ever sends a NEW
// message. Uses Lark's message PATCH endpoint (im.v1.message.patch), which
// supports card content; the separate PUT .../messages/:message_id
// endpoint ("update") only supports text/post messages per Lark's own
// docs (see editMessage's doc comment in the installed SDK's type
// definitions). Used by decideLeaveRequest's proactive sync step
// (specs/2026-08-21-lark-card-proactive-sync-design.md) to push the
// decided-state card into every OTHER admin's still-pending card the
// moment ANY decision happens, regardless of whether it came from a Lark
// click or KaiSpace's own UI. Returns true on success, false on any
// failure — null-graceful like every other function here; the caller
// tracks per-recipient success itself (LeaveCardMessage.pushedAt).
export async function patchLeaveApprovalCard(messageId: string, card: Lark.InteractiveCard, organizationId: string): Promise<boolean> {
  const token = await getTenantToken(organizationId);
  if (!token) return false;
  try {
    const res = await fetch(`${LARK_OPENAPI_BASE}/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ content: JSON.stringify(card) }),
    });
    const j: any = await res.json();
    if (j?.code !== 0) {
      console.error('[larkIm] patchLeaveApprovalCard failed:', j?.code, j?.msg);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[larkIm] patchLeaveApprovalCard error:', e);
    return false;
  }
}
```

- [ ] **Step 2: Track each sent card's message_id**

Current (`server/src/routes/attendanceAdmin.ts`, the leave-create route's fan-out loop):

```ts
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

Replace with:

```ts
      for (const a of larkAdmins) {
        void sendLeaveApprovalCard(a.larkOpenId!, {
          leaveId: leave.id,
          requesterName: me?.displayName ?? 'Seseorang',
          typeName: type.name,
          rangeLabel,
          reason,
          canDecide: a.id !== req.userId!,
        }, req.organizationId).then((messageId) => {
          // Tracked so a later decision (from KaiSpace's UI or any other
          // admin's own Lark card) can proactively push an update into
          // THIS specific card — see decideLeaveRequest's sync step. Still
          // fire-and-forget relative to this route's own response; only
          // chained internally so the tracking write happens after the
          // Lark send resolves, never blocking leave creation.
          if (messageId) {
            void prisma.leaveCardMessage.create({
              data: { leaveId: leave.id, recipientId: a.id, messageId },
            });
          }
        });
      }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/lib/larkIm.ts server/src/routes/attendanceAdmin.ts
git commit -m "feat: add patchLeaveApprovalCard, track sent card message_ids"
```

---

### Task 3: Sync-on-decide orchestration

**Files:**
- Modify: `server/src/routes/attendanceAdmin.ts` (imports, `decideLeaveRequest`'s success path)

**Interfaces:**
- Consumes: `patchLeaveApprovalCard`, `buildLeaveResultCard` (Task 2 and pre-existing, from `../lib/larkIm`); `prisma.leaveCardMessage.findMany`/`.update` (Task 1).
- Produces: no new exports — `decideLeaveRequest`'s existing signature and `DecideLeaveOutcome` type are unchanged.

- [ ] **Step 1: Import the two new/existing larkIm functions**

Current (`server/src/routes/attendanceAdmin.ts:10`):

```ts
import { sendLeaveApprovalCard } from '../lib/larkIm';
```

Replace with:

```ts
import { sendLeaveApprovalCard, buildLeaveResultCard, patchLeaveApprovalCard } from '../lib/larkIm';
```

- [ ] **Step 2: Include the requester's displayName in decideLeaveRequest's leave fetch**

Current (`server/src/routes/attendanceAdmin.ts`, inside `decideLeaveRequest`):

```ts
  const leave = await prisma.leave.findUnique({
    where: { id: params.leaveId },
    include: { type: true, user: { select: { organizationId: true } } },
  });
```

Replace with:

```ts
  const leave = await prisma.leave.findUnique({
    where: { id: params.leaveId },
    include: { type: true, user: { select: { organizationId: true, displayName: true } } },
  });
```

- [ ] **Step 3: Add the sync step to decideLeaveRequest's success path**

Current (`server/src/routes/attendanceAdmin.ts`, the end of `decideLeaveRequest`):

```ts
  await writeAudit(prisma, {
    actorId: params.approverId, action: 'attendance:approve', targetType: 'leave', targetId: leave.id,
    targetUserId: leave.userId, meta: { before: { status: leave.status }, after: { status: params.decision } }, ip: params.ip ?? null,
  });
  await prisma.notification.create({
    data: { recipientId: leave.userId, kind: 'workspace', body: `Pengajuan ${leave.type.name} kamu ${params.decision === 'approved' ? 'disetujui' : 'ditolak'}.` },
  });
  return { ok: true, leave: updated, typeName: leave.type.name };
}
```

Replace with:

```ts
  await writeAudit(prisma, {
    actorId: params.approverId, action: 'attendance:approve', targetType: 'leave', targetId: leave.id,
    targetUserId: leave.userId, meta: { before: { status: leave.status }, after: { status: params.decision } }, ip: params.ip ?? null,
  });
  await prisma.notification.create({
    data: { recipientId: leave.userId, kind: 'workspace', body: `Pengajuan ${leave.type.name} kamu ${params.decision === 'approved' ? 'disetujui' : 'ditolak'}.` },
  });

  // Proactive Lark card sync (specs/2026-08-21-lark-card-proactive-sync-
  // design.md) — push the decided-state card into every OTHER admin's own
  // still-showing message for this leave, regardless of whether THIS
  // decision came from a Lark click or KaiSpace's own UI. Fire-and-forget:
  // never delays or fails the decide action above. Each recipient's patch
  // is isolated (own try/catch) so one admin's failure never blocks
  // another's, and every tracked row is patched unconditionally — including
  // whichever one belongs to a message that was just clicked, if any;
  // patching an about-to-update-anyway card is harmless.
  void (async () => {
    const approver = await prisma.user.findUnique({ where: { id: params.approverId }, select: { displayName: true } });
    const fmt = (d: Date) => d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric' });
    const rangeLabel = leave.startDate.getTime() === leave.endDate.getTime()
      ? fmt(leave.startDate)
      : `${fmt(leave.startDate)} - ${fmt(leave.endDate)}`;
    const card = buildLeaveResultCard({
      requesterName: leave.user.displayName,
      typeName: leave.type.name,
      rangeLabel,
      reason: leave.reason,
      status: params.decision,
      approverName: approver?.displayName ?? 'admin',
    });
    const rows = await prisma.leaveCardMessage.findMany({ where: { leaveId: leave.id } });
    for (const row of rows) {
      try {
        const ok = await patchLeaveApprovalCard(row.messageId, card, params.organizationId);
        if (ok) {
          await prisma.leaveCardMessage.update({ where: { id: row.id }, data: { pushedAt: new Date() } });
        }
      } catch (e) {
        console.error('[attendance] leave card sync error for row', row.id, e);
      }
    }
  })();

  return { ok: true, leave: updated, typeName: leave.type.name };
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/attendanceAdmin.ts
git commit -m "feat: proactively sync every admin's Lark card when a leave is decided"
```

---

## Final Verification

- [ ] Run `npm run typecheck --workspace=server` once more from a clean state (all 3 tasks applied) — expect PASS with zero errors.
- [ ] `git log --oneline -3` — confirm the 3 commits above exist in order.

## Manual Testing After Deploy

1. Deploy, which runs the Task 1 migration automatically.
2. As a non-admin test user, submit a leave/izin request that requires approval, with at least 2 workspace admins linked to Lark.
3. Confirm both admins receive their own separate Lark card, each with Acc/Tolak buttons.
4. Have ONE admin click Acc (or Tolak) directly in Lark.
5. Within a few seconds, check the OTHER admin's Lark card (the one they did NOT click) — it should update on its own to show the same decided result ("✅ Disetujui oleh ..." / "❌ Ditolak oleh ..."), with no interaction from that admin.
6. Repeat the test, but this time decide the leave via KaiSpace's in-app member-list Acc/Tolak buttons instead of any Lark card — confirm BOTH admins' Lark cards update on their own, even though neither of them clicked anything in Lark.
7. Confirm the original single-card flows still work exactly as before: the requester's own card (if they're an admin) still renders with no buttons; a stale second click on an already-updated card still resolves to the correct final state (no regression to the existing 409 guard's behavior).
