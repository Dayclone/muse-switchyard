# Changelog

All notable changes are listed here. Format follows [Keep a Changelog](https://keepachangelog.com/),
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
