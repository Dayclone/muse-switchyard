// Minimal in-memory stand-in for the chrome.* APIs Switchyard uses.
// Enough fidelity to exercise cookie jars, host permissions, events, storage
// areas, tabs/scripting, alarms and messaging.

const normHost = (d) => d.replace(/^\./, '').toLowerCase();

export function installChrome() {
  const state = {
    now: 1_800_000_000_000,
    jar: new Map(),
    local: {},
    session: {},
    tabs: [],
    reloads: [],
    alarms: new Map(),
    perms: new Set(['https://*.muse.ai/*']),
    badge: {},
    grant: true,
    quotaBytes: 10_000_000
  };
  const L = { message: [], changed: [], alarm: [], command: [], idle: [], removed: [] };

  Date.now = () => state.now;
  const nowSec = () => state.now / 1000;
  const keyOf = (c) => [c.name, c.domain, c.path, c.partitionKey ? c.partitionKey.topLevelSite : ''].join('|');
  const permitted = (host) => [...state.perms].some((p) => {
    const m = /^https:\/\/\*\.([^/]+)\/\*$/.exec(p);
    return m && (host === m[1] || host.endsWith('.' + m[1]));
  });
  const fire = (info) => { for (const l of L.changed) l(info); };
  const purge = () => {
    for (const [k, c] of state.jar) if (!c.session && c.expirationDate <= nowSec()) state.jar.delete(k);
  };

  const cookies = {
    onChanged: { addListener: (f) => L.changed.push(f) },
    async set(d) {
      const host = new URL(d.url).hostname;
      if (!permitted(host)) throw new Error('No host permission for ' + host);
      let domain, hostOnly;
      if (d.domain) {
        const dd = normHost(d.domain);
        if (!(host === dd || host.endsWith('.' + dd))) return null;
        domain = '.' + dd;
        hostOnly = false;
      } else { domain = host; hostOnly = true; }
      if (d.name.startsWith('__Host-') && (d.domain || d.path !== '/' || !d.secure)) return null;
      if (d.name.startsWith('__Secure-') && !d.secure) return null;
      if (d.sameSite === 'no_restriction' && !d.secure) return null;
      const path = d.path || '/';
      const c = {
        name: d.name, value: d.value, domain, path, secure: !!d.secure, httpOnly: !!d.httpOnly,
        sameSite: d.sameSite || 'unspecified', hostOnly, session: d.expirationDate === undefined, storeId: '0'
      };
      if (d.expirationDate !== undefined) c.expirationDate = d.expirationDate;
      if (d.partitionKey) c.partitionKey = d.partitionKey;
      if (!c.session && c.expirationDate <= nowSec()) return null;
      const k = keyOf(c);
      const had = state.jar.get(k);
      if (had) fire({ removed: true, cookie: had, cause: 'overwrite' });
      state.jar.set(k, c);
      fire({ removed: false, cookie: c, cause: 'explicit' });
      return structuredClone(c);
    },
    async getAll(q = {}) {
      purge();
      return [...state.jar.values()]
        .filter((c) => {
          if (q.partitionKey ? !c.partitionKey : c.partitionKey) return false;
          if (q.domain) {
            const h = normHost(c.domain);
            const d = normHost(q.domain);
            if (!(h === d || h.endsWith('.' + d))) return false;
          }
          return true;
        })
        .map((c) => structuredClone(c));
    },
    async get({ url, name, partitionKey }) {
      purge();
      const u = new URL(url);
      for (const c of state.jar.values()) {
        const hostOk = normHost(c.domain) === u.hostname || (!c.hostOnly && u.hostname.endsWith('.' + normHost(c.domain)));
        const pkOk = (partitionKey ? partitionKey.topLevelSite : '') === (c.partitionKey ? c.partitionKey.topLevelSite : '');
        if (c.name === name && hostOk && pkOk && u.pathname.startsWith(c.path)) return structuredClone(c);
      }
      return null;
    },
    async remove({ url, name, partitionKey }) {
      const u = new URL(url);
      if (!permitted(u.hostname)) throw new Error('No host permission');
      for (const [k, c] of state.jar) {
        const hostOk = normHost(c.domain) === u.hostname || (!c.hostOnly && u.hostname.endsWith('.' + normHost(c.domain)));
        const pkOk = (partitionKey ? partitionKey.topLevelSite : '') === (c.partitionKey ? c.partitionKey.topLevelSite : '');
        if (c.name === name && hostOk && pkOk && u.pathname === c.path) {
          state.jar.delete(k);
          fire({ removed: true, cookie: c, cause: 'explicit' });
          return { url, name };
        }
      }
      return null;
    }
  };

  const area = (store, getObj) => ({
    async get(keys) {
      const o = getObj();
      if (keys == null) return structuredClone(o);
      const list = typeof keys === 'string' ? [keys] : keys;
      const out = {};
      for (const k of list) if (k in o) out[k] = structuredClone(o[k]);
      return out;
    },
    async set(obj) {
      if (store === 'local') {
        const merged = { ...getObj(), ...obj };
        if (JSON.stringify(merged).length > state.quotaBytes) throw new Error('QUOTA_BYTES quota exceeded');
      }
      Object.assign(getObj(), structuredClone(obj));
    },
    async remove(keys) { for (const k of [].concat(keys)) delete getObj()[k]; },
    async clear() { for (const k of Object.keys(getObj())) delete getObj()[k]; }
  });

  const mkStorage = (obj) => ({
    get length() { return Object.keys(obj).length; },
    key: (i) => Object.keys(obj)[i] ?? null,
    getItem: (k) => (k in obj ? obj[k] : null),
    setItem: (k, v) => { obj[k] = String(v); },
    removeItem: (k) => { delete obj[k]; },
    clear: () => { for (const k of Object.keys(obj)) delete obj[k]; }
  });

  // Chrome match patterns: "https://*.muse.ai/*" also matches the bare host muse.ai.
  const patternRe = (p) => new RegExp('^' + p
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace('://*\\.', '://([^/]*\\.)?')
    .replace(/\*/g, '.*') + '$');

  globalThis.chrome = {
    runtime: {
      id: 'test-extension-id',
      getURL: (p = '') => 'chrome-extension://test-extension-id/' + p,
      onMessage: { addListener: (f) => L.message.push(f) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} }
    },
    cookies,
    storage: {
      local: area('local', () => state.local),
      session: area('session', () => state.session)
    },
    tabs: {
      async query({ url }) {
        const res = (Array.isArray(url) ? url : [url]).map(patternRe);
        return state.tabs.filter((t) => res.some((r) => r.test(t.url))).map((t) => ({ id: t.id, url: t.url }));
      },
      async reload(id) { state.reloads.push(id); },
      async create() {},
      onRemoved: { addListener: (f) => L.removed.push(f) }
    },
    scripting: {
      async executeScript({ target, func, args = [] }) {
        const tab = state.tabs.find((t) => t.id === target.tabId);
        if (!tab) throw new Error('No tab');
        const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
        def('localStorage', mkStorage(tab.local));
        def('sessionStorage', mkStorage(tab.session));
        def('location', { origin: tab.origin || new URL(tab.url).origin });
        return [{ result: func(...args) }];
      }
    },
    alarms: {
      create(name, info) { state.alarms.set(name, info); },
      async get(name) { return state.alarms.get(name) || undefined; },
      onAlarm: { addListener: (f) => L.alarm.push(f) }
    },
    permissions: {
      async contains({ origins }) { return origins.every((o) => state.perms.has(o)); },
      async remove({ origins }) { origins.forEach((o) => state.perms.delete(o)); return true; },
      async request({ origins }) { if (state.grant) origins.forEach((o) => state.perms.add(o)); return state.grant; }
    },
    action: {
      async setBadgeText({ text }) { state.badge.text = text; },
      async setBadgeBackgroundColor({ color }) { state.badge.color = color; }
    },
    commands: { onCommand: { addListener: (f) => L.command.push(f) } },
    idle: { onStateChanged: { addListener: (f) => L.idle.push(f) } }
  };

  const api = {
    state,
    send(msg, sender = { id: 'test-extension-id', url: 'chrome-extension://test-extension-id/popup.html' }) {
      return new Promise((resolve) => {
        let keep = false;
        let answered = false;
        const respond = (r) => { answered = true; resolve(r); };
        for (const l of L.message) keep = l(msg, sender, respond) === true || keep;
        if (!keep && !answered) resolve(undefined);
      });
    },
    fireAlarm(name) { for (const l of L.alarm) l({ name }); },
    fireCommand(name) { for (const l of L.command) l(name); },
    fireIdle(s) { for (const l of L.idle) l(s); },
    tick: (ms = 40) => new Promise((r) => setTimeout(r, ms)),
    advance(sec) { state.now += sec * 1000; },
    reset() {
      state.jar.clear();
      for (const k of Object.keys(state.local)) delete state.local[k];
      for (const k of Object.keys(state.session)) delete state.session[k];
      state.tabs.length = 0;
      state.reloads.length = 0;
      state.alarms.clear();
      state.perms = new Set(['https://*.muse.ai/*']);
      state.badge = {};
      state.grant = true;
      state.quotaBytes = 10_000_000;
      state.now = 1_800_000_000_000;
    },
    removeTab(id) {
      const i = state.tabs.findIndex((t) => t.id === id);
      if (i >= 0) state.tabs.splice(i, 1);
      for (const l of L.removed) l(id);
    },
    addTab(t) {
      const tab = { id: state.tabs.length + 1, local: {}, session: {}, ...t };
      state.tabs.push(tab);
      return tab;
    },
    jarGet(name) {
      purge();
      return [...state.jar.values()].filter((c) => c.name === name);
    },

    /** Simulated website behaviour. */
    site: {
      async login(who, { ttl = 7 * 86400, allPersistent = false } = {}) {
        const exp = nowSec() + ttl;
        const set = (d) => cookies.set(d);
        await set({ url: 'https://muse.ai/', domain: '.muse.ai', name: '__Secure-sid', value: `sid-${who}`, path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: exp });
        await set({ url: 'https://auth.muse.ai/', name: 'auth_rt', value: `rt-${who}`, path: '/', secure: true, httpOnly: true, expirationDate: exp });
        await set({ url: 'https://muse.ai/', domain: '.muse.ai', name: 'csrf', value: `csrf-${who}`, path: '/', secure: true, expirationDate: nowSec() + (allPersistent ? ttl : 3600) });
        await set({ url: 'https://muse.ai/', name: '__Host-dev', value: `dev-${who}`, path: '/', secure: true, httpOnly: true, expirationDate: exp });
        await set({ url: 'https://muse.ai/', domain: '.muse.ai', name: 'sess', value: `sess-${who}`, path: '/', secure: true, ...(allPersistent ? { expirationDate: exp } : {}) });
      },
      async rotate(value) {
        await cookies.set({ url: 'https://muse.ai/', domain: '.muse.ai', name: '__Secure-sid', value, path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: nowSec() + 7 * 86400 });
      },
      /** Server-side logout: Set-Cookie with a past expiry on every cookie. */
      logout() {
        for (const [k, c] of [...state.jar]) {
          state.jar.delete(k);
          fire({ removed: true, cookie: c, cause: 'expired_overwrite' });
        }
      }
    }
  };
  return api;
}
