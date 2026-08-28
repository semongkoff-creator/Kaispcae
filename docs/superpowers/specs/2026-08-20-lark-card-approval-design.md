# Lark Interactive Card Approval for Leave Requests — Design

## Goal

Replace the plain-text Lark DM admins currently get when someone submits a
cuti/izin request with an interactive Lark message **card** carrying real
Acc/Tolak buttons. Tapping a button in Lark runs the exact same
approve/reject logic already built for KaiSpace's in-app flow — this never
touches Lark's own native Cuti/Approval feature (a separate, pre-existing
system, explicitly out of scope/deferred).

## Context — why this needs a new HTTP endpoint, not the existing WS channel

`server/src/lib/larkWs.ts` maintains one persistent WebSocket
(`Lark.WSClient`, from `@larksuiteoapi/node-sdk`) per organization, and
today registers exactly one event handler:

```ts
new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => handleInboundLarkMessage(io, data, organizationId),
});
```

Investigated the installed SDK's own type declarations
(`node_modules/@larksuiteoapi/node-sdk/types/index.d.ts`) to check whether
`card.action.trigger` (button-click events) can flow over this same
channel. Findings:

- `WSClient.start(params: { eventDispatcher: EventDispatcher })` only
  accepts an `EventDispatcher` — never a card handler.
- The SDK exports a **separate** `CardActionHandler` class specifically for
  card-button interactions, constructed with its own `verificationToken`/
  `encryptKey` and a single `cardHandler` callback (not a keyed
  `.register()` map like `EventDispatcher`).
- `CardActionHandler` is designed to pair with the SDK's own
  `adaptExpress`/`adaptKoa`/`adaptDefault` HTTP-framework adapters — i.e.
  it's built for an HTTP webhook, not the long-connection WS.
- Lark's own app-registration types distinguish `events.items` (delivered
  over WS/long-connection — where `im.message.receive_v1` lives) from a
  **separate** `callbacks.items` category (`'card.action.trigger'` is the
  SDK's own example for this key) — two different subscription categories
  in the Lark platform's own model.

**Conclusion:** card-button clicks need a genuinely new, public HTTPS
endpoint (a Lark "Callback URL"), configured manually per-organization in
that org's own Lark App Console — the existing WS channel cannot carry
this. Confirmed acceptable (the room admin manages the KAITECH org's own
Lark App Console).

## Architecture

### 1. New Prisma fields (migration, no new table)

`OrgIntegration` (provider='lark' rows) gains two new nullable columns:

```prisma
larkVerificationToken String?
larkEncryptKey        String?
```

Same non-secret-critical-but-sensitive handling as the existing
`clientSecretEnc` — these aren't the app secret itself, but should still be
treated as credentials (not logged, not exposed to non-admins). Hand-authored
SQL migration, same convention this session already uses for schema changes
without local Postgres access (`CREATE TABLE`/`ALTER TABLE` reviewed, no
data migration risk since both columns are nullable additions).

### 2. New route: per-org card callback endpoint

New file `server/src/routes/larkCardCallback.ts`, mounted at `/api` like
every other route file. Single route:

```
POST /api/lark/card-callback/:organizationId
```

Handler built from the SDK's `CardActionHandler` + `adaptExpress`, one
instance constructed per incoming request using that URL's
`:organizationId` to look up `getOrgLarkCredentials`-equivalent
`larkVerificationToken`/`larkEncryptKey` from `OrgIntegration`. The
organization is resolved directly from the URL path — no ambiguity, no
need to try multiple orgs' tokens against one shared URL. Each org's Lark
App Console "Callback URL" field is set to this exact per-org path.

The `cardHandler` callback:
1. Extracts the operator's `open_id` and the button's encoded
   `action.value` (`{ leaveId, decision: 'approved' | 'rejected' }`).
2. Resolves the MeetKai user: `prisma.user.findUnique({ where: { larkOpenId: openId, organizationId } })`
   — the exact same lookup pattern `larkInbound.ts` already uses for
   inbound chat messages.
3. Calls the **same internal decide logic** the existing
   `POST /attendance/leaves/:id/decide` route uses (extracted into a
   shared function both routes call — see "Shared decide logic" below),
   passing that resolved user as the approver.
4. Returns a **new card JSON** as the response — the SDK replaces the
   clicked message's content with whatever the handler returns, no
   separate "update message" API call needed for the card that was
   actually clicked.
5. The returned card always reflects the leave's **current real status**
   after the attempt (approved-by-X / rejected-by-X / already-decided-by-
   someone-else) — never a generic "OK" — so a stale second click from a
   different admin (a genuine race) converges to showing the true outcome
   rather than a confusing error only.

### 3. Shared decide logic

`attendanceAdmin.ts`'s existing `POST /attendance/leaves/:id/decide`
handler already contains: org/existence check, self-approval block,
`canApprove()` check, the new 409-if-already-decided guard, the
`prisma.leave.update`, the audit write, and the in-app `Notification`
creation. This logic is extracted into one function,
`decideLeaveRequest(prisma, { leaveId, approverId, decision })`, called
from BOTH the existing HTTP route (thin wrapper, unchanged response shape)
and the new card callback handler. No behavior change for the existing
route — pure extraction so the two entry points can never drift out of
sync.

### 4. New card-sending function

`server/src/lib/larkIm.ts` gains `sendLeaveApprovalCard(openId, leave,
canDecide, organizationId): Promise<string | null>` — same null-graceful,
per-org-token convention as `sendUserDm`, but posts `msg_type:
'interactive'` with a card body (using the SDK's own `InteractiveCard`
element types: header, a `div` with the requester/type/date-range/reason
fields, and — only when `canDecide` is true — an actions row with two
buttons whose `value` encodes `{leaveId, decision}`).

`attendanceAdmin.ts`'s leave-create route's admin fan-out (currently a
loop calling `sendUserDm` with plain text) is replaced with a loop calling
`sendLeaveApprovalCard` instead — one card per admin, `canDecide` computed
per-recipient exactly like `status-today`'s existing `canDecide` (`false`
when that admin IS the requester). This fully replaces the plain-text DM;
nothing sends both.

## Card content & behavior

- **Fields shown:** requester name, leave type, date range (formatted the
  same `id-ID`/`Asia/Jakarta` way the existing Lark DM text already does),
  reason.
- **Buttons:** "Acc" / "Tolak" — present only when that recipient's
  `canDecide` is true for this request (excludes the requester themselves,
  even if they're an admin — they still receive the card for visibility,
  just without buttons, matching the in-app list's own behavior).
- **After a decide:** the clicked card immediately re-renders in place as
  a result card ("✅ Disetujui oleh {approver}" / "❌ Ditolak oleh
  {approver}"), buttons removed. Other admins' own copies of the card are
  **not** proactively pushed an update — they still show the original
  Acc/Tolak card until they interact with it, at which point the shared
  decide logic's 409 guard fires and the response card shows the real
  "already decided" outcome instead of silently re-processing.

## Out of scope (unchanged from the base feature)

- Lark's native Cuti/Approval integration — untouched, not read from, not
  written to.
- Who is allowed to decide (`canApprove()` — admin OR direct manager) —
  unchanged, reused as-is by the extracted shared function.
- The in-app KaiSpace approval UI (member list Acc/Tolak) — unchanged,
  continues to work exactly as already shipped; this is an *additional*
  decision surface, not a replacement.
- Multi-card proactive sync (pushing an update to every OTHER admin's copy
  the instant one decides) — explicitly deferred per the room admin's
  choice; each card resolves to the true state lazily, on next interaction.

## Manual setup required (not part of the code change)

For each organization that wants this: in that org's Lark App Console,
under Events & Callbacks, set the Callback URL to
`https://<domain>/api/lark/card-callback/<organizationId>` and copy that
app's Verification Token (and Encrypt Key, if message encryption is
enabled) into the new `OrgIntegration` fields — via a direct DB write for
now (no admin UI for these two new fields in this iteration; the existing
`IntegrationPanel.tsx` Lark section could gain input fields for these in a
later pass if that's wanted, but isn't required for this feature to work).
