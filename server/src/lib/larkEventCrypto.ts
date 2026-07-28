import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto';

// Bagian 4 — Lark Event Subscription security primitives. This is the ONE file
// that has to be exactly right: it's the boundary where an unauthenticated
// request from the public internet first gets trusted. Both the signature
// check and the decryption follow the official Lark/Feishu spec verbatim (see
// the Event Subscription "encrypt key encryption configuration" docs) — do not
// "optimise" the string concatenation order or the key derivation.

// Signature = SHA256_hex(timestamp + nonce + encryptKey + rawBody), compared
// against the X-Lark-Signature header. `rawBody` MUST be the exact bytes Lark
// sent (the still-encrypted JSON), which is why the webhook route parses the
// body with express.raw, not express.json — re-serialising a parsed body would
// change the bytes and every signature would fail.
export function verifyLarkSignature(
  encryptKey: string,
  timestamp: string,
  nonce: string,
  rawBody: Buffer,
  signature: string,
): boolean {
  if (!encryptKey || !timestamp || !nonce || !signature) return false;
  const hash = createHash('sha256');
  hash.update(Buffer.from(timestamp + nonce + encryptKey, 'utf8'));
  hash.update(rawBody);
  const expected = hash.digest('hex');
  // Constant-time compare — a normal === leaks, via timing, how many leading
  // bytes matched, which is enough to forge a signature byte-by-byte.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Decrypt an AES-256-CBC event payload. Key = SHA256(encryptKey) as raw 32
// bytes; the base64-decoded blob is [16-byte IV][ciphertext]; PKCS7 padding is
// removed by node's default auto-padding. Returns the decrypted JSON string, or
// null on any failure (bad key, tampered blob) — the caller treats null as
// "reject", never as an empty event.
export function decryptLarkEvent(encryptKey: string, encrypt: string): string | null {
  try {
    const key = createHash('sha256').update(encryptKey).digest(); // 32 bytes
    const blob = Buffer.from(encrypt, 'base64');
    if (blob.length <= 16) return null;
    const iv = blob.subarray(0, 16);
    const ciphertext = blob.subarray(16);
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return out.toString('utf8');
  } catch {
    return null;
  }
}
