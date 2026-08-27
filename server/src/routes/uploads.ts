import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import { authenticateToken, authenticateUploadRead, AuthRequest } from '../middleware/auth';
import { getPrisma } from '../lib/prisma';
import { canAccessConversation } from '../lib/chatAccess';

// Chat attachments, Add Media files and recordings all land on local disk and
// are served back through this module. There is exactly one locator shape:
//
//   /api/uploads/<uuid>.<ext>   (served by GET /uploads below, access-gated)
//
// An external object store previously sat in front of this, with disk as its
// fallback; the fallback was always the real implementation, so removing the
// remote path left the storage behaviour unchanged.
const uploads = Router();

export const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// §6 — Add Media (Image/File). No S3/cloud storage is configured for this
// app, so uploads land on local disk under server/uploads and are served
// back from GET /api/uploads/:filename below — a deliberate simplification
// of the spec's "upload to storage" for a single-instance deployment; a
// real multi-instance deploy would need this on a shared volume or S3.
//
// Deliberately NOT a plain express.static mount: allowedMimeTypes excludes
// anything that can carry an XSS payload when rendered inline (svg, html,
// js) — the whole point of an allowlist here rather than a denylist — and
// GET below sets nosniff + a per-type Content-Disposition so a browser can
// never be tricked into executing an uploaded file as a page.
const allowedMimeTypes = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf', 'application/zip',
  'text/plain', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
]);

// Browsers don't consistently report the "correct" IANA mime type for every
// extension — Windows Chrome in particular sends .zip as
// application/x-zip-compressed (confirmed via direct testing), not
// application/zip, so a mime-only check rejected legitimate zip uploads
// outright. Accepting by EITHER a known-good mime type OR the file
// extension (checked below) closes that gap without loosening what's
// actually allowed — still no svg/html/js either way.
const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.zip', '.txt', '.doc', '.docx', '.xlsx', '.mp4', '.webm', '.mov', '.avi']);

// Exported so routes/rooms.ts's Soundboard upload (its own multer instance,
// with a much smaller size cap + audio-only fileFilter) writes into the SAME
// disk directory and gets served back by the SAME GET /uploads/:filename
// route below, instead of duplicating the storage/serving setup.
export const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB — raised from 50MB for Room Editor's Import Image feature
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowedMimeTypes.has(file.mimetype) || allowedExtensions.has(ext));
  },
});

uploads.post('/uploads', authenticateToken, upload.single('file'), async (req: AuthRequest, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided, or file type not allowed' });
  }
  const fileName = req.file.originalname;
  return res.status(201).json({ url: `/api/uploads/${req.file.filename}`, fileName });
});

// §7 — Screen Recording. A recording can run up to 80 minutes (see
// RECORDING_MAX_DURATION_MS), so it needs a much larger size ceiling than
// ordinary Add Media uploads — kept as its own multer instance rather than
// raising the 10MB limit above for everyone.
const RECORDING_MIME_TYPES = new Set(['video/webm', 'video/mp4']);
// Bug fix — a mimetype-only check silently rejected almost every REAL
// recording. A browser recording video+audio together reports a mimeType
// like `video/webm;codecs=vp8,opus` (an UNQUOTED comma inside the codecs
// parameter — the normal, expected shape whenever more than one codec is
// listed, not an edge case). Confirmed directly against this exact multer
// version: that comma makes the underlying multipart parser misparse the
// whole Content-Type header, and `file.mimetype` comes back as
// 'text/plain' — not 'video/webm' with extra params attached, a
// completely different value with nothing left to loosely match against.
// `file.originalname` is carried by a SEPARATE header (Content-Disposition)
// untouched by this, and the client always sets it deterministically
// (recording.webm/recording.mp4 — see api.ts's uploadRecordingBlob), so
// checking the extension is what the general Add Media upload above
// already does for its own (different) mimetype-unreliability reason —
// same fix shape, different root cause.
const RECORDING_EXTENSIONS = new Set(['.webm', '.mp4']);

const recordingUpload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, RECORDING_MIME_TYPES.has(file.mimetype) || RECORDING_EXTENSIONS.has(ext));
  },
});

uploads.post('/uploads/recording', authenticateToken, recordingUpload.single('file'), async (req: AuthRequest, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided, or not a supported recording format (webm/mp4)' });
  }
  return res.status(201).json({ url: `/api/uploads/${req.file.filename}` });
});

// Requires a logged-in session. This was deliberately public once, on the
// reasoning that re-checking auth per <img> load would need the token in a
// query param (leaking it into logs/history) — a worse trade than a
// guessable-only-by-uuid path. That reasoning had a hole: "guessable only by
// uuid" is not a secret when the uuid is handed to clients. Recording.fileUrl
// was returned in full by GET /rooms/:slug/recordings, so anyone who could
// list a recording could re-fetch the file here forever and walk straight
// past the role check, expiry, and maxDownloads counter that
// routes/recordings.ts enforces on the real download route.
//
// authenticateUploadRead resolves the session from an HttpOnly cookie
// (see middleware/auth.ts), so the query-param leak the original comment
// worried about never happens and <img>/<video> tags keep working untouched.
uploads.get('/uploads/:filename', authenticateUploadRead, async (req: AuthRequest, res: Response) => {
  const filename = path.basename(req.params.filename); // strip any path traversal attempt
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  // Step 1b — being logged in is not enough for a chat attachment. A file
  // sent into a DM must be readable only by that DM's participants, so
  // resolve the URL back to its message and ask the conversation.
  //
  // Files with no message behind them (Add Media objects, recordings) keep
  // the old rule of "any authenticated user", which is what map media already
  // assumes: a media object's url is broadcast to everyone in the room.
  // Falling through is therefore deliberate, not an oversight — but it is
  // also why this lookup keys off attachmentUrl rather than trusting the
  // caller to say which conversation they want.
  try {
    const prisma = getPrisma();
    const message = await prisma.chatMessage.findFirst({
      where: { attachmentUrl: `/api/uploads/${filename}` },
      select: { conversationId2: true },
    });
    if (message) {
      // A chat attachment whose message somehow has no conversation is
      // unreachable rather than public — there is no one to authorize against.
      if (!message.conversationId2) return res.status(403).json({ error: 'Not authorized to read this file' });
      if (!(await canAccessConversation(prisma, message.conversationId2, req.userId!, req.organizationId))) {
        return res.status(403).json({ error: 'Not authorized to read this file' });
      }
    }
  } catch (err) {
    // Fail CLOSED. An error here means we could not establish that the caller
    // is allowed to read this file, and "the check threw" must never be a way
    // to serve a private attachment.
    console.error('[uploads] attachment authorization check failed:', err);
    return res.status(500).json({ error: 'Failed to serve file' });
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  const ext = path.extname(filename).toLowerCase();
  // .pdf included alongside image/video — AttachmentLightbox.tsx previews all
  // three inline (img/video/iframe). Leaving it out forced a download dialog
  // instead of ever reaching the iframe, no matter what the client tried to do.
  const isInlineable = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov', '.avi', '.pdf'].includes(ext);
  res.setHeader('Content-Disposition', isInlineable ? 'inline' : 'attachment');
  return res.sendFile(filePath);
});

export function deleteUploadedFile(url: string): void {
  // Called by mediaHandler's TTL sweep with a url this module generated.
  // path.basename guards against a full/relative path.
  const filePath = path.join(UPLOAD_DIR, path.basename(url));
  fs.unlink(filePath, () => {}); // best-effort — a missing file is not an error here
}

export default uploads;
