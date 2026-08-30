# Bidirectional Lark Mentions — Design

## Goal

Mentioning someone by name in a KaiSpace channel chat that's relayed to Lark should trigger a REAL Lark mention (notification + highlight) for that person, not just plain text with their name in it. Symmetrically, being mentioned in the Lark group should trigger a REAL KaiSpace mention (the existing highlight + "kamu disebut" browser notification) when that message is relayed into KaiSpace, not an unresolved raw placeholder. Both directions degrade gracefully to plain text when the mentioned person can't be resolved (a guest, someone not linked to Lark, or someone not in the target group) — that's an accepted, non-error outcome, not something to special-case or crash on.

## Context

Direct codebase checks (not assumptions) found:

- **KaiSpace's own mention token**: `@[Name](userId)`, inserted by the chat input's autocomplete (`client/src/components/ui/ChatPanel.tsx`'s `insertMention`), matched by `MENTION_PATTERN` in `client/src/utils/mentions.tsx`. `textMentionsUser(text, userId)` does a simple userId-equality scan over every match — this is what drives both the amber "you were mentioned" highlight and the browser notification, and it is **entirely client-side** (no server-side "was I mentioned" check exists anywhere in `server/src`).
- **Outbound today (KaiSpace → Lark)**: `larkChatSync.ts`'s `stripMentionTokens` regex-replaces every `@[Name](userId)` token with plain `@$1` — the `userId` is discarded entirely. This is the whole of today's outbound mention handling: a mentioned Lark user gets their name in the text, nothing else. No Lark API call in this codebase constructs a real mention tag today.
- **Inbound today (Lark → KaiSpace)**: `larkInbound.ts`'s `handleInboundLarkMessage` takes a text message's `content.text` as-is (`rawText = content?.text ?? ''`) and never reads the event's parallel `mentions` array at all (confirmed: no reference to it anywhere in `server/src`). Lark represents an inbound mention as a literal placeholder token (e.g. `@_user_1`) inside `text`, resolved via a same-indexed `mentions` array (`{key: '@_user_1', id: {open_id, ...}, name, tenant_key}`) — today that placeholder arrives in KaiSpace completely unresolved and meaningless to a reader.
- **The open_id ↔ KaiSpace user lookup already exists and is reused throughout this session's Lark work**: `prisma.user.findUnique({ where: { larkOpenId: openId, organizationId }, select: { id: true } })`, used at `larkInbound.ts:164` to attribute an inbound message's sender. This is the natural building block for resolving an inbound mention too.
- **The existing "resolve if possible, else degrade to a name in the text, never throw" precedent**: when an inbound sender's `open_id` doesn't resolve to any KaiSpace account, `larkInbound.ts` falls back to a synthetic relay account and rewrites the text as `[Name] ...` using whatever name Lark provided. This is the precedent this feature's own fallback behavior mirrors.
- **Lark's real mention syntax for a `msg_type: 'text'` message is `<at user_id="ou_xxx">Name</at>` embedded directly in the `content.text` string** — this is Lark/Feishu's standard, publicly documented mention syntax for outbound text messages, requiring no new `msg_type` and no change to the existing `sendAsUser`/`sendGroupText` functions' own signatures (they already just take a plain string and JSON-encode it as `{text}` — the string itself carrying the `<at>` markup is all that's needed).
- **Aside, not part of this feature**: while researching this, some large, clearly-foreign helper functions (`composeMentionsTextPrefix`, `markdownToPost`, etc., with comments referencing an unrelated project) were found inside the installed `@larksuiteoapi/node-sdk` package under `node_modules`, unused by this codebase. Flagging this as a curiosity worth a separate look sometime — it's not wired into the app and not relevant to this feature, so it's being left alone here.

## Scope (confirmed with user)

- **Both directions** are in scope: Lark mention → KaiSpace mention, and KaiSpace mention → Lark mention.
- Applies to the same channel-chat relay path already in place (default channel only, including thread replies — thread replies already flow through the same relay function).
- **Graceful degradation is the explicit, accepted behavior** for an unresolvable mention in either direction (mentioned person is a guest, has no linked Lark account, or isn't a member of the target Lark group) — falls back to plain text with the person's name, never an error, never a broken message.
- One open technical question to verify empirically during implementation (not a product decision): whether Lark silently downgrades an `<at user_id="...">` tag to plain text when that user isn't a member of the target group, or rejects the whole send. The design below builds in a defensive fallback for either outcome.

## Design

### Inbound (Lark → KaiSpace)

`larkInbound.ts`'s `handleInboundLarkMessage`, for `message_type === 'text'`, currently reads only `content.text`. This adds reading the event's own `mentions` array (each entry: `{key, id: {open_id}, name}`) alongside it. For every mention entry:

1. Look up `prisma.user.findUnique({ where: { larkOpenId: entry.id.open_id, organizationId }, select: { id: true } })` — the exact existing lookup pattern, reused, not reinvented.
2. If found: replace that mention's placeholder (`entry.key`, e.g. `@_user_1`) in the raw text with KaiSpace's own token format, `@[DisplayName](userId)` — using the resolved KaiSpace user's own `displayName`, so the existing render/highlight/notification pipeline (`textMentionsUser`, `renderWithMentions`) picks it up with zero client-side changes.
3. If not found (not a KaiSpace member, no linked account): replace the placeholder with plain `@Name` (Lark's own provided name), matching the existing "can't resolve → plain text with a name" precedent.

This replacement happens before the existing `sanitizeChat` call, so the final text still gets the same sanitization pass as every other inbound message, regardless of how many mentions were or weren't resolved.

### Outbound (KaiSpace → Lark)

`larkChatSync.ts`'s `stripMentionTokens` is replaced by an async resolver (the function fundamentally changes what it does, not just how — renamed accordingly). For a piece of outbound text:

1. Collect every `@[Name](userId)` token's `userId` in the text.
2. One batched `prisma.user.findMany({ where: { id: { in: [...] } }, select: { id: true, larkOpenId: true, displayName: true } })` — a single query regardless of how many mentions are in the message, not one lookup per mention.
3. For each token: if the corresponding user has a `larkOpenId`, replace with `<at user_id="{larkOpenId}">{displayName}</at>`. If not (no linked Lark account), replace with plain `@{displayName}`.
4. The resulting string is what gets sent via the existing `sendAsUser`/`sendGroupText` — neither of those functions needs to change; they already just forward whatever string they're given.

If sending a message containing an `<at>` tag for someone outside the target group turns out to make Lark reject the whole send (rather than silently degrading that one mention to plain text) — verified during implementation — the send is retried once with that specific mention downgraded to plain text before giving up, so a single unresolvable mention never blocks an otherwise-deliverable message.

## Error handling

- Any lookup failure, missing `larkOpenId`, or cross-org mismatch: that one mention degrades to plain text with a name. Never blocks the rest of the message, never throws.
- If Lark rejects an `<at>`-bearing send for a non-group-member (to be confirmed empirically): one retry with that mention downgraded to plain text, per the design above.
- No behavior change at all for a message with zero mentions in either direction.
- No behavior change to sender attribution, thread-reply handling, or any other part of the existing relay pipeline — this feature only touches how mention tokens/placeholders inside the text are transformed.

## Out of scope

- Zone/proximity chat or DMs — mentions there aren't relayed to Lark at all today (only the default channel is), and this feature doesn't change that.
- Any change to `User.larkOpenId`'s own semantics, how it gets set, or Lark login/OAuth.
- A server-side "was I mentioned" check for KaiSpace's own native chat (today's detection is client-side only) — unrelated to this feature, not being added here.
- The unrelated foreign SDK helper functions noted above — flagged for awareness only, not touched by this feature.
