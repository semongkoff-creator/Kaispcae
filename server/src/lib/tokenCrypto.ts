import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getConfig } from '../config';

// Bagian 4 upgrade — encrypt Lark user tokens at rest. These are impersonation
// credentials (anyone holding one can act as the user in Lark), so they must
// never sit in the DB as plaintext: a DB dump alone should be useless without
// the key, which lives only in LARK_TOKEN_ENC_KEY (env, never in the DB).
//
// AES-256-GCM: authenticated encryption, so a tampered ciphertext fails to
// decrypt rather than yielding garbage. Stored format is three base64 parts
// joined by dots: iv.tag.ciphertext.

const ENC_VERSION = 'v1';

function key(): Buffer | null {
  const raw = getConfig().LARK_TOKEN_ENC_KEY;
  if (!raw) return null;
  // Hash to exactly 32 bytes so any-length env value is a valid AES-256 key.
  return createHash('sha256').update(raw).digest();
}

// True when a key is configured — callers use this to decide whether to store
// user tokens at all (no key → skip storage, fall back to the bot).
export function tokenCryptoEnabled(): boolean {
  return key() !== null;
}

// Returns null if no key is configured (caller must treat that as "can't
// store"). Never throws on the happy path.
export function encryptToken(plain: string): string | null {
  const k = key();
  if (!k) return null;
  const iv = randomBytes(12); // 96-bit nonce, standard for GCM
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_VERSION}.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

// Returns null on any failure (no key, wrong key, tampered/rotated ciphertext).
// A null here means the stored token is unusable → the caller refreshes or
// falls back to the bot, never crashes.
export function decryptToken(enc: string | null | undefined): string | null {
  const k = key();
  if (!k || !enc) return null;
  try {
    const parts = enc.split('.');
    if (parts.length !== 4 || parts[0] !== ENC_VERSION) return null;
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const decipher = createDecipheriv('aes-256-gcm', k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
