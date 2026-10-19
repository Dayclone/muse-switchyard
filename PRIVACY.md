# Privacy policy

_Switchyard is an unofficial, open-source browser extension. Last updated: 2026-10-19._

**Short version:** Switchyard collects nothing. It has no server, no analytics and makes no network
requests of its own. Everything it stores stays in your browser.

## What it handles
- **Session data for muse.ai accounts you choose to save:** cookies (including httpOnly cookies) and the
  localStorage / sessionStorage of open muse.ai tabs. You can optionally add meta.ai, meta.com and
  facebook.com, which also saves their cookies.
- **Settings and an activity log** for the optional auto-approve feature (card title, action, task name and
  account name, never recipients or message bodies; the log keeps the latest 200 entries).

## Where it lives
- Saved sessions are encrypted (PBKDF2-SHA256, 600,000 iterations, then AES-256-GCM) with a passphrase only you
  know, and stored in `chrome.storage.local` on your device.
- The unlock key is held in `chrome.storage.session` (memory) and discarded when the vault locks, the idle
  timer fires, or the browser closes.
- Nothing is transmitted to the developer or any third party. If you use browser sync, Switchyard does not
  use `chrome.storage.sync`.

## Permissions, and why
| Permission | Why |
|---|---|
| `cookies` + host access to `https://*.muse.ai/*` | Read and restore the session cookies of the accounts you save |
| `storage` | Keep the encrypted vault and settings on your device |
| `scripting` | Read and restore page storage of open muse.ai tabs |
| `alarms`, `idle` | Auto-lock, cookie upkeep and the optional account loop |
| Content script on `https://*.muse.ai/*` | Optional auto-approve: find approval cards and click Allow. It can only report to the extension |
| Optional host access (meta.ai, meta.com, facebook.com) | Requested only if you add those sites |

## Your control
Delete an account, erase the vault, or uninstall the extension and the data is gone. There is no remote copy.

## Contact
Questions or concerns: open an issue at https://github.com/Dayclone/muse-switchyard/issues, or report
security problems privately via the repository's Security tab.
