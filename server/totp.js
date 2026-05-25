// Implémentation TOTP (RFC 6238) sans dépendance externe.
// Compatible Google Authenticator, Authy, 1Password, etc.
import crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;       // secondes par fenêtre
const DIGITS = 6;        // longueur du code
const WINDOW = 1;        // tolérance ±1 fenêtre (gère la dérive horloge)

export function generateBase32Secret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  return base32Encode(buf);
}

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Caractère Base32 invalide');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secretBuf, counter) {
  const counterBuf = Buffer.alloc(8);
  // Counter sur 64 bits big-endian
  for (let i = 7; i >= 0; i--) {
    counterBuf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hmac = crypto.createHmac('sha1', secretBuf).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function generateTotp(secretBase32, atSeconds = Math.floor(Date.now() / 1000)) {
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(atSeconds / PERIOD);
  return hotp(secret, counter);
}

export function verifyTotp(secretBase32, token, atSeconds = Math.floor(Date.now() / 1000)) {
  if (!secretBase32 || !token) return false;
  const cleaned = String(token).replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(atSeconds / PERIOD);
  for (let w = -WINDOW; w <= WINDOW; w++) {
    if (timingSafeEqual(hotp(secret, counter + w), cleaned)) return true;
  }
  return false;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// otpauth://totp/Issuer:account?secret=BASE32&issuer=Issuer&algorithm=SHA1&digits=6&period=30
export function buildOtpAuthUrl({ issuer, account, secret }) {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?${params.toString()}`;
}
