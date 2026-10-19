# Security policy

Switchyard handles login sessions, so security reports matter.

## Reporting

Please **do not open a public issue** for a vulnerability. Use GitHub's private reporting:
**Security → Report a vulnerability** on this repository. Include what you found, steps to reproduce,
and the version (see `manifest.json`). You will get an acknowledgement; fixes ship as a patch release
with credit if you want it.

## Supported versions

Only the latest release gets fixes.

## In scope

- Anything that exposes cookie values, the vault key, or passphrases.
- Ways for a web page (including muse.ai content) to change settings, switch accounts or trigger actions
  through the content script.
- Vault, import or export flaws (decryption bypass, rollback, injection through imported data).
- Auto-approve acting when it is off, or clicking cards it should not.

## Out of scope

- Anyone who already has an unlocked vault or an active session on your machine (see the README security model).
- Muse/Meta service behaviour, and terms-of-service questions.
