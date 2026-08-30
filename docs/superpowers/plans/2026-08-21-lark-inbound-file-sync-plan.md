# Deliver Lark File/Image Messages into KaiSpace Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a file or image is sent natively in a Lark group chat mapped to a KaiSpace room, deliver it into that room's default channel as a real chat attachment, stored directly in the room's existing Lark Drive folder.

**Architecture:** Widen the inbound sync's message-type gate to accept `file`/`image` alongside `text`; download the resource off the Lark message via a new low-level API function, stage it in a local temp file, push it into the room's already-existing Lark Drive folder via the already-existing `ensureRoomFolder`/`uploadFileFromPath`, then deliver it on the `ChatMessage` the same way a native KaiSpace attachment already works.

**Tech Stack:** Express, Prisma, Socket.IO, `@larksuiteoapi/node-sdk`'s underlying REST API (`GET /im/v1/messages/:message_id/resources/:file_key`, called via `fetch` matching every other `larkIm.ts` function's convention), Node's `fs/promises` + `os.tmpdir()`.

## Global Constraints

- Supported `message_type`s are `file` and `image` ONLY — sticker/audio/video/media/merged-forward messages stay out of scope, unchanged from today's silent-drop behavior.
- When Lark Drive isn't enabled for the org, the file portion is silently skipped, but any accompanying text on the same message still delivers normally — the whole message must NOT be dropped just because the file part failed.
- No size limit is added beyond what Lark's own resource-download endpoint already enforces (100MB).
- File type is NOT re-validated against KaiSpace's own upload allowlist — a file that came through Lark's own system is trusted as-is.
- The downloaded file is written to a local temp file, uploaded to the room's existing Lark Drive folder via the existing `ensureRoomFolder`/`uploadFileFromPath` functions (do not modify `larkDrive.ts`), and the temp file is deleted immediately after, regardless of success or failure — never left on disk.
- Any download-or-upload failure is logged and degrades gracefully: skips the file, never blocks/corrupts an accompanying text portion, never crashes the inbound handler.
- Images without a filename in their Lark event get a synthesized default filename rather than a blank/undefined one.
- The resulting `attachmentUrl` is in the exact `/api/files/<fileToken>` shape the existing `GET /api/files/:token` route already expects — no client-side or route changes needed.
- No local dev database/server this session — `npm run typecheck --workspace=server` is the verification gate for every task. This typecheck is slow on this machine (3-5+ minutes) — let it run to completion. Live end-to-end verification (does a real Lark file actually arrive as a KaiSpace attachment) can only happen after deploy — see "Manual Testing After Deploy" at the end.

---

## File Structure

- `server/src/lib/larkIm.ts` — new `downloadMessageResource()`, a pure Lark API wrapper (download bytes, no side effects) — matches this file's existing "Lark IM API calls" responsibility.
- `server/src/lib/larkChatSync.ts` — `deliverLarkMessageToChannel()` gains an optional attachment parameter.
- `server/src/lib/larkInbound.ts` — the only orchestration point (type gate, content branching, temp-file staging, Drive upload, cleanup) — kept here rather than a new file, since it has exactly one caller and already branches on message content.

---

### Task 1: downloadMessageResource in larkIm.ts

**Files:**
- Modify: `server/src/lib/larkIm.ts` (append one new export)

**Interfaces:**
- Produces: `export async function downloadMessageResource(messageId: string, fileKey: string, type: 'image' | 'file', organizationId: string): Promise<Buffer | null>` — consumed by Task 3.

- [ ] **Step 1: Add downloadMessageResource**

Add this at the end of `server/src/lib/larkIm.ts` (after the existing `recallGroupMessage` function):

```ts

// Pull a file/image resource off an already-received Lark message — Lark's
// im.v1.message.resource.get endpoint (confirmed via the installed SDK's
// own bundled documentation), distinct from Lark Drive's own file API
// (larkDrive.ts): this is how you get bytes OFF a chat message, a required
// first step before larkInbound.ts can push them INTO Drive. `type` must
// match the resource's actual kind ('image' for an image message's
// image_key, 'file' for a file message's file_key) — Lark rejects a
// mismatched type. Capped at 100MB by Lark itself; does not support
// sticker resources. Returns the raw bytes or null on any failure —
// null-graceful like every other function here.
export async function downloadMessageResource(messageId: string, fileKey: string, type: 'image' | 'file', organizationId: string): Promise<Buffer | null> {
  const token = await getTenantToken(organizationId);
  if (!token) return null;
  try {
    const res = await fetch(
      `${LARK_OPENAPI_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      console.error('[larkIm] downloadMessageResource failed:', res.status);
      return null;
    }
    const contentType = res.headers.get('content-type') || '';
    // A Lark API error comes back as JSON with this content-type instead of
    // file bytes — treat it as failure rather than returning the error blob
    // as if it were the file (same defensive check larkDrive.ts's
    // openDownloadStream already uses for its own Drive-download endpoint).
    if (contentType.includes('application/json')) {
      const j: any = await res.json().catch(() => ({}));
      console.error('[larkIm] downloadMessageResource returned error json:', j?.code, j?.msg);
      return null;
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (e) {
    console.error('[larkIm] downloadMessageResource error:', e);
    return null;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS. This can take 3-5+ minutes on this machine — let it run to completion.

- [ ] **Step 3: Commit**

```bash
git add server/src/lib/larkIm.ts
git commit -m "feat: add downloadMessageResource for pulling files off Lark messages"
```

---

### Task 2: deliverLarkMessageToChannel accepts an optional attachment

**Files:**
- Modify: `server/src/lib/larkChatSync.ts:48-69` (`deliverLarkMessageToChannel`)

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `deliverLarkMessageToChannel(io, prisma, channel, senderId, text, attachment?: { url: string; name: string }): Promise<void>` (was 5 required params, no attachment) — consumed by Task 3.

- [ ] **Step 1: Extend the function**

Current (`server/src/lib/larkChatSync.ts:48-69`):

```ts
export async function deliverLarkMessageToChannel(
  io: Server,
  prisma: PrismaClient,
  channel: { id: string; name: string; roomId: string },
  senderId: string,
  text: string,
): Promise<void> {
  const conversationId2 = await ensureGroupConversation(prisma, channel);
  const message = await prisma.chatMessage.create({
    data: { channelId: channel.id, conversationId2, senderId, text },
    include: { sender: { select: { displayName: true } } },
  });
  const dto: ChannelMessage = {
    id: message.id,
    channelId: message.channelId ?? undefined,
    senderId: message.senderId,
    senderName: message.sender.displayName,
    text: message.text,
    createdAt: message.createdAt.getTime(),
  };
  io.to(`channel:${channel.id}`).emit(SocketEvents.CHANNEL_MESSAGE_NEW, dto);
}
```

Replace with:

```ts
export async function deliverLarkMessageToChannel(
  io: Server,
  prisma: PrismaClient,
  channel: { id: string; name: string; roomId: string },
  senderId: string,
  text: string,
  // specs/2026-08-21-lark-inbound-file-sync-design.md — set when
  // larkInbound.ts successfully staged a file/image message into the
  // room's Lark Drive folder. url is already in the exact /api/files/<token>
  // shape GET /api/files/:token expects, same as a native KaiSpace upload.
  attachment?: { url: string; name: string },
): Promise<void> {
  const conversationId2 = await ensureGroupConversation(prisma, channel);
  const message = await prisma.chatMessage.create({
    data: {
      channelId: channel.id, conversationId2, senderId, text,
      attachmentUrl: attachment?.url ?? null,
      attachmentName: attachment?.name ?? null,
    },
    include: { sender: { select: { displayName: true } } },
  });
  const dto: ChannelMessage = {
    id: message.id,
    channelId: message.channelId ?? undefined,
    senderId: message.senderId,
    senderName: message.sender.displayName,
    text: message.text,
    createdAt: message.createdAt.getTime(),
    attachmentUrl: message.attachmentUrl ?? undefined,
    attachmentName: message.attachmentName ?? undefined,
  };
  io.to(`channel:${channel.id}`).emit(SocketEvents.CHANNEL_MESSAGE_NEW, dto);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/lib/larkChatSync.ts
git commit -m "feat: let deliverLarkMessageToChannel carry an attachment"
```

---

### Task 3: Wire file/image handling into handleInboundLarkMessage

**Files:**
- Modify: `server/src/lib/larkInbound.ts` (imports, the type gate, content extraction, delivery call)

**Interfaces:**
- Consumes: `downloadMessageResource` (Task 1, from `./larkIm`); `deliverLarkMessageToChannel`'s new `attachment` param (Task 2, from `./larkChatSync`); `ensureRoomFolder`, `uploadFileFromPath` (pre-existing, from `./larkDrive`).
- Produces: no new exports — `handleInboundLarkMessage`'s own signature is unchanged.

- [ ] **Step 1: Add the new imports**

Current (`server/src/lib/larkInbound.ts:1-5`):

```ts
import { Server } from 'socket.io';
import { getPrisma } from './prisma';
import { sanitizeChat } from '../middleware/validate';
import { getUserName } from './larkIm';
import { deliverLarkMessageToChannel, getLarkRelayUserId, wasRecentlySentByUs } from './larkChatSync';
```

Replace with:

```ts
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server } from 'socket.io';
import { getPrisma } from './prisma';
import { sanitizeChat } from '../middleware/validate';
import { getUserName, downloadMessageResource } from './larkIm';
import { deliverLarkMessageToChannel, getLarkRelayUserId, wasRecentlySentByUs } from './larkChatSync';
import { ensureRoomFolder, uploadFileFromPath } from './larkDrive';
```

- [ ] **Step 2: Widen the type gate**

Current (`server/src/lib/larkInbound.ts:25-29`):

```ts
  // Group text only. p2p (DM) and non-text are explicitly out of scope.
  if (msg.chat_type !== 'group' || msg.message_type !== 'text') {
    console.log('[diag-b4 in] dropped: not group-text', msg?.chat_type, msg?.message_type);
    return;
  }
```

Replace with:

```ts
  // Group chat only (p2p/DM out of scope). Text, file, and image messages
  // are delivered — specs/2026-08-21-lark-inbound-file-sync-design.md;
  // sticker/audio/video/media and merged-forward sub-messages stay
  // unsupported (Lark's own resource-download API doesn't cover stickers
  // either, and the others aren't asked for).
  const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'file', 'image']);
  if (msg.chat_type !== 'group' || !SUPPORTED_MESSAGE_TYPES.has(msg.message_type)) {
    console.log('[diag-b4 in] dropped: not group-text/file/image', msg?.chat_type, msg?.message_type);
    return;
  }
```

- [ ] **Step 3: Branch content extraction by message type**

Current (`server/src/lib/larkInbound.ts:91-99`):

```ts
  // Message content is a JSON string {"text":"..."}.
  let rawText = '';
  try {
    rawText = JSON.parse(msg.content || '{}')?.text ?? '';
  } catch {
    rawText = '';
  }
  let text = sanitizeChat(rawText);
  if (!text) return;
```

Replace with:

```ts
  // Message content is a JSON string whose shape depends on message_type:
  // {"text":"..."} for text, {"file_key":"...","file_name":"..."} for
  // file, {"image_key":"..."} for image (images don't reliably carry a
  // filename — one is synthesized below when staging the attachment).
  let rawText = '';
  let resourceKey: string | null = null;
  let resourceType: 'image' | 'file' | null = null;
  let resourceFileName: string | null = null;
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
  // Unlike the old text-only path, an empty caption must NOT bail out here
  // — a file/image message can legitimately have no accompanying text and
  // still have something to deliver.
  if (!text && !resourceKey) return;
```

- [ ] **Step 4: Stage the attachment into the room's Lark Drive folder**

Current (`server/src/lib/larkInbound.ts:101-121`, the sender-attribution block through the final delivery call):

```ts
  // Attribute the sender: prefer a real MeetKai account (name + avatar render
  // correctly for free), else the relay bot with the Lark name prefixed.
  // Per-org (Addendum A1) — larkOpenId is globally unique and open_ids are
  // per-Lark-app, so a real cross-org collision is very unlikely, but this
  // mirrors the same org-scoping analyticsSweep.ts's equivalent lookup
  // already applies (Plan A Task 8) rather than leaving this one lookup
  // as the odd one out.
  const openId: string | undefined = event?.sender?.sender_id?.open_id;
  let senderId: string | null = null;
  if (openId) {
    const u = await prisma.user.findUnique({ where: { larkOpenId: openId, organizationId }, select: { id: true } });
    if (u) senderId = u.id;
  }
  if (!senderId) {
    senderId = await getLarkRelayUserId(prisma);
    const name = (openId ? await getUserName(openId, organizationId) : null) || 'Lark';
    text = sanitizeChat(`[${name}] ${text}`);
  }

  await deliverLarkMessageToChannel(io, prisma, channel, senderId, text);
}
```

Replace with:

```ts
  // Attribute the sender: prefer a real MeetKai account (name + avatar render
  // correctly for free), else the relay bot with the Lark name prefixed.
  // Per-org (Addendum A1) — larkOpenId is globally unique and open_ids are
  // per-Lark-app, so a real cross-org collision is very unlikely, but this
  // mirrors the same org-scoping analyticsSweep.ts's equivalent lookup
  // already applies (Plan A Task 8) rather than leaving this one lookup
  // as the odd one out.
  const openId: string | undefined = event?.sender?.sender_id?.open_id;
  let senderId: string | null = null;
  if (openId) {
    const u = await prisma.user.findUnique({ where: { larkOpenId: openId, organizationId }, select: { id: true } });
    if (u) senderId = u.id;
  }
  if (!senderId) {
    senderId = await getLarkRelayUserId(prisma);
    const name = (openId ? await getUserName(openId, organizationId) : null) || 'Lark';
    text = sanitizeChat(`[${name}] ${text}`);
  }

  // specs/2026-08-21-lark-inbound-file-sync-design.md — download the
  // resource off the Lark message, stage it in a local temp file, and push
  // it into the room's EXISTING Lark Drive folder (never onto KaiSpace's
  // own persistent storage). Any failure here (Drive not enabled for this
  // org, download error, upload error) just leaves `attachment` unset —
  // an accompanying text caption still delivers normally either way.
  let attachment: { url: string; name: string } | undefined;
  if (resourceKey && resourceType) {
    const folderToken = await ensureRoomFolder(channel.roomId);
    if (!folderToken) {
      console.log('[diag-b4 in] Drive not enabled for room, skipping attachment', channel.roomId);
    } else {
      const buffer = await downloadMessageResource(messageId, resourceKey, resourceType, organizationId);
      if (buffer) {
        const resolvedName = resourceFileName || (resourceType === 'image' ? 'gambar.jpg' : 'file');
        const tempPath = path.join(tmpdir(), `${randomUUID()}-${resolvedName}`);
        try {
          await writeFile(tempPath, buffer);
          const fileToken = await uploadFileFromPath(folderToken, resolvedName, tempPath, organizationId);
          if (fileToken) {
            attachment = { url: `/api/files/${fileToken}`, name: resolvedName };
          } else {
            console.error('[diag-b4 in] Drive upload failed for message', messageId);
          }
        } catch (e) {
          console.error('[diag-b4 in] attachment staging error:', e);
        } finally {
          await unlink(tempPath).catch(() => {});
        }
      } else {
        console.error('[diag-b4 in] resource download failed for message', messageId);
      }
    }
  }
  // Both the caption and the attachment failed/were absent — nothing to
  // deliver (e.g. an image with no caption in a room with Drive disabled).
  if (!text && !attachment) return;

  await deliverLarkMessageToChannel(io, prisma, channel, senderId, text, attachment);
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/larkInbound.ts
git commit -m "feat: deliver Lark file/image messages into KaiSpace chat via Lark Drive"
```

---

## Final Verification

- [ ] Run `npm run typecheck --workspace=server` once more from a clean state (all 3 tasks applied) — expect PASS with zero errors.
- [ ] `git log --oneline -3` — confirm the 3 commits above exist in order.

## Manual Testing After Deploy

1. Deploy (no migration this time — no schema change).
2. In a Lark group already mapped to a KaiSpace room (via `RoomChatMap`) with Lark Drive already enabled for that org, send a plain file (e.g. a PDF). Confirm it appears in KaiSpace's channel chat as a downloadable/previewable attachment.
3. Send an image the same way. Confirm it renders as an image attachment (inline preview via `AttachmentLightbox`, same as a native KaiSpace image upload).
4. Send a file WITH caption text in the same Lark message. Confirm both the text and the attachment appear together on the same KaiSpace message.
5. In a room where Lark Drive is NOT enabled, send a file. Confirm no error/crash server-side, and — if that message also had text — confirm the text still comes through normally (only the file portion is silently skipped).
6. Send a sticker, or a file larger than 100MB, and confirm it's silently skipped with no crash — check server logs for the specific reason (`resource download failed`, Drive not enabled, etc.).
7. Send a few plain text messages (no file) and confirm they still behave exactly as before this change — no regression to the existing text-only inbound sync.
