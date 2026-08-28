# Relay KaiSpace Attachments into Lark — Design

## Goal

When a KaiSpace user sends a file/image attachment in a channel chat message mapped to a Lark group, relay the attachment itself into Lark as a real image/file message — today only an accompanying caption's text is relayed; an attachment-only message sends nothing to Lark at all.

## Context

`relayChannelMessageToLark` (`server/src/lib/larkChatSync.ts`) currently only handles text: it early-returns when the trimmed caption is empty (comment: "attachment-only sends have nothing to relay"), and its one call site (`channelChatHandler.ts`'s `CHANNEL_MESSAGE_SEND` handler) doesn't pass attachment info at all, even though the already-created `message` object has it.

Lark's outbound APIs (confirmed via the installed SDK's own bundled documentation) require a two-step process: upload the file to get a key, then send a message referencing that key. Uploads go through two SEPARATE endpoints depending on category:
- `POST /im/v1/images` (`image_type: 'message'`) — JPEG/PNG/WEBP/GIF/TIFF/BMP/ICO only, max 10MB — returns an `image_key`.
- `POST /im/v1/files` (`file_type`, one of `'opus'|'mp4'|'pdf'|'doc'|'xls'|'ppt'|'stream'`, `file_name`) — max 30MB — returns a `file_key`.

Both keys are then sent via the SAME `POST /im/v1/messages` endpoint the existing `sendGroupText`/`sendAsUser` already use, just with `msg_type: 'image'`/`content: {image_key}` or `msg_type: 'file'`/`content: {file_key}` instead of `msg_type: 'text'`.

A Lark message can only carry ONE `msg_type`. There is no combined text+image/file message — a captioned attachment therefore becomes two separate Lark messages (the caption as text, the attachment as image/file), not one combined bubble. This is a hard constraint of Lark's own API, not a design choice.

Attachment bytes must be read from wherever they're actually stored — a `ChatMessage.attachmentUrl` is either `/api/files/<token>` (Lark Drive, read via the existing `larkDrive.ts`'s `openDownloadStream`) or `/api/uploads/<filename>` (local disk fallback, a plain file read) — mirroring the same two-shape branching `routes/uploads.ts`'s existing `deleteUploadedFile` already does.

## Data flow

1. **Reading bytes.** A new helper resolves a `ChatMessage`'s `attachmentUrl` to raw bytes regardless of backend: Drive-backed URLs go through `openDownloadStream`, disk-backed URLs are read directly from `UPLOAD_DIR`.
2. **Category + size check.** The attachment's extension determines its Lark category: `.jpg/.jpeg/.png/.gif/.webp` → image (10MB cap); everything else KaiSpace already allows (`.pdf/.zip/.txt/.doc/.docx/.xlsx/.mp4/.webm/.mov/.avi`) → file (30MB cap, `file_type: 'mp4'` for `.mp4`, `'stream'` for everything else). If the attachment exceeds its category's cap, it's skipped entirely (see Error handling) — no partial/truncated upload is attempted.
3. **Upload, then send.** The bytes are uploaded to Lark (image or file endpoint per category) to get a key, then a SEPARATE `POST /im/v1/messages` call sends `msg_type: 'image'`/`'file'` referencing that key — using the same sender-identity preference already established for text (`sendAsUser` with the sender's own linked Lark account, falling back to `sendGroupText` as the bot).
4. **Anti-echo tracking.** The attachment message's own returned `message_id` is tracked into the existing anti-echo ledger (`markSent` + `LarkSentMessage`) exactly like every other outbound send already is, so it doesn't loop back in as a duplicate inbound message.
5. **Caption relay, unchanged in spirit.** Text relay (if there's a caption) proceeds independently — the same code path that exists today, just no longer gated on "text must be non-empty to do anything at all."

## Error handling

- Read failure (file missing, Drive error), size-cap exceeded, upload failure, or send failure at any step: the attachment relay is skipped, logged, and does NOT prevent an accompanying caption from still relaying as its own separate text message.
- An attachment-only message (no caption) whose relay fails simply sends nothing to Lark for that message — same as today's behavior for any failure.
- No retry logic, no partial/truncated fallback upload, no user-facing indication of relay success/failure in KaiSpace's own UI.

## Out of scope

- Combining caption + attachment into a single Lark message — not possible via Lark's API (`msg_type` is exclusive), not attempted.
- Any change to the INBOUND direction (already shipped) or to `relayBroadcastToLark` (admin announcements, always bot-only, text-only, untouched).
- Any change to KaiSpace's own upload allowlist, size limits, or storage backend selection (Drive vs disk) — this feature only reads what's already there.
