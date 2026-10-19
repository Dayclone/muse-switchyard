// Usage: node scripts/bump.mjs patch|minor|major   (or an explicit x.y.z)
// Updates package.json, manifest.json and CHANGELOG.md together so they cannot drift.
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8');
const write = (f, s) => fs.writeFileSync(new URL(f, root), s);

const arg = process.argv[2];
const pkg = JSON.parse(read('package.json'));
const man = JSON.parse(read('manifest.json'));
if (pkg.version !== man.version) throw new Error(`package.json (${pkg.version}) and manifest.json (${man.version}) already differ`);

const [maj, min, pat] = pkg.version.split('.').map(Number);
let next;
if (arg === 'major') next = `${maj + 1}.0.0`;
else if (arg === 'minor') next = `${maj}.${min + 1}.0`;
else if (arg === 'patch') next = `${maj}.${min}.${pat + 1}`;
else if (/^\d+\.\d+\.\d+$/.test(arg || '')) next = arg;
else throw new Error('usage: node scripts/bump.mjs patch|minor|major|x.y.z');

const date = new Date().toISOString().slice(0, 10);
let log = read('CHANGELOG.md');
if (!log.includes('## [Unreleased]')) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
if (log.includes(`## [${next}]`)) throw new Error(`CHANGELOG.md already has ${next}`);
log = log.replace('## [Unreleased]', `## [Unreleased]\n\n## [${next}] - ${date}`);

pkg.version = next;
man.version = next;
write('package.json', JSON.stringify(pkg, null, 2) + '\n');
write('manifest.json', JSON.stringify(man, null, 2) + '\n');
write('CHANGELOG.md', log);
console.log(`${pkg.version === next ? 'bumped to' : ''} ${next}. Review the diff, fill in the changelog section, open a PR, then tag v${next} after merge.`);
