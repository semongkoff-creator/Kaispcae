# Recall Relayed Lark Messages on In-App Delete — Design

## Goal

When a user deletes their own message in a KaiSpace channel (the existing `MESSAGE_DELETE` flow), also recall the corresponding message in the mapped Lark group chat, if that message was ever relayed out to Lark. Best-effort: KaiSpace's own delete always succeeds locally regardless of whether the Lark recall does.

## Context

Channel chat already has a working, own-messages-only delete (`server/src/socket/channelChatHandler.ts`'s `MESSAGE_DELETE` handler) that is purely local today — it never touches Lark. Outbound relay to Lark (`server/src/lib/larkChatSync.ts`'s `relayChannelMessageToLark`) prefers sending as the real user (`sendAsUser`, using their own linked Lark `user_access_token`) and falls back to the bot (`sendGroupText`, with a `[Name]` prefix) only when the user has no valid token. Both paths return a Lark `message_id`, but neither is currently persisted anywhere durable — the only existing Lark-message-id table, `LarkSentMessage`, is an explicitly disposable anti-echo ledger with no link back to the originating `ChatMessage`.

Lark's message-recall endpoint (`DELETE /im/v1/messages/:message_id`, confirmed via the installed `@larksuiteoapi/node-sdk`'s own bundled documentation) allows: (a) the bot recalling a message it itself sent, within 24 hours, or (b) — if the bot is the group's owner/admin/creator — recalling *anyone's* message in that group, within 1 year. Since the common relay path sends as the real user (not the bot), case (a) alone would only cover the fallback path. This design assumes the room admin will grant the bot admin/owner rights on the mapped Lark group (a one-time manual Lark-side setting, out of band from this code change) so recall works uniformly regardless of which path originally sent the message.

## Data model

One new nullable column on the existing `ChatMessage` model:

```prisma
larkMessageId String?
```

Set after a successful outbound relay (see Data flow below). No new table needed — this is a strict 1:1 relationship per message, unlike the leave-approval card feature's `LeaveCardMessage` (which needed one row per *recipient*).

## Data flow

**1. Tracking on send.** `relayChannelMessageToLark` (`server/src/lib/larkChatSync.ts`) currently returns `Promise<void>`; it changes to return `Promise<string | null>` (the Lark `message_id`, mirroring what `sendAsUser`/`sendGroupText` already give it). Its caller (`channelChatHandler.ts`'s `CHANNEL_MESSAGE_SEND` handler, which already calls it fire-and-forget via `void relayChannelMessageToLark(...).catch(...)`) chains a `.then()` that, when a `messageId` comes back, updates that `ChatMessage` row's `larkMessageId`. Still fire-and-forget relative to the user's own send — never adds latency to sending a message.

**2. Recall on delete.** New function `recallGroupMessage(messageId: string, organizationId: string): Promise<boolean>` in `server/src/lib/larkIm.ts`, calling Lark's `DELETE /im/v1/messages/:message_id` with the bot's tenant token — same null-graceful/try-catch/`console.error`-on-failure shape every other function in that file already uses. The `MESSAGE_DELETE` handler's existing `prisma.chatMessage.findUnique` already fetches the full row before deleting; after the local `prisma.chatMessage.delete(...)` succeeds, if that row had a `larkMessageId`, fire off `recallGroupMessage(...)` (fire-and-forget, using the deleting user's own `organizationId` off the socket — always correct here, since `MESSAGE_DELETE` only permits deleting your own message, and you can only have sent it from within your own org's room).

**3. Result.** Deleting your own message in a KaiSpace channel now also removes it from the mirrored Lark conversation, whenever Lark's own rules allow it.

## Error handling

- `recallGroupMessage` never throws — matches every other `larkIm.ts` function's contract (returns `false` and logs on any failure: no token, network error, Lark API rejection).
- A rejection from Lark (message too old, bot lacks the necessary group role, message already recalled, etc.) is expected and silent from the user's perspective — the local delete has already succeeded by the time recall is attempted, and is never rolled back or retried.
- No retry logic, no user-facing indication of whether the Lark-side recall succeeded or failed.

## Out of scope

- Recalling the *original* Lark message when a KaiSpace user deletes a message that arrived via the INBOUND direction (a real Lark user's own native message, mirrored into a KaiSpace channel via `deliverLarkMessageToChannel`) — that message was never "sent" by KaiSpace on Lark's side at all, so there is nothing for KaiSpace to recall. Deleting that local mirror only ever removes the KaiSpace-side copy.
- Syncing `MESSAGE_EDIT` to Lark — edits remain local-only, unchanged from today.
- `relayBroadcastToLark` (admin/CEO broadcast announcements) — a separate, always-bot-sent, one-way mechanism with no corresponding editable/deletable `ChatMessage` UI path exercised by this feature.
- Any admin UI or automated flow for granting the bot group-admin rights on Lark — that setup is manual, on the Lark side, done once by the room admin.
