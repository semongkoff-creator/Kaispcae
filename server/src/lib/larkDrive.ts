import { readFile, stat, open } from 'node:fs/promises';
import { getConfig } from '../config';
import { getPrisma } from './prisma';
import { getTenantToken, LARK_OPENAPI_BASE } from './larkToken';

// A8 — Lark Drive storage for chat attachments + P2P recordings, replacing
// local disk. All calls use the bot's tenant token (server-to-server), so the
// app never hands a Drive link to an end user — bytes are always proxied back
// through MeetKai's own access gates (see routes/uploads + routes/recordings).
// Every function is null/void-graceful: a Drive failure must let the caller
// fall back (to disk) or fail the one upload, never crash a request.
//
// upload_all is capped at 20MB by Lark; larger files (recordings) go through
// the chunked upload_prepare → upload_part → upload_finish flow.

const UPLOAD_ALL_LIMIT = 20 * 1024 * 1024;

export function driveEnabled(): boolean {
  const c = getConfig();
  return !!(c.LARK_DRIVE_ROOT_FOLDER_TOKEN && c.LARK_APP_ID && c.LARK_APP_SECRET);
}

async function tenant(): Promise<string | null> {
  return getTenantToken();
}

// Create a folder under the configured root. Returns the new folder_token or
// null on any failure.
export async function createFolder(name: string): Promise<string | null> {
  const c = getConfig();
  const token = await tenant();
  if (!token || !c.LARK_DRIVE_ROOT_FOLDER_TOKEN) return null;
  try {
    const res = await fetch(`${LARK_OPENAPI_BASE}/drive/v1/files/create_folder`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder_token: c.LARK_DRIVE_ROOT_FOLDER_TOKEN }),
    });
    const j: any = await res.json();
    if (j?.code !== 0) {
      console.error('[larkDrive] create_folder failed:', j?.code, j?.msg);
      return null;
    }
    return j?.data?.token ?? null;
  } catch (e) {
    console.error('[larkDrive] create_folder error:', e);
    return null;
  }
}

// Return the room's Drive folder token, creating (and persisting) it on first
// need. This doubles as the retry path: a room whose folder failed to create at
// room-creation time (or predates A8) gets one here on its first upload.
export async function ensureRoomFolder(roomId: string): Promise<string | null> {
  if (!driveEnabled()) return null;
  const prisma = getPrisma();
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { id: true, name: true, slug: true, larkFolderToken: true },
  });
  if (!room) return null;
  if (room.larkFolderToken) return room.larkFolderToken;
  const folderToken = await createFolder(`${room.name} — ${room.slug}`);
  if (!folderToken) return null;
  await prisma.room.update({ where: { id: roomId }, data: { larkFolderToken: folderToken } }).catch(() => {});
  return folderToken;
}

// Upload a file (given its on-disk temp path) into a folder. Picks upload_all
// vs the chunked flow by size, and streams chunks from disk for large files so
// a 1GB recording is never fully buffered in memory. Returns the new file_token
// or null on failure.
export async function uploadFileFromPath(folderToken: string, fileName: string, filePath: string): Promise<string | null> {
  try {
    const { size } = await stat(filePath);
    if (size <= UPLOAD_ALL_LIMIT) {
      const buffer = await readFile(filePath);
      return uploadAll(folderToken, fileName, buffer);
    }
    return uploadChunkedFromPath(folderToken, fileName, filePath, size);
  } catch (e) {
    console.error('[larkDrive] uploadFileFromPath error:', e);
    return null;
  }
}

async function uploadAll(folderToken: string, fileName: string, buffer: Buffer): Promise<string | null> {
  const token = await tenant();
  if (!token) return null;
  try {
    const form = new FormData();
    form.append('file_name', fileName);
    form.append('parent_type', 'explorer');
    form.append('parent_node', folderToken);
    form.append('size', String(buffer.length));
    // `file` MUST come last (Lark parses fields in order).
    form.append('file', new Blob([buffer as unknown as BlobPart]), fileName);
    const res = await fetch(`${LARK_OPENAPI_BASE}/drive/v1/files/upload_all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const j: any = await res.json();
    if (j?.code !== 0) {
      console.error('[larkDrive] upload_all failed:', j?.code, j?.msg);
      return null;
    }
    return j?.data?.file_token ?? null;
  } catch (e) {
    console.error('[larkDrive] upload_all error:', e);
    return null;
  }
}

async function uploadChunkedFromPath(folderToken: string, fileName: string, filePath: string, size: number): Promise<string | null> {
  const token = await tenant();
  if (!token) return null;
  const fh = await open(filePath, 'r');
  try {
    // 1) prepare
    const prepRes = await fetch(`${LARK_OPENAPI_BASE}/drive/v1/files/upload_prepare`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: fileName, parent_type: 'explorer', parent_node: folderToken, size }),
    });
    const prep: any = await prepRes.json();
    if (prep?.code !== 0) {
      console.error('[larkDrive] upload_prepare failed:', prep?.code, prep?.msg);
      return null;
    }
    const uploadId: string = prep.data.upload_id;
    const blockSize: number = prep.data.block_size;
    const blockNum: number = prep.data.block_num;

    // 2) parts — read each block off disk so the whole file is never in memory
    for (let seq = 0; seq < blockNum; seq++) {
      const offset = seq * blockSize;
      const len = Math.min(blockSize, size - offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      const form = new FormData();
      form.append('upload_id', uploadId);
      form.append('seq', String(seq));
      form.append('size', String(len));
      form.append('file', new Blob([buf as unknown as BlobPart]), fileName);
      const partRes = await fetch(`${LARK_OPENAPI_BASE}/drive/v1/files/upload_part`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const part: any = await partRes.json();
      if (part?.code !== 0) {
        console.error('[larkDrive] upload_part failed at seq', seq, ':', part?.code, part?.msg);
        return null;
      }
    }

    // 3) finish
    const finRes = await fetch(`${LARK_OPENAPI_BASE}/drive/v1/files/upload_finish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: uploadId, block_num: blockNum }),
    });
    const fin: any = await finRes.json();
    if (fin?.code !== 0) {
      console.error('[larkDrive] upload_finish failed:', fin?.code, fin?.msg);
      return null;
    }
    return fin?.data?.file_token ?? null;
  } catch (e) {
    console.error('[larkDrive] chunked upload error:', e);
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

// Open a file's byte stream (for the backend proxy). Returns the Web
// ReadableStream body so the caller can pipe it straight to the HTTP response
// without buffering the whole file (a recording can be ~1GB). Returns null on
// any failure so the caller 404s/500s WITHOUT ever exposing a Drive link.
export async function openDownloadStream(
  fileToken: string,
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string } | null> {
  const token = await tenant();
  if (!token) return null;
  try {
    const res = await fetch(`${LARK_OPENAPI_BASE}/drive/v1/files/${encodeURIComponent(fileToken)}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok || !res.body) {
      console.error('[larkDrive] download failed:', res.status);
      return null;
    }
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    // A Lark API error comes back as JSON with this content-type instead of
    // file bytes — treat it as failure rather than piping the error blob.
    if (contentType.includes('application/json')) {
      const j: any = await res.json().catch(() => ({}));
      console.error('[larkDrive] download returned error json:', j?.code, j?.msg);
      return null;
    }
    return { body: res.body, contentType };
  } catch (e) {
    console.error('[larkDrive] download error:', e);
    return null;
  }
}

// Best-effort delete (TTL sweep). Never throws.
export async function deleteFile(fileToken: string): Promise<void> {
  const token = await tenant();
  if (!token) return;
  try {
    await fetch(`${LARK_OPENAPI_BASE}/drive/v1/files/${encodeURIComponent(fileToken)}?type=file`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    console.error('[larkDrive] delete error:', e);
  }
}
