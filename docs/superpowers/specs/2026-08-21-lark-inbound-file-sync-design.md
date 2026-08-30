# Deliver Lark File/Image Messages into KaiSpace Chat — Design

## Goal

When a file or image is sent natively in a Lark group chat mapped to a KaiSpace room, deliver it into that room's default channel as a real chat attachment — stored directly in the room's Lark Drive folder, never downloaded to KaiSpace's own local disk/storage.

## Context

Inbound Lark→KaiSpace sync (`server/src/lib/larkInbound.ts`'s `handleInboundLarkMessage`) currently hard-rejects any message that isn't `message_type === 'text'` — a file or image sent in Lark is silently dropped today, never reaching KaiSpace. Every other part of that pipeline (anti-echo guards, `RoomChatMap` → room → default-channel resolution, sender attribution via `larkOpenId` or the relay-bot fallback, final delivery via `larkChatSync.ts`'s `deliverLarkMessageToChannel`) already applies equally to a file-carrying message — only the type gate and the content-extraction step need to change.

KaiSpace already has a complete, working Lark Drive integration for the OUTBOUND direction (`server/src/lib/larkDrive.ts`, "A8"): `ensureRoomFolder(roomId)` resolves/creates a room's Drive folder, `uploadFileFromPath(folderToken, fileName, filePath, organizationId)` pushes a local temp file into it, and `GET /api/files/:token` (`server/src/routes/uploads.ts`) is the existing authenticated proxy that serves Drive-backed attachments back to users — the exact same route a KaiSpace-native file upload already uses. This design reuses all of it unchanged.

Lark's `GET /im/v1/messages/:message_id/resources/:file_key` (confirmed via the installed SDK's own bundled documentation) is how a file already attached to a received message is pulled off Lark's side — a required first step before it can be pushed into Drive, distinct from Lark Drive's own file API.

## Data flow

1. **Type gate widens.** `handleInboundLarkMessage`'s current `msg.message_type !== 'text'` rejection becomes `!['text', 'file', 'image'].includes(msg.message_type)`. Every existing guard before and after this point (anti-echo, chat_id → org → room → channel resolution) is unchanged and applies identically regardless of type.
2. **Content extraction branches by type.** For `text`, unchanged (`JSON.parse(msg.content)?.text`). For `file`, `msg.content` is parsed for `file_key` and `file_name`. For `image`, `msg.content` is parsed for `image_key`; since image messages don't reliably carry a filename, one is synthesized (e.g. `gambar.jpg`) when absent.
3. **Download from Lark, then upload to Drive.** The resource is fetched via `GET /im/v1/messages/:message_id/resources/:file_key?type=file` (or `type=image`), written to a local temp file (mirroring exactly how `POST /api/uploads` already stages a KaiSpace-native upload before it goes to Drive), then pushed into the room's Drive folder via the existing `ensureRoomFolder` + `uploadFileFromPath`. The local temp file is deleted immediately after (never persisted).
4. **Message delivery.** The resulting `ChatMessage` gets `attachmentUrl: '/api/files/<fileToken>'` and `attachmentName: <resolved filename>` — the identical shape a native KaiSpace upload produces, so no new client-side rendering code is needed (`ChatPanel`, `AttachmentLightbox` already just render whatever's in those two fields). Text alongside a file (if any) is delivered on the same message, matching how a native KaiSpace attachment-plus-caption send already works.

## Scope and error handling

- **Supported types:** `file` and `image` only. Sticker, audio, video/media, and merged-forward sub-messages are explicitly out of scope — Lark's own resource-download API doesn't support stickers either, and the others aren't asked for.
- **Lark Drive not enabled for the org:** the file portion is silently skipped (matching today's existing silent-drop behavior for anything non-text); if the same message carries text too, the text half still delivers normally. No error surfaces to either side — a KaiSpace room admin who hasn't set up Drive simply doesn't get inbound files, exactly as today.
- **Size limit:** none added beyond what Lark's own resource-download endpoint already enforces (100MB) — this happens to already match KaiSpace's own upload ceiling, so no additional check is needed.
- **File type validation:** not re-checked against KaiSpace's own upload allowlist (`allowedMimeTypes`/`allowedExtensions` in `routes/uploads.ts`) — a file that made it through Lark's own system is trusted as-is, since it never passed through KaiSpace's upload endpoint to begin with and re-validating it there would have no natural enforcement point in this pipeline.
- **Download or Drive-upload failure** (network error, Lark API error, Drive quota, etc.): logged and the file is skipped for that message, same graceful-degradation posture as every other Lark integration point in this codebase — never blocks or corrupts delivery of an accompanying text portion.
