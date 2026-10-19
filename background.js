import { b64, unb64, createVault, sealVault, openWithKey, openVault } from './lib/crypto.js';
import {
  normHost, inScope, cookieId, slimCookie, sanitizeCookie, sanitizeWeb, cookieUrl, toSetDetails,
  looksLoggedOut, looksLikeOtherLogin, lostCredentials, cleanLabel, isId
} from './lib/cookies.js';

const MAX_PROFILES = 50;
const MAX_COOKIES = 500;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const REQUIRED = ['muse.ai'];
const OPTIONAL = ['facebook.com', 'meta.ai', 'meta.com']; // must match manifest
const DEFAULTS = {
  domains: [...REQUIRED],
  keepAliveDays: 180,
  persistSession: false,
  autoSync: true,
  autoLockMinutes: 30,
  reloadAfterSwitch: true,
  clearOnLock: false
};

class Err extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const int = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

function sanitize(s = {}) {
  const extra = (Array.isArray(s.domains) ? s.domains : [])
    .map((x) => String(x).toLowerCase().trim())
    .filter((x) => OPTIONAL.includes(x));
  return {
    domains: [...new Set([...REQUIRED, ...extra])],
    keepAliveDays: int(s.keepAliveDays, 0, 400, DEFAULTS.keepAliveDays),
    persistSession: s.persistSession === undefined ? DEFAULTS.persistSession : !!s.persistSession,
    autoSync: s.autoSync === undefined ? DEFAULTS.autoSync : !!s.autoSync,
    autoLockMinutes: int(s.autoLockMinutes, 1, 1440, DEFAULTS.autoLockMinutes),
    reloadAfterSwitch: s.reloadAfterSwitch === undefined ? DEFAULTS.reloadAfterSwitch : !!s.reloadAfterSwitch,
    clearOnLock: s.clearOnLock === undefined ? DEFAULTS.clearOnLock : !!s.clearOnLock
  };
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return sanitize(settings);
}

const originPattern = (d) => `https://*.${normHost(d)}/*`;

async function saveSettings(input) {
  const prev = await getSettings();
  const next = sanitize({ ...prev, ...input });
  for (const d of next.domains) {
    if (REQUIRED.includes(d)) continue;
    const has = await chrome.permissions.contains({ origins: [originPattern(d)] });
    if (!has) throw new Err('NO_PERMISSION', `Permission for ${d} was not granted.`);
  }
  for (const d of prev.domains) {
    if (!next.domains.includes(d) && !REQUIRED.includes(d)) {
      try { await chrome.permissions.remove({ origins: [originPattern(d)] }); } catch { /* ignore */ }
    }
  }
  await chrome.storage.local.set({ settings: next });
  return next;
}

/* ------------------------------------------------------------------ */
/* Vault access (serialised so writes never interleave)                */
/* ------------------------------------------------------------------ */

let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function bumpLock() {
  const s = await getSettings();
  await chrome.storage.session.set({ lockAt: Date.now() + s.autoLockMinutes * 60000 });
}

const MAX_VAULT_CHARS = 8_000_000; // keep clear of the 10 MB storage.local quota

/**
 * Run fn(data, commit) against the decrypted vault. `commit()` persists the
 * current state immediately (used to checkpoint before touching the browser);
 * a final commit happens automatically when `write` is true.
 */
async function withVault(fn, { write = true, touch = true } = {}) {
  return serial(async () => {
    const { vault } = await chrome.storage.local.get('vault');
    if (!vault) throw new Err('NO_VAULT', 'No vault yet.');
    const { k, gen: seen = 0 } = await chrome.storage.session.get(['k', 'gen']);
    if (!k) throw new Err('LOCKED', 'Vault is locked.');
    const raw = unb64(k);
    const data = await openWithKey(vault, raw);
    if ((data.gen || 0) < seen) {
      throw new Err('ROLLBACK', 'The vault on disk is older than the version this session last saw (restored from a backup, or tampered with).');
    }
    let current = vault;
    const commit = async () => {
      data.gen = (data.gen || 0) + 1;
      try {
        const next = await sealVault(current, raw, data);
        if (next.ct.length > MAX_VAULT_CHARS) throw new Err('QUOTA', 'The vault is full. Remove an account or reduce what is saved.');
        await chrome.storage.local.set({ vault: next });
        current = next;
      } catch (e) {
        data.gen -= 1;
        throw /quota/i.test(String(e && e.message)) ? new Err('QUOTA', 'The vault is full. Remove an account or reduce what is saved.') : e;
      }
      await chrome.storage.session.set({ gen: data.gen });
    };
    const res = await fn(data, commit);
    if (write) await commit();
    if (touch) await bumpLock();
    return res;
  });
}

async function unlockedKey() {
  const { k } = await chrome.storage.session.get('k');
  if (!k) throw new Err('LOCKED', 'Vault is locked.');
  return k;
}

/* ------------------------------------------------------------------ */
/* Browser state: cookies + page storage                               */
/* ------------------------------------------------------------------ */

async function captureCookies(domains) {
  const seen = new Map();
  for (const d of domains) {
    for (const q of [{ domain: d }, { domain: d, partitionKey: {} }]) {
      try {
        for (const c of await chrome.cookies.getAll(q)) {
          if (inScope(c.domain, domains)) seen.set(cookieId(c), slimCookie(c));
        }
      } catch { /* partitioned query unsupported or no permission */ }
    }
  }
  return [...seen.values()];
}

async function removeCookie(c) {
  const d = { url: cookieUrl(c), name: c.name };
  if (c.partitionKey) d.partitionKey = c.partitionKey;
  try { await chrome.cookies.remove(d); } catch { /* ignore */ }
}

async function clearCookies(domains) {
  const live = await captureCookies(domains);
  for (const c of live) await removeCookie(c);
}

async function restoreCookies(cookies, settings) {
  let restored = 0;
  let failed = 0;
  const now = Date.now() / 1000;
  for (const raw of cookies) {
    const c = sanitizeCookie(raw); // never trust stored data blindly
    if (!c || !inScope(c.domain, settings.domains)) { failed++; continue; }
    const d = toSetDetails(c, {
      keepAliveDays: settings.keepAliveDays,
      persistSession: settings.persistSession,
      now
    });
    if (!d) continue; // expired and keep-alive is off
    try {
      (await chrome.cookies.set(d)) ? restored++ : failed++;
    } catch { failed++; }
  }
  return { restored, failed };
}

async function siteTabs(domains) {
  try { return await chrome.tabs.query({ url: domains.map(originPattern) }); } catch { return []; }
}

async function captureWeb(domains) {
  const out = {};
  for (const tab of await siteTabs(domains)) {
    let origin;
    try { origin = new URL(tab.url).origin; } catch { continue; }
    if (out[origin]) continue;
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [origin],
        func: (expected) => {
          // The tab may have navigated since we queried it; never read another origin's storage.
          if (location.origin !== expected) return null;
          const dump = (st) => {
            const o = {};
            try { for (let i = 0; i < st.length; i++) { const k = st.key(i); o[k] = st.getItem(k); } } catch { /* blocked */ }
            return o;
          };
          return { local: dump(localStorage), session: dump(sessionStorage) };
        }
      });
      if (r && r.result) out[origin] = r.result;
    } catch { /* tab not scriptable (discarded, error page...) */ }
  }
  return out;
}

async function restoreWeb(domains, rawWeb = {}) {
  const web = sanitizeWeb(rawWeb, domains);
  for (const tab of await siteTabs(domains)) {
    let origin;
    try { origin = new URL(tab.url).origin; } catch { continue; }
    const saved = web[origin] || { local: {}, session: {} };
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [origin, saved.local || {}, saved.session || {}],
        func: (expected, local, session) => {
          if (location.origin !== expected) return; // tab navigated away meanwhile
          try { localStorage.clear(); for (const k of Object.keys(local)) localStorage.setItem(k, local[k]); } catch { /* ignore */ }
          try { sessionStorage.clear(); for (const k of Object.keys(session)) sessionStorage.setItem(k, session[k]); } catch { /* ignore */ }
        }
      });
    } catch { /* ignore */ }
  }
}

async function reloadTabs(domains) {
  for (const tab of await siteTabs(domains)) {
    try { await chrome.tabs.reload(tab.id); } catch { /* ignore */ }
  }
}

/* "Frozen" = auto-save paused because the live browser may no longer match the active
   account. Kept in storage.local so locking, restarts and worker eviction cannot clear it. */
const isFrozen = async () => !!(await chrome.storage.local.get('frozen')).frozen;
const setFrozen = () => chrome.storage.local.set({ frozen: true });
const clearFrozen = () => chrome.storage.local.remove('frozen');

async function suppressEvents(ms) {
  await chrome.storage.session.set({ suppressUntil: Date.now() + ms });
}

/* ------------------------------------------------------------------ */
/* Profile operations (run inside withVault)                           */
/* ------------------------------------------------------------------ */

function cleanName(n) {
  const s = cleanLabel(n);
  if (!s) throw new Err('BAD_NAME', 'Give the account a name.');
  return s;
}

/** Own-property, UUID-shaped lookup so ids like "__proto__" can never reach Object.prototype. */
function P(d, id) {
  if (!isId(id) || !Object.hasOwn(d.profiles, id)) throw new Err('NOT_FOUND', 'Unknown account.');
  return d.profiles[id];
}

/** Page-storage snapshot, size-capped at capture time. */
async function snapshotWeb(domains) {
  const raw = await captureWeb(domains);
  const web = sanitizeWeb(raw, domains);
  const dropped = Object.keys(raw).filter((o) => !(o in web));
  return { web, dropped };
}

/** Copy the live browser state into a saved profile. */
async function syncProfile(data, id, settings, { force = false } = {}) {
  const p = P(data, id);
  const cookies = await captureCookies(settings.domains);
  if (force) p.cookies = [];
  if (!force && (looksLoggedOut(p.cookies.length, cookies.length) || lostCredentials(p.cookies, cookies))) {
    p.warn = 'Browser looks signed out; the last good copy was kept.';
    return { saved: false };
  }
  if (!force && looksLikeOtherLogin(p.cookies, cookies)) {
    // Nearly every credential changed at once: a different login, not token rotation.
    await setFrozen();
    p.warn = 'Browser looks signed in as a different account; auto-save paused.';
    updateBadge(); // queued behind the current vault operation
    return { saved: false, frozen: true };
  }
  if (!cookies.length) throw new Err('NO_SESSION', 'No muse.ai session found in the browser. Log in first.');
  // Merge rather than replace: a cookie that is merely absent right now (cleared, blocked,
  // or not yet re-set) is kept; live values win. Expired entries are pruned.
  const now = Date.now() / 1000;
  const merged = new Map();
  for (const c of p.cookies) if (c.session || !c.expirationDate || c.expirationDate > now) merged.set(cookieId(c), c);
  for (const c of cookies) merged.set(cookieId(c), c);
  p.cookies = [...merged.values()].slice(0, MAX_COOKIES);
  const { web, dropped } = await snapshotWeb(settings.domains);
  p.web = { ...p.web, ...web };
  for (const o of dropped) delete p.web[o];
  p.updated = Date.now();
  delete p.warn;
  if (dropped.length) p.warn = 'Page storage was too large and was skipped; cookies were saved.';
  return { saved: true };
}

/**
 * Save the live state into the active account, unless auto-save is paused
 * ("frozen") because cookies were removed behind our back, which usually
 * means the user signed out or into a different account outside Switchyard.
 */
async function autoSyncActive(data, settings) {
  if (!settings.autoSync || !data.activeId || !data.profiles[data.activeId]) return;
  if (await isFrozen()) return;
  await syncProfile(data, data.activeId, settings);
}

async function doSwitch(data, id, settings, commit) {
  const p = P(data, id);
  await suppressEvents(15000);
  if (data.activeId === id) {
    // Already active: re-applying the snapshot would overwrite newer rotated tokens with stale ones.
    // Only re-apply when the browser has nothing to lose (signed out).
    const live = await captureCookies(settings.domains);
    if (live.length > 0) {
      await autoSyncActive(data, settings);
      await suppressEvents(1500);
      return { restored: 0, failed: 0, unchanged: true };
    }
  } else {
    await autoSyncActive(data, settings);
  }

  // What the browser holds now, so a failed restore cannot leave the user signed out.
  const backup = await captureCookies(settings.domains);
  const backupWeb = await captureWeb(settings.domains);

  // Persist the intent *before* touching the browser. If the vault cannot be written
  // (quota, disk), nothing has changed yet and the error surfaces cleanly.
  const prevActive = data.activeId;
  const wasFrozen = await isFrozen();
  data.activeId = id;
  await commit();
  // Journal: if the worker dies mid-switch the browser may hold a half-restored mix, so
  // auto-save stays paused until a switch completes or the user refreshes.
  await setFrozen();

  try {
    await clearCookies(settings.domains);
    const result = await restoreCookies(p.cookies, settings);
    if (result.restored === 0 && p.cookies.length > 0) {
      await restoreCookies(backup, { ...settings, keepAliveDays: 0 });
      await restoreWeb(settings.domains, backupWeb);
      data.activeId = prevActive;
      await commit();
      if (!wasFrozen) await clearFrozen();
      await suppressEvents(1500);
      return { ...result, rolledBack: true };
    }
    await restoreWeb(settings.domains, p.web);
    p.lastUsed = Date.now();
    delete p.warn;
    if (result.failed > 0) p.warn = `${result.failed} cookie(s) could not be restored; the rest were. Sign in again if something looks wrong.`;
    await clearFrozen();
    if (settings.reloadAfterSwitch) await reloadTabs(settings.domains);
    await suppressEvents(1500);
    return result;
  } catch (e) {
    try {
      await restoreCookies(backup, { ...settings, keepAliveDays: 0 });
      await restoreWeb(settings.domains, backupWeb);
      data.activeId = prevActive;
      await commit();
      if (!wasFrozen) await clearFrozen();
    } catch { /* best effort; the journal flag stays set */ }
    throw e;
  }
}

const meta = (data) => ({
  activeId: data.activeId || null,
  profiles: Object.values(data.profiles)
    .map((p) => ({
      id: p.id, name: p.name, updated: p.updated, lastUsed: p.lastUsed || null,
      cookieCount: p.cookies.length, hasWeb: Object.keys(p.web || {}).length > 0, warn: p.warn || null
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
});

/* ------------------------------------------------------------------ */
/* Lock / unlock                                                       */
/* ------------------------------------------------------------------ */

async function lockNow() {
  try {
    const s = await getSettings();
    // A stuck tab/script call must never keep the vault key alive: give up waiting after 8 s.
    await Promise.race([withVault(async (d, commit) => {
      await autoSyncActive(d, s);
      if (s.clearOnLock) {
        // The live browser session is plaintext in Chrome's own cookie jar; optionally drop it.
        await commit(); // saved copy is durable before the live session is removed
        await suppressEvents(15000);
        await clearCookies(s.domains);
        await restoreWeb(s.domains, {});
        d.activeId = null;
        if (s.reloadAfterSwitch) await reloadTabs(s.domains);
      }
    }, { touch: false }), sleep(8000)]);
  } catch { /* best effort: never block locking */ }
  await chrome.storage.session.remove(['k', 'lockAt']);
  updateBadge();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let authChain = Promise.resolve();
function authSerial(fn) {
  const run = authChain.then(fn);
  authChain = run.catch(() => {});
  return run;
}

/**
 * Every passphrase check on the live vault (unlock, export, change) goes through
 * here: attempts are serialised and the counter is bumped *before* the delay, so
 * parallel guesses cannot dodge the back-off.
 */
function verifyPass(pass, vault) {
  return authSerial(async () => {
    const { fails = 0 } = await chrome.storage.session.get('fails');
    await chrome.storage.session.set({ fails: fails + 1 });
    if (fails > 0) await sleep(Math.min(fails, 5) * 800);
    try {
      const res = await openVault(String(pass || ''), vault);
      await chrome.storage.session.set({ fails: 0 });
      return res;
    } catch (e) {
      if (e.message === 'BAD_PASSPHRASE') throw new Err('BAD_PASSPHRASE', 'Wrong passphrase.');
      throw new Err('BAD_VAULT', 'The vault is damaged.');
    }
  });
}

async function unlock(pass) {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) throw new Err('NO_VAULT', 'No vault yet.');
  const { raw, data } = await verifyPass(pass, vault);
  await chrome.storage.session.set({ k: b64(raw), gen: data.gen || 0 });
  await bumpLock();
}

const COMMON = ['password', 'passw0rd', 'qwerty', 'letmein', '123456', 'abcdef', '111111', 'iloveyou', 'welcome', 'admin'];
function checkPass(p) {
  if (typeof p !== 'string' || p.length < 12 || p.length > 256 || new Set(p).size < 8 ||
      COMMON.some((w) => p.toLowerCase().includes(w))) {
    throw new Err('WEAK_PASS', 'Use at least 12 characters with variety, for example four unrelated words. Common patterns are rejected.');
  }
}


/* ------------------------------------------------------------------ */
/* Auto-approve settings, log, and account loop                        */
/* ------------------------------------------------------------------ */

const APPROVE_DEFAULTS = {
  enabled: false, all: false, messages: false, listings: false, holdRisky: false, learn: false,
  maxPerMinute: 12, idleSeconds: 20, loop: false, loopMinutes: 10
};

function sanitizeApprove(a) {
  const o = a && typeof a === 'object' ? a : {};
  const b = (v, d) => (v === undefined ? d : v === true);
  return {
    enabled: o.enabled === true,
    all: o.all === true,
    messages: o.messages === true,
    listings: o.listings === true,
    holdRisky: o.holdRisky === true,
    learn: o.learn === true,
    maxPerMinute: int(o.maxPerMinute, 1, 120, APPROVE_DEFAULTS.maxPerMinute),
    idleSeconds: int(o.idleSeconds, 5, 300, APPROVE_DEFAULTS.idleSeconds),
    loop: b(o.loop, false),
    loopMinutes: int(o.loopMinutes, 2, 240, APPROVE_DEFAULTS.loopMinutes)
  };
}
const getApprove = async () => sanitizeApprove((await chrome.storage.local.get('approve')).approve);

let logChain = Promise.resolve();
function appendApproveLog(entry) {
  const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, n);
  const e = {
    t: Number.isFinite(entry.t) ? entry.t : Date.now(),
    decision: clip(entry.decision, 20), title: clip(entry.title, 160), action: clip(entry.action, 80),
    task: clip(entry.task, 80), category: clip(entry.category, 12), account: clip(entry.account, 60)
  };
  logChain = logChain.then(async () => {
    const { approveLog = [] } = await chrome.storage.local.get('approveLog');
    approveLog.push(e);
    await chrome.storage.local.set({ approveLog: approveLog.slice(-200) });
  }).catch(() => {});
  return logChain;
}

// Messages from the muse.ai content script. It can only report; it can never change settings or switch accounts.
chrome.runtime.onMessage.addListener((msg, sender) => {
  const fromSite = sender.id === chrome.runtime.id && sender.tab && typeof sender.url === 'string' &&
    /^https:\/\/([a-z0-9-]+\.)*muse\.ai\//.test(sender.url);
  if (!fromSite || !msg || typeof msg.type !== 'string') return false;
  if (msg.type === 'approve:log' && msg.entry && typeof msg.entry === 'object') {
    (async () => {
      const a = await getApprove();
      if (!a.enabled) return;
      const { activeName } = await chrome.storage.session.get('activeName');
      await appendApproveLog({ ...msg.entry, account: activeName });
    })();
  } else if (msg.type === 'approve:idle') {
    chrome.storage.session.set({ approveIdleAt: Date.now() }).catch(() => {});
  }
  return false;
});

/**
 * Account loop, as a tick-driven state machine (the service worker can be evicted between ticks):
 * switch to an account, stay until its approvals are cleared (page reports idle) or a time cap,
 * then move on. Runs only while the vault is unlocked.
 */
const DWELL_MIN_MS = 25000;
const DWELL_MAX_MS = 150000;

async function loopTick() {
  const a = await getApprove();
  const { loopState: st, k, approveIdleAt = 0 } = await chrome.storage.session.get(['loopState', 'k', 'approveIdleAt']);
  if (!a.enabled || !a.loop || !k) { if (st) await chrome.storage.session.remove('loopState'); return; }
  const now = Date.now();
  const { lastLoopEnd = 0 } = await chrome.storage.session.get('lastLoopEnd');

  let state = st;
  if (!state) {
    if (now - lastLoopEnd < a.loopMinutes * 60000) return;
    const ids = await withVault(async (d) => Object.values(d.profiles).sort((x, y) => x.name.localeCompare(y.name)).map((p) => p.id),
      { write: false, touch: false });
    if (!ids.length) return;
    state = { queue: ids, i: -1, dwellAt: 0 };
  } else {
    const waited = now - state.dwellAt;
    const settled = approveIdleAt > state.dwellAt && waited >= DWELL_MIN_MS;
    if (!settled && waited < DWELL_MAX_MS) return;
  }

  state.i += 1;
  if (state.i >= state.queue.length) {
    await chrome.storage.session.set({ lastLoopEnd: now });
    await chrome.storage.session.remove('loopState');
    return;
  }
  const s = await getSettings();
  try {
    await withVault((d, commit) => doSwitch(d, state.queue[state.i], s, commit), { touch: false });
    if (!(await siteTabs(s.domains)).length) await chrome.tabs.create({ url: 'https://muse.ai/', active: false });
  } catch (e) {
    if (e.code === 'LOCKED' || e.code === 'NO_VAULT') { await chrome.storage.session.remove('loopState'); return; }
    // Account missing or restore failed: skip it, carry on with the rest.
  }
  state.dwellAt = Date.now();
  await chrome.storage.session.set({ loopState: state });
  updateBadge();
}

/* ------------------------------------------------------------------ */
/* Message handlers                                                    */
/* ------------------------------------------------------------------ */

const handlers = {
  async status() {
    const { vault } = await chrome.storage.local.get('vault');
    const { k } = await chrome.storage.session.get('k');
    const settings = await getSettings();
    if (!vault) return { state: 'nosetup', settings };
    if (!k) return { state: 'locked', settings };
    let m;
    try {
      m = await withVault(async (d) => meta(d), { write: false });
    } catch (e) {
      const code = e.code || e.message;
      if (code === 'DECRYPT_FAILED' || code === 'BAD_VAULT' || code === 'ROLLBACK') {
        return { state: 'corrupt', code, message: e.code === 'ROLLBACK' ? e.message : 'The stored vault is damaged or was modified.', settings };
      }
      throw e;
    }
    return { state: 'unlocked', settings, frozen: await isFrozen(), ...m };
  },

  async setup({ pass }) {
    checkPass(pass);
    return serial(async () => {
      const { vault } = await chrome.storage.local.get('vault');
      if (vault) throw new Err('EXISTS', 'A vault already exists.');
      const { vault: v, raw } = await createVault(pass, { profiles: {}, activeId: null });
      await chrome.storage.local.set({ vault: v });
      await chrome.storage.local.remove('frozen');
      await chrome.storage.session.set({ k: b64(raw), fails: 0, gen: 0 });
      await bumpLock();
      return {};
    });
  },

  async unlock({ pass }) { await unlock(pass); return {}; },
  async lock() { await lockNow(); return {}; },

  async saveCurrent({ name }) {
    const s = await getSettings();
    const clean = cleanName(name);
    return withVault(async (d) => {
      const cookies = await captureCookies(s.domains);
      if (!cookies.length) throw new Err('NO_SESSION', 'No muse.ai session found in the browser. Log in first.');
      if (Object.keys(d.profiles).length >= MAX_PROFILES) throw new Err('TOO_MANY', `Limit of ${MAX_PROFILES} accounts reached.`);
      const id = crypto.randomUUID();
      const { web, dropped } = await snapshotWeb(s.domains);
      d.profiles[id] = {
        id, name: clean, created: Date.now(), updated: Date.now(),
        cookies: cookies.slice(0, MAX_COOKIES), web
      };
      if (dropped.length) d.profiles[id].warn = 'Page storage was too large and was skipped; cookies were saved.';
      d.activeId = id;
      await clearFrozen();
      return { id };
    });
  },

  async refresh({ id }) {
    const s = await getSettings();
    return withVault(async (d) => {
      if (P(d, id) && d.activeId !== id) {
        throw new Err('NOT_ACTIVE', 'Switch to this account first, then refresh. Refreshing copies whoever is signed in right now into the account.');
      }
      await syncProfile(d, id, s, { force: true });
      d.activeId = id;
      await clearFrozen();
      return {};
    });
  },

  async switch({ id }) {
    const s = await getSettings();
    return withVault((d, commit) => doSwitch(d, id, s, commit));
  },

  /** Cycle to the next saved account (keyboard shortcut). */
  async nextAccount() {
    const s = await getSettings();
    return withVault(async (d, commit) => {
      const ids = Object.values(d.profiles).sort((a, b) => a.name.localeCompare(b.name)).map((p) => p.id);
      if (ids.length < 2) throw new Err('NOT_ENOUGH', 'Save at least two accounts first.');
      const next = ids[(ids.indexOf(d.activeId) + 1) % ids.length];
      return doSwitch(d, next, s, commit);
    });
  },

  async rename({ id, name }) {
    const clean = cleanName(name);
    return withVault(async (d) => {
      P(d, id).name = clean;
      return {};
    });
  },

  async remove({ id }) {
    return withVault(async (d) => {
      P(d, id);
      delete d.profiles[id];
      if (d.activeId === id) d.activeId = null;
      return {};
    });
  },

  /** Sign out in the browser only; saved accounts stay. */
  async signOut() {
    const s = await getSettings();
    return withVault(async (d, commit) => {
      await suppressEvents(15000);
      await autoSyncActive(d, s);
      await commit(); // saved copy is durable before the live session is removed
      await clearCookies(s.domains);
      await restoreWeb(s.domains, {});
      d.activeId = null;
      await clearFrozen();
      if (s.reloadAfterSwitch) await reloadTabs(s.domains);
      await suppressEvents(1500);
      return {};
    });
  },

  async getApprove() { return { approve: await getApprove() }; },
  async setApprove({ approve }) {
    const next = sanitizeApprove(approve);
    await chrome.storage.local.set({ approve: next });
    if (!next.loop) await chrome.storage.session.remove(['loopState', 'lastLoopEnd']);
    return { approve: next };
  },
  async approveLog() {
    const { approveLog = [] } = await chrome.storage.local.get('approveLog');
    return { log: approveLog.slice(-100).reverse() };
  },
  async clearApproveLog() { await chrome.storage.local.remove('approveLog'); return {}; },

  async getSettings() { return { settings: await getSettings() }; },
  async setSettings({ settings }) {
    const next = await saveSettings(settings);
    await bumpLock().catch(() => {});
    return { settings: next };
  },

  async exportVault({ pass, repeat, currentPass }) {
    checkPass(pass);
    if (pass !== repeat) throw new Err('MISMATCH', 'The two export passphrases do not match.');
    await unlockedKey();
    const { vault } = await chrome.storage.local.get('vault');
    await verifyPass(currentPass, vault); // re-authenticate: an unlocked browser alone is not enough to exfiltrate
    const data = await withVault(async (d) => ({ kind: 'switchyard-export', profiles: d.profiles }), { write: false });
    const { vault: out } = await createVault(pass, data);
    await openVault(pass, out); // prove the file decrypts before offering it
    return { text: JSON.stringify(out) };
  },

  /** confirm=false returns a preview only; confirm=true writes. Imported accounts are never auto-activated. */
  async importVault({ text, pass, confirm }) {
    if (typeof text !== 'string' || text.length > 32_000_000) throw new Err('BAD_VAULT', 'That file is not a Switchyard export.');
    let vault;
    try { vault = JSON.parse(text); } catch { throw new Err('BAD_VAULT', 'That file is not a Switchyard export.'); }
    let opened;
    try { opened = await openVault(String(pass || ''), vault); } catch (e) {
      throw new Err(e.message === 'BAD_PASSPHRASE' ? 'BAD_PASSPHRASE' : 'BAD_VAULT',
        e.message === 'BAD_PASSPHRASE' ? 'Wrong passphrase for that file.' : 'That file is not a Switchyard export.');
    }
    const incoming = opened.data && opened.data.kind === 'switchyard-export' ? opened.data.profiles : null;
    if (!incoming || typeof incoming !== 'object') throw new Err('BAD_VAULT', 'That file is not a Switchyard export.');
    const s = await getSettings();
    const clean = [];
    let skipped = 0;
    for (const p of Object.values(incoming)) {
      if (!p || typeof p !== 'object' || !Array.isArray(p.cookies)) { skipped++; continue; }
      const name = cleanLabel(p.name);
      const cookies = p.cookies.slice(0, MAX_COOKIES).map(sanitizeCookie).filter(Boolean);
      if (!name || !cookies.length) { skipped++; continue; }
      const t = (v) => (Number.isFinite(v) ? v : Date.now());
      clean.push({
        name: `${name.slice(0, 48)} (imported)`, created: t(p.created), updated: t(p.updated),
        cookies, web: sanitizeWeb(p.web, s.domains)
      });
    }
    if (!confirm) {
      return {
        preview: clean.map((c) => ({
          name: c.name, cookieCount: c.cookies.length,
          domains: [...new Set(c.cookies.map((k) => k.domain.replace(/^\./, '')))].slice(0, 6)
        })),
        skipped
      };
    }
    await unlockedKey();
    return withVault(async (d) => {
      let n = 0;
      for (const c of clean) {
        if (Object.keys(d.profiles).length >= MAX_PROFILES) { skipped++; continue; }
        const id = crypto.randomUUID();
        d.profiles[id] = { id, ...c };
        n++;
      }
      return { imported: n, skipped };
    });
  },

  /** Whole read-verify-rekey-write cycle runs inside the vault lock so no concurrent write is lost. */
  async changePass({ oldPass, newPass }) {
    checkPass(newPass);
    await unlockedKey();
    return serial(async () => {
      const { vault } = await chrome.storage.local.get('vault');
      const { data } = await verifyPass(oldPass, vault);
      data.gen = (data.gen || 0) + 1;
      const { vault: v, raw } = await createVault(newPass, data);
      await chrome.storage.local.set({ vault: v });
      await chrome.storage.session.set({ k: b64(raw), gen: data.gen });
      await bumpLock();
      return {};
    });
  },

  /** Names and flags only; never values. */
  async inspect() {
    await unlockedKey();
    const s = await getSettings();
    const cookies = (await captureCookies(s.domains)).map((c) => ({
      name: c.name, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
      sameSite: c.sameSite, session: c.session, hostOnly: c.hostOnly,
      expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString().slice(0, 10) : null,
      valueLen: c.value.length, partitioned: !!c.partitionKey
    }));
    const web = await captureWeb(s.domains);
    const storage = Object.entries(web).map(([origin, v]) => ({
      origin, local: Object.keys(v.local), session: Object.keys(v.session)
    }));
    return { cookies, storage };
  },

  async wipe() {
    await serial(async () => {
      await chrome.storage.local.remove('vault');
      await chrome.storage.session.clear();
      await chrome.storage.local.remove(['frozen', 'approveLog']);
    });
    return {};
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own extension pages (popup, or popup.html opened in a tab). Content scripts carry the web page's URL.
  const ownPage = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  if (sender.id !== chrome.runtime.id || !ownPage || !msg || typeof msg.type !== 'string') return false;
  const fn = Object.prototype.hasOwnProperty.call(handlers, msg.type) ? handlers[msg.type] : null;
  if (!fn) { sendResponse({ ok: false, error: 'Unknown request.' }); return false; }
  fn(msg)
    .then((res) => sendResponse({ ok: true, ...res }))
    .catch((e) => sendResponse({ ok: false, code: e.code || 'ERROR', error: e.message || String(e) }))
    .finally(() => { if (msg.type !== 'inspect') updateBadge(); });
  return true;
});

/* ------------------------------------------------------------------ */
/* Toolbar badge, shortcut, idle lock                                  */
/* ------------------------------------------------------------------ */

async function updateBadge() {
  try {
    const { k } = await chrome.storage.session.get('k');
    const frozen = await isFrozen();
    let text = '';
    let color = '#0f766e';
    if (!k) { text = 'LOCK'; color = '#6b7280'; }
    else {
      const name = await withVault(async (d) => (d.activeId && d.profiles[d.activeId] ? d.profiles[d.activeId].name : null),
        { write: false, touch: false });
      await chrome.storage.session.set({ activeName: name || '' });
      if (frozen) { text = '!'; color = '#b45309'; }
      else if (name) text = Array.from(name).slice(0, 2).join('').toUpperCase();
      else { text = '?'; color = '#6b7280'; }
    }
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* cosmetic only */ }
}

async function flashError() {
  try {
    await chrome.action.setBadgeText({ text: 'ERR' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
  } catch { /* cosmetic */ }
  setTimeout(updateBadge, 4000);
}

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== 'next-account') return;
  handlers.nextAccount()
    .then((r) => (r && r.rolledBack ? flashError() : updateBadge()))
    .catch(() => flashError());
});

// Lock when the OS screen locks.
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'locked') lockNow().catch(() => {});
});

/* ------------------------------------------------------------------ */
/* Background upkeep                                                   */
/* ------------------------------------------------------------------ */

// Cookie changes on the active account (token rotation) -> debounced re-save.
chrome.cookies.onChanged.addListener(async (info) => {
  try {
    const { k, suppressUntil = 0 } = await chrome.storage.session.get(['k', 'suppressUntil']);
    if (Date.now() < suppressUntil) return;
    const s = await getSettings();
    if (!inScope(info.cookie.domain, s.domains)) return;
    // A cookie deleted by the site or the user (not replaced) means sign-out or an account
    // change outside Switchyard. Pause auto-save so we never write someone else's session
    // over the saved copy; the user resumes with the refresh button.
    if (info.removed && (info.cause === 'explicit' || info.cause === 'expired_overwrite')) {
      const { vault } = await chrome.storage.local.get('vault');
      if (vault) { await setFrozen(); updateBadge(); }
      return;
    }
    // Do not push the alarm back on every event: steady rotation would starve the save.
    if (k && s.autoSync && !(await chrome.alarms.get('sync'))) chrome.alarms.create('sync', { delayInMinutes: 0.5 });
  } catch { /* ignore */ }
});

async function runSync() {
  const s = await getSettings();
  if (!s.autoSync) return;
  try {
    await withVault(async (d) => { await autoSyncActive(d, s); }, { touch: false });
  } catch (e) {
    if (e.code !== 'LOCKED' && e.code !== 'NO_VAULT') throw e;
  }
}

async function autoLockTick() {
  const { k, lockAt } = await chrome.storage.session.get(['k', 'lockAt']);
  if (k && lockAt && Date.now() > lockAt) await lockNow();
}

/** Re-apply long expiry to the cookies currently live in the browser. */
function keepAlive() {
  return serial(async () => {
    const s = await getSettings();
    if (s.keepAliveDays <= 0) return;
    const now = Date.now() / 1000;
    for (const c of await captureCookies(s.domains)) {
      if (!c.session && c.expirationDate && c.expirationDate <= now) continue; // never resurrect a dead cookie
      const d = toSetDetails(c, { keepAliveDays: s.keepAliveDays, persistSession: s.persistSession, now });
      if (!d) continue;
      if (c.session && !d.expirationDate) continue;
      if (!c.session && d.expirationDate && Math.abs(d.expirationDate - (c.expirationDate || 0)) < 86400) continue;
      try {
        // The site may have rotated this cookie while we were iterating: never write a stale value.
        const q = { url: d.url, name: c.name };
        if (c.partitionKey) q.partitionKey = c.partitionKey;
        const fresh = await chrome.cookies.get(q);
        if (!fresh || fresh.value !== c.value) continue;
        await chrome.cookies.set(d);
      } catch { /* ignore */ }
    }
  });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'sync') runSync().catch(() => {});
  else if (a.name === 'autolock') autoLockTick().catch(() => {});
  else if (a.name === 'keepalive') keepAlive().catch(() => {});
  else if (a.name === 'approveTick') loopTick().catch(() => {});
});

async function ensureAlarms() {
  if (!(await chrome.alarms.get('autolock'))) chrome.alarms.create('autolock', { periodInMinutes: 1 });
  if (!(await chrome.alarms.get('keepalive'))) chrome.alarms.create('keepalive', { periodInMinutes: 360 });
  if (!(await chrome.alarms.get('approveTick'))) chrome.alarms.create('approveTick', { periodInMinutes: 0.5 });
}
chrome.runtime.onInstalled.addListener(ensureAlarms);
chrome.runtime.onStartup.addListener(() => { ensureAlarms(); updateBadge(); });
ensureAlarms();
updateBadge();
