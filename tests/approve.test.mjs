// Auto-approve content script: rules (always run) + DOM behaviour on a fixture copied from the
// real approval card's structure (needs jsdom; skips cleanly without it, like popup.smoke.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const SRC = fs.readFileSync(new URL('../content/approve.js', import.meta.url), 'utf8');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };

const MSG = `Allow Muse to send this message in Messenger for Acme Marketplace Auto Replies?

Muse wants to send a message in Messenger to conversation x.
Action
Send Messenger message
Conversation
Pheng · 2015 Chevrolet Tahoe LS
Message
Hey Pheng! Finance Price $21,900 plus GST. Price is as listed. Call me about the payment plan or order.`;
const LIST = `Allow Muse to publish this Marketplace listing on Facebook?
Action
Publish Marketplace listing`;
const PAY = `Allow Muse to make a purchase on Amazon?
Action
Purchase item`;
const ODD = `Allow Muse to access your calendar?
Action
Read calendar`;

/** Load the script into a stubbed page so the pure logic can be exercised without a DOM. */
function load() {
  const sent = [];
  const ctx = {
    window: { __SY_TEST__: {} }, document: { readyState: 'complete', documentElement: {}, querySelectorAll: () => [] },
    MutationObserver: class { observe() {} }, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, Date,
    chrome: { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); } }, storage: { local: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } } }
  };
  ctx.window.window = ctx.window;
  vm.runInNewContext(SRC, ctx);
  return ctx.window.__SY_TEST__.approve;
}

await test('classify reads title, action, task and category; money words in the message body do not matter', () => {
  const A = load();
  const m = A.classify(MSG);
  assert.equal(m.action, 'Send Messenger message');
  assert.equal(m.task, 'Acme Marketplace Auto Replies');
  assert.equal(m.category, 'messages');
  assert.equal(m.risky, false, '"payment"/"order" inside the buyer message must not count');
  assert.equal(A.classify(LIST).category, 'listings');
  assert.equal(A.classify(PAY).risky, true);
  assert.equal(A.classify(ODD).category, 'other');
});

await test('toggles: messages / listings / everything / master / holdRisky / learn', () => {
  const A = load();
  const d = (cfg, text) => { A.setCfg(cfg); return A.decide(A.classify(text)); };
  assert.equal(d({}, MSG), 'off');
  assert.equal(d({ enabled: true }, MSG), 'skipped');
  assert.equal(d({ enabled: true, messages: true }, MSG), 'approve');
  assert.equal(d({ enabled: true, messages: true }, LIST), 'skipped');
  assert.equal(d({ enabled: true, listings: true }, LIST), 'approve');
  assert.equal(d({ enabled: true, listings: true }, MSG), 'skipped');
  assert.equal(d({ enabled: true, all: true }, ODD), 'approve');
  assert.equal(d({ enabled: true, all: true }, PAY), 'approve', 'nothing is held by default');
  assert.equal(d({ enabled: true, all: true, holdRisky: true }, PAY), 'held', 'the hold is opt-in');
  assert.equal(d({ enabled: true, all: true, learn: true }, MSG), 'learn');
});

await test('sanitize ignores junk and keeps safe defaults', () => {
  const A = load();
  const c = A.sanitize({ enabled: 'yes', all: 1, maxPerMinute: 99999, holdRisky: undefined });
  assert.equal(c.enabled, false);
  assert.equal(c.all, false);
  assert.equal(c.maxPerMinute, 120);
  assert.equal(c.holdRisky, false);
  assert.equal(A.sanitize({ holdRisky: true }).holdRisky, true);
});

let JSDOM;
try { ({ JSDOM } = await import(process.env.JSDOM ? pathToFileURL(process.env.JSDOM).href : 'jsdom')); } catch { JSDOM = null; }
if (!JSDOM) console.log('skip - DOM tests need jsdom (see popup.smoke.mjs header)');
else {
  const cardHtml = (text, { deny = true } = {}) => {
    const [title, ...rest] = text.split('\n');
    return `<div id="card"><div>${title}</div><pre>${rest.join('\n')}</pre><div class="row">
      <div class="contents"><button id="allow" data-hatch-approval-primary-action="true"><span>Allow</span></button></div>
      <span><button aria-label="More allow options"></button></span>${deny ? '<button id="deny"><span>Deny</span></button>' : ''}</div></div>`;
  };
  const run = async (html, cfg) => {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    // jsdom has no layout: make every element count as visible, and observe clicks
    Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { get: () => 10 });
    w.HTMLElement.prototype.getBoundingClientRect = function () { return { top: 12, left: 300, width: 56, height: 56, right: 356, bottom: 68 }; };
    const logs = [];
    w.chrome = { runtime: { sendMessage: (m) => { logs.push(m); return Promise.resolve(); } }, storage: { local: { get: () => Promise.resolve({ approve: cfg }) }, onChanged: { addListener() {} } } };
    w.__SY_TEST__ = {};
    let clicks = 0;
    let tabClicks = 0;
    w.document.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('#allow')) clicks++;
      if (e.target.closest && e.target.closest('#appr')) tabClicks++;
    }, true);
    w.eval(SRC);
    w.__SY_TEST__.approve.setCfg(cfg);
    w.__SY_TEST__.approve.scan();
    return { clicks: () => clicks, tabClicks: () => tabClicks, logs, A: w.__SY_TEST__.approve, w };
  };

  await test('DOM: clicks Allow on a message card when messages is on, and logs it', async () => {
    const r = await run(cardHtml(MSG), { enabled: true, messages: true });
    assert.equal(r.clicks(), 1);
    assert.equal(r.logs.find((m) => m.type === 'approve:log').entry.decision, 'approved');
    assert.ok(!JSON.stringify(r.logs).includes('Pheng'), 'log must not carry the recipient or message body');
  });

  await test('DOM: does nothing for a listing card when only messages is on; reports it as skipped', async () => {
    const r = await run(cardHtml(LIST), { enabled: true, messages: true });
    assert.equal(r.clicks(), 0);
    assert.equal(r.logs[0].entry.decision, 'skipped');
  });

  await test('DOM: holds a purchase card even with everything on; learn mode never clicks', async () => {
    assert.equal((await run(cardHtml(PAY), { enabled: true, all: true })).clicks(), 1, 'default: clicks everything');
    assert.equal((await run(cardHtml(PAY), { enabled: true, all: true, holdRisky: true })).clicks(), 0, 'opt-in hold');
    assert.equal((await run(cardHtml(MSG), { enabled: true, all: true, learn: true })).clicks(), 0);
  });

  await test('DOM: a lone Allow button with no Deny is not treated as an approval card', async () => {
    const r = await run(cardHtml(MSG, { deny: false }), { enabled: true, all: true });
    assert.equal(r.clicks(), 0);
  });

  await test('DOM: switches the pane from Activity to Approvals before looking for cards, and leaves it alone once there', async () => {
    const tabs = (pressed) => `<button aria-label="Activity" aria-pressed="${pressed === 'activity'}"></button><button id="appr" aria-label="Approvals" aria-pressed="${pressed === 'approvals'}"></button>`;
    const r = await run(tabs('activity'), { enabled: true, all: true });
    assert.equal(r.tabClicks(), 1, 'clicked the Approvals tab');
    const r2 = await run(tabs('approvals') + cardHtml(MSG), { enabled: true, all: true });
    assert.equal(r2.clicks(), 1, 'already on Approvals: goes straight to the card');
    const r3 = await run(tabs('activity'), { enabled: false });
    assert.equal(r3.tabClicks(), 0, 'does nothing while auto-approve is off');
  });

  await test('DOM: the "A task needs review" bar button is found even though its parent holds only the word Review', async () => {
    const html = '<div><span>A task needs review</span><div><button id="appr" data-pel-click="chat_background_approval_review"><span>Review</span></button></div></div>';
    const r = await run(html, { enabled: true, all: true });
    assert.equal(r.tabClicks(), 1);
    const plain = '<div><span>A task needs review</span><button id="appr"><span>Review</span></button></div>';
    assert.equal((await run(plain, { enabled: true, all: true })).tabClicks(), 1, 'text fallback also works');
  });

  await test('DOM: chat-only view: opens the pane via the avatar (found by shape, not name), never when a pane is open', async () => {
    const avatar = (label) => `<div id="appr" role="button" aria-label="${label}" class="relative z-10 aspect-square shrink-0 rounded-full"></div><div role="button" aria-label="${label}" class="rounded-18"></div>`;
    const r = await run(avatar('Muse'), { enabled: true, all: true });
    assert.equal(r.tabClicks(), 1, 'clicked the avatar');
    assert.equal((await run(avatar('Renamed Bot'), { enabled: true, all: true })).tabClicks(), 1, 'works after a rename');
    const open = '<button aria-label="Approvals" aria-pressed="true"></button>' + avatar('Muse');
    assert.equal((await run(open, { enabled: true, all: true })).tabClicks(), 0, 'pane already open: leave it alone');
    const close = '<button data-pel-click="status_close_panel"></button>' + avatar('Muse');
    assert.equal((await run(close, { enabled: true, all: true })).tabClicks(), 0, 'pane open on another view: leave it alone');
    assert.equal((await run(avatar('Muse'), { enabled: false })).tabClicks(), 0, 'off: does nothing');
  });

  await test('DOM: rate limit stops a runaway at maxPerMinute', async () => {
    const html = Array.from({ length: 5 }, (_, i) => cardHtml(MSG).replace(/id="/g, `id="x${i}`).replace('id="x' + i + 'allow"', 'id="allow"')).join('');
    const r = await run(html, { enabled: true, messages: true, maxPerMinute: 2 });
    assert.ok(r.clicks() <= 2, `clicked ${r.clicks()}`);
  });
}

console.log(`\n${passed} auto-approve tests passed`);
process.exit(process.exitCode||0)
