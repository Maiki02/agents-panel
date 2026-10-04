import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Derives an independent 32-byte key per purpose from PANEL_SECRET_KEY. */
export function deriveKey(secret: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', `agents-panel:${purpose}`, 32));
}

/** AES-256-GCM; output is base64url(iv | tag | ciphertext). */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function decrypt(key: Buffer, payload: string): string {
  const raw = Buffer.from(payload, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

function sign(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

/** Stateless signed token: base64url(JSON payload) + "." + HMAC. */
export function signPayload(key: Buffer, payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(key, data)}`;
}

export function verifyPayload(key: Buffer, token: string | undefined): unknown {
  if (!token) return undefined;
  const [data, mac, extra] = token.split('.');
  if (!data || !mac || extra !== undefined) return undefined;
  const expected = Buffer.from(sign(key, data));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
