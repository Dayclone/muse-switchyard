// Vault encryption: PBKDF2-SHA256 -> AES-256-GCM, WebCrypto only.
// The KDF parameters are bound to the ciphertext as AAD, so tampering with
// the salt or iteration count makes decryption fail instead of silently
// weakening the key derivation.

const te = new TextEncoder();
const td = new TextDecoder();

export const KDF_ITER = 600000;
const ITER_MIN = 100000;
const ITER_MAX = 2000000;
const CT_MAX_CHARS = 32_000_000; // ~24 MB of ciphertext
const PAD_TO = 4096; // pad plaintext so the stored size does not reveal the number of accounts

export function b64(bytes) {
  const u = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) {
    s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function unb64(str) {
  const s = atob(str);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

async function deriveRaw(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    base,
    256
  );
  return new Uint8Array(bits);
}

const aadFor = (iter, saltB64) => te.encode(`switchyard/1|${iter}|${saltB64}`);

function validate(vault) {
  const ok =
    vault && typeof vault === 'object' &&
    vault.v === 1 && vault.kdf === 'PBKDF2-SHA256' &&
    Number.isInteger(vault.iter) && vault.iter >= ITER_MIN && vault.iter <= ITER_MAX &&
    typeof vault.salt === 'string' && typeof vault.iv === 'string' && typeof vault.ct === 'string' &&
    vault.salt.length > 0 && vault.salt.length <= 44 && vault.iv.length === 16 &&
    vault.ct.length > 0 && vault.ct.length <= CT_MAX_CHARS;
  if (!ok) throw new Error('BAD_VAULT');
}

// Trailing spaces are valid JSON whitespace, so decryption needs no unpadding.
function pad(bytes) {
  const extra = (PAD_TO - (bytes.length % PAD_TO)) % PAD_TO;
  if (!extra) return bytes;
  const out = new Uint8Array(bytes.length + extra);
  out.set(bytes);
  out.fill(0x20, bytes.length);
  return out;
}

async function encrypt(raw, header, obj) {
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(header.iter, header.salt) },
    key,
    pad(te.encode(JSON.stringify(obj)))
  );
  return { ...header, iv: b64(iv), ct: b64(ct) };
}

/** Create a brand new vault (fresh salt). Returns { vault, raw }. */
export async function createVault(pass, data, iter = KDF_ITER) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const raw = await deriveRaw(pass, salt, iter);
  const header = { v: 1, kdf: 'PBKDF2-SHA256', iter, salt: b64(salt) };
  return { vault: await encrypt(raw, header, data), raw };
}

/** Re-encrypt with an already-derived key (fresh IV every time). */
export function sealVault(vault, raw, data) {
  return encrypt(raw, { v: 1, kdf: vault.kdf, iter: vault.iter, salt: vault.salt }, data);
}

export async function openWithKey(vault, raw) {
  validate(vault);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(vault.iv), additionalData: aadFor(vault.iter, vault.salt) },
      key,
      unb64(vault.ct)
    );
    return JSON.parse(td.decode(pt));
  } catch {
    throw new Error('DECRYPT_FAILED');
  }
}

/** Unlock with a passphrase. Returns { raw, data }. */
export async function openVault(pass, vault) {
  validate(vault);
  const raw = await deriveRaw(pass, unb64(vault.salt), vault.iter);
  try {
    return { raw, data: await openWithKey(vault, raw) };
  } catch {
    throw new Error('BAD_PASSPHRASE');
  }
}
