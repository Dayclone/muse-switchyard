import assert from 'node:assert/strict';
import { createVault, sealVault, openVault, openWithKey } from '../lib/crypto.js';
import {
  toSetDetails, inScope, looksLoggedOut, slimCookie, cookieUrl, sanitizeCookie, sanitizeWeb,
  looksLikeOtherLogin, lostCredentials, cleanLabel, isId, WEB_MAX_CHARS
} from '../lib/cookies.js';
import { unb64 } from '../lib/crypto.js';

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log('ok  -', name);
};

const NOW = 1_800_000_000;

await test('vault round trip', async () => {
  const data = { profiles: { a: { name: 'A', cookies: [{ name: 'x', value: 'y' }] } }, activeId: 'a' };
  const { vault, raw } = await createVault('correct horse battery', data, 100000);
  const opened = await openVault('correct horse battery', vault);
  assert.deepEqual(opened.data, data);
  assert.deepEqual(await openWithKey(vault, raw), data);
});

await test('wrong passphrase is rejected', async () => {
  const { vault } = await createVault('correct horse battery', { a: 1 }, 100000);
  await assert.rejects(openVault('wrong passphrase!!', vault), /BAD_PASSPHRASE/);
});

await test('re-seal uses a fresh IV and still opens', async () => {
  const { vault, raw } = await createVault('correct horse battery', { a: 1 }, 100000);
  const next = await sealVault(vault, raw, { a: 2 });
  assert.notEqual(next.iv, vault.iv);
  assert.deepEqual((await openVault('correct horse battery', next)).data, { a: 2 });
});

await test('tampering with KDF parameters or ciphertext fails', async () => {
  const { vault } = await createVault('correct horse battery', { a: 1 }, 100000);
  await assert.rejects(openVault('correct horse battery', { ...vault, iter: 100001 }), /BAD_PASSPHRASE/);
  const flipped = { ...vault, ct: (vault.ct[0] === 'A' ? 'B' : 'A') + vault.ct.slice(1) };
  await assert.rejects(openVault('correct horse battery', flipped), /BAD_PASSPHRASE/);
});

await test('malformed or out-of-range vaults are refused', async () => {
  await assert.rejects(openVault('x', { v: 1 }), /BAD_VAULT/);
  const { vault } = await createVault('correct horse battery', {}, 100000);
  await assert.rejects(openVault('x', { ...vault, iter: 1e9 }), /BAD_VAULT/);
});

await test('scope matching', () => {
  assert.ok(inScope('.muse.ai', ['muse.ai']));
  assert.ok(inScope('auth.muse.ai', ['muse.ai']));
  assert.ok(!inScope('notmuse.ai', ['muse.ai']));
  assert.ok(!inScope('muse.ai.evil.com', ['muse.ai']));
});

await test('__Host- cookies drop the domain and force secure + root path', () => {
  const d = toSetDetails({ name: '__Host-s', value: 'v', domain: 'muse.ai', path: '/x', hostOnly: true, secure: false, session: false, expirationDate: NOW + 1000 }, { now: NOW });
  assert.equal(d.domain, undefined);
  assert.equal(d.path, '/');
  assert.equal(d.secure, true);
});

await test('host-only cookies omit domain; domain cookies keep it', () => {
  const base = { name: 'a', value: '1', path: '/', secure: true, session: false, expirationDate: NOW + 1000 };
  assert.equal(toSetDetails({ ...base, domain: 'auth.muse.ai', hostOnly: true }, { now: NOW }).domain, undefined);
  assert.equal(toSetDetails({ ...base, domain: '.muse.ai', hostOnly: false }, { now: NOW }).domain, '.muse.ai');
});

await test('SameSite=None forces secure', () => {
  const d = toSetDetails({ name: 'a', value: '1', domain: '.muse.ai', path: '/', secure: false, sameSite: 'no_restriction', session: true }, { now: NOW });
  assert.equal(d.secure, true);
  assert.equal(d.sameSite, 'no_restriction');
});

await test('expired cookies are skipped unless keep-alive is on', () => {
  const c = { name: 'a', value: '1', domain: '.muse.ai', path: '/', secure: true, session: false, expirationDate: NOW - 5 };
  assert.equal(toSetDetails(c, { now: NOW }), null);
  const d = toSetDetails(c, { now: NOW, keepAliveDays: 30 });
  assert.equal(d.expirationDate, NOW + 30 * 86400);
});

await test('keep-alive never shortens a longer expiry, and caps at 400 days', () => {
  const far = NOW + 300 * 86400;
  const c = { name: 'a', value: '1', domain: '.muse.ai', path: '/', secure: true, session: false, expirationDate: far };
  assert.equal(toSetDetails(c, { now: NOW, keepAliveDays: 30 }).expirationDate, far);
  assert.equal(toSetDetails({ ...c, expirationDate: NOW + 10 }, { now: NOW, keepAliveDays: 9999 }).expirationDate, NOW + 400 * 86400);
});

await test('session cookies: stay session unless persistSession', () => {
  const c = { name: 'a', value: '1', domain: '.muse.ai', path: '/', secure: true, session: true };
  assert.equal(toSetDetails(c, { now: NOW, keepAliveDays: 30 }).expirationDate, undefined);
  assert.equal(toSetDetails(c, { now: NOW, keepAliveDays: 30, persistSession: true }).expirationDate, NOW + 30 * 86400);
  assert.equal(toSetDetails(c, { now: NOW, keepAliveDays: 0, persistSession: true }).expirationDate, undefined);
});

await test('partition key is carried through; slimCookie drops extras', () => {
  const pk = { topLevelSite: 'https://muse.ai' };
  const c = slimCookie({ name: 'a', value: '1', domain: '.muse.ai', path: '/', secure: true, session: true, storeId: '0', partitionKey: pk, extra: 'x' });
  assert.equal(c.storeId, undefined);
  assert.equal(c.extra, undefined);
  assert.deepEqual(toSetDetails(c, { now: NOW }).partitionKey, pk);
  assert.equal(cookieUrl(c), 'https://muse.ai/');
});

await test('logged-out guard', () => {
  assert.ok(looksLoggedOut(6, 0));
  assert.ok(looksLoggedOut(8, 3));
  assert.ok(!looksLoggedOut(8, 6));
  assert.ok(!looksLoggedOut(2, 1));
});


await test('cookie prefixes are case-insensitive; __Http- is secure + httpOnly', () => {
  const d = toSetDetails({ name: '__host-s', value: 'v', domain: 'muse.ai', path: '/x', hostOnly: false, secure: false, session: true }, { now: NOW });
  assert.equal(d.domain, undefined);
  assert.equal(d.path, '/');
  assert.equal(d.secure, true);
  const h = toSetDetails({ name: '__Http-t', value: 'v', domain: '.muse.ai', path: '/', session: true }, { now: NOW });
  assert.equal(h.secure, true);
  assert.equal(h.httpOnly, true);
});

await test('sanitizeCookie: absurd expiry, partition key shape, hostile hosts and paths', () => {
  const base = { name: 'a', value: '1', domain: '.muse.ai', path: '/', secure: true };
  const far = sanitizeCookie({ ...base, session: false, expirationDate: 1e300 });
  assert.equal(far.session, true);
  assert.equal(far.expirationDate, undefined);
  assert.equal(sanitizeCookie({ ...base, session: false, expirationDate: -5 }).session, true);
  const pk = sanitizeCookie({ ...base, session: true, partitionKey: { topLevelSite: 'https://muse.ai', hasCrossSiteAncestor: false } });
  assert.deepEqual(pk.partitionKey, { topLevelSite: 'https://muse.ai' });
  const pk2 = sanitizeCookie({ ...base, session: true, partitionKey: { topLevelSite: 'https://muse.ai', hasCrossSiteAncestor: true } });
  assert.equal(pk2.partitionKey.hasCrossSiteAncestor, true);
  for (const domain of ['muse.ai#.evil.com', 'evil.com/x', 'a b.com', 'muse.ai\r\n', '', 'localhost', 'x'.repeat(300) + '.com']) {
    assert.equal(sanitizeCookie({ ...base, domain }), null, domain);
  }
  for (const path of ['x', '/;Domain=evil.com', '/a b', '/\\x', '/?q', '/#f']) {
    assert.equal(sanitizeCookie({ ...base, path }), null, path);
  }
});

await test('sanitizeWeb drops oversize origins whole and never keeps __proto__', () => {
  const bases = ['muse.ai'];
  const ok = sanitizeWeb({ 'https://muse.ai': { local: { a: '1' }, session: {} } }, bases);
  assert.deepEqual(Object.keys(ok), ['https://muse.ai']);
  const big = sanitizeWeb({ 'https://muse.ai': { local: { a: 'x'.repeat(WEB_MAX_CHARS + 1) }, session: {} } }, bases);
  assert.deepEqual(big, {});
  const manyKeys = {};
  for (let i = 0; i < 1001; i++) manyKeys['k' + i] = 'v';
  assert.deepEqual(sanitizeWeb({ 'https://muse.ai': { local: manyKeys, session: {} } }, bases), {});
  const proto = sanitizeWeb(JSON.parse('{"https://muse.ai":{"local":{"__proto__":"x","ok":"1"}}}'), bases);
  assert.deepEqual(proto['https://muse.ai'].local, { ok: '1' });
  assert.deepEqual(sanitizeWeb({ 'http://muse.ai': { local: { a: '1' } }, 'https://evil.com': { local: { a: '1' } } }, bases), {});
});

await test('looksLikeOtherLogin: rotation is fine, a different login is not', () => {
  const mk = (v) => ['sid', 'rt', 'dev'].map((n) => ({ name: n, domain: '.muse.ai', path: '/', httpOnly: true, value: n + v }));
  const saved = mk('A');
  const rotated = mk('A'); rotated[0].value = 'sid-new';
  assert.equal(looksLikeOtherLogin(saved, rotated), false);
  assert.equal(looksLikeOtherLogin(saved, mk('B')), true);
  assert.equal(looksLikeOtherLogin(saved.slice(0, 1), mk('B')), false, 'a single sample is too few to judge');
  assert.equal(looksLikeOtherLogin(saved.slice(0, 2), mk('B')), true, 'two samples that all changed');
  assert.equal(looksLikeOtherLogin(saved.slice(0, 2), rotated.slice(0, 2)), false, 'only one of two changed');
  const nonHttpOnly = saved.map((c) => ({ ...c, httpOnly: false }));
  assert.equal(looksLikeOtherLogin(nonHttpOnly, mk('B').map((c) => ({ ...c, httpOnly: false }))), false);
});

await test('lostCredentials: anonymous downgrade is detected, rotation is not', () => {
  const mk = (names) => names.map((n) => ({ name: n, domain: '.muse.ai', path: '/', httpOnly: true, value: 'v' }));
  const saved = mk(['sid', 'rt', 'dev']);
  assert.equal(lostCredentials(saved, mk(['dev'])), true);
  assert.equal(lostCredentials(saved, mk(['sid', 'rt'])), false);
  assert.equal(lostCredentials(mk(['sid']), []), false, 'too few credentials to judge');
});

await test('cleanLabel strips control and bidi characters; isId is strict', () => {
  assert.equal(cleanLabel('Work‮gnp.exe\u0000 '), 'Workgnp.exe');
  assert.equal(cleanLabel('x'.repeat(100)).length, 60);
  assert.ok(isId(crypto.randomUUID()));
  for (const bad of ['__proto__', 'constructor', '', null, undefined, 5, {}, 'x'.repeat(36)]) assert.ok(!isId(bad), String(bad));
});

await test('vault plaintext is padded to 4 KB so size hides the account count', async () => {
  const small = (await createVault('correct horse battery', { a: 1 }, 100000)).vault;
  const large = (await createVault('correct horse battery', { a: 'x'.repeat(3000) }, 100000)).vault;
  assert.equal(unb64(small.ct).length, unb64(large.ct).length);
  assert.equal(unb64(small.ct).length % 4096, 16);
});

await test('oversized fields and unrealistic KDF counts are refused before any work', async () => {
  const { vault } = await createVault('correct horse battery', {}, 100000);
  await assert.rejects(openVault('x', { ...vault, iter: 3_000_000 }), /BAD_VAULT/);
  await assert.rejects(openVault('x', { ...vault, iv: 'A'.repeat(40) }), /BAD_VAULT/);
  await assert.rejects(openVault('x', { ...vault, ct: 'A'.repeat(33_000_000) }), /BAD_VAULT/);
});

console.log(`\n${passed} tests passed`);
