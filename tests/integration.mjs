// Integration tests: the real background.js running against a fake chrome.* API.
import assert from 'node:assert/strict';
import { installChrome } from './mockchrome.mjs';
import { createVault, openWithKey, unb64 } from '../lib/crypto.js';

const M = installChrome();
await import('../background.js');

const PASS = 'correct horse battery staple';
const PASS2 = 'another long passphrase here';

const ok = async (type, p = {}) => {
  const r = await M.send({ type, ...p });
  assert.ok(r && r.ok, `${type} should succeed, got: ${r && r.error}`);
  return r;
};
const bad = async (type, p = {}) => {
  const r = await M.send({ type, ...p });
  assert.ok(r && r.ok === false, `${type} should fail`);
  return r;
};
const peek = async () => {
  const raw = unb64(M.state.session.k);
  return openWithKey(M.state.local.vault, raw);
};
const sid = () => (M.jarGet('__Secure-sid')[0] || {}).value;
const profileByName = (st, n) => st.profiles.find((p) => p.name === n);

let passed = 0;
const test = async (name, fn) => {
  M.reset();
  Date.now = () => M.state.now;
  try {
    await fn();
  } catch (e) {
    console.error(`FAIL - ${name}\n`, e);
    process.exitCode = 1;
    return;
  }
  passed++;
  console.log('ok  -', name);
};

/** vault + two saved accounts (A active) + one open muse.ai tab */
async function twoAccounts() {
  await ok('setup', { pass: PASS });
  const tab = M.addTab({ url: 'https://muse.ai/app', local: { user: 'A', theme: 'dark' } });
  await M.site.login('A');
  await ok('saveCurrent', { name: 'A' });
  await ok('signOut');
  tab.local = { user: 'B' };
  await M.site.login('B');
  await ok('saveCurrent', { name: 'B' });
  const st = await ok('status');
  return { tab, A: profileByName(st, 'A'), B: profileByName(st, 'B') };
}

await test('setup rejects weak passphrases and a second vault', async () => {
  assert.equal((await bad('setup', { pass: 'short' })).code, 'WEAK_PASS');
  for (const weak of ['aaaaaaaaaaaa', 'password12345', '1234567890ab', 'qwertyuiopas', 'abcdefghijkl', 'Aa1!Aa1!Aa1!']) {
    assert.equal((await bad('setup', { pass: weak })).code, 'WEAK_PASS', weak);
  }
  await ok('setup', { pass: PASS });
  assert.equal((await bad('setup', { pass: PASS })).code, 'EXISTS');
  assert.equal((await ok('status')).state, 'unlocked');
});

await test('switching swaps cookies, page storage, reloads tabs', async () => {
  const { tab, A, B } = await twoAccounts();
  assert.equal(sid(), 'sid-B');
  await ok('switch', { id: A.id });
  assert.equal(sid(), 'sid-A');
  assert.equal(M.jarGet('auth_rt')[0].value, 'rt-A');
  assert.equal(M.jarGet('__Host-dev')[0].value, 'dev-A');
  assert.deepEqual(tab.local, { user: 'A', theme: 'dark' });
  assert.ok(M.state.reloads.includes(tab.id));
  await ok('switch', { id: B.id });
  assert.equal(sid(), 'sid-B');
  assert.deepEqual(tab.local, { user: 'B' });
  assert.equal((await ok('status')).activeId, B.id);
});

await test('rotated tokens are captured, and a wiped browser cannot clobber the saved copy', async () => {
  const { A, B } = await twoAccounts();
  await ok('switch', { id: A.id });
  await chrome.storage.session.set({ suppressUntil: 0 });
  await M.site.rotate('sid-A-rotated');
  assert.ok(M.state.alarms.has('sync'), 'rotation should schedule a debounced sync');
  M.fireAlarm('sync');
  await M.tick(80);
  M.state.jar.clear(); // browser state vanishes without any event
  await ok('switch', { id: B.id }); // pre-switch sync must refuse the empty state
  await ok('switch', { id: A.id });
  assert.equal(sid(), 'sid-A-rotated');
});

await test('freeze guard: logout + login elsewhere must not overwrite the saved account', async () => {
  const { A } = await twoAccounts();
  await ok('switch', { id: A.id });
  await chrome.storage.session.set({ suppressUntil: 0 });
  M.site.logout();
  await M.tick(30);
  assert.equal((await ok('status')).frozen, true);
  await M.site.login('INTRUDER'); // user signs into some other account outside Switchyard
  M.fireAlarm('sync');
  await M.tick(80);
  let data = await peek();
  assert.equal(data.profiles[A.id].cookies.find((c) => c.name === '__Secure-sid').value, 'sid-A');
  // the pre-lock/pre-switch syncs must respect the freeze too
  await ok('lock');
  await ok('unlock', { pass: PASS });
  data = await peek();
  assert.equal(data.profiles[A.id].cookies.find((c) => c.name === '__Secure-sid').value, 'sid-A');
  // explicit user action resumes
  await ok('refresh', { id: A.id });
  assert.equal((await ok('status')).frozen, false);
});

await test('failed restore rolls back instead of leaving the user signed out', async () => {
  await ok('setup', { pass: PASS });
  await ok('setSettings', { settings: { keepAliveDays: 0 } });
  M.addTab({ url: 'https://muse.ai/', local: {} });
  await M.site.login('B', { ttl: 100, allPersistent: true });
  const { id: bId } = await ok('saveCurrent', { name: 'B' });
  await ok('signOut');
  await M.site.login('A');
  await ok('saveCurrent', { name: 'A' });
  M.advance(1000); // everything in B has expired
  const r = await ok('switch', { id: bId });
  assert.equal(r.rolledBack, true);
  assert.equal(sid(), 'sid-A');
  assert.notEqual((await ok('status')).activeId, bId);
});

await test('keep-alive: session cookies stay session unless persistSession is on', async () => {
  const { A } = await twoAccounts();
  await ok('setSettings', { settings: { keepAliveDays: 30, persistSession: false } });
  await ok('switch', { id: A.id });
  assert.equal(M.jarGet('sess')[0].session, true);
  await ok('setSettings', { settings: { keepAliveDays: 30, persistSession: true } });
  await ok('signOut');
  await ok('switch', { id: A.id });
  const sess = M.jarGet('sess')[0];
  assert.equal(sess.session, false);
  assert.ok(Math.abs(sess.expirationDate - (M.state.now / 1000 + 30 * 86400)) < 5);
});

await test('keep-alive alarm extends live cookies but never shortens', async () => {
  await ok('setup', { pass: PASS });
  await M.site.login('A');
  const before = M.jarGet('csrf')[0].expirationDate; // 1h
  await ok('setSettings', { settings: { keepAliveDays: 30, persistSession: false } });
  M.fireAlarm('keepalive');
  await M.tick(80);
  const after = M.jarGet('csrf')[0].expirationDate;
  assert.ok(after > before + 29 * 86400);
  assert.equal(M.jarGet('sess')[0].session, true);
});

await test('malicious import is sanitised', async () => {
  await ok('setup', { pass: PASS });
  const evil = {
    kind: 'switchyard-export',
    profiles: {
      p1: {
        name: 'Imported', cookies: [
          { name: 'a', value: '1', domain: 'evil.com/x.muse.ai', path: '/' },
          { name: 'b', value: '1', domain: '.muse.ai', path: 'no-slash' },
          { name: 'c;x', value: '1', domain: '.muse.ai', path: '/' },
          { name: 'd', value: 'x'.repeat(9000), domain: '.muse.ai', path: '/' },
          { name: 'e', value: '1', domain: 'evil.com', path: '/' },
          { name: 'f', value: '1', domain: '.muse.ai', path: '/\r\nX: y' },
          42, null, 'str',
          { name: 'good', value: 'v', domain: '.muse.ai', path: '/', secure: true, session: true, sameSite: 'bogus' }
        ],
        web: JSON.parse('{"https://evil.com":{"local":{"a":"1"}},"https://muse.ai":{"local":{"ok":"1","n":5,"__proto__":"x"},"session":null},"http://muse.ai":{"local":{"a":"1"}}}')
      },
      p2: { name: '', cookies: [{ name: 'g', value: '1', domain: '.muse.ai', path: '/' }] },
      p3: { name: 'NoCookies', cookies: [] },
      p4: 'not an object'
    }
  };
  const { vault } = await createVault(PASS2, evil, 100000);
  const preview = await ok('importVault', { text: JSON.stringify(vault), pass: PASS2 });
  assert.equal(preview.preview.length, 1);
  assert.equal(Object.keys((await peek()).profiles).length, 0, 'preview must not write');
  assert.ok(preview.preview[0].name.endsWith('(imported)'));
  const r = await ok('importVault', { text: JSON.stringify(vault), pass: PASS2, confirm: true });
  assert.equal(r.imported, 1);
  assert.equal(r.skipped, 3);
  assert.equal((await peek()).activeId, null, 'imports are never auto-activated');
  const data = await peek();
  const p = Object.values(data.profiles)[0];
  assert.deepEqual(p.cookies.map((c) => c.name).sort(), ['e', 'good']);
  assert.equal(p.cookies.find((c) => c.name === 'good').sameSite, 'unspecified');
  assert.deepEqual(Object.keys(p.web), ['https://muse.ai']);
  assert.deepEqual(p.web['https://muse.ai'].local, { ok: '1' });
  // even with permission for evil.com, restore must not write outside the configured domains
  M.state.perms.add('https://*.evil.com/*');
  await ok('switch', { id: p.id });
  assert.equal(M.jarGet('e').length, 0);
  assert.equal(M.jarGet('good').length, 1);
});

await test('import: wrong passphrase and non-export files are rejected', async () => {
  await ok('setup', { pass: PASS });
  const { vault } = await createVault(PASS2, { kind: 'switchyard-export', profiles: {} }, 100000);
  assert.equal((await bad('importVault', { text: JSON.stringify(vault), pass: 'nope nope nope' })).code, 'BAD_PASSPHRASE');
  assert.equal((await bad('importVault', { text: 'not json', pass: PASS2 })).code, 'BAD_VAULT');
  const other = (await createVault(PASS2, { something: 'else' }, 100000)).vault;
  assert.equal((await bad('importVault', { text: JSON.stringify(other), pass: PASS2 })).code, 'BAD_VAULT');
});

await test('message surface: only our own extension pages are served', async () => {
  await ok('setup', { pass: PASS });
  const ext = 'chrome-extension://test-extension-id/popup.html';
  assert.equal(await M.send({ type: 'status' }, { id: 'someone-else', url: ext }), undefined);
  assert.equal(await M.send({ type: 'status' }, { id: 'test-extension-id' }), undefined, 'no url');
  assert.equal(await M.send({ type: 'status' }, { id: 'test-extension-id', url: 'https://muse.ai/', tab: { id: 1 } }), undefined, 'content script in a page');
  assert.equal(await M.send({ type: 'status' }, { id: 'test-extension-id', url: 'chrome-extension://other-id/x.html' }), undefined);
  // popup.html opened in a normal tab (the documented Import workaround) must work
  const r = await M.send({ type: 'status' }, { id: 'test-extension-id', url: ext, tab: { id: 9 } });
  assert.ok(r && r.ok);
  for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '']) {
    const x = await M.send({ type: t });
    assert.ok(x === undefined || (x.ok === false && x.error === 'Unknown request.'), `type "${t}" must not dispatch`);
  }
  assert.equal(await M.send({ type: { toString: () => 'status' } }), undefined);
  assert.equal(await M.send(null), undefined);
  assert.equal(await M.send('status'), undefined);
});

await test('locked vault refuses everything; wrong passphrase backs off; unlock works', async () => {
  const { A } = await twoAccounts();
  await ok('lock');
  assert.equal((await ok('status')).state, 'locked');
  for (const [t, p] of [['switch', { id: A.id }], ['saveCurrent', { name: 'x' }], ['exportVault', { pass: PASS2, repeat: PASS2, currentPass: PASS }], ['inspect', {}], ['remove', { id: A.id }]]) {
    assert.equal((await bad(t, p)).code, 'LOCKED', t);
  }
  assert.equal((await bad('unlock', { pass: 'wrong wrong wrong' })).code, 'BAD_PASSPHRASE');
  assert.equal(M.state.session.fails, 1);
  await ok('unlock', { pass: PASS });
  assert.equal(M.state.session.fails, 0);
  assert.equal((await ok('status')).state, 'unlocked');
});

await test('auto-lock after idle, and lock when the screen locks', async () => {
  await ok('setup', { pass: PASS });
  await ok('setSettings', { settings: { autoLockMinutes: 5 } });
  M.advance(4 * 60);
  M.fireAlarm('autolock');
  await M.tick(50);
  assert.ok(M.state.session.k, 'still unlocked before the timeout');
  await ok('status'); // user activity resets the idle timer
  M.advance(4 * 60);
  M.fireAlarm('autolock');
  await M.tick(50);
  assert.ok(M.state.session.k, 'activity extended the timeout');
  M.advance(2 * 60);
  M.fireAlarm('autolock');
  await M.tick(50);
  assert.equal(M.state.session.k, undefined, 'locked after idle');
  assert.equal((await ok('status')).state, 'locked');
  await ok('unlock', { pass: PASS });
  M.fireIdle('idle');
  await M.tick(50);
  assert.ok(M.state.session.k, 'plain idle does not lock; only the idle timeout does');
  M.fireIdle('locked');
  await M.tick(50);
  assert.equal(M.state.session.k, undefined, 'locks when the OS screen locks');
  await M.tick(30);
  assert.equal(M.state.badge.text, 'LOCK');
});

await test('clear-on-lock saves rotated tokens first, then signs the browser out', async () => {
  const { A } = await twoAccounts();
  await ok('switch', { id: A.id });
  await ok('setSettings', { settings: { clearOnLock: true } });
  await chrome.storage.session.set({ suppressUntil: 0 });
  await M.site.rotate('sid-A-v2');
  await ok('lock');
  assert.equal(M.jarGet('__Secure-sid').length, 0);
  await ok('unlock', { pass: PASS });
  await ok('switch', { id: A.id });
  assert.equal(sid(), 'sid-A-v2');
});

await test('origin guard: a tab that navigated away is never read or written', async () => {
  await ok('setup', { pass: PASS });
  const tab = M.addTab({ url: 'https://muse.ai/', origin: 'https://evil.example', local: { secret: 'victim data' } });
  await M.site.login('A');
  await ok('saveCurrent', { name: 'A' });
  const data = await peek();
  assert.deepEqual(Object.values(data.profiles)[0].web, {});
  await ok('signOut');
  assert.deepEqual(tab.local, { secret: 'victim data' }, 'must not clear storage of a different origin');
});

await test('domain settings: needs real permission, unknown sites are dropped', async () => {
  await ok('setup', { pass: PASS });
  assert.equal((await bad('setSettings', { settings: { domains: ['meta.ai'] } })).code, 'NO_PERMISSION');
  M.state.perms.add('https://*.meta.ai/*');
  let r = await ok('setSettings', { settings: { domains: ['meta.ai'] } });
  assert.deepEqual(r.settings.domains, ['muse.ai', 'meta.ai']);
  r = await ok('setSettings', { settings: { domains: ['muse.ai', 'evil.com', '../x', 5] } });
  assert.deepEqual(r.settings.domains, ['muse.ai']);
  assert.ok(!M.state.perms.has('https://*.meta.ai/*'), 'dropped optional permission is released');
  r = await ok('setSettings', { settings: { keepAliveDays: 99999, autoLockMinutes: -4, autoSync: 'yes' } });
  assert.equal(r.settings.keepAliveDays, 400);
  assert.equal(r.settings.autoLockMinutes, 1);
  assert.equal(r.settings.autoSync, true);
});

await test('at rest: no secret or account name in plaintext storage; popup responses carry no values', async () => {
  await ok('setup', { pass: PASS });
  M.addTab({ url: 'https://muse.ai/', local: { token: 'LOCALSTORAGE-SECRET' } });
  await M.site.login('A');
  await ok('saveCurrent', { name: 'Quite Secret Name' });
  const disk = JSON.stringify(M.state.local);
  for (const needle of ['sid-A', 'rt-A', 'Quite Secret Name', 'LOCALSTORAGE-SECRET', PASS]) {
    assert.ok(!disk.includes(needle), `plaintext leak: ${needle}`);
  }
  for (const t of ['status', 'inspect']) {
    const out = JSON.stringify(await ok(t));
    for (const needle of ['sid-A', 'rt-A', 'LOCALSTORAGE-SECRET']) assert.ok(!out.includes(needle), `${t} leaks ${needle}`);
  }
  const ins = await ok('inspect');
  assert.ok(ins.cookies.every((c) => typeof c.valueLen === 'number' && c.value === undefined));
});

await test('export needs the current passphrase and a confirmed export passphrase; round trip survives a wipe', async () => {
  await twoAccounts();
  assert.equal((await bad('exportVault', { pass: PASS2, repeat: PASS2, currentPass: 'wrong wrong wrong' })).code, 'BAD_PASSPHRASE');
  assert.equal((await bad('exportVault', { pass: PASS2, repeat: PASS2 + 'x', currentPass: PASS })).code, 'MISMATCH');
  assert.equal((await bad('exportVault', { pass: 'short', repeat: 'short', currentPass: PASS })).code, 'WEAK_PASS');
  const { text } = await ok('exportVault', { pass: PASS2, repeat: PASS2, currentPass: PASS });
  assert.ok(!text.includes('sid-A'));
  await ok('wipe');
  assert.equal((await ok('status')).state, 'nosetup');
  await ok('setup', { pass: PASS });
  const r = await ok('importVault', { text, pass: PASS2, confirm: true });
  assert.equal(r.imported, 2);
  const st = await ok('status');
  await ok('switch', { id: profileByName(st, 'A (imported)').id });
  assert.equal(sid(), 'sid-A');
});

await test('change passphrase: old one stops working, data survives', async () => {
  await twoAccounts();
  assert.equal((await bad('changePass', { oldPass: 'wrong wrong wrong', newPass: PASS2 })).code, 'BAD_PASSPHRASE');
  await ok('changePass', { oldPass: PASS, newPass: PASS2 });
  await ok('lock');
  assert.equal((await bad('unlock', { pass: PASS })).code, 'BAD_PASSPHRASE');
  await ok('unlock', { pass: PASS2 });
  assert.equal((await ok('status')).profiles.length, 2);
  assert.ok(!('vaultPrev' in M.state.local), 'no stale copy encrypted under the old passphrase');
});

await test('shortcut cycles accounts and the badge shows initials', async () => {
  const { A, B } = await twoAccounts();
  await ok('switch', { id: A.id });
  M.fireCommand('next-account');
  await M.tick(120);
  assert.equal((await ok('status')).activeId, B.id);
  await M.tick(60);
  assert.equal(M.state.badge.text, 'B');
  M.fireCommand('next-account');
  await M.tick(120);
  assert.equal((await ok('status')).activeId, A.id);
});

await test('race: concurrent switches never corrupt the vault or the browser state', async () => {
  const { A, B } = await twoAccounts();
  const ids = [A.id, B.id, A.id, B.id, A.id, B.id];
  const rs = await Promise.all(ids.map((id) => M.send({ type: 'switch', id })));
  assert.ok(rs.every((r) => r && r.ok));
  const st = await ok('status');
  assert.equal(st.activeId, B.id);
  assert.equal(sid(), 'sid-B');
  const data = await peek();
  assert.equal(data.profiles[A.id].cookies.find((c) => c.name === '__Secure-sid').value, 'sid-A');
  assert.equal(data.profiles[B.id].cookies.find((c) => c.name === '__Secure-sid').value, 'sid-B');
});

await test('profile and name validation', async () => {
  await ok('setup', { pass: PASS });
  await M.site.login('A');
  assert.equal((await bad('saveCurrent', { name: '   ' })).code, 'BAD_NAME');
  const { id } = await ok('saveCurrent', { name: 'x'.repeat(200) });
  assert.equal((await ok('status')).profiles[0].name.length, 60);
  assert.equal((await bad('switch', { id: 'nope' })).code, 'NOT_FOUND');
  assert.equal((await bad('rename', { id: 'nope', name: 'q' })).code, 'NOT_FOUND');
  await ok('remove', { id });
  assert.equal((await ok('status')).profiles.length, 0);
  M.state.jar.clear();
  await ok('signOut');
  assert.equal((await bad('saveCurrent', { name: 'empty' })).code, 'NO_SESSION');
});


await test('hostile page storage cannot bloat the vault or break saving', async () => {
  await ok('setup', { pass: PASS });
  const big = 'x'.repeat(5_000_000);
  M.addTab({ url: 'https://muse.ai/a', local: { junk: big, keep: 'small' } });
  await M.site.login('A');
  const { id } = await ok('saveCurrent', { name: 'A' });
  const data = await peek();
  assert.deepEqual(data.profiles[id].web, {}, 'oversized origin is dropped whole, not truncated');
  assert.ok(data.profiles[id].warn);
  assert.ok(JSON.stringify(M.state.local).length < 100_000);
  await ok('refresh', { id });
  await ok('signOut');
  await ok('switch', { id });
  assert.equal(sid(), 'sid-A');
});

await test('a full vault fails a switch cleanly: browser untouched, nothing half-applied', async () => {
  const { A } = await twoAccounts();
  assert.equal(sid(), 'sid-B');
  M.state.quotaBytes = 500; // storage suddenly refuses writes
  const r = await bad('switch', { id: A.id });
  assert.equal(r.code, 'QUOTA');
  assert.equal(sid(), 'sid-B', 'browser must still be signed in as B');
  assert.equal(M.jarGet('auth_rt')[0].value, 'rt-B');
});

await test('changePass is atomic with respect to concurrent writes', async () => {
  await ok('setup', { pass: PASS });
  await M.site.login('A');
  const slow = M.send({ type: 'changePass', oldPass: PASS, newPass: PASS2 });
  await M.tick(5);
  const concurrent = M.send({ type: 'saveCurrent', name: 'During change' });
  const [a, b] = await Promise.all([slow, concurrent]);
  assert.ok(a.ok && b.ok);
  const st = await ok('status');
  assert.deepEqual(st.profiles.map((p) => p.name), ['During change']);
  await ok('lock');
  await ok('unlock', { pass: PASS2 });
  assert.equal((await ok('status')).profiles.length, 1);
});

await test('damaged vault is reported as corrupt and can be erased', async () => {
  await twoAccounts();
  const v = M.state.local.vault;
  v.ct = v.ct.slice(0, -8) + 'AAAAAAAA';
  const st = await ok('status');
  assert.equal(st.state, 'corrupt');
  await ok('wipe');
  assert.equal((await ok('status')).state, 'nosetup');
});

await test('vault rollback to an older copy is detected within a session', async () => {
  const { A } = await twoAccounts();
  const old = structuredClone(M.state.local.vault);
  await ok('rename', { id: A.id, name: 'A2' });
  M.state.local.vault = old; // attacker / sync tool restores an older file
  const st = await ok('status');
  assert.equal(st.state, 'corrupt');
  assert.equal(st.code, 'ROLLBACK');
  await ok('lock');
  await ok('unlock', { pass: PASS }); // the user can knowingly accept the older file
  assert.equal((await ok('status')).state, 'unlocked');
});

await test('prototype-key and malformed ids never reach Object.prototype', async () => {
  await twoAccounts();
  for (const id of ['__proto__', 'constructor', 'toString', '', null, 5, {}, 'x'.repeat(36)]) {
    for (const t of ['rename', 'switch', 'remove', 'refresh']) {
      const r = await bad(t, { id, name: 'POLLUTED' });
      assert.equal(r.code, 'NOT_FOUND', `${t}(${String(id)})`);
    }
  }
  assert.equal(({}).name, undefined);
  assert.equal(Object.prototype.name, undefined);
});

await test('another login that only overwrites cookies pauses auto-save instead of contaminating', async () => {
  const { A } = await twoAccounts();
  await ok('switch', { id: A.id });
  await chrome.storage.session.set({ suppressUntil: 0 });
  await M.site.login('INTRUDER'); // overwrite only, no removal events
  M.fireAlarm('sync');
  await M.tick(80);
  const data = await peek();
  assert.equal(data.profiles[A.id].cookies.find((c) => c.name === '__Secure-sid').value, 'sid-A');
  assert.ok(data.profiles[A.id].warn);
  const st = await ok('status');
  assert.equal(st.frozen, true);
  assert.equal(M.state.badge.text, '!');
});

await test('brute force: parallel guesses are serialised and still back off', async () => {
  await ok('setup', { pass: PASS });
  await ok('lock');
  const t0 = Date.now ? performance.now() : 0;
  const rs = await Promise.all([1, 2, 3].map(() => M.send({ type: 'unlock', pass: 'wrong wrong wrong' })));
  const dt = performance.now() - t0;
  assert.ok(rs.every((r) => r.code === 'BAD_PASSPHRASE'));
  assert.equal(M.state.session.fails, 3);
  assert.ok(dt >= 2000, `3 parallel guesses should take >= 2.4s of back-off, took ${Math.round(dt)}ms`);
});

await test('stored vault size does not reveal the number of accounts (4 KB padding)', async () => {
  await ok('setup', { pass: PASS });
  const len = () => unb64(M.state.local.vault.ct).length;
  assert.equal(len() % 4096, 16);
  await M.site.login('A');
  await ok('saveCurrent', { name: 'A' });
  assert.equal(len() % 4096, 16);
});


await test('freeze survives lock/unlock and is recorded while locked', async () => {
  const { A } = await twoAccounts();
  await ok('switch', { id: A.id });
  await chrome.storage.session.set({ suppressUntil: 0 });
  await ok('lock');
  M.site.logout(); // happens while the vault is locked
  await M.tick(30);
  await ok('unlock', { pass: PASS });
  assert.equal((await ok('status')).frozen, true, 'logout seen while locked must still freeze');
  await M.site.login('INTRUDER');
  await ok('lock');
  await ok('unlock', { pass: PASS });
  assert.equal((await ok('status')).frozen, true, 'locking must not clear the freeze');
  const data = await peek();
  assert.equal(data.profiles[A.id].cookies.find((c) => c.name === '__Secure-sid').value, 'sid-A');
});

await test('auto-save merges: cookies missing right now are not dropped from the saved copy', async () => {
  const { A } = await twoAccounts();
  await ok('switch', { id: A.id });
  await chrome.storage.session.set({ suppressUntil: 0 });
  const before = (await peek()).profiles[A.id].cookies.length;
  for (const [k, c] of [...M.state.jar]) if (c.name === 'csrf') M.state.jar.delete(k); // vanishes without an event
  await M.site.rotate('sid-A-2');
  M.fireAlarm('sync');
  await M.tick(80);
  const saved = (await peek()).profiles[A.id].cookies;
  assert.equal(saved.length, before, 'csrf kept');
  assert.equal(saved.find((c) => c.name === '__Secure-sid').value, 'sid-A-2', 'live value wins');
});

await test('anonymous downgrade (credentials gone, junk cookie left) is not saved over the account', async () => {
  const { A } = await twoAccounts();
  await ok('switch', { id: A.id });
  await chrome.storage.session.set({ suppressUntil: 0 });
  for (const [k, c] of [...M.state.jar]) if (c.httpOnly) M.state.jar.delete(k);
  M.fireAlarm('sync');
  await M.tick(80);
  const saved = (await peek()).profiles[A.id].cookies;
  assert.equal(saved.find((c) => c.name === '__Secure-sid').value, 'sid-A');
});

await test('switching to the already-active account does not overwrite newer tokens with stale ones', async () => {
  const { A } = await twoAccounts();
  await ok('switch', { id: A.id });
  await chrome.storage.session.set({ suppressUntil: 0 });
  for (const c of M.state.jar.values()) if (c.name === '__Secure-sid') c.value = 'sid-A-live-newer';
  const r = await ok('switch', { id: A.id });
  assert.equal(r.unchanged, true);
  assert.equal(sid(), 'sid-A-live-newer');
});

await test('refresh is refused for an account that is not the active one', async () => {
  const { A, B } = await twoAccounts();
  await ok('switch', { id: A.id });
  assert.equal((await bad('refresh', { id: B.id })).code, 'NOT_ACTIVE');
  assert.equal((await peek()).profiles[B.id].cookies.find((c) => c.name === '__Secure-sid').value, 'sid-B');
});

await test('a failed switch rolls back cleanly and leaves auto-save as it was', async () => {
  const { A, B } = await twoAccounts();
  await ok('switch', { id: A.id });
  const orig = chrome.cookies.set;
  chrome.cookies.set = async () => { throw new Error('boom'); };
  await M.send({ type: 'switch', id: B.id });
  chrome.cookies.set = orig;
  assert.equal((await ok('status')).frozen, false);
});

await test('keep-alive never resurrects an expired cookie', async () => {
  await ok('setup', { pass: PASS });
  await M.site.login('A');
  await ok('setSettings', { settings: { keepAliveDays: 30 } });
  for (const c of M.state.jar.values()) if (c.name === 'csrf') c.expirationDate = M.state.now / 1000 - 10;
  M.fireAlarm('keepalive');
  await M.tick(80);
  assert.equal(M.jarGet('csrf').length, 0);
});

await test('setup called twice in parallel creates exactly one vault', async () => {
  const [a, b] = await Promise.all([M.send({ type: 'setup', pass: PASS }), M.send({ type: 'setup', pass: PASS2 })]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
});

await test('sync debounce is not pushed back by every cookie event', async () => {
  const { A } = await twoAccounts();
  await ok('switch', { id: A.id });
  await chrome.storage.session.set({ suppressUntil: 0 });
  await M.site.rotate('r1');
  const first = M.state.alarms.get('sync');
  await M.site.rotate('r2');
  assert.strictEqual(M.state.alarms.get('sync'), first, 'existing alarm kept');
});

const SITE = { id: 'test-extension-id', tab: { id: 1 }, url: 'https://muse.ai/' };

await test('auto-approve settings are sanitised and off by default', async () => {
  const d = (await ok('getApprove')).approve;
  assert.equal(d.enabled, false);
  assert.equal(d.holdRisky, false, 'nothing held by default');
  const r = await ok('setApprove', { approve: { enabled: 'yes', all: true, loopMinutes: 99999, holdRisky: 'x', junk: 1 } });
  assert.equal(r.approve.enabled, false, 'only a real true enables');
  assert.equal(r.approve.loopMinutes, 240);
  assert.equal(r.approve.holdRisky, false, 'only an explicit true turns the hold on');
  assert.equal(r.approve.junk, undefined);
});

await test('the page content script can log but cannot change settings or run handlers', async () => {
  await ok('setApprove', { approve: { enabled: true, messages: true } });
  await M.send({ type: 'approve:log', entry: { decision: 'approved', title: 'x'.repeat(500), category: 'messages', t: M.state.now } }, SITE);
  await M.tick(60);
  const log = (await ok('approveLog')).log;
  assert.equal(log.length, 1);
  assert.equal(log[0].title.length, 160);
  const evil = await M.send({ type: 'setApprove', approve: { enabled: true, all: true } }, SITE);
  assert.equal(evil, undefined, 'a page-origin sender never reaches the real handlers');
  assert.equal((await ok('getApprove')).approve.all, false);
  await M.send({ type: 'approve:log', entry: { decision: 'approved' } }, { ...SITE, url: 'https://evil.example/' });
  await M.send({ type: 'approve:log', entry: { decision: 'approved' } }, { ...SITE, url: 'https://muse.ai.evil.example/' });
  await M.tick(60);
  assert.equal((await ok('approveLog')).log.length, 1, 'other origins cannot log');
});

await test('nothing is logged while auto-approve is off; the log is capped at 200 and can be cleared', async () => {
  await M.send({ type: 'approve:log', entry: { decision: 'approved' } }, SITE);
  await M.tick(40);
  assert.equal((await ok('approveLog')).log.length, 0);
  await ok('setApprove', { approve: { enabled: true } });
  for (let i = 0; i < 230; i++) await M.send({ type: 'approve:log', entry: { decision: 'approved', title: 't' + i } }, SITE);
  await M.tick(300);
  assert.equal(M.state.local.approveLog.length, 200);
  await ok('clearApproveLog');
  assert.equal((await ok('approveLog')).log.length, 0);
});

await test('account loop visits every saved account, waits for idle, then rests', async () => {
  const { A, B } = await twoAccounts();
  await ok('setApprove', { approve: { enabled: true, all: true, loop: true, loopMinutes: 10 } });
  const active = async () => (await ok('status')).activeId;
  M.fireAlarm('approveTick'); await M.tick(150);
  assert.equal(await active(), A.id, 'first account in name order');
  M.state.now += 5000; M.fireAlarm('approveTick'); await M.tick(100);
  assert.equal(await active(), A.id, 'still dwelling before the minimum time');
  M.state.now += 30000; await M.send({ type: 'approve:idle' }, SITE); M.state.now += 1; await M.tick(30);
  M.fireAlarm('approveTick'); await M.tick(150);
  assert.equal(await active(), B.id, 'moved on once the page reported idle');
  M.state.now += 200000; M.fireAlarm('approveTick'); await M.tick(150); // no idle report: the time cap moves on
  assert.equal(M.state.session.loopState, undefined, 'loop finished');
  M.state.now += 30000; M.fireAlarm('approveTick'); await M.tick(100);
  assert.equal(M.state.session.loopState, undefined, 'rests until the interval has passed');
});

await test('the loop stops when the vault locks', async () => {
  await twoAccounts();
  await ok('setApprove', { approve: { enabled: true, loop: true } });
  M.fireAlarm('approveTick'); await M.tick(150);
  assert.ok(M.state.session.loopState, 'loop started');
  await ok('lock');
  M.fireAlarm('approveTick'); await M.tick(100);
  assert.equal(M.state.session.loopState, undefined);
});

/* ---------- 0.4.0 hardening: watchdog, needs-login, loop caps ---------- */

const SITE2 = { ...SITE, tab: { id: 2 } };
const decisions = async () => (await ok('approveLog')).log.map((e) => `${e.decision}:${e.account || ''}`);
const logOf = async (decision) => (await ok('approveLog')).log.filter((e) => e.decision === decision);
const MIN = 60000;

await test('watchdog: approve:stale is validated, logged with our own text, rate limited per tab, and sets a badge warning', async () => {
  await ok('setup', { pass: PASS });
  await M.tick(100);
  await M.send({ type: 'approve:stale' }, SITE);
  await M.tick(80);
  assert.equal((await ok('approveLog')).log.length, 0, 'ignored while auto-approve is off');
  await ok('setApprove', { approve: { enabled: true, all: true } });
  await M.send({ type: 'approve:stale', text: 'page text must never be stored', entry: { title: 'SECRET' } }, SITE);
  await M.tick(120);
  const [e, ...rest] = (await ok('approveLog')).log;
  assert.equal(rest.length, 0);
  assert.equal(e.decision, 'stale');
  assert.match(e.title, /layout may have changed; auto-approve could not find its controls/);
  assert.ok(!JSON.stringify(M.state.local).includes('SECRET') && !JSON.stringify(M.state.local).includes('page text must'));
  assert.equal(M.state.badge.text, 'WARN');
  assert.equal((await ok('getApprove')).stale, true);
  await M.send({ type: 'approve:stale' }, SITE); await M.tick(60);
  assert.equal((await logOf('stale')).length, 1, 'same tab, within 30 minutes: ignored');
  await M.send({ type: 'approve:stale' }, SITE2); await M.tick(80);
  assert.equal((await logOf('stale')).length, 2, 'another tab is tracked separately');
  M.state.now += 31 * MIN;
  await M.send({ type: 'approve:stale' }, SITE); await M.tick(80);
  assert.equal((await logOf('stale')).length, 3, 'allowed again after 30 minutes');
  for (const bad of [{ ...SITE, url: 'https://evil.example/' }, { ...SITE, url: 'https://muse.ai.evil.example/' }, { ...SITE, id: 'other-ext' }, { id: 'test-extension-id', url: 'https://muse.ai/' }]) {
    await M.send({ type: 'approve:stale' }, { ...bad, tab: bad.tab }); 
  }
  M.state.now += 31 * MIN;
  const before = (await logOf('stale')).length;
  await M.send({ type: 'approve:stale' }, { ...SITE, url: 'https://evil.example/' });
  await M.send({ type: 'approve:stale' }, { id: 'test-extension-id', url: 'https://muse.ai/' }); // no tab
  await M.tick(80);
  assert.equal((await logOf('stale')).length, before, 'only muse.ai tabs of this extension are believed');
});

await test('watchdog: the warning clears on approved/skipped logs or a controls report from that tab, on tab close, and when auto-approve is turned off', async () => {
  await ok('setup', { pass: PASS });
  await ok('setApprove', { approve: { enabled: true, all: true } });
  const warn = async () => { await M.tick(100); return M.state.badge.text === 'WARN'; };
  const stale = (from = SITE) => { M.state.now += 31 * MIN; return M.send({ type: 'approve:stale' }, from); };
  await stale(); assert.ok(await warn());
  await M.send({ type: 'approve:log', entry: { decision: 'held', title: 'x' } }, SITE);
  assert.ok(await warn(), 'a held card is not proof that the controls work');
  await M.send({ type: 'approve:log', entry: { decision: 'approved', title: 'x' } }, SITE2);
  assert.ok(await warn(), 'another tab cannot clear this tab\'s warning');
  await M.send({ type: 'approve:log', entry: { decision: 'approved', title: 'x' } }, SITE);
  assert.ok(!(await warn()), 'approved clears it');
  await stale(); assert.ok(await warn());
  await M.send({ type: 'approve:log', entry: { decision: 'skipped', title: 'x' } }, SITE);
  assert.ok(!(await warn()), 'skipped clears it');
  await stale(); assert.ok(await warn());
  await M.send({ type: 'approve:controls' }, SITE);
  assert.ok(!(await warn()), 'controls visible again clears it');
  assert.equal((await ok('getApprove')).stale, false);
  await stale(); assert.ok(await warn());
  M.removeTab(1);
  assert.ok(!(await warn()), 'closing the tab clears it');
  await stale(); assert.ok(await warn());
  await ok('setApprove', { approve: { enabled: false } });
  assert.ok(!(await warn()), 'turning auto-approve off clears it');
});

await test('the page cannot forge the decisions the background owns, and unknown decisions are dropped', async () => {
  await ok('setApprove', { approve: { enabled: true } });
  for (const d of ['stale', 'needs-login', 'loop-timeout', 'whatever']) await M.send({ type: 'approve:log', entry: { decision: d, title: 'forged' } }, SITE);
  for (const d of ['confirmed', 'stuck', 'needs-input']) await M.send({ type: 'approve:log', entry: { decision: d, title: 'ok' } }, SITE);
  await M.tick(120);
  assert.deepEqual((await ok('approveLog')).log.map((e) => e.decision).sort(), ['confirmed', 'needs-input', 'stuck']);
  assert.equal(M.state.badge.text === 'WARN', false);
});

/** vault + A, B, C saved (C active) + one open muse.ai tab; the loop visits A, B, C in name order. */
async function threeAccounts() {
  await ok('setup', { pass: PASS });
  const tab = M.addTab({ url: 'https://muse.ai/app', local: {} });
  for (const who of ['A', 'B', 'C']) {
    await M.site.login(who);
    await ok('saveCurrent', { name: who });
    await ok('signOut');
  }
  await M.site.login('C');
  await ok('switch', { id: (profileByName(await ok('status'), 'C')).id });
  const st = await ok('status');
  return { tab, A: profileByName(st, 'A'), B: profileByName(st, 'B'), C: profileByName(st, 'C') };
}
const tickLoop = async (adv = 0) => { M.state.now += adv; M.fireAlarm('approveTick'); await M.tick(220); };
/** the page reports it is done, after the minimum dwell */
const settle = async () => { M.state.now += 30000; await M.send({ type: 'approve:idle' }, SITE); M.state.now += 1; await M.tick(30); };
const activeName = async () => { const st = await ok('status'); return (st.profiles.find((p) => p.id === st.activeId) || {}).name; };

await test('needs-login: an account that lands on a sign-in page is flagged, skipped now and in later loops, and re-saving clears it', async () => {
  const { tab, B } = await threeAccounts();
  await ok('setApprove', { approve: { enabled: true, all: true, loop: true, loopMinutes: 10 } });
  await tickLoop();
  assert.equal(await activeName(), 'A');
  await settle(); await tickLoop();
  assert.equal(await activeName(), 'B');
  tab.url = 'https://muse.ai/login?next=/app'; // Muse bounced the expired session to its sign-in page
  await settle(); await tickLoop();
  assert.equal(await activeName(), 'C', 'the loop moved on');
  assert.ok(M.state.session.needsLogin[B.id]);
  assert.deepEqual((await logOf('needs-login')).map((e) => e.account), ['B'], 'logged once, naming the account');
  assert.ok((await ok('status')).profiles.find((p) => p.id === B.id).needsLogin, 'the popup gets the flag');
  tab.url = 'https://muse.ai/app';
  await settle(); await tickLoop(); // C done: loop ends
  assert.equal(M.state.session.loopState, undefined);
  // next loop: A, then straight to C
  await tickLoop(11 * MIN);
  assert.equal(await activeName(), 'A');
  await settle(); await tickLoop();
  assert.equal(await activeName(), 'C', 'B is skipped');
  assert.equal((await logOf('needs-login')).length, 1, 'not logged again');
  await settle(); await tickLoop();
  // the user signs in again and re-saves
  await ok('switch', { id: B.id });
  await M.site.login('B');
  await ok('refresh', { id: B.id });
  assert.equal(M.state.session.needsLogin, undefined, 'flag cleared by the re-save');
  assert.equal((await ok('status')).profiles.find((p) => p.id === B.id).needsLogin, false);
  await tickLoop(11 * MIN);
  assert.equal(await activeName(), 'A');
  await settle(); await tickLoop();
  assert.equal(await activeName(), 'B', 'B is back in the rotation');
});

await test('needs-login: cookies wiped by the server during the dwell (the existing logged-out guard) also flag the account', async () => {
  const { B } = await threeAccounts();
  await ok('setApprove', { approve: { enabled: true, all: true, loop: true } });
  await tickLoop(); await settle(); await tickLoop();
  assert.equal(await activeName(), 'B');
  M.site.logout();
  await settle(); await tickLoop();
  assert.equal(await activeName(), 'C');
  assert.ok(M.state.session.needsLogin[B.id]);
  assert.equal((await logOf('needs-login')).length, 1);
});

await test('needs-login: a saved session whose cookies cannot be restored at all is flagged and the loop carries on', async () => {
  const { B } = await threeAccounts();
  await ok('setApprove', { approve: { enabled: true, all: true, loop: true } });
  const set = chrome.cookies.set;
  chrome.cookies.set = async (d) => (/-B$/.test(d.value) ? null : set(d));
  try {
    await tickLoop(); await settle(); await tickLoop();
    assert.ok(M.state.session.needsLogin[B.id], 'rolled back = nothing usable: flagged');
    assert.equal(await activeName(), 'A', 'the browser was put back');
    await tickLoop();
    assert.equal(await activeName(), 'C', 'next tick goes straight on, no dwell on a dead account');
  } finally { chrome.cookies.set = set; }
});

await test('needs-login: the flag is never set by a healthy loop, and nothing is typed or submitted', async () => {
  await threeAccounts();
  await ok('setApprove', { approve: { enabled: true, all: true, loop: true } });
  const scripts = [];
  const exec = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (o) => { scripts.push(o.func.toString()); return exec(o); };
  try {
    for (let i = 0; i < 4; i++) { await tickLoop(); await settle(); }
  } finally { chrome.scripting.executeScript = exec; }
  assert.equal(M.state.session.needsLogin, undefined);
  assert.deepEqual(await logOf('needs-login'), []);
  assert.ok(scripts.every((f) => !/\.submit\(|\.click\(|\.value\s*=|dispatchEvent/.test(f)), 'only storage capture/restore scripts ran');
});

await test('loop robustness: a closed tab mid-dwell is skipped quickly with a loop-timeout entry and later accounts still run', async () => {
  await threeAccounts();
  await ok('setApprove', { approve: { enabled: true, all: true, loop: true } });
  await tickLoop();
  assert.equal(await activeName(), 'A');
  M.state.tabs.length = 0; // the user closed every muse.ai tab
  const t0 = M.state.now;
  await tickLoop(20000);
  assert.equal(await activeName(), 'B', 'moved on long before the 150 s cap');
  assert.ok(M.state.now - t0 < 60000);
  const [t] = await logOf('loop-timeout');
  assert.equal(t.account, 'A');
  assert.match(t.title, /tab was closed/);
  await tickLoop(20000);
  assert.equal(await activeName(), 'C');
  assert.deepEqual((await logOf('loop-timeout')).map((e) => e.account).sort(), ['A', 'B']);
  await tickLoop(20000);
  assert.equal(M.state.session.loopState, undefined, 'the round completes');
});

await test('loop robustness: an account whose page never sends approve:idle is skipped at the per-account cap, not before', async () => {
  await threeAccounts();
  await ok('setApprove', { approve: { enabled: true, all: true, loop: true } });
  await tickLoop();
  assert.equal(await activeName(), 'A');
  await tickLoop(100000);
  assert.equal(await activeName(), 'A', 'still within the cap');
  assert.deepEqual(await logOf('loop-timeout'), []);
  await tickLoop(60000);
  assert.equal(await activeName(), 'B');
  const [t] = await logOf('loop-timeout');
  assert.equal(t.account, 'A');
  assert.match(t.title, /never reported/);
  await tickLoop(160000);
  assert.equal(await activeName(), 'C', 'one stalled account does not hold up the rest');
  await tickLoop(160000);
  assert.equal(M.state.session.loopState, undefined, 'loop ends');
  assert.ok(M.state.session.lastLoopEnd);
});

await test('loop robustness: the whole loop has a cap and then rests', async () => {
  await threeAccounts();
  await ok('setApprove', { approve: { enabled: true, all: true, loop: true } });
  await tickLoop();
  assert.ok(M.state.session.loopState);
  await tickLoop(46 * MIN); // e.g. the machine slept mid-loop
  assert.equal(M.state.session.loopState, undefined);
  assert.ok(M.state.session.lastLoopEnd);
  const [t] = await logOf('loop-timeout');
  assert.match(t.title, /Account loop stopped after 45 minutes/);
  await tickLoop(MIN);
  assert.equal(M.state.session.loopState, undefined, 'rests until the interval has passed');
});

await test('loop robustness: a switch that hangs is abandoned at its cap with a loop-timeout entry', async () => {
  await threeAccounts();
  await ok('setApprove', { approve: { enabled: true, all: true, loop: true } });
  const holds = [];
  const reload = chrome.tabs.reload;
  chrome.tabs.reload = () => new Promise((res) => holds.push(res)); // a tab call that never answers
  const st = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => st(fn, ms === 20000 ? 40 : ms, ...a); // shrink the 20 s switch cap
  try {
    await tickLoop();
    await M.tick(150);
    const [t] = await logOf('loop-timeout');
    assert.ok(t, 'logged');
    assert.match(t.title, /switching did not finish/);
    assert.ok(M.state.session.loopState, 'the loop state moved on instead of hanging in loopTick');
  } finally {
    globalThis.setTimeout = st;
    chrome.tabs.reload = reload;
    for (let i = 0; i < 6; i++) { holds.splice(0).forEach((r) => r()); await M.tick(120); }
  }
});

await test('loop robustness: locking the vault mid-dwell stops the loop; a fresh unlock starts a clean round', async () => {
  await threeAccounts();
  await ok('setApprove', { approve: { enabled: true, all: true, loop: true } });
  await tickLoop();
  assert.ok(M.state.session.loopState);
  await ok('lock');
  const active = M.jarGet('__Secure-sid')[0]?.value;
  await tickLoop(200000);
  assert.equal(M.state.session.loopState, undefined);
  assert.equal(M.jarGet('__Secure-sid')[0]?.value, active, 'nothing was switched while locked');
  await ok('unlock', { pass: PASS });
  await tickLoop();
  assert.ok(M.state.session.loopState, 'a new round starts after unlock');
});

await test('loop robustness: the vault locking between the tick reading its state and switching ends the loop cleanly', async () => {
  await threeAccounts();
  await ok('setApprove', { approve: { enabled: true, all: true, loop: true } });
  await tickLoop();
  const sid0 = sid();
  const get = chrome.storage.session.get;
  chrome.storage.session.get = async (keys) => {
    const r = await get(keys);
    if (Array.isArray(keys) && keys.includes('loopState')) delete M.state.session.k; // locked right after the check
    return r;
  };
  try { await tickLoop(200000); } finally { chrome.storage.session.get = get; }
  assert.equal(M.state.session.loopState, undefined);
  assert.equal(sid(), sid0, 'no account switch happened');
  assert.ok(!(await decisions()).some((d) => d.startsWith('needs-login')), 'a lock is not an expired account');
});

await test('defaults: session cookies are not made persistent unless asked', async () => {
  await ok('setup', { pass: PASS });
  const st = await ok('status');
  assert.equal(st.settings.persistSession, false);
  assert.equal(st.settings.clearOnLock, false);
});

await test('shortcut failures are surfaced on the badge', async () => {
  await ok('setup', { pass: PASS });
  await M.tick(100); // let the setup badge refresh finish first
  M.fireCommand('next-account'); // fewer than two accounts
  await M.tick(150);
  assert.equal(M.state.badge.text, 'ERR');
});


console.log(`\n${passed} integration tests passed${process.exitCode ? ' (SOME FAILED)' : ''}`);
