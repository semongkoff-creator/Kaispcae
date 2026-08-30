# Bidirectional Lark Mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A KaiSpace channel-chat mention that gets relayed to Lark triggers a real Lark mention (notification + highlight), and a Lark-side mention of a KaiSpace-linked user relayed into KaiSpace triggers a real KaiSpace mention (highlight + "kamu disebut" notification) — both directions degrading gracefully to a plain name when the mentioned person can't be resolved.

**Architecture:** Outbound, `server/src/lib/larkChatSync.ts`'s `stripMentionTokens` (which today just discards the mentioned userId and sends a plain name) is replaced by an async resolver that batch-looks-up every mentioned user's `larkOpenId` in one query and builds Lark's real `<at user_id="...">Name</at>` mention tag for anyone who has one. Inbound, `server/src/lib/larkInbound.ts` reads the event's own `mentions` array (parallel to the placeholder tokens already embedded in the message text) and replaces each placeholder with KaiSpace's own `@[Name](userId)` token for anyone resolvable via `larkOpenId`, or a plain name otherwise. Both resolvers are internally failure-safe: a DB error degrades every mention in that one message to a plain name rather than throwing or leaking a raw placeholder.

**Tech Stack:** Prisma (`findMany`/`findUnique` on the existing `User.larkOpenId` field, no schema change), the existing raw-fetch Lark API pattern already used throughout `larkIm.ts`/`larkChatSync.ts` (no new dependency).

## Global Constraints

- Both directions are in scope, applying to the existing default-channel relay path — including thread replies, which already flow through the same `relayChannelMessageToLark`/`handleInboundLarkMessage` functions this plan modifies. No new relay entry point.
- An unresolvable mention (guest, no linked Lark account, not a group member) must ALWAYS degrade gracefully to plain text with the person's name — NEVER throw, NEVER block the rest of the message, NEVER leave a raw unresolved placeholder token visible to the end user.
- The KaiSpace mention token format `@[Name](userId)` must be constructed/parsed using the exact same pattern `client/src/utils/mentions.tsx`'s `MENTION_PATTERN` already uses — copied verbatim server-side (already the case for `larkChatSync.ts`'s existing `MENTION_TOKEN`; this plan reuses it, does not redefine it).
- Outbound batch-resolution must be ONE `prisma.user.findMany` call regardless of how many mentions are in a message — never one query per mention. Inbound mirrors the same discipline: one `prisma.user.findMany` regardless of mention count.
- Lark's real mention tag is `<at user_id="...">Name</at>`, embedded directly in the existing plain-string content — this requires NO change to `sendAsUser`/`sendGroupText`'s own signatures or `msg_type` handling; they already just forward whatever string they're given.
- Whether Lark rejects an outbound send outright when an `<at>` tag targets someone outside the destination group (versus silently rendering it as plain text on its own) is unconfirmed as of writing this plan — verify this empirically during manual testing, not by assumption. A single-retry-with-mentions-downgraded fallback is built in regardless of which way it turns out, since it's a no-cost safety net either way (it only fires after both existing identity-send attempts have already failed).
- Do not change sender attribution, thread-reply relay mechanics, `hadCaption` logic, or any other part of the existing relay pipeline beyond the mention-token transformation itself.
- Do not add a server-side "was I mentioned" check for KaiSpace's own native chat — that detection stays client-side only, unrelated to this feature.
- Do not touch `User.larkOpenId`'s own semantics or how/when it gets set.

---

### Task 1: Outbound mention resolution (KaiSpace → Lark)

**Files:**
- Modify: `server/src/lib/larkChatSync.ts`

**Interfaces:**
- Produces: `resolveMentionsForLark(text: string, prisma: PrismaClient): Promise<string>` (internal to this file, not exported — mirrors `stripMentionTokens`'s own current visibility); `stripMentionTokensToPlainText(text: string): string` (internal, the retry path's fully-downgraded fallback).
- Consumes: nothing from Task 2 (the two directions are independent).

- [ ] **Step 1: Replace `stripMentionTokens` with the two new functions**

Current (`server/src/lib/larkChatSync.ts`, around lines 124-135):
```ts
// The in-app chat input's mention autocomplete stores "@[Name](userId)" in
// the raw message text (see client/src/components/ui/ChatPanel.tsx's
// insertMention) — this app's own chat resolves it back to a highlighted
// "@Name" at RENDER time (client/src/utils/mentions.tsx), never storing the
// plain form. Lark has no idea about that token format, so without this it
// would receive the raw "@[Rizal Muzaki](cmabc123...) tes" literally. Same
// pattern, duplicated rather than shared, since mentions.tsx is a client
// (JSX) module the server can't import.
const MENTION_TOKEN = /@\[([^\]]+)\]\(([^)]+)\)/g;
function stripMentionTokens(text: string): string {
  return text.replace(MENTION_TOKEN, '@$1');
}
```

Replace with:
```ts
// The in-app chat input's mention autocomplete stores "@[Name](userId)" in
// the raw message text (see client/src/components/ui/ChatPanel.tsx's
// insertMention) — this app's own chat resolves it back to a highlighted
// "@Name" at RENDER time (client/src/utils/mentions.tsx), never storing the
// plain form. Lark has no idea about that token format on its own, so
// without translating it Lark would receive the raw
// "@[Rizal Muzaki](cmabc123...) tes" literally. Same MENTION_TOKEN pattern
// as client/src/utils/mentions.tsx's own MENTION_PATTERN, duplicated rather
// than shared, since mentions.tsx is a client (JSX) module the server can't
// import.
const MENTION_TOKEN = /@\[([^\]]+)\]\(([^)]+)\)/g;

// specs/2026-08-21-bidirectional-lark-mentions-design.md — every mention
// becomes a plain name, no <at> tags at all. Used as the retry path's
// fully-downgraded fallback (see relayChannelMessageToLark below) — kept
// separate from resolveMentionsForLark (which produces a MIX of real
// mentions and plain names) since the retry's whole point is to remove
// every possible cause of a rejected send, not just some of it.
function stripMentionTokensToPlainText(text: string): string {
  return text.replace(MENTION_TOKEN, '@$1');
}

// specs/2026-08-21-bidirectional-lark-mentions-design.md — resolves each
// mentioned KaiSpace user's OWN larkOpenId (one batched query, not one per
// mention) and constructs Lark's real <at user_id="..."> mention tag so
// that person gets an actual Lark notification/highlight, instead of just
// their name appearing as plain text. Falls back to a plain name for
// anyone with no linked Lark account. Never throws — a DB failure here
// degrades every mention in this one message to a plain name rather than
// blocking the caption send or the (independent) attachment relay that
// follows it in relayChannelMessageToLark.
async function resolveMentionsForLark(text: string, prisma: PrismaClient): Promise<string> {
  const matches = [...text.matchAll(MENTION_TOKEN)];
  if (matches.length === 0) return text;
  const userIds = [...new Set(matches.map((m) => m[2]))];
  let byId = new Map<string, { larkOpenId: string | null; displayName: string }>();
  try {
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, larkOpenId: true, displayName: true },
    });
    byId = new Map(users.map((u) => [u.id, u]));
  } catch (e) {
    console.error('[larkChatSync] mention lookup error (degrading to plain names):', e);
  }
  return text.replace(MENTION_TOKEN, (_match, name: string, userId: string) => {
    const u = byId.get(userId);
    if (u?.larkOpenId) return `<at user_id="${u.larkOpenId}">${u.displayName}</at>`;
    return `@${name}`;
  });
}
```

(No `organizationId` parameter, deliberately — `User.id` is already globally unique across the whole multi-tenant DB, and the mentioned userId came from KaiSpace's own already-org-scoped chat in the first place, so no additional org filter is needed on this lookup. This is unlike Task 2's inbound direction, where the identifier being looked up — a Lark open_id — genuinely could collide across orgs and does need the filter.)

- [ ] **Step 2: Widen `relayChannelMessageToLark`'s empty-check to not depend on mention resolution**

Current (`server/src/lib/larkChatSync.ts`, inside `relayChannelMessageToLark`):
```ts
  if (!channel.isDefault) return { textMessageId: null, attachmentMessageId: null };
  const trimmed = stripMentionTokens((text || '').trim());
```

Replace with:
```ts
  if (!channel.isDefault) return { textMessageId: null, attachmentMessageId: null };
  // specs/2026-08-21-bidirectional-lark-mentions-design.md — mention
  // resolution needs organizationId (resolved further down, from the
  // room), and is genuinely async (a DB lookup), so it can no longer
  // happen right here. This emptiness check only needs to know whether
  // there's any non-whitespace content at all — a mention token is never
  // itself whitespace, so checking the RAW trimmed text (before resolving
  // any mentions in it) produces the exact same true/false outcome as
  // checking the old stripped-to-plain-text version did.
  const trimmed = (text || '').trim();
```

- [ ] **Step 3: Resolve mentions right before the actual send, now that `organizationId` is known**

Current (`server/src/lib/larkChatSync.ts`, inside `relayChannelMessageToLark`, after `organizationId` is resolved from the room):
```ts
  const userToken = await getValidUserToken(senderId);

  // Caption text — same identity preference and fallback as before this
  // feature; unconditional on `attachment` being present or not.
  let textMessageId: string | null = null;
  if (trimmed) {
    // 1) Prefer the user's own identity.
    if (userToken) {
      textMessageId = await sendAsUser(map.chatId, trimmed, userToken);
      console.log('[diag-b4 out] sendAsUser ->', textMessageId ? `ok ${textMessageId}` : 'failed → bot fallback');
    }
    // 2) Fallback: bot + [Name] prefix (the original mechanism, never removed).
    if (!textMessageId) {
      textMessageId = await sendGroupText(map.chatId, `[${senderName}] ${trimmed}`, organizationId);
      console.log('[diag-b4 out] sendGroupText(bot) ->', textMessageId ? `ok ${textMessageId}` : 'FAILED (see [larkIm] error above)');
    }
    if (textMessageId) {
      // Fast in-memory guard first (beats the echo's round-trip), then the durable
      // row (survives a restart). A lost row only risks one echoed message.
      markSent(textMessageId);
      await prisma.larkSentMessage.create({ data: { messageId: textMessageId } }).catch(() => {});
    }
  }
```

Replace with:
```ts
  const userToken = await getValidUserToken(senderId);

  // Caption text — same identity preference and fallback as before this
  // feature; unconditional on `attachment` being present or not.
  let textMessageId: string | null = null;
  if (trimmed) {
    // specs/2026-08-21-bidirectional-lark-mentions-design.md — resolve
    // KaiSpace's own @[Name](userId) mention tokens into Lark's real
    // <at user_id="..."> mention syntax (or a plain name for anyone
    // without a linked Lark account) right before sending, now that
    // organizationId is known.
    const larkText = await resolveMentionsForLark(trimmed, prisma);
    // 1) Prefer the user's own identity.
    if (userToken) {
      textMessageId = await sendAsUser(map.chatId, larkText, userToken);
      console.log('[diag-b4 out] sendAsUser ->', textMessageId ? `ok ${textMessageId}` : 'failed → bot fallback');
    }
    // 2) Fallback: bot + [Name] prefix (the original mechanism, never removed).
    if (!textMessageId) {
      textMessageId = await sendGroupText(map.chatId, `[${senderName}] ${larkText}`, organizationId);
      console.log('[diag-b4 out] sendGroupText(bot) ->', textMessageId ? `ok ${textMessageId}` : 'FAILED (see [larkIm] error above)');
    }
    // 3) specs/2026-08-21-bidirectional-lark-mentions-design.md — if both
    // attempts above failed AND the text contained a real Lark mention
    // tag, retry once with every mention downgraded to plain text.
    // Whether Lark actually rejects an <at> tag for someone outside the
    // target group (as opposed to silently rendering it as plain text on
    // its own) is unconfirmed as of writing — this is a no-cost safety net
    // either way, since it only runs after both identity paths already
    // failed and can only rescue an otherwise fully-lost message.
    if (!textMessageId && larkText.includes('<at ')) {
      const plainText = stripMentionTokensToPlainText(trimmed);
      textMessageId = await sendGroupText(map.chatId, `[${senderName}] ${plainText}`, organizationId);
      console.log('[diag-b4 out] retry with mentions downgraded ->', textMessageId ? `ok ${textMessageId}` : 'still failed');
    }
    if (textMessageId) {
      // Fast in-memory guard first (beats the echo's round-trip), then the durable
      // row (survives a restart). A lost row only risks one echoed message.
      markSent(textMessageId);
      await prisma.larkSentMessage.create({ data: { messageId: textMessageId } }).catch(() => {});
    }
  }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS. Slow on this machine — 3-5+ minutes. If the Prisma client seems stale, run `npx prisma generate --schema=server/prisma/schema.prisma` first, then retype (this plan doesn't touch the schema, so this shouldn't actually be needed, but is a known fallback from earlier in this session).

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/larkChatSync.ts
git commit -m "feat: relay real Lark mention tags for outbound KaiSpace chat mentions"
```

---

### Task 2: Inbound mention resolution (Lark → KaiSpace)

**Files:**
- Modify: `server/src/lib/larkInbound.ts`

**Interfaces:**
- Produces: `resolveLarkMentionsForKaiSpace(rawText: string, mentions: Array<{key: string; id: {open_id?: string}; name: string}> | undefined, organizationId: string, prisma: PrismaClient): Promise<string>` (internal to this file).
- Consumes: nothing from Task 1.

- [ ] **Step 1: Add the resolver function**

Current (`server/src/lib/larkInbound.ts`, top of file):
```ts
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server } from 'socket.io';
import { getPrisma } from './prisma';
import { sanitizeChat } from '../middleware/validate';
import { getUserName, downloadMessageResourceToFile } from './larkIm';
import { deliverLarkMessageToChannel, getLarkRelayUserId, wasRecentlySentByUs } from './larkChatSync';
import { ensureRoomFolder, uploadFileFromPath } from './larkDrive';

// Text, file, and image messages are delivered —
// specs/2026-08-21-lark-inbound-file-sync-design.md; sticker/audio/video/media
// and merged-forward sub-messages stay unsupported (Lark's own
// resource-download API doesn't cover stickers either, and the others
// aren't asked for). Module-scoped so it's built once, not on every event.
const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'file', 'image']);
```

Replace with:
```ts
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { getPrisma } from './prisma';
import { sanitizeChat } from '../middleware/validate';
import { getUserName, downloadMessageResourceToFile } from './larkIm';
import { deliverLarkMessageToChannel, getLarkRelayUserId, wasRecentlySentByUs } from './larkChatSync';
import { ensureRoomFolder, uploadFileFromPath } from './larkDrive';

// Text, file, and image messages are delivered —
// specs/2026-08-21-lark-inbound-file-sync-design.md; sticker/audio/video/media
// and merged-forward sub-messages stay unsupported (Lark's own
// resource-download API doesn't cover stickers either, and the others
// aren't asked for). Module-scoped so it's built once, not on every event.
const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'file', 'image']);

// specs/2026-08-21-bidirectional-lark-mentions-design.md — a Lark
// im.message.receive_v1 text message's `content.text` embeds mention
// PLACEHOLDERS (e.g. "@_user_1"), resolved via a same-indexed `mentions`
// array on the event's own `message` object — confirmed against the
// installed SDK's own event type (node_modules/@larksuiteoapi/node-sdk's
// types/index.d.ts, the "im.message.receive_v1" event body's
// `message.mentions?: Array<{ key, id: { open_id, ... }, name, ... }>`).
// This resolves each placeholder into KaiSpace's own @[Name](userId) token
// format for anyone who's a KaiSpace member in this org (via larkOpenId),
// so the relayed message gets the exact same highlight + "kamu disebut"
// notification a native KaiSpace mention gets — or a plain "@Name" (Lark's
// own provided name) for anyone who isn't, mirroring the same
// "resolve if possible, else degrade to a name, never throw" posture this
// file already uses for sender attribution just below. One batched query
// regardless of mention count, and never throws — a DB failure degrades
// EVERY mention in this one message to its plain Lark-provided name
// (never leaving Lark's raw "@_user_1"-style placeholder visible, which
// would happen if this function let an exception escape and the caller
// left rawText untouched).
async function resolveLarkMentionsForKaiSpace(
  rawText: string,
  mentions: Array<{ key: string; id: { open_id?: string }; name: string }> | undefined,
  organizationId: string,
  prisma: PrismaClient,
): Promise<string> {
  if (!mentions || mentions.length === 0) return rawText;
  const openIds = [...new Set(mentions.map((m) => m.id?.open_id).filter((id): id is string => !!id))];
  let byOpenId = new Map<string, { id: string; displayName: string }>();
  if (openIds.length) {
    try {
      const users = await prisma.user.findMany({
        where: { larkOpenId: { in: openIds }, organizationId },
        select: { id: true, larkOpenId: true, displayName: true },
      });
      byOpenId = new Map(users.map((u) => [u.larkOpenId as string, u]));
    } catch (e) {
      console.error('[larkInbound] mention lookup error (degrading to plain names):', e);
    }
  }
  let text = rawText;
  for (const m of mentions) {
    const u = m.id?.open_id ? byOpenId.get(m.id.open_id) : undefined;
    const replacement = u ? `@[${u.displayName}](${u.id})` : `@${m.name}`;
    text = text.split(m.key).join(replacement);
  }
  return text;
}
```

(`text.split(m.key).join(replacement)` rather than `text.replace(m.key, replacement)` — deliberate: `String.prototype.replace`'s replacement-string argument interprets special patterns like `$&`/`$1` even when the search value is a plain string, not a regex; a resolved `displayName` or Lark-provided `name` could coincidentally contain a `$` character, and split/join is immune to that gotcha since it does a pure literal substitution.)

- [ ] **Step 2: Call the resolver before `sanitizeChat`**

Current (`server/src/lib/larkInbound.ts`, inside `handleInboundLarkMessage`):
```ts
  try {
    const content = JSON.parse(msg.content || '{}');
    if (msg.message_type === 'text') {
      rawText = content?.text ?? '';
    } else if (msg.message_type === 'file') {
      resourceKey = content?.file_key ?? null;
      resourceFileName = content?.file_name ?? null;
      resourceType = 'file';
    } else if (msg.message_type === 'image') {
      resourceKey = content?.image_key ?? null;
      resourceType = 'image';
    }
  } catch {
    rawText = '';
  }
  let text = sanitizeChat(rawText);
```

Replace with:
```ts
  try {
    const content = JSON.parse(msg.content || '{}');
    if (msg.message_type === 'text') {
      rawText = content?.text ?? '';
    } else if (msg.message_type === 'file') {
      resourceKey = content?.file_key ?? null;
      resourceFileName = content?.file_name ?? null;
      resourceType = 'file';
    } else if (msg.message_type === 'image') {
      resourceKey = content?.image_key ?? null;
      resourceType = 'image';
    }
  } catch {
    rawText = '';
  }
  // specs/2026-08-21-bidirectional-lark-mentions-design.md — resolve
  // Lark's own inbound mention placeholders into KaiSpace's own token
  // format before sanitizeChat runs, so a relayed mention gets the exact
  // same highlight + "kamu disebut" notification a native KaiSpace mention
  // gets. msg.mentions is only ever meaningful for text messages — a
  // file/image message's content has no mention placeholders to resolve.
  if (msg.message_type === 'text' && rawText) {
    rawText = await resolveLarkMentionsForKaiSpace(rawText, msg.mentions, organizationId, prisma);
  }
  let text = sanitizeChat(rawText);
```

(`prisma` is already in scope at this point in the function — it was assigned via `const prisma = getPrisma();` earlier, well before this block. `organizationId` is a parameter of `handleInboundLarkMessage` itself, in scope throughout.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS. Slow on this machine — 3-5+ minutes.

- [ ] **Step 4: Commit**

```bash
git add server/src/lib/larkInbound.ts
git commit -m "feat: resolve inbound Lark mention placeholders into real KaiSpace mentions"
```

---

## Final Verification

- [ ] `npm run typecheck --workspace=server` — PASS, zero errors.
- [ ] `git log --oneline -2` — confirm both commits above exist in order.

## Manual Testing After Deploy

1. A KaiSpace user mentions another KaiSpace user who HAS a linked Lark account, in a channel chat message relayed to Lark. Confirm that person gets a real Lark mention notification/highlight in the Lark group — not just their name appearing as plain text.
2. A KaiSpace user mentions someone with NO linked Lark account. Confirm the message still relays fine with just their plain name — no error, no broken/missing send.
3. Someone in the Lark group mentions a KaiSpace-linked user by name (native Lark @-mention). Confirm the relayed KaiSpace message shows a real highlighted mention, and the mentioned person gets KaiSpace's own "kamu disebut" browser notification.
4. Someone in Lark mentions a person with NO matching KaiSpace account (or someone outside this org). Confirm the relayed message shows their Lark-provided name as plain text — no raw `@_user_1`-style placeholder leaking through, no crash.
5. A message with MULTIPLE mentions (a mix of resolved and unresolved people) in one message, tested in both directions. Confirm each mention resolves independently and correctly — the resolved ones become real mentions, the unresolved ones become plain names, in the same message.
6. A mention inside a THREAD REPLY, both directions. Confirm it's handled identically to a top-level channel message (thread replies already flow through the same relay functions this plan modifies).
7. A message with ZERO mentions. Confirm it relays exactly as it did before this feature, both directions — no behavior change.
8. Specifically test what happens when an outbound `<at user_id="...">` tag targets someone who is NOT a member of the destination Lark group. Confirm which of the two possible Lark behaviors is real — "silently downgrades that one mention to plain text on its own" or "rejects the whole send" — and if it's the latter, confirm the implemented single-retry-with-mentions-downgraded fallback actually recovers and the message still gets delivered (as plain text) rather than being lost entirely.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-21-bidirectional-lark-mentions-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
