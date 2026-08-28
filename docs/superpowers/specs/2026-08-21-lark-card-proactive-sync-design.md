# Proactive Lark Card Sync for Leave-Approval Decisions — Design

## Goal

When a leave/izin request is decided (via KaiSpace's in-app Acc/Tolak buttons, OR by any one admin's Lark card), every OTHER admin's own separate Lark card for that same request currently keeps showing the original Acc/Tolak buttons until that specific admin personally interacts with it — at which point the existing 409 guard correctly reveals the true state. This is a staleness problem, not a correctness one: no double-decision was ever possible. This feature makes every admin's card update proactively and immediately, the moment a decision is made anywhere, regardless of which of the two decision paths triggered it.

## Context

This builds directly on the interactive Lark card approval feature shipped earlier this session:
- `POST /attendance/leaves` (`server/src/routes/attendanceAdmin.ts`) fans a card out to every workspace admin via `sendLeaveApprovalCard()` (`server/src/lib/larkIm.ts`) — each admin gets their own separate Lark message, with its own `message_id`.
- `decideLeaveRequest()` (`server/src/routes/attendanceAdmin.ts`) is the single shared function both the in-app HTTP route (`POST /attendance/leaves/:id/decide`) and the Lark card-button callback (`server/src/routes/larkCardCallback.ts`) call to actually approve/reject a leave — already proven as the one true "a decision just happened" trigger point regardless of which surface initiated it.
- `buildLeaveResultCard()` (`server/src/lib/larkIm.ts`) already builds the exact "✅ Disetujui oleh X" / "❌ Ditolak oleh X" card content the card-callback route returns for the clicked message. This is directly reusable here — no new card content needed.
- The card-callback route's own response mechanism (the SDK returning the handler's return value as that one HTTP response) only ever updates the SPECIFIC message that was clicked. It has no way to reach any other admin's separate message — that requires a distinct outbound Lark API call per message.

Lark's IM API has a message-patch endpoint, `PATCH /open-apis/im/v1/messages/:message_id`, distinct from the "update text/post message" endpoint (`PUT .../messages/:message_id`, which the SDK's own docs note does not support cards). This is the mechanism needed to push new content into an already-sent card message.

## Data model

New Prisma model, one row per admin per leave request, created at the moment their card is sent:

```prisma
model LeaveCardMessage {
  id          String    @id @default(cuid())
  leaveId     String
  leave       Leave     @relation(fields: [leaveId], references: [id], onDelete: Cascade)
  recipientId String
  recipient   User      @relation(fields: [recipientId], references: [id], onDelete: Cascade)
  messageId   String    // Lark's message_id for this specific card
  pushedAt    DateTime? // null until a decision-update patch succeeds for this row
  createdAt   DateTime  @default(now())

  @@index([leaveId])
}
```

Retained permanently (confirmed with the room admin) — not cleaned up after the leave is decided. `pushedAt` doubles as an audit signal: `NULL` means that admin's card has not yet been confirmed updated to reflect the leave's current (decided) state — either because it's still genuinely pending, or because a push attempt to that admin failed. A non-null `pushedAt` means that specific card was successfully patched to show the decision.

`Leave` gains the inverse relation (`cardMessages LeaveCardMessage[]`); `User` gains `leaveCardMessages LeaveCardMessage[]` for the `recipientId` relation — both are additive, no existing field changes.

## Data flow

**1. Tracking on initial send.** In `POST /attendance/leaves`'s admin fan-out loop (`server/src/routes/attendanceAdmin.ts`), each `sendLeaveApprovalCard(...)` call currently discards its resolved `message_id` (`void sendLeaveApprovalCard(...)`). This changes to chain a `.then()`: when a `message_id` comes back non-null, create one `LeaveCardMessage` row (`leaveId`, that admin's `recipientId`, the `messageId`, `pushedAt: null`). Still fire-and-forget relative to the leave-creation HTTP response — the response never waits on any Lark round-trip, matching the existing convention.

**2. Sync on decide.** `decideLeaveRequest()` gains one new step in its `{ ok: true }` success path, after the existing audit-log write and notification creation: fire off (not awaited by the function's own return, i.e. the caller — the HTTP route or the card callback — gets its response immediately) a new orchestration step that:
   - Queries every `LeaveCardMessage` row for that `leaveId`.
   - Builds the result card once via the already-existing `buildLeaveResultCard()`, using the decision's outcome (approver name, status) — the same content already used for the clicked card in the callback route.
   - For each row, calls a new `patchLeaveApprovalCard(messageId, card, organizationId)` function (new, in `server/src/lib/larkIm.ts`, using `PATCH /open-apis/im/v1/messages/:message_id` with the same `getTenantToken()`-based auth every other function in that file already uses).
   - On success, sets that row's `pushedAt` to now. On failure, leaves it `null` and logs the error — does not affect any other row's own attempt.
   - This runs for every tracked row, including the one belonging to whichever card was actually clicked (if the decision came from a Lark click at all) — patching a card that's about to receive its own response-based update anyway is harmless (identical content, one extra idempotent API call), and it keeps `decideLeaveRequest()` simple: it never needs to know or care which specific card (if any) triggered it, so the in-app HTTP decide path and the Lark card-click path stay symmetric.

**3. Result.** Whether an admin decides via KaiSpace's member list or via their own Lark card, every other admin's Lark card updates within moments to show the true outcome — no more stale Acc/Tolak buttons sitting on an already-decided request.

## Error handling

- Each recipient's patch attempt is isolated (its own try/catch) — one admin's failure (revoked Lark link, transient API error) never blocks or delays any other admin's update.
- The whole sync step is fire-and-forget relative to the decide action itself — approving/rejecting a leave (from either surface) never waits on any number of outbound Lark calls.
- No automatic retry is built for a failed push in this iteration — `pushedAt IS NULL` on an otherwise-decided leave is the queryable signal a future pass could act on (e.g., a manual "resync" admin action, or a sweep job) — out of scope here, not requested.

## Out of scope

- Any UI to browse/query the `LeaveCardMessage` audit data (e.g., "which admins haven't seen this decision yet") — the data is retained and queryable, but no admin-console surface for it is being built now.
- Automatic retry/backoff for a failed patch.
- Cleanup/archival of old rows — explicitly deferred per the room admin's choice to retain permanently.
- Any change to the card-callback route's own response-based update mechanism for the clicked message, or to the 409 stale-click guard — both already work correctly and are untouched.
