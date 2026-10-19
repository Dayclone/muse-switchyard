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
2. Tag the merge commit `vX.Y.Z` and push the tag. CI tests, builds `switchyard-vX.Y.Z.zip`, and
   publishes a GitHub Release with it.

### Store publishing (maintainer)

The `store-publish` job in `release.yml` uploads the release zip to the Chrome Web Store and Microsoft Edge
Add-ons. The first submission of each listing is manual (see `docs/STORE_LISTING.md`); after that:

1. Create a GitHub Environment named `store-publish` (Settings, Environments) and add yourself as a required reviewer.
2. Add repository **variables** `CHROME_EXTENSION_ID` and `EDGE_PRODUCT_ID`.
3. Add **secrets** `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN` (Chrome Web Store API OAuth)
   and `EDGE_CLIENT_ID`, `EDGE_API_KEY` (Partner Center, Publish API). The Edge API key expires periodically; rotate it.
4. Tag a release. Approve the environment when prompted. A step with missing values is skipped.

Never paste these values into issues, PRs or chat.
