# Changelog

All notable changes are listed here. Format follows [Keep a Changelog](https://keepachangelog.com/),
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-10-19

### Added
- Markup watchdog: with auto-approve on, a muse.ai tab that shows none of the known controls for 10 minutes sends `approve:stale` (once per 30 minutes per tab); the background logs a `stale` warning, shows `WARN` on the toolbar badge and a banner in Settings until a later approved/skipped card or an `approve:controls` report.
- Click verification: about 3 seconds after clicking Allow the content script logs `confirmed` (card gone) or, after the retry limit, `stuck`. The popup log shows them distinctly.
- Cards with an unsatisfied required input (select, radio, checkbox, text, textarea, ARIA equivalents, `aria-required`) are not clicked; logged once as `needs-input`.
- Account loop: an account that lands on a sign-in page or loses its cookies is marked `needsLogin` (session storage), skipped until re-saved with ↻, logged as `needs-login`, and tagged "needs re-login" in the popup.

### Fixed
- Account loop robustness: a stalled account (tab closed, page never reports idle, switch hangs) is skipped with a `loop-timeout` log entry instead of holding up later accounts. Caps: 150 s dwell per account, 20 s per switch, 15 s without any muse.ai tab, 45 min for the whole round. A switch that rolls back (none of the saved cookies could be restored) now skips the account at once instead of dwelling on the previous one, and flags it `needs-login`.

### Changed
- Decisions in `approve:log` from the page are allow-listed; `stale`, `needs-login` and `loop-timeout` can only come from the background.

## [0.3.1] - 2026-10-19

### Fixed
- Chat-only view: when Muse's right pane is closed, the watcher now opens it by clicking the avatar at the top centre (found by shape and position, never by its editable name), then switches to Approvals. It never clicks while a pane is already open.

## [0.3.0] - 2026-10-19

### Added
- Auto-approve for Muse approval cards: master switch, messages / Marketplace listings / everything toggles,
  optional hold for money-delete-credential cards, learn mode, per-minute rate limit, log.
- Account loop that switches through every saved account and clears each one's approvals.
- Watcher switches the right pane to the Approvals tab before checking, and opens the
  "A task needs review" bar as a fallback.
- "Keep muse.ai tabs awake" button (Chrome and Edge) that opens the right settings page and copies the site.
- Repository docs: README, AGENTS.md, CONTRIBUTING, SECURITY, issue and PR templates, CI and release workflows.

### Changed
- Version is kept in sync across `package.json`, `manifest.json` and this file (checked by a test).

## [0.2.0] - 2026-10-18

### Fixed (red-team round)
- Frozen auto-save flag persists across lock and restart, and is recorded while locked.
- Auto-save merges instead of replacing; anonymous-downgrade and other-login detection improved.
- Keep-alive runs inside the vault queue and re-reads cookies before writing; never revives expired cookies.
- Interrupted switches leave auto-save paused; switching to the already-active account no longer overwrites newer tokens.
- Refresh is refused for non-active accounts; lock cannot hang; setup is serialised; sync debounce no longer starves.

### Added
- Passphrase policy and back-off, padded vault size, export re-authentication, import preview,
  `ERASE` confirmation, rollback detection.

## [0.1.0] - 2026-10-17

### Added
- Encrypted multi-account session switcher for muse.ai: save, switch, rename, remove, sign out, lock,
  cookie keep-alive, token-rotation capture, `Alt+Shift+S` shortcut.
