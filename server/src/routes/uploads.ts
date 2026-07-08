import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const uploads = Router();

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
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
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    cb(null, allowedMimeTypes.has(file.mimetype));
  },
});

uploads.post('/uploads', authenticateToken, upload.single('file'), (req: AuthRequest, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided, or file type not allowed' });
  }
  return res.status(201).json({
    url: `/api/uploads/${req.file.filename}`,
    fileName: req.file.originalname,
  });
});

// §7 — Screen Recording. A recording can run up to 80 minutes (see
// RECORDING_MAX_DURATION_MS), so it needs a much larger size ceiling than
// ordinary Add Media uploads — kept as its own multer instance rather than
// raising the 10MB limit above for everyone.
const recordingUpload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'video/webm'),
});

uploads.post('/uploads/recording', authenticateToken, recordingUpload.single('file'), (req: AuthRequest, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided, or not a video/webm recording' });
  }
  return res.status(201).json({ url: `/api/uploads/${req.file.filename}` });
});

// Public GET (no auth) — a media object's url is shared with everyone in
// the room via socket broadcast, and re-checking auth per <img> tag load
// would need the token in a query param (leaking it into server logs/
// browser history), a worse tradeoff than a guessable-only-by-uuid path.
uploads.get('/uploads/:filename', (req: Request, res: Response) => {
  const filename = path.basename(req.params.filename); // strip any path traversal attempt
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  res.setHeader('X-Content-Type-Options', 'nosniff');
  const ext = path.extname(filename).toLowerCase();
  const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
  res.setHeader('Content-Disposition', isImage ? 'inline' : 'attachment');
  return res.sendFile(filePath);
});

export function deleteUploadedFile(url: string): void {
  // Only ever called with a url this same route generated (see
  // mediaHandler.ts's TTL sweep), never user input directly — but
  // path.basename still guards against any future caller passing a
  // full/relative path instead of the expected "/api/uploads/<name>".
  const filename = path.basename(url);
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.unlink(filePath, () => {}); // best-effort — a missing file is not an error here
}

export default uploads;
