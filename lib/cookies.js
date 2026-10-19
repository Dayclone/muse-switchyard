// Pure helpers for turning stored cookie snapshots back into
// chrome.cookies.set() calls. No chrome.* access here so it can be unit tested.

export const MAX_DAYS = 400; // browsers clamp cookie lifetime to ~400 days

export const normHost = (d) => String(d).replace(/^\./, '').toLowerCase();

export function inScope(cookieDomain, bases) {
  const h = normHost(cookieDomain);
  return bases.some((b) => {
    const base = normHost(b);
    return h === base || h.endsWith('.' + base);
  });
}

export const cookieId = (c) =>
  [c.name, c.domain, c.path, c.partitionKey ? c.partitionKey.topLevelSite : ''].join('\u0000');

/** Keep only the fields we need to restore a cookie. */
export function slimCookie(c) {
  const o = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite || 'unspecified',
    hostOnly: !!c.hostOnly,
    session: !!c.session
  };
  if (!c.session && typeof c.expirationDate === 'number') o.expirationDate = c.expirationDate;
  if (c.partitionKey) o.partitionKey = c.partitionKey;
  return o;
}

const HOST_RE = /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SAMESITE = new Set(['unspecified', 'no_restriction', 'lax', 'strict']);

/**
 * Strict validation for anything that did not come straight from the live
 * browser (imports, and every restore). Returns a clean slim cookie or null.
 * Rejects hosts/paths that could make `https://${domain}${path}` point
 * somewhere other than the intended site.
 */
export function sanitizeCookie(c) {
  if (!c || typeof c !== 'object') return null;
  const { name, value, domain, path } = c;
  if (typeof name !== 'string' || !name || name.length > 256 || /[\x00-\x1f\x7f;=,]/.test(name)) return null;
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x08\x0a-\x1f\x7f;]/.test(value)) return null;
  if (typeof domain !== 'string' || domain.length > 253 || !HOST_RE.test(domain.toLowerCase())) return null;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 512 || /[\x00-\x20\x7f;?#\\]/.test(path)) return null;
  const out = slimCookie({ ...c, domain: domain.toLowerCase() });
  if (!SAMESITE.has(out.sameSite)) out.sameSite = 'unspecified';
  if ('expirationDate' in out && !(out.expirationDate > 0 && out.expirationDate < 4102444800)) {
    delete out.expirationDate; // absurd or non-finite: treat as a session cookie
    out.session = true;
  }
  if (out.partitionKey) {
    const ts = out.partitionKey.topLevelSite;
    if (typeof ts !== 'string' || ts.length > 300) delete out.partitionKey;
    else {
      out.partitionKey = { topLevelSite: ts };
      if (c.partitionKey.hasCrossSiteAncestor === true) out.partitionKey.hasCrossSiteAncestor = true;
    }
  }
  return out;
}

export const WEB_MAX_CHARS = 400_000; // per profile, all origins together
const WEB_MAX_KEYS = 1000;
const WEB_MAX_ORIGINS = 5;

/**
 * Keep only https origins inside `bases`, with string-only storage maps.
 * An origin that exceeds the size caps is dropped whole (a truncated
 * snapshot would be inconsistent), never partially kept.
 */
export function sanitizeWeb(web, bases) {
  const out = {};
  if (!web || typeof web !== 'object') return out;
  let total = 0;
  const clean = (o) => {
    const r = {};
    let n = 0;
    let size = 0;
    if (!o || typeof o !== 'object') return { r, n, size };
    for (const [k, v] of Object.entries(o)) {
      if (k === '__proto__' || typeof v !== 'string' || k.length > 1024) continue;
      r[k] = v;
      n++;
      size += k.length + v.length;
    }
    return { r, n, size };
  };
  for (const [origin, v] of Object.entries(web).slice(0, WEB_MAX_ORIGINS)) {
    let u;
    try { u = new URL(origin); } catch { continue; }
    if (u.protocol !== 'https:' || u.origin !== origin || !inScope(u.hostname, bases)) continue;
    const l = clean(v && v.local);
    const s = clean(v && v.session);
    const size = l.size + s.size;
    if (l.n > WEB_MAX_KEYS || s.n > WEB_MAX_KEYS || total + size > WEB_MAX_CHARS) continue;
    total += size;
    out[origin] = { local: l.r, session: s.r };
  }
  return out;
}

export const cookieUrl = (c) => `https://${normHost(c.domain)}${c.path || '/'}`;

/**
 * Build the details object for chrome.cookies.set(), or null to skip.
 * opts: { keepAliveDays, persistSession, now }
 */
export function toSetDetails(c, opts = {}) {
  const { keepAliveDays = 0, persistSession = false, now = Date.now() / 1000 } = opts;
  const lname = c.name.toLowerCase(); // cookie prefixes are case-insensitive
  const hostPrefix = lname.startsWith('__host-');
  const securePrefix = lname.startsWith('__secure-') || lname.startsWith('__http-');
  const secure = !!c.secure || hostPrefix || securePrefix || c.sameSite === 'no_restriction';
  const path = hostPrefix ? '/' : c.path || '/';

  const d = {
    url: `https://${normHost(c.domain)}${path}`,
    name: c.name,
    value: c.value,
    path,
    secure,
    httpOnly: !!c.httpOnly || lname.startsWith('__http-')
  };
  if (c.sameSite && c.sameSite !== 'unspecified') d.sameSite = c.sameSite;
  // __Host- cookies must not carry a Domain attribute; host-only cookies neither.
  if (!c.hostOnly && !hostPrefix) d.domain = c.domain;
  if (c.partitionKey) d.partitionKey = c.partitionKey;

  const extend = Math.min(Math.max(0, keepAliveDays), MAX_DAYS) * 86400;
  if (c.session) {
    if (extend > 0 && persistSession) d.expirationDate = now + extend;
  } else if (extend > 0) {
    d.expirationDate = Math.max(c.expirationDate || 0, now + extend);
  } else {
    if (!c.expirationDate || c.expirationDate <= now) return null; // already dead
    d.expirationDate = c.expirationDate;
  }
  return d;
}

/**
 * Guard against overwriting a good saved snapshot with a logged-out one.
 * True means "the live state looks much smaller than what we have saved".
 */
export function looksLoggedOut(savedCount, liveCount) {
  if (liveCount === 0) return true;
  return savedCount >= 4 && liveCount < savedCount * 0.5;
}

/**
 * Heuristic: does the live cookie set look like a *different login* rather than
 * token rotation? Rotation changes one or two values; signing in as someone else
 * changes nearly every credential-bearing (httpOnly) cookie at once.
 */
export function looksLikeOtherLogin(saved, live, { minSample = 3, ratio = 0.75 } = {}) {
  const key = (c) => [c.name, c.domain, c.path].join('\u0000');
  const liveMap = new Map(live.map((c) => [key(c), c]));
  let both = 0;
  let changed = 0;
  for (const c of saved) {
    if (!c.httpOnly) continue;
    const l = liveMap.get(key(c));
    if (!l) continue;
    both++;
    if (l.value !== c.value) changed++;
  }
  if (both >= minSample) return changed / both >= ratio;
  // Few credential cookies: only call it a different login when every one of them changed.
  return both >= 2 && changed === both;
}

/**
 * True when most credential (httpOnly) cookies we saved are gone from the live set:
 * the browser was downgraded to an anonymous session even though other cookies remain.
 */
export function lostCredentials(saved, live) {
  const key = (c) => [c.name, c.domain, c.path].join('\u0000');
  const liveKeys = new Set(live.map(key));
  const cred = saved.filter((c) => c.httpOnly);
  if (cred.length < 2) return false;
  const present = cred.filter((c) => liveKeys.has(key(c))).length;
  return present < cred.length * 0.5;
}

/** Strip control and bidirectional-override characters from user-supplied names. */
export function cleanLabel(n) {
  return String(n || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim().slice(0, 60);
}

export const isId = (id) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
