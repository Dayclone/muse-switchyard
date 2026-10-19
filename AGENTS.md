# AGENTS.md

Guidance for AI coding agents (and humans in a hurry) working on Switchyard, a Manifest V3 browser
extension that saves and swaps muse.ai sessions and can auto-approve Muse approval cards.

## Commands

```
npm install          # once; installs jsdom (dev only)
npm test             # everything: unit, integration, auto-approve DOM, popup smoke
npm run bump -- patch|minor|major   # version bump (package.json + manifest.json + CHANGELOG.md)
```

All tests must pass before you open a PR. There is no build step: the repo folder is the extension.

## Map

| Path | Role |
| --- | --- |
| `background.js` | Service worker: encrypted vault, snapshot/restore, switching, auto-sync, locking, auto-approve settings/log, account loop, alarms |
| `content/approve.js` | Classic content script on `*.muse.ai`: finds approval cards, clicks Allow per the rules. Cannot change settings; only reports via `approve:log` / `approve:idle` |
| `popup.html/js/css` | UI. Names and metadata only; never receives cookie values. DOM is built with `h()`, never `innerHTML` |
| `lib/crypto.js` | PBKDF2 to AES-GCM, KDF params as AAD, padding |
| `lib/cookies.js` | Pure cookie/storage sanitising and heuristics |
| `tests/mockchrome.mjs` | Fake `chrome.*` API (cookie jar, storage areas, alarms, tabs, listeners) |
| `tests/*.mjs` | `test.mjs` (unit), `integration.mjs` (real `background.js` on the fake), `approve.test.mjs`, `popup.smoke.mjs` |
| `docs/` | `GAP_ANALYSIS.md`, `RED_TEAM.md` (what was attacked, fixed, accepted) |

## Hard rules

1. **Never** log, display, or message cookie values, tokens, passphrases, message bodies or recipients.
   The approve log keeps title/action/task/category/account only.
2. **No new permissions, no new host permissions, no network calls, no remote code, no `innerHTML`/`eval`**
   without an issue where the maintainer agreed first. Keep the CSP strict.
3. Everything that comes from outside the extension is hostile: imported files, stored profiles, page
   storage, card text, messages from content scripts. Sanitise at the boundary (`sanitizeCookie`,
   `sanitizeWeb`, `sanitizeApprove`). Content-script messages are accepted only from `https://*.muse.ai/`
   and may never reach `handlers`.
4. Anything that touches the live browser must be crash-safe: commit the intent first, keep a rollback,
   keep the "frozen" journal flag semantics (see `doSwitch`).
5. Auto-approve defaults must stay **off**. Do not add behaviour that approves without an explicit user
   toggle. Do not use Muse's "Always allow for this conversation" menu item.
6. No code, text or assets copied from other projects. Write it yourself.

## Making a change

1. Branch from `main`; never push to `main`.
2. Write the failing test first when fixing a bug (use `tests/mockchrome.mjs` for anything touching
   `chrome.*`; for the card watcher use the fixtures in `tests/approve.test.mjs`).
3. Keep the diff small and focused. Update README/docs if behaviour changes.
4. Add a line under `## [Unreleased]` in `CHANGELOG.md`.
5. Version bumps belong to the maintainer at release time (`npm run bump`), unless asked.
6. Open a PR using the template. Say what you verified and what you could not (for example "not tried in
   a real browser").

## Versioning

Semantic versioning, one source of truth checked by a test: `package.json` and `manifest.json` must
match, and `CHANGELOG.md` must have a section for that version. Patch = fixes, minor = features or
behaviour changes, major = breaking changes to stored data or settings. Releases are tags `vX.Y.Z`;
CI builds and attaches the extension zip.

## Gotchas

- Muse's right pane opens on Activity; approval cards only exist while the **Approvals** tab is selected
  (`aria-pressed="true"` on `button[aria-label="Approvals"]`). The watcher switches to it first.
- The card's button row is a sibling of its question text; `findCards` climbs until the "...?" line is inside.
- Card category comes from the action line, not the title: a task named "Marketplace Auto Replies" must
  not look like a listing.
- An already-open tab keeps running the old content script after an extension reload; reload the tab.
- jsdom has no layout and no `innerText`; the tests stub visibility and read text nodes instead.
- Chrome and Edge both run this unchanged; the only browser-specific code is the settings page address in
  the "keep tabs awake" button.
