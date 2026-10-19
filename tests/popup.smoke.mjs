// Renders the real popup.js in jsdom against the real background.js (fake chrome API).
// jsdom is NOT a project dependency. Run with:  JSDOM=/path/to/node_modules/jsdom/lib/api.js node tests/popup.smoke.mjs
// (or `npm i --no-save jsdom` in this folder). Skips cleanly when jsdom is unavailable.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { installChrome } from './mockchrome.mjs';

let JSDOM;
try {
  const spec = process.env.JSDOM ? pathToFileURL(process.env.JSDOM).href : 'jsdom';
  ({ JSDOM } = await import(spec));
} catch {
  console.log('skip - jsdom not available (see header)');
  process.exit(0);
}

const M = installChrome();
await import('../background.js');
const PASS = 'correct horse battery staple';

const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { url: 'chrome-extension://test-extension-id/popup.html' });
globalThis.document = dom.window.document;
globalThis.chrome.runtime.sendMessage = (m) => M.send(m);
globalThis.chrome.tabs.create = async () => {};
globalThis.URL.createObjectURL = () => 'blob:x';
globalThis.URL.revokeObjectURL = () => {};

let n = 0;
const load = async () => { await import(`../popup.js?run=${++n}`); await M.tick(80); };
const app = () => document.getElementById('app');
const text = () => app().textContent;
const btn = (label) => [...app().querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const input = (ph) => [...app().querySelectorAll('input')].find((i) => (i.placeholder || '').startsWith(ph));
const click = async (b, ms = 120) => { assert.ok(b, 'button exists'); b.click(); await M.tick(ms); };
const type = (i, v) => { assert.ok(i, 'input exists'); i.value = v; i.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); process.exitCode = 1; });

await step('first run shows setup; mismatched passphrases are rejected', async () => {
  await load();
  assert.match(text(), /Create vault/);
  type(input('Passphrase'), PASS);
  type(input('Repeat'), PASS + 'x');
  await click(btn('Create vault'));
  assert.match(text(), /do not match/);
});

await step('setup succeeds and the main view renders', async () => {
  await load();
  type(input('Passphrase'), PASS);
  type(input('Repeat'), PASS);
  await click(btn('Create vault'), 1200);
  assert.match(text(), /Accounts/);
  assert.match(text(), /No saved accounts yet/);
  assert.ok(btn('Open muse.ai'));
});

await step('saving an account renders a card; names are text, never markup', async () => {
  M.addTab({ url: 'https://muse.ai/', local: { a: '1' } });
  await M.site.login('A');
  type(input('Name for the account'), '<img src=x onerror=alert(1)> Work');
  await click(btn('Save'), 200);
  assert.ok(app().querySelector('.card'));
  assert.equal(app().querySelectorAll('img').length, 0, 'no element injected');
  assert.match(text(), /<img src=x/);
  assert.match(text(), /active/);
});

await step('settings view renders every control without throwing', async () => {
  await click(app().querySelector('button[aria-label="Settings"]'), 150);
  assert.match(text(), /Session lifetime/);
  for (const l of ['Save settings', 'Export', 'Preview import', 'Change', 'Show what is stored right now']) assert.ok(btn(l), l);
  assert.ok(app().querySelector('input[type=file]'));
  const erase = btn('Erase vault and all saved accounts');
  assert.equal(erase.disabled, true, 'erase is gated behind typing ERASE');
  type(input('Type ERASE'), 'ERASE');
  assert.equal(erase.disabled, false);
  await click(btn('Show what is stored right now'), 200);
  assert.match(app().querySelector('pre').textContent, /__Secure-sid/);
  assert.ok(!app().querySelector('pre').textContent.includes('sid-A'), 'diagnostics never print values');
});

await step('export requires the current passphrase (UI path)', async () => {
  type(input('Your current vault'), 'wrong wrong wrong');
  type(input('New passphrase for the export'), 'another long passphrase here');
  type(input('Repeat the export'), 'another long passphrase here');
  await click(btn('Export'), 1500);
  assert.match(text(), /Wrong passphrase/);
});

await step('double-click on a confirm button does not confirm', async () => {
  await click(app().querySelector('button[aria-label="Settings"]') || btn('←'), 50).catch(() => {});
  await load();
  const x = [...app().querySelectorAll('.card button')].find((b) => b.textContent === '✕');
  assert.ok(x);
  x.click();
  x.click(); // immediate second click
  await M.tick(100);
  assert.ok(app().querySelector('.card'), 'account still present after a double-click');
});

await step('lock screen: wrong passphrase is reported, right one unlocks', async () => {
  await click(app().querySelector('button[aria-label="Lock vault"]'), 150);
  assert.match(text(), /Unlock/);
  assert.match(text(), /Forgot the passphrase/);
  type(input('Passphrase'), 'wrong wrong wrong');
  await click(btn('Unlock'), 2500); // earlier failures make the back-off kick in
  assert.match(text(), /Wrong passphrase/);
  type(input('Passphrase'), PASS);
  await click(btn('Unlock'), 4500);
  assert.match(text(), /Accounts/);
});

await step('an account that needs re-login carries a tag; a healthy one does not', async () => {
  await load();
  assert.equal(app().querySelectorAll('.badge.relogin').length, 0);
  const st = await M.send({ type: 'status' });
  M.state.session.needsLogin = { [st.profiles[0].id]: Date.now() };
  await load();
  const tag = app().querySelector('.card .badge.relogin');
  assert.ok(tag, 'tag shown');
  assert.equal(tag.textContent, 'needs re-login');
  assert.match(app().querySelector('.card').textContent, /press ↻ to re-save/);
  delete M.state.session.needsLogin;
});

await step('the log shows confirmed / stuck / warnings distinctly, as text only', async () => {
  await M.send({ type: 'setApprove', approve: { enabled: true } });
  const t = Date.now();
  M.state.local.approveLog = [
    { t, decision: 'approved', title: 'Allow? <b>bold</b>', action: '', task: '', category: 'messages', account: 'Work' },
    { t, decision: 'confirmed', title: 'Allow?', action: '', task: '', category: 'messages', account: 'Work' },
    { t, decision: 'stuck', title: 'Allow?', action: '', task: '', category: 'messages', account: 'Work' },
    { t, decision: 'needs-input', title: 'Pick a time?', action: '', task: '', category: 'other', account: 'Work' },
    { t, decision: 'needs-login', title: 'Signed out', action: '', task: '', category: '', account: 'Work' },
    { t, decision: 'loop-timeout', title: 'Skipped', action: '', task: '', category: '', account: 'Work' },
    { t, decision: 'stale', title: 'Muse layout', action: '', task: '', category: '', account: 'Work' },
    { t, decision: 'mystery"><i>', title: 'x', action: '', task: '', category: '', account: '' }
  ];
  await click(app().querySelector('button[aria-label="Settings"]'), 150);
  await click(btn('Show what was approved'), 150);
  const log = app().querySelector('.log');
  assert.equal(log.hidden, false);
  assert.match(log.querySelector('.d-confirmed').textContent, /CONFIRMED \(card closed\)/);
  assert.match(log.querySelector('.d-stuck').textContent, /STUCK \(card did not close\)/);
  assert.match(log.querySelector('.d-approved').textContent, /APPROVED \(clicked\)/);
  for (const d of ['needs-input', 'needs-login', 'loop-timeout', 'stale', 'other']) assert.ok(log.querySelector('.d-' + d), d);
  assert.equal(log.querySelectorAll('b, i').length, 0, 'titles and decisions are text, never markup');
  assert.notEqual(log.querySelector('.d-confirmed').className, log.querySelector('.d-stuck').className);
});

await step('a stale-markup warning shows in the auto-approve section until it clears', async () => {
  assert.doesNotMatch(text(), /layout may have changed/);
  M.state.session.staleWarn = { 1: Date.now() };
  await load();
  await click(app().querySelector('button[aria-label="Settings"]'), 150);
  assert.match(text(), /layout may have changed; auto-approve could not find its controls/);
  delete M.state.session.staleWarn;
  await load();
  await click(app().querySelector('button[aria-label="Settings"]'), 150);
  assert.doesNotMatch(text(), /layout may have changed/);
});

await step('a damaged vault shows the corrupt screen with a typed-ERASE escape hatch', async () => {
  const v = M.state.local.vault;
  v.ct = v.ct.slice(0, -8) + 'AAAAAAAA';
  await load();
  assert.match(text(), /damaged|modified/i);
  const erase = btn('Erase vault and all saved accounts');
  assert.ok(erase && erase.disabled);
  type(input('Type ERASE'), 'ERASE');
  await click(erase, 200);
  assert.match(text(), /Create vault/, 'back to first-run setup after erasing');
});

console.log(`\n${passed} popup smoke steps passed${process.exitCode ? ' (SOME FAILED)' : ''}`);
