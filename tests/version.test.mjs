// One source of truth for the version: package.json, manifest.json and CHANGELOG.md must agree.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const man = JSON.parse(read('manifest.json'));
const log = read('CHANGELOG.md');

assert.match(man.version, /^\d+\.\d+\.\d+$/, 'manifest version is x.y.z');
assert.equal(pkg.version, man.version, 'package.json and manifest.json versions match');
assert.ok(log.includes(`## [${man.version}]`), `CHANGELOG.md has a section for ${man.version}`);
assert.ok(log.includes('## [Unreleased]'), 'CHANGELOG.md keeps an Unreleased section');
console.log('ok  - versions agree:', man.version);
