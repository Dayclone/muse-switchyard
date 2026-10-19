// Dev-only: regenerates the README screenshots in docs/img/ from popup.html using ONLY canned demo data.
// Not part of `npm test` and not a dependency: it needs an importable `playwright` and a Chromium, e.g.
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tools/screenshots.mjs
// Env: PLAYWRIGHT (path to the playwright module, if not importable), CHROMIUM (browser executable).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'img');
fs.mkdirSync(outDir, { recursive: true });

async function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT, 'playwright'];
  try { tries.push(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); } catch { /* no npm */ }
  for (const t of tries.filter(Boolean)) {
    try {
      const m = t.startsWith('/') ? createRequire(import.meta.url)(t) : await import(t);
      return m.chromium ? m : m.default;
    } catch { /* try next */ }
  }
  throw new Error('playwright is not importable; set PLAYWRIGHT=/path/to/node_modules/playwright');
}

/* ---- canned demo state (fake names only) ---- */
const FIXED_NOW = Date.UTC(2026, 0, 15, 17, 30); // frozen clock so "saved 5 min ago" and log times are stable
const min = 60000;
const DEMO = {
  profiles: [
    { id: 'demo-a', name: 'Demo A', updated: FIXED_NOW - 5 * min, cookieCount: 14, needsLogin: false },
    { id: 'demo-b', name: 'Demo B', updated: FIXED_NOW - 3 * 60 * min, cookieCount: 12, needsLogin: false },
    { id: 'demo-c', name: 'Demo C', updated: FIXED_NOW - 30 * 60 * min, cookieCount: 9, needsLogin: true }
  ],
  activeId: 'demo-a',
  settings: { keepAliveDays: 180, persistSession: true, autoSync: true, reloadAfterSwitch: true, clearOnLock: false, autoLockMinutes: 30, domains: ['muse.ai'] },
  approve: { enabled: true, all: false, messages: true, listings: true, holdRisky: true, learn: false, loop: true, loopMinutes: 5 },
  log: [
    { t: FIXED_NOW - 9 * min, decision: 'approved', category: 'messages', title: 'Send message', task: 'Demo task', account: 'Demo A' },
    { t: FIXED_NOW - 9 * min + 4000, decision: 'confirmed', category: 'messages', title: 'Send message', task: 'Demo task', account: 'Demo A' },
    { t: FIXED_NOW - 6 * min, decision: 'approved', category: 'listings', title: 'Publish listing', task: 'Demo task', account: 'Demo B' },
    { t: FIXED_NOW - 6 * min + 4000, decision: 'confirmed', category: 'listings', title: 'Publish listing', task: 'Demo task', account: 'Demo B' },
    { t: FIXED_NOW - 3 * min, decision: 'skipped', category: 'other', title: 'Delete item', task: 'Demo task', account: 'Demo B' },
    { t: FIXED_NOW - 1 * min, decision: 'needs-login', category: '', title: 'Signed out', task: '', account: 'Demo C' }
  ]
};

// Runs before popup.js. Answers the runtime.sendMessage({type, ...}) calls popup.js makes, same response shapes as background.js.
function fakeChrome({ demo, now }) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return now; }
  }
  globalThis.Date = FixedDate;
  let approve = { ...demo.approve };
  const handlers = {
    status: () => ({ state: 'unlocked', settings: demo.settings, frozen: false, profiles: demo.profiles, activeId: demo.activeId }),
    getApprove: () => ({ approve, stale: false }),
    setApprove: (m) => { approve = { ...approve, ...m.approve }; return { approve }; },
    approveLog: () => ({ log: demo.log }),
    clearApproveLog: () => ({})
  };
  globalThis.chrome = {
    runtime: { sendMessage: async (m) => { const f = handlers[m.type]; return f ? { ok: true, ...f(m) } : { ok: false, error: `demo: unhandled ${m.type}` }; } },
    tabs: { create: async () => {} },
    permissions: { request: async () => false }
  };
}

/* ---- serve the extension folder locally (module scripts do not load from file://) ---- */
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end(); return; }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/popup.html`;

const pw = await loadPlaywright();
const exe = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium/chrome-linux/chrome') ? '/opt/pw-browsers/chromium/chrome-linux/chrome' : undefined);
const browser = await pw.chromium.launch(exe ? { executablePath: exe } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 600 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await ctx.addInitScript(fakeChrome, { demo: DEMO, now: FIXED_NOW });
  await ctx.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '.log{max-height:none!important}'; document.head.append(s); }); });
  const open = async () => { const pg = await ctx.newPage(); await pg.goto(base); await pg.waitForSelector('h1'); await pg.waitForTimeout(150); return pg; };
  const shot = async (pg, name, clip) => { await pg.screenshot({ path: path.join(outDir, name), clip, fullPage: true }); console.log('wrote', name); };
  const heightOf = (pg, sel) => pg.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return Math.ceil(r.bottom + window.scrollY); }, sel);

  // 1. account list: header, Accounts, Save current session
  let pg = await open();
  await pg.waitForSelector('.card');
  const accountsBottom = await pg.evaluate(() => Math.ceil([...document.querySelectorAll('.row')].pop().getBoundingClientRect().bottom + window.scrollY) + 8);
  await shot(pg, 'popup-accounts.png', { x: 0, y: 0, width: 360, height: accountsBottom });

  // 2. settings with the Auto-approve section (toggles + hold-risky + loop)
  await pg.click('button[aria-label="Settings"]');
  await pg.waitForSelector('label.check');
  await pg.waitForTimeout(150);
  await pg.evaluate(() => { // popup.js currently renders a literal "null" text node here; hide it so the docs show the intended UI
    const w = document.createTreeWalker(document.getElementById('app'), NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue === 'null') n.remove();
  });
  const loopBottom = await pg.evaluate(() => Math.ceil(document.querySelector('.field input[type=number]').getBoundingClientRect().bottom + window.scrollY) + 14);
  await shot(pg, 'popup-settings.png', { x: 0, y: 0, width: 360, height: loopBottom });

  // 3. activity log: scroll-free crop from the log buttons through the end of the log
  await pg.getByText('Show what was approved', { exact: true }).click();
  await pg.waitForSelector('.log:not([hidden])');
  const top = await pg.evaluate(() => Math.floor([...document.querySelectorAll('button.wide')].find((b) => b.textContent === 'Keep muse.ai tabs awake…').getBoundingClientRect().top + window.scrollY) - 8);
  const logBottom = await heightOf(pg, '.log');
  // header strip + log area: capture as one clip of the log region with the Auto-approve heading context
  await shot(pg, 'popup-log.png', { x: 0, y: top, width: 360, height: logBottom - top + 14 });
} finally {
  await browser.close();
  server.close();
}
