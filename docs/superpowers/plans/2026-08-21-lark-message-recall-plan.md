# Recall Relayed Lark Messages on In-App Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user deletes their own message in a KaiSpace channel, also recall the corresponding message in the mapped Lark group chat, if that message was ever relayed out to Lark.

**Architecture:** Persist the Lark `message_id` a relayed message received (a new nullable column on `ChatMessage`), then, on delete, fire-and-forget a call to a new Lark message-recall function using that stored id.

**Tech Stack:** Express, Prisma, `@larksuiteoapi/node-sdk`'s underlying REST API (`DELETE /im/v1/messages/:message_id`, called directly via `fetch` matching every other `larkIm.ts` function's convention).

## Global Constraints

- `relayChannelMessageToLark`'s return type changes from `Promise<void>` to `Promise<string | null>` — every existing call site must be checked and updated (there is only one, in `channelChatHandler.ts`).
- Tracking the returned `messageId` onto the `ChatMessage` row stays fire-and-forget relative to the user's own message send — never adds latency.
- `recallGroupMessage` must never throw, matching every other function in `larkIm.ts`'s null-graceful/try-catch/`console.error`-on-failure contract — returns `boolean`, not `void`.
- The recall attempt in `MESSAGE_DELETE` is fire-and-forget relative to the local delete — the local delete/broadcast completes and responds to the user regardless of whether recall succeeds, fails, or is even attempted.
- No retry logic. No user-facing indication of whether the Lark-side recall succeeded or failed.
- `MESSAGE_EDIT` is NOT touched by this plan. `relayBroadcastToLark` is NOT touched by this plan.
- Inbound-mirrored messages (delivered via `deliverLarkMessageToChannel`) never get a `larkMessageId` written to them by this plan's changes, so deleting one naturally skips the recall attempt — no special-case code needed for that path.
- No local dev database/server this session — `npm run typecheck --workspace=server` is the verification gate for every task. This typecheck is slow on this machine (3-5+ minutes) — let it run to completion. Live end-to-end verification (does a real delete actually recall the Lark message) can only happen after deploy — see "Manual Testing After Deploy" at the end.

---

## File Structure

- `server/prisma/schema.prisma` + a new migration — one new nullable column on `ChatMessage`.
- `server/src/lib/larkIm.ts` — new `recallGroupMessage()`.
- `server/src/lib/larkChatSync.ts` — `relayChannelMessageToLark()` returns the sent message's id instead of discarding it.
- `server/src/socket/channelChatHandler.ts` — the `CHANNEL_MESSAGE_SEND` handler tracks the returned id; the `MESSAGE_DELETE` handler triggers recall.

---

### Task 1: ChatMessage.larkMessageId schema + migration

**Files:**
- Modify: `server/prisma/schema.prisma:1486-1541` (the `ChatMessage` model)
- Create: `server/prisma/migrations/20260821140000_add_chat_message_lark_message_id/migration.sql`

**Interfaces:**
- Produces: `ChatMessage.larkMessageId: string | null` — consumed by Tasks 2 and 3.

- [ ] **Step 1: Add the column to the model**

Current (`server/prisma/schema.prisma`, inside the `ChatMessage` model, right before the pin field):

```prisma
  // Slack/Discord-style per-thread pin (SocketEvents.MESSAGE_PIN) — distinct
  // from the room-wide Notice board's own pin, a totally separate
  // admin-announcement feature. Open to anyone in the thread, not gated to
  // admins or the sender.
  isPinned Boolean @default(false)

  @@unique([conversationId2, clientId])
```

Replace with:

```prisma
  // Slack/Discord-style per-thread pin (SocketEvents.MESSAGE_PIN) — distinct
  // from the room-wide Notice board's own pin, a totally separate
  // admin-announcement feature. Open to anyone in the thread, not gated to
  // admins or the sender.
  isPinned Boolean @default(false)

  // The Lark message_id this message was relayed to, if any
  // (specs/2026-08-21-lark-message-recall-design.md) — set after a
  // successful outbound relay (see larkChatSync.ts's relayChannelMessageToLark),
  // NULL for messages that were never relayed (a non-default channel, no
  // RoomChatMap, a relay failure) or that arrived INBOUND from Lark in the
  // first place (there's nothing of ours to recall for those). Used only to
  // decide whether MESSAGE_DELETE has anything to recall in Lark.
  larkMessageId String?

  @@unique([conversationId2, clientId])
```

- [ ] **Step 2: Write the migration**

Create `server/prisma/migrations/20260821140000_add_chat_message_lark_message_id/migration.sql`:

```sql
-- The Lark message_id a relayed ChatMessage received, if any (see
-- specs/2026-08-21-lark-message-recall-design.md) — lets MESSAGE_DELETE
-- recall the corresponding Lark message. Nullable, no backfill: every
-- existing row simply has NULL (nothing to recall for messages sent
-- before this feature).

ALTER TABLE "ChatMessage" ADD COLUMN "larkMessageId" TEXT;
```

- [ ] **Step 3: Regenerate the Prisma client and typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS. This can take 3-5+ minutes on this machine — let it run to completion. If the new field isn't picked up, run `npx prisma generate --schema=server/prisma/schema.prisma` first, then re-run typecheck.

- [ ] **Step 4: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260821140000_add_chat_message_lark_message_id
git commit -m "feat: add ChatMessage.larkMessageId for message-recall tracking"
```

---

### Task 2: recallGroupMessage + relay returns the sent message id

**Files:**
- Modify: `server/src/lib/larkIm.ts` (append one new export)
- Modify: `server/src/lib/larkChatSync.ts` (`relayChannelMessageToLark`'s return type and every early return)
- Modify: `server/src/socket/channelChatHandler.ts` (the `CHANNEL_MESSAGE_SEND` handler's call site)

**Interfaces:**
- Produces: `export async function recallGroupMessage(messageId: string, organizationId: string): Promise<boolean>` from `server/src/lib/larkIm.ts` — consumed by Task 3. `relayChannelMessageToLark(...): Promise<string | null>` (was `Promise<void>`) from `server/src/lib/larkChatSync.ts`.

- [ ] **Step 1: Add recallGroupMessage to larkIm.ts**

Add this at the end of `server/src/lib/larkIm.ts` (after the existing `patchLeaveApprovalCard` function):

```ts

// Recall (retract) a message the bot's own tenant token is authorized to
// remove — either one the bot itself sent within the last 24h, or, if the
// bot has been granted admin/owner rights on the group (a manual one-time
// Lark-side setting, see specs/2026-08-21-lark-message-recall-design.md),
// ANY message in that group within the last year. Used by
// channelChatHandler.ts's MESSAGE_DELETE handler to recall a relayed
// channel message's Lark-side mirror. Null-graceful like every other
// function here: a permission error, an expired recall window, or an
// already-recalled message are all expected, silent outcomes — the local
// KaiSpace delete has already succeeded by the time this runs and is never
// rolled back based on this result.
export async function recallGroupMessage(messageId: string, organizationId: string): Promise<boolean> {
  const token = await getTenantToken(organizationId);
  if (!token) return false;
  try {
    const res = await fetch(`${LARK_OPENAPI_BASE}/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const j: any = await res.json();
    if (j?.code !== 0) {
      console.error('[larkIm] recallGroupMessage failed:', messageId, j?.code, j?.msg);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[larkIm] recallGroupMessage error:', messageId, e);
    return false;
  }
}
```

- [ ] **Step 2: relayChannelMessageToLark returns the sent message id**

Current (`server/src/lib/larkChatSync.ts:121-162`):

```ts
export async function relayChannelMessageToLark(
  prisma: PrismaClient,
  channel: { roomId: string; isDefault: boolean },
  senderId: string,
  senderName: string,
  text: string,
): Promise<void> {
  if (!channel.isDefault) return;
  const trimmed = stripMentionTokens((text || '').trim());
  if (!trimmed) return; // attachment-only sends have nothing to relay
  const map = await prisma.roomChatMap.findUnique({ where: { roomId: channel.roomId } });
  if (!map) {
    console.log('[diag-b4 out] skipped: no RoomChatMap for room', channel.roomId);
    return;
  }
  // Per-org (specs/2026-08-16) — resolved from the room itself rather than
  // threaded as a new parameter, since every caller already only has
  // roomId on hand (this keeps channelChatHandler.ts unchanged).
  const room = await prisma.room.findUnique({ where: { id: channel.roomId }, select: { organizationId: true } });
  if (!room) return;
  const organizationId = room.organizationId;

  // 1) Prefer the user's own identity.
  let messageId: string | null = null;
  const userToken = await getValidUserToken(senderId);
  if (userToken) {
    messageId = await sendAsUser(map.chatId, trimmed, userToken);
    console.log('[diag-b4 out] sendAsUser ->', messageId ? `ok ${messageId}` : 'failed → bot fallback');
  }
  // 2) Fallback: bot + [Name] prefix (the original mechanism, never removed).
  if (!messageId) {
    messageId = await sendGroupText(map.chatId, `[${senderName}] ${trimmed}`, organizationId);
    console.log('[diag-b4 out] sendGroupText(bot) ->', messageId ? `ok ${messageId}` : 'FAILED (see [larkIm] error above)');
  }

  if (messageId) {
    // Fast in-memory guard first (beats the echo's round-trip), then the durable
    // row (survives a restart). A lost row only risks one echoed message.
    markSent(messageId);
    await prisma.larkSentMessage.create({ data: { messageId } }).catch(() => {});
  }
}
```

Replace with:

```ts
export async function relayChannelMessageToLark(
  prisma: PrismaClient,
  channel: { roomId: string; isDefault: boolean },
  senderId: string,
  senderName: string,
  text: string,
): Promise<string | null> {
  if (!channel.isDefault) return null;
  const trimmed = stripMentionTokens((text || '').trim());
  if (!trimmed) return null; // attachment-only sends have nothing to relay
  const map = await prisma.roomChatMap.findUnique({ where: { roomId: channel.roomId } });
  if (!map) {
    console.log('[diag-b4 out] skipped: no RoomChatMap for room', channel.roomId);
    return null;
  }
  // Per-org (specs/2026-08-16) — resolved from the room itself rather than
  // threaded as a new parameter, since every caller already only has
  // roomId on hand (this keeps channelChatHandler.ts unchanged).
  const room = await prisma.room.findUnique({ where: { id: channel.roomId }, select: { organizationId: true } });
  if (!room) return null;
  const organizationId = room.organizationId;

  // 1) Prefer the user's own identity.
  let messageId: string | null = null;
  const userToken = await getValidUserToken(senderId);
  if (userToken) {
    messageId = await sendAsUser(map.chatId, trimmed, userToken);
    console.log('[diag-b4 out] sendAsUser ->', messageId ? `ok ${messageId}` : 'failed → bot fallback');
  }
  // 2) Fallback: bot + [Name] prefix (the original mechanism, never removed).
  if (!messageId) {
    messageId = await sendGroupText(map.chatId, `[${senderName}] ${trimmed}`, organizationId);
    console.log('[diag-b4 out] sendGroupText(bot) ->', messageId ? `ok ${messageId}` : 'FAILED (see [larkIm] error above)');
  }

  if (messageId) {
    // Fast in-memory guard first (beats the echo's round-trip), then the durable
    // row (survives a restart). A lost row only risks one echoed message.
    markSent(messageId);
    await prisma.larkSentMessage.create({ data: { messageId } }).catch(() => {});
  }
  // specs/2026-08-21-lark-message-recall-design.md — the caller (channelChatHandler.ts)
  // stores this onto the originating ChatMessage row so MESSAGE_DELETE later
  // knows whether there's a Lark-side mirror to recall.
  return messageId;
}
```

- [ ] **Step 3: Track the returned id on the originating ChatMessage**

Current (`server/src/socket/channelChatHandler.ts:397-405`, inside the `CHANNEL_MESSAGE_SEND` handler):

```ts
      // Bagian 4 — relay to the mapped Lark group (default channel only).
      // Fire-and-forget: a Lark outage must never fail the MeetKai send. Skip
      // duplicates (already relayed by the original send) and attachment-only
      // messages (empty text; the helper no-ops on those too).
      if (!duplicate && text) {
        void relayChannelMessageToLark(prisma, channel, userId, message.sender.displayName, text).catch((e) =>
          console.error('[channelChat] Lark relay failed:', e),
        );
      }
```

Replace with:

```ts
      // Bagian 4 — relay to the mapped Lark group (default channel only).
      // Fire-and-forget: a Lark outage must never fail the MeetKai send. Skip
      // duplicates (already relayed by the original send) and attachment-only
      // messages (empty text; the helper no-ops on those too).
      //
      // specs/2026-08-21-lark-message-recall-design.md — the resolved
      // message_id (if any) is stored back onto this ChatMessage row so a
      // later MESSAGE_DELETE knows there's a Lark-side mirror to recall.
      // Still fire-and-forget relative to this handler's own response; only
      // chained internally so the tracking write happens after the relay
      // resolves, never blocking the user's send.
      if (!duplicate && text) {
        void relayChannelMessageToLark(prisma, channel, userId, message.sender.displayName, text)
          .then((larkMessageId) => {
            if (larkMessageId) {
              return prisma.chatMessage.update({ where: { id: message.id }, data: { larkMessageId } });
            }
          })
          .catch((e) => console.error('[channelChat] Lark relay failed:', e));
      }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/larkIm.ts server/src/lib/larkChatSync.ts server/src/socket/channelChatHandler.ts
git commit -m "feat: add recallGroupMessage, track relayed message ids"
```

---

### Task 3: Wire recall into MESSAGE_DELETE

**Files:**
- Modify: `server/src/socket/channelChatHandler.ts` (imports, the `MESSAGE_DELETE` handler)

**Interfaces:**
- Consumes: `recallGroupMessage` (Task 2, from `../lib/larkIm`); `ChatMessage.larkMessageId` (Task 1).
- Produces: no new exports.

- [ ] **Step 1: Import recallGroupMessage**

Current (`server/src/socket/channelChatHandler.ts:9`):

```ts
import { relayChannelMessageToLark } from '../lib/larkChatSync';
```

Replace with:

```ts
import { relayChannelMessageToLark } from '../lib/larkChatSync';
import { recallGroupMessage } from '../lib/larkIm';
```

- [ ] **Step 2: Trigger recall after a successful local delete**

Current (`server/src/socket/channelChatHandler.ts:208-232`):

```ts
  socket.on(SocketEvents.MESSAGE_DELETE, async (payload: { messageId: string }) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof payload?.messageId !== 'string') return;
    try {
      const prisma = getPrisma();
      const msg = await prisma.chatMessage.findUnique({ where: { id: payload.messageId } });
      // Own messages only — no admin-delete in this pass. A missing/foreign
      // message is silently ignored (nothing to do, and we don't leak whether
      // an id exists).
      if (!msg || msg.senderId !== userId) return;
      // Deleting a parent cascades its thread replies (see schema's
      // ThreadReplies onDelete: Cascade), so one delete cleans the whole
      // subtree; clients drop replies on their own when the parent goes.
      await prisma.chatMessage.delete({ where: { id: msg.id } });
      const room = msg.channelId ? `channel:${msg.channelId}` : `dm:${msg.conversationId}`;
      io.to(room).emit(SocketEvents.MESSAGE_DELETED, {
        messageId: msg.id,
        channelId: msg.channelId ?? undefined,
        conversationId: msg.conversationId ?? undefined,
        parentId: msg.parentId ?? undefined,
      });
    } catch (e) {
      console.error('[channelChat] failed to delete message:', e);
    }
  });
```

Replace with:

```ts
  socket.on(SocketEvents.MESSAGE_DELETE, async (payload: { messageId: string }) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof payload?.messageId !== 'string') return;
    try {
      const prisma = getPrisma();
      const msg = await prisma.chatMessage.findUnique({ where: { id: payload.messageId } });
      // Own messages only — no admin-delete in this pass. A missing/foreign
      // message is silently ignored (nothing to do, and we don't leak whether
      // an id exists).
      if (!msg || msg.senderId !== userId) return;
      // Deleting a parent cascades its thread replies (see schema's
      // ThreadReplies onDelete: Cascade), so one delete cleans the whole
      // subtree; clients drop replies on their own when the parent goes.
      await prisma.chatMessage.delete({ where: { id: msg.id } });
      const room = msg.channelId ? `channel:${msg.channelId}` : `dm:${msg.conversationId}`;
      io.to(room).emit(SocketEvents.MESSAGE_DELETED, {
        messageId: msg.id,
        channelId: msg.channelId ?? undefined,
        conversationId: msg.conversationId ?? undefined,
        parentId: msg.parentId ?? undefined,
      });

      // specs/2026-08-21-lark-message-recall-design.md — best-effort recall
      // of this message's Lark-side mirror, if it was ever relayed out
      // (larkMessageId is null for inbound-mirrored messages, messages in a
      // non-default channel, or a relay that failed — nothing to recall in
      // any of those cases). Fire-and-forget: the local delete above has
      // already completed and been broadcast; this never delays or fails
      // that regardless of whether Lark accepts the recall.
      const organizationId = socket.data.organizationId as string | undefined;
      if (msg.larkMessageId && organizationId) {
        void recallGroupMessage(msg.larkMessageId, organizationId);
      }
    } catch (e) {
      console.error('[channelChat] failed to delete message:', e);
    }
  });
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/socket/channelChatHandler.ts
git commit -m "feat: recall the Lark-side mirror when a relayed channel message is deleted"
```

---

## Final Verification

- [ ] Run `npm run typecheck --workspace=server` once more from a clean state (all 3 tasks applied) — expect PASS with zero errors.
- [ ] `git log --oneline -3` — confirm the 3 commits above exist in order.

## Manual Testing After Deploy

1. **Prerequisite (cannot be verified or set up by this plan):** confirm the bot has been manually granted admin/owner rights on the mapped Lark group in Lark's own group settings. Without this, recall will only work for the bot-fallback relay path (a user with no linked Lark account), not the more common "sent as the user" path.
2. Deploy, which runs the Task 1 migration automatically.
3. Send a message in a KaiSpace channel bound to a Lark group (a room with a `RoomChatMap` row, in its default channel). Confirm it appears in the Lark group as expected (either under the sender's own name, or bot-prefixed `[Name]` if they have no linked Lark account).
4. Delete that message in KaiSpace. Within moments, confirm it's recalled (removed) from the Lark group too.
5. Repeat with a user who has NO linked Lark account (bot-fallback relay path) — confirm that delete also recalls correctly.
6. Send a message natively in the Lark group (so it mirrors INTO KaiSpace via the inbound sync) and delete the KaiSpace copy — confirm this does NOT error, simply removes the local copy, and does not attempt (or need) a recall, since that message never received a `larkMessageId`.
7. Check server logs for any `[larkIm] recallGroupMessage failed` entries during steps 4-5 even if the card visually did recall — these reveal real-world failure modes (the 24h/1-year window, the bot not actually having the needed group role, etc.) worth knowing about even on an apparent happy path.
