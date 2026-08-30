# Relay KaiSpace Attachments into Lark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a KaiSpace user sends a file/image attachment in a channel chat message mapped to a Lark group, relay the attachment itself into Lark as a real image/file message — not just an accompanying caption's text, which already works today.

**Architecture:** Read the attachment's bytes from wherever KaiSpace actually stored them (Lark Drive or local disk), upload those bytes to Lark to get an `image_key`/`file_key`, then send a genuinely separate Lark message referencing that key — using the exact same sender-identity preference (as-user, falling back to as-bot) already established for text relay.

**Tech Stack:** Express, Prisma, `fetch` (raw REST calls matching every existing `larkIm.ts` function's convention — not the SDK's typed client), Node's `fs/promises` + `stream`.

## Global Constraints

- A Lark message can only carry ONE `msg_type` — a captioned attachment becomes TWO separate Lark messages (caption as text, attachment as image/file), never combined into one.
- `relayChannelMessageToLark`'s early-return-on-empty-text guard must change so an attachment-only message (empty caption, real attachment) still proceeds to relay the attachment, instead of returning `null` immediately.
- Attachment category mapping: `.jpg/.jpeg/.png/.gif/.webp` → Lark image upload (10MB cap); everything else KaiSpace already allows (`.pdf/.zip/.txt/.doc/.docx/.xlsx/.mp4/.webm/.mov/.avi`) → Lark file upload (30MB cap), using `file_type: 'mp4'` specifically for `.mp4` and `'stream'` for every other file-category extension.
- An attachment exceeding its category's size cap is skipped entirely (never attempted, never truncated) — any accompanying caption text still relays as its own independent send.
- Any read/upload/send failure for the attachment is logged and skipped — never blocks or corrupts an accompanying caption's relay, never crashes the handler.
- The attachment message's returned `message_id` is tracked into the existing anti-echo ledger (`markSent` + `prisma.larkSentMessage.create`) exactly like every other outbound send already is.
- `ChatMessage.larkMessageId` (used by the already-shipped recall feature) tracks the ATTACHMENT message's id when one was sent, falling back to the caption text message's id only when there was no attachment — confirmed with the room admin: when both exist, only the attachment is recallable via KaiSpace delete; the caption's own separate Lark message is not.
- No retry logic, no truncated-fallback upload, no user-facing success/failure indication.
- Do not modify `larkDrive.ts`. Do not touch `relayBroadcastToLark` or the `MESSAGE_EDIT` handler. Do not change KaiSpace's own upload allowlist, size limits, or storage backend selection.
- The local-disk attachment read MUST resolve the filename via `path.basename()` before ever joining it with `UPLOAD_DIR` — even though in this direction the filename originates from KaiSpace's own already-validated `ChatMessage.attachmentUrl` rather than an external untrusted source, treat it as untrusted anyway as a defense-in-depth default. (This session's sibling inbound-file-sync feature shipped a real, exploitable path-traversal Critical bug from skipping exactly this kind of sanitization — `routes/uploads.ts`'s own `GET /uploads/:filename` and `deleteUploadedFile` already both do this; mirror that exact pattern here, don't skip it.)
- No local dev database/server this session — `npm run typecheck --workspace=server` is the verification gate for every task. This typecheck is slow on this machine (3-5+ minutes) — let it run to completion. The Prisma client has gone stale multiple times today after unrelated schema changes — if typecheck fails on something unrelated to your own edits, run `npx prisma generate --schema=server/prisma/schema.prisma` first, then re-run. Live end-to-end verification (does a real attachment actually arrive in Lark) can only happen after deploy — see "Manual Testing After Deploy" at the end.

---

## File Structure

- `server/src/lib/larkIm.ts` — `uploadImageToLark`, `uploadFileToLark` (upload bytes, return a key), `sendAsUserAttachment`, `sendGroupAttachment` (send a message referencing a key, mirroring `sendAsUser`/`sendGroupText`'s existing per-identity split).
- `server/src/lib/larkChatSync.ts` — `readAttachmentBytes` (resolve a `ChatMessage.attachmentUrl` to raw bytes regardless of backend), `relayAttachmentToLark` (orchestrates category/size decision → upload → send → anti-echo tracking), and `relayChannelMessageToLark` gains an `attachment` parameter and calls the new orchestration.
- `server/src/socket/channelChatHandler.ts` — the `CHANNEL_MESSAGE_SEND` handler's one call site passes attachment info through.

---

### Task 1: readAttachmentBytes

**Files:**
- Modify: `server/src/lib/larkChatSync.ts` (imports, append one new function)

**Interfaces:**
- Consumes: `openDownloadStream` (pre-existing, from `./larkDrive`); `UPLOAD_DIR` (pre-existing export, from `../routes/uploads`).
- Produces: `readAttachmentBytes(attachmentUrl: string, organizationId: string): Promise<Buffer | null>` — consumed by Task 4.

- [ ] **Step 1: Add the new imports**

Current (`server/src/lib/larkChatSync.ts:1-8`):

```ts
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { SocketEvents, ChannelMessage } from '@virtualmeet/shared';
import { ensureGroupConversation } from './conversations';
import { sendGroupText, sendAsUser } from './larkIm';
import { getValidUserToken } from './larkUserToken';
import { DEFAULT_ORG_ID } from './defaultOrg';
```

Replace with:

```ts
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { SocketEvents, ChannelMessage } from '@virtualmeet/shared';
import { ensureGroupConversation } from './conversations';
import { sendGroupText, sendAsUser } from './larkIm';
import { getValidUserToken } from './larkUserToken';
import { DEFAULT_ORG_ID } from './defaultOrg';
import { openDownloadStream } from './larkDrive';
import { UPLOAD_DIR } from '../routes/uploads';
```

(This task deliberately imports ONLY what `readAttachmentBytes` itself needs. Task 4 adds a further import line for `uploadImageToLark`/`uploadFileToLark`/`sendAsUserAttachment`/`sendGroupAttachment` from `./larkIm` when it introduces `relayAttachmentToLark`, the first code in this file to actually call them — keeping this task's own typecheck genuinely self-contained and passing in isolation, not just "expected to fail until later.")

- [ ] **Step 2: Add readAttachmentBytes**

Add this at the end of `server/src/lib/larkChatSync.ts` (after the existing `relayBroadcastToLark` function):

```ts

// specs/2026-08-21-lark-outbound-file-sync-design.md — resolve a
// ChatMessage's attachmentUrl to raw bytes regardless of which backend
// KaiSpace actually stored it in. Mirrors the exact same two-shape
// branching routes/uploads.ts's existing deleteUploadedFile already does.
// Null-graceful: any read failure returns null rather than throwing, so a
// caller can treat "couldn't read the file" the same as "upload failed"
// and just skip the attachment.
export async function readAttachmentBytes(attachmentUrl: string, organizationId: string): Promise<Buffer | null> {
  try {
    if (attachmentUrl.startsWith('/api/files/')) {
      const token = attachmentUrl.slice('/api/files/'.length);
      const dl = await openDownloadStream(token, organizationId);
      if (!dl) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of Readable.fromWeb(dl.body as any)) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    }
    if (attachmentUrl.startsWith('/api/uploads/')) {
      // path.basename strips any directory components before this ever
      // touches the filesystem — defense in depth, matching the exact
      // pattern routes/uploads.ts's own GET /uploads/:filename and
      // deleteUploadedFile already use, even though this URL technically
      // only ever comes from KaiSpace's own already-validated ChatMessage
      // row rather than an external untrusted source.
      const filename = path.basename(attachmentUrl.slice('/api/uploads/'.length));
      const filePath = path.join(UPLOAD_DIR, filename);
      return await readFile(filePath);
    }
    // Unknown/unsupported locator shape (e.g. drive:<token>, which is only
    // ever used for recordings, not chat attachments).
    return null;
  } catch (e) {
    console.error('[larkChatSync] readAttachmentBytes error:', e);
    return null;
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS. `readAttachmentBytes` is unused by anything yet (Task 4 is its first caller), but that alone does not fail a typecheck — only genuinely missing/unresolvable imports would, and this task's import list only references things that already exist.

- [ ] **Step 4: Commit**

```bash
git add server/src/lib/larkChatSync.ts
git commit -m "feat: add readAttachmentBytes for outbound Lark attachment relay"
```

---

### Task 2: uploadImageToLark + uploadFileToLark

**Files:**
- Modify: `server/src/lib/larkIm.ts` (append two new exports)

**Interfaces:**
- Produces: `uploadImageToLark(buffer: Buffer, organizationId: string): Promise<string | null>`, `uploadFileToLark(buffer: Buffer, fileName: string, fileType: 'mp4' | 'stream', organizationId: string): Promise<string | null>` — consumed by Task 4.

- [ ] **Step 1: Add both upload functions**

Add this at the end of `server/src/lib/larkIm.ts` (after the existing `recallGroupMessage` function):

```ts

// specs/2026-08-21-lark-outbound-file-sync-design.md — upload bytes to
// Lark's im.v1.image endpoint to get an image_key usable in a msg_type:
// 'image' send. Confirmed against the installed SDK's own bundled doc
// comment for this exact endpoint (node_modules/@larksuiteoapi/node-sdk,
// project=im&resource=image&apiName=create): "上传图片接口，支持上传 JPEG、
// PNG、WEBP、GIF、TIFF、BMP、ICO格式图片" (JPEG/PNG/WEBP/GIF/TIFF/BMP/ICO
// only) and "图片大小不得超过10M，且不支持上传大小为0的图片" (max 10MB,
// empty images rejected) — the caller is responsible for the size/category
// check before calling this; this function does not re-validate either.
// `image_type: 'message'` (not 'avatar') is required for an image destined
// for a chat message. Null-graceful like every other function here.
export async function uploadImageToLark(buffer: Buffer, organizationId: string): Promise<string | null> {
  const token = await getTenantToken(organizationId);
  if (!token) return null;
  try {
    const form = new FormData();
    form.append('image_type', 'message');
    // `image` MUST come last (Lark parses multipart fields in order — same
    // requirement larkDrive.ts's own uploadAll already documents for its
    // own `file` field).
    form.append('image', new Blob([buffer as unknown as BlobPart]), 'image');
    const res = await fetch(`${LARK_OPENAPI_BASE}/im/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const j: any = await res.json();
    if (j?.code !== 0) {
      console.error('[larkIm] uploadImageToLark failed:', j?.code, j?.msg);
      return null;
    }
    return j?.data?.image_key ?? null;
  } catch (e) {
    console.error('[larkIm] uploadImageToLark error:', e);
    return null;
  }
}

// specs/2026-08-21-lark-outbound-file-sync-design.md — upload bytes to
// Lark's im.v1.file endpoint to get a file_key usable in a msg_type:
// 'file' send. Confirmed against the installed SDK's own bundled doc
// comment (project=im&resource=file&apiName=create): "上传文件，可以上传
// 视频，音频和常见的文件类型" (supports video/audio/common file types) and
// "文件大小不得超过30M，且不允许上传空文件" (max 30MB, empty files
// rejected) — the caller is responsible for the size/category check
// before calling this. `fileType` is the SDK's own documented enum
// ('opus'|'mp4'|'pdf'|'doc'|'xls'|'ppt'|'stream') — this feature only ever
// passes 'mp4' or the generic 'stream' fallback (see the caller in
// larkChatSync.ts for the exact extension-to-fileType mapping). Null-
// graceful like every other function here.
export async function uploadFileToLark(buffer: Buffer, fileName: string, fileType: 'mp4' | 'stream', organizationId: string): Promise<string | null> {
  const token = await getTenantToken(organizationId);
  if (!token) return null;
  try {
    const form = new FormData();
    form.append('file_type', fileType);
    form.append('file_name', fileName);
    // `file` MUST come last, same ordering requirement as uploadImageToLark
    // above and larkDrive.ts's own uploadAll.
    form.append('file', new Blob([buffer as unknown as BlobPart]), fileName);
    const res = await fetch(`${LARK_OPENAPI_BASE}/im/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const j: any = await res.json();
    if (j?.code !== 0) {
      console.error('[larkIm] uploadFileToLark failed:', j?.code, j?.msg);
      return null;
    }
    return j?.data?.file_key ?? null;
  } catch (e) {
    console.error('[larkIm] uploadFileToLark error:', e);
    return null;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/lib/larkIm.ts
git commit -m "feat: add uploadImageToLark and uploadFileToLark"
```

---

### Task 3: sendAsUserAttachment + sendGroupAttachment

**Files:**
- Modify: `server/src/lib/larkIm.ts` (append two new exports)

**Interfaces:**
- Produces: `sendAsUserAttachment(chatId: string, msgType: 'image' | 'file', content: { image_key: string } | { file_key: string }, userAccessToken: string): Promise<string | null>`, `sendGroupAttachment(chatId: string, msgType: 'image' | 'file', content: { image_key: string } | { file_key: string }, organizationId: string): Promise<string | null>` — consumed by Task 4.

- [ ] **Step 1: Add both send functions**

Add this at the end of `server/src/lib/larkIm.ts` (after `uploadFileToLark` from Task 2):

```ts

// specs/2026-08-21-lark-outbound-file-sync-design.md — send an
// already-uploaded image/file (by its key) as a real Lark message, AS THE
// USER (their own user_access_token — same identity-preference mechanism
// already established for text relay in larkChatSync.ts's
// relayChannelMessageToLark). Confirmed against the SDK's own message.create
// implementation that image/file sends go through the exact same
// POST /im/v1/messages endpoint sendAsUser (text) already uses — only
// msg_type and the shape of `content` differ. Returns the Lark message_id
// or null on any failure (caller falls back to sendGroupAttachment).
export async function sendAsUserAttachment(
  chatId: string,
  msgType: 'image' | 'file',
  content: { image_key: string } | { file_key: string },
  userAccessToken: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${LARK_OPENAPI_BASE}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userAccessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify(content),
      }),
    });
    const j: any = await res.json();
    if (j?.code !== 0) {
      console.error('[larkIm] sendAsUserAttachment failed:', j?.code, j?.msg);
      return null;
    }
    return j?.data?.message_id ?? null;
  } catch (e) {
    console.error('[larkIm] sendAsUserAttachment error:', e);
    return null;
  }
}

// Same as sendAsUserAttachment above, but AS THE BOT (tenant token) — the
// fallback path when the sender has no linked/valid Lark user token, same
// role sendGroupText already plays for text relay.
export async function sendGroupAttachment(
  chatId: string,
  msgType: 'image' | 'file',
  content: { image_key: string } | { file_key: string },
  organizationId: string,
): Promise<string | null> {
  const token = await getTenantToken(organizationId);
  if (!token) return null;
  try {
    const res = await fetch(`${LARK_OPENAPI_BASE}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify(content),
      }),
    });
    const j: any = await res.json();
    if (j?.code !== 0) {
      console.error('[larkIm] sendGroupAttachment failed:', j?.code, j?.msg);
      return null;
    }
    return j?.data?.message_id ?? null;
  } catch (e) {
    console.error('[larkIm] sendGroupAttachment error:', e);
    return null;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/lib/larkIm.ts
git commit -m "feat: add sendAsUserAttachment and sendGroupAttachment"
```

---

### Task 4: Orchestrate relayAttachmentToLark and wire it into the send flow

**Files:**
- Modify: `server/src/lib/larkChatSync.ts` (append `relayAttachmentToLark`; modify `relayChannelMessageToLark`)
- Modify: `server/src/socket/channelChatHandler.ts` (the `CHANNEL_MESSAGE_SEND` handler's relay call site)

**Interfaces:**
- Consumes: `readAttachmentBytes` (Task 1); `uploadImageToLark`, `uploadFileToLark`, `sendAsUserAttachment`, `sendGroupAttachment` (Tasks 2-3, from `./larkIm`).
- Produces: `relayChannelMessageToLark`'s signature gains an `attachment?: { url: string; name: string }` parameter — its return type stays `Promise<string | null>` (now potentially the attachment message's id, per the Global Constraints' recall-priority rule).

- [ ] **Step 1: Import Tasks 2-3's new larkIm exports**

Current (`server/src/lib/larkChatSync.ts`, the import line Task 1 left in place):

```ts
import { sendGroupText, sendAsUser } from './larkIm';
```

Replace with:

```ts
import { sendGroupText, sendAsUser, uploadImageToLark, uploadFileToLark, sendAsUserAttachment, sendGroupAttachment } from './larkIm';
```

- [ ] **Step 2: Add relayAttachmentToLark**

Add this in `server/src/lib/larkChatSync.ts`, right before the existing `relayChannelMessageToLark` function:

```ts

// specs/2026-08-21-lark-outbound-file-sync-design.md — the extension-to-
// category mapping. Exactly 4 of KaiSpace's own allowed extensions
// (routes/uploads.ts's allowedExtensions) are also Lark-image-upload-
// compatible; everything else KaiSpace allows goes through Lark's file
// upload instead. 'mp4' gets the SDK's exact matching file_type enum
// value; every other file-category extension uses the generic 'stream'
// fallback (also an SDK-documented enum value).
const LARK_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const LARK_IMAGE_SIZE_CAP = 10 * 1024 * 1024;
const LARK_FILE_SIZE_CAP = 30 * 1024 * 1024;

// Orchestrates one attachment's full relay: read bytes -> category/size
// decision -> upload -> send (as-user preferred, bot fallback) -> anti-echo
// tracking. Returns the Lark message_id or null on ANY failure at any
// step (unreadable file, oversized, upload failure, send failure) — the
// caller (relayChannelMessageToLark) treats null exactly like "there was
// no attachment to begin with" and still relays any accompanying caption
// independently.
async function relayAttachmentToLark(
  prisma: PrismaClient,
  chatId: string,
  attachment: { url: string; name: string },
  userToken: string | null,
  organizationId: string,
): Promise<string | null> {
  const buffer = await readAttachmentBytes(attachment.url, organizationId);
  if (!buffer) {
    console.log('[diag-b4 out] attachment relay skipped: could not read bytes for', attachment.name);
    return null;
  }

  const ext = path.extname(attachment.name).toLowerCase();
  const isImage = LARK_IMAGE_EXTENSIONS.has(ext);
  const cap = isImage ? LARK_IMAGE_SIZE_CAP : LARK_FILE_SIZE_CAP;
  if (buffer.length === 0 || buffer.length > cap) {
    console.log('[diag-b4 out] attachment relay skipped: size', buffer.length, 'exceeds cap', cap, 'for', attachment.name);
    return null;
  }

  let key: string | null;
  let msgType: 'image' | 'file';
  let content: { image_key: string } | { file_key: string };
  if (isImage) {
    msgType = 'image';
    key = await uploadImageToLark(buffer, organizationId);
    content = { image_key: key ?? '' };
  } else {
    msgType = 'file';
    const fileType: 'mp4' | 'stream' = ext === '.mp4' ? 'mp4' : 'stream';
    key = await uploadFileToLark(buffer, attachment.name, fileType, organizationId);
    content = { file_key: key ?? '' };
  }
  if (!key) {
    console.log('[diag-b4 out] attachment relay skipped: Lark upload failed for', attachment.name);
    return null;
  }

  let messageId: string | null = null;
  if (userToken) {
    messageId = await sendAsUserAttachment(chatId, msgType, content, userToken);
  }
  if (!messageId) {
    messageId = await sendGroupAttachment(chatId, msgType, content, organizationId);
  }
  if (messageId) {
    markSent(messageId);
    await prisma.larkSentMessage.create({ data: { messageId } }).catch(() => {});
  }
  return messageId;
}
```

- [ ] **Step 3: Widen relayChannelMessageToLark**

Current (`server/src/lib/larkChatSync.ts:132-172`):

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

Replace with:

```ts
export async function relayChannelMessageToLark(
  prisma: PrismaClient,
  channel: { roomId: string; isDefault: boolean },
  senderId: string,
  senderName: string,
  text: string,
  // specs/2026-08-21-lark-outbound-file-sync-design.md
  attachment?: { url: string; name: string },
): Promise<string | null> {
  if (!channel.isDefault) return null;
  const trimmed = stripMentionTokens((text || '').trim());
  // A Lark message can only carry ONE msg_type, so a captioned attachment
  // becomes two separate Lark sends below, not one combined message —
  // that's a hard constraint of Lark's own API, not a choice made here.
  if (!trimmed && !attachment) return null; // genuinely nothing to relay
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

  // Attachment — a genuinely separate Lark message, independent of whether
  // the caption above succeeded, failed, or didn't exist.
  let attachmentMessageId: string | null = null;
  if (attachment) {
    attachmentMessageId = await relayAttachmentToLark(prisma, map.chatId, attachment, userToken, organizationId);
  }

  // specs/2026-08-21-lark-message-recall-design.md /
  // specs/2026-08-21-lark-outbound-file-sync-design.md — the caller
  // (channelChatHandler.ts) stores this onto the originating ChatMessage
  // row so MESSAGE_DELETE later knows which Lark-side mirror to recall.
  // The attachment's id wins when both exist (confirmed with the room
  // admin) — the caption's own separate Lark message is not recallable in
  // that case.
  return attachmentMessageId ?? textMessageId;
}
```

- [ ] **Step 4: Pass attachment info at the call site**

Current (`server/src/socket/channelChatHandler.ts:450-459`):

```ts
      if (!duplicate && text) {
        void relayChannelMessageToLark(prisma, channel, userId, message.sender.displayName, text)
          .then((larkMessageId) => {
            if (larkMessageId) {
              return prisma.chatMessage.update({ where: { id: message.id }, data: { larkMessageId } });
            }
          })
          .catch((e) => {
            if (e?.code === 'P2025') {
              console.log('[channelChat] Lark relay succeeded but message was deleted before tracking write landed (harmless, unrecalled)');
            } else {
              console.error('[channelChat] Lark relay failed:', e);
            }
          });
      }
```

Replace with:

```ts
      // specs/2026-08-21-lark-outbound-file-sync-design.md — relay now
      // proceeds for an attachment-only send too, not just when `text` is
      // present (relayChannelMessageToLark's own guard handles "genuinely
      // nothing to relay" internally).
      if (!duplicate && (text || hasAttachment)) {
        const attachmentForRelay = hasAttachment && payload.attachmentUrl && payload.attachmentName
          ? { url: payload.attachmentUrl, name: payload.attachmentName }
          : undefined;
        void relayChannelMessageToLark(prisma, channel, userId, message.sender.displayName, text, attachmentForRelay)
          .then((larkMessageId) => {
            if (larkMessageId) {
              return prisma.chatMessage.update({ where: { id: message.id }, data: { larkMessageId } });
            }
          })
          .catch((e) => {
            if (e?.code === 'P2025') {
              console.log('[channelChat] Lark relay succeeded but message was deleted before tracking write landed (harmless, unrecalled)');
            } else {
              console.error('[channelChat] Lark relay failed:', e);
            }
          });
      }
```

(`hasAttachment` and `payload.attachmentUrl`/`payload.attachmentName` are already in scope in this handler — confirmed at `channelChatHandler.ts:398,429-430` — no new variables needed beyond the small `attachmentForRelay` object literal, which narrows the two optional payload strings into the required non-optional shape `relayChannelMessageToLark`'s new parameter expects.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/larkChatSync.ts server/src/socket/channelChatHandler.ts
git commit -m "feat: relay KaiSpace attachments into Lark as image/file messages"
```

---

## Final Verification

- [ ] Run `npm run typecheck --workspace=server` once more from a clean state (all 4 tasks applied) — expect PASS with zero errors.
- [ ] Run `npm run typecheck --workspace=client` — expect PASS (no client files touched by this plan, but confirms nothing else broke).
- [ ] `git log --oneline -4` — confirm the 4 commits above exist in order.

## Manual Testing After Deploy

1. Send a small image (well under 10MB) as an attachment WITH a caption in a KaiSpace channel bound to Lark. Confirm BOTH a text message (the caption) AND a separate image message appear in the Lark group — two distinct bubbles, not one combined.
2. Send an image with NO caption. Confirm only the image message appears — no phantom empty text message.
3. Send a document attachment (e.g. a `.pdf`). Confirm it appears as a real Lark file message (downloadable/previewable in Lark), not as text.
4. Send an oversized image (>10MB) or oversized file (>30MB). Confirm no crash, any caption still relays normally, and check server logs for the specific skip reason (`exceeds cap`).
5. Send a `.mp4` video attachment. Confirm it uses `file_type: 'mp4'` correctly — check whether Lark renders it as a playable video rather than a generic file icon, if that's observable from the Lark client.
6. Delete (in KaiSpace) a message that had both a caption and an attachment. Confirm the ATTACHMENT's Lark message gets recalled — the caption's separate Lark text message is expected to remain (per the confirmed recall-priority rule), not a bug if it does.
7. Confirm no regression to plain text-only sends, and confirm the already-shipped INBOUND direction (a file sent natively in Lark still arriving into KaiSpace) still works exactly as before this plan's changes.
