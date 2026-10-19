# Contributing

Thanks for helping. The rules are short:

- **Everything goes through a pull request.** Nobody pushes to `main`, including the maintainer.
  Fork or branch, open a PR, wait for review and green CI.
- **Found a bug or have an idea?** Open an issue first using the template. For anything that touches
  security, read [SECURITY.md](SECURITY.md) and report privately instead.
- **Small, focused PRs** merge fastest. One fix or one feature each.

## Before you open a PR

```
npm install
npm test
```

All suites must pass. Add or update tests for what you changed (bug fixes need a test that fails
without the fix). Add a line under `## [Unreleased]` in `CHANGELOG.md`.

Do not bump the version in your PR; the maintainer does that when releasing.

## What gets rejected

- New permissions, network calls, remote code, `innerHTML`/`eval`, or analytics.
- Anything that logs or shows cookie values, tokens, or message contents.
- Auto-approve changes that act without an explicit opt-in toggle.
- Code or text copied from other projects.

## Testing in a browser

Load the folder unpacked in Chrome or Edge, use **Learn mode** first, and say in the PR what you tried
and what you did not. Tests run against a fake `chrome.*` API, so a green CI is not proof it works on
the real Muse site.

## Conduct

Be kind and assume good faith. Harassment gets you removed. Keep discussion about the code.

## Releases (maintainer)

1. `npm run bump -- minor` (or `patch` / `major`), review the diff, merge via PR.
2. After the bump PR is merged, run `gh workflow run Release -f version=X.Y.Z` (no leading `v`), or
   use Actions > Release > Run workflow. The workflow checks out `main` and fails if
   `manifest.json` version does not equal the input, or if tag `vX.Y.Z` or a GitHub Release already
   exists. Otherwise it runs `npm ci` and `npm test`, builds `switchyard-vX.Y.Z.zip`, creates the
   tag on `main`, and publishes a GitHub Release with generated notes.

Alternative: tag the merge commit `vX.Y.Z` and push the tag. CI tests, checks that the tag matches
`manifest.json`, builds the zip, and publishes the Release.

### Dependabot

`.github/workflows/dependabot-automerge.yml` enables auto-merge (merge commit) for Dependabot
semver-minor and semver-patch updates only. It approves them only when the repo variable
`DEPENDABOT_AUTO_APPROVE` is `true`. This needs the repo setting "Allow GitHub Actions to create
and approve pull requests", and "Allow auto-merge" must be on. Major updates and human PRs are
merged manually.

jsdom major updates are ignored for now: jsdom 30 needs a newer Node than 20, which this repo still
supports.
