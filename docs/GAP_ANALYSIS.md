# Gap analysis

Scope: Switchyard v0.1.0 as first delivered, measured against what was asked for:

1. Switch muse.ai accounts quickly and easily in the browser.
2. Long-lived sessions so it **doesn't ask for an OTP unless it has to**.
3. A cleaner, hardened, original implementation (no ties to any existing project).

Status legend: **Fixed** (code + test), **Mitigated** (reduced, residual risk noted),
**Accepted** (deliberate trade-off), **Open** (not solved; needs real-world input).

## A. Gaps found in v0.1.0 and what was done

| # | Gap | Why it matters | Status |
|---|-----|----------------|--------|
| G1 | A switch clears the browser *then* restores. If nothing restores (all cookies expired, bad data), the user is left signed out and the "active" account is wrong. | Data-state loss; confusing. | **Fixed**: pre-switch backup + automatic rollback; popup explains. Test: *failed restore rolls back*. |
| G2 | Auto-save assumes the browser still holds the **active** account. If the user logs out and into another account outside the extension, the next auto-save would overwrite account A's copy with B's cookies. | Silent cross-account contamination, the worst failure for this tool. | **Mitigated**: cookie *removals* (explicit / server delete) pause auto-save ("frozen"), shown in the popup and badge (`!`); also respected by the pre-switch, sign-out and lock saves. Residual: a login that only *overwrites* cookies and deletes none is indistinguishable from token rotation. |
| G3 | Stored/imported cookie fields went straight into `https://${domain}${path}` and `chrome.cookies.set`. A crafted domain/path could aim at another host or smuggle odd characters. | Injection via import or a corrupted vault. | **Fixed**: `sanitizeCookie` (strict host, path, name, value, size, SameSite); applied on import **and** every restore; restore additionally filters to configured domains. |
| G4 | Imported page-storage was stored unvalidated. | Prototype keys, other origins, huge blobs. | **Fixed**: `sanitizeWeb` (https origins inside scope only, string-only, `__proto__` dropped, size caps). |
| G5 | A tab can navigate between "find the tab" and "run the script", so storage could be read from or written to a different origin. | Cross-origin storage read/write if an optional Meta site is enabled. | **Fixed**: injected code verifies `location.origin` first. Test: *origin guard*. |
| G6 | Idle timeout only; screen lock did not lock the vault. | Unattended unlocked vault. | **Fixed**: locks on OS screen lock (`idle`). |
| G7 | The signed-in account lives in Chrome's own cookie store, unencrypted, regardless of the vault. | The vault protects *inactive* accounts only; easy to misunderstand. | **Mitigated**: optional "sign out when the vault locks" (after saving rotated tokens); README states the limit plainly. Inherent otherwise. |
| G8 | No indication which account is active. | Wrong-account mistakes. | **Fixed**: toolbar badge (initials / `?` / `LOCK` / `!`). |
| G9 | Switching needed the popup. | "Quickly and easily". | **Fixed**: `Alt+Shift+S` cycles accounts (rebindable). |
| G10 | Only length checked on the passphrase. | Offline brute force is the main at-rest threat. | **Mitigated**: length 10–256 and character variety. PBKDF2 stays the KDF (see O7). |
| G11 | Only the pure helpers had tests; the logic that actually loses data (background.js) had none. | Regression risk. | **Fixed**: fake-`chrome` harness + 41 integration tests (+22 unit, 8 popup steps) (switching, rotation, freeze, rollback, keep-alive, import abuse, locking, races, at-rest leakage, message surface). |
| G12 | Unbounded numbers of profiles/cookies/storage keys. | Storage quota and DoS. | **Fixed**: caps (50 profiles, 500 cookies each, 2 MB storage per profile). |
| G13 | Icon-only buttons had no accessible names; empty state had no next step. | Usability. | **Fixed**: `aria-label`s, "Open muse.ai" button. |
| G14 | Message handler dispatched on any `type` string. | Prototype-key dispatch. | **Fixed** earlier (own-property check) and now covered by a test. |

## B. Requirement coverage

| Requirement | Delivered | Honest caveat |
|---|---|---|
| Fast, easy switching | Popup one-click switch, shortcut, badge, auto page reload | Switching is browser-wide: one account at a time per Chrome profile. |
| Long-lived cookies / fewer OTPs | Keep-alive (up to the 400-day browser cap), session→persistent, rotated-token capture, pre-switch save, 6-hourly refresh of live cookies | Only stops the *browser* dropping cookies. The server decides whether a session is valid. When it says no, one OTP is unavoidable. |
| Harden | Encrypted vault, minimal permissions, sanitised inputs, strict CSP, no `innerHTML`, auto-lock + screen-lock, rollback, freeze guard | See open items. |
| Own implementation, no traces | Written from scratch from the idea only; own name, layout, code, tests; no references to any other project | No LICENSE file added; choose one. |

## C. Open / accepted items

| # | Item | Status | Notes |
|---|------|--------|-------|
| O1 | **No session health check.** The extension cannot tell whether a saved session is still valid server-side until you switch to it. | Open | Needs knowledge of a muse.ai endpoint that reveals login state; none assumed. Could be added as an optional probe once known. |
| O2 | **Where the muse.ai session really lives** (muse.ai vs Meta cookies) is unverified. | Open | First real run: Settings → *Show what is stored right now*, compare before/after login; enable the Meta sites only if needed. |
| O3 | Two accounts **at the same time** in one browser. | Accepted | Not possible with cookie swapping. Use separate Chrome profiles for concurrency. |
| O4 | IndexedDB is not snapshotted. | Accepted | Serialisation of Blob/File loses data; add only if a real need shows up. |
| O5 | Device binding / fingerprint checks by the server. | Accepted | If the server binds a session to something we don't carry, switching will prompt for OTP. Not fixable client-side. |
| O6 | After a browser restart the vault is locked (key lives in session memory only). | Accepted | Deliberate security choice; costs one passphrase entry per browser start. |
| O7 | PBKDF2-SHA256 (600k) instead of Argon2/scrypt. | Accepted | WebCrypto offers only PBKDF2; a WASM KDF would add a dependency to audit. Mitigate with a long passphrase. |
| O8 | Backups are manual. | Open | An "export reminder" would be a small addition. |
| O9 | Chrome/Edge only; unpacked install, no auto-update. | Accepted | Firefox needs a port; store packaging not requested. |
| O10 | Behaviour verified against a **fake** `chrome` API, not a real browser. | Open | The mock mirrors documented semantics; real-Chrome differences are the main residual risk. Items the red team could not settle are listed in `RED_TEAM.md`. |
| O11 | Considered and rejected: keeping a "previous vault" copy for corruption recovery. | Rejected | It would retain deleted accounts and, after a passphrase change, a copy under the **old** passphrase. `storage.set` is atomic; the encrypted export is the backup. |
| O12 | Considered and rejected: account-identity probing to detect "someone else logged in". | Rejected | Needs site-specific knowledge; the freeze guard is the generic substitute. |

## D. Closed in 0.4.0 (auto-approve hardening)

All proven in Node against jsdom fixtures and the fake `chrome.*` API only. **None of it has been run in a real browser.**

| # | Gap | What changed | Tests |
|---|-----|--------------|-------|
| H1 | If Muse changed its markup, auto-approve would silently do nothing. | Watchdog: no known control (Approvals tab, pane close button, avatar, review bar, any card) for 10 min with auto-approve on sends `approve:stale` (rate limited per tab in both content script and background). Background logs `stale`, shows `WARN` on the badge and a Settings banner until an approved/skipped log or `approve:controls` from that tab, tab close, or auto-approve off. No page text is sent or stored. | approve.test (7), integration (2), popup (1) |
| H2 | `approved` only meant "clicked". | Follow-up `confirmed` (card gone ~3 s later) or `stuck` (still there after the retry limit). Popup shows them distinctly. | approve.test (4), popup (1) |
| H3 | A card with an unanswered question was approved anyway. | `needs-input`: unsatisfied visible select/radio/checkbox/text/textarea/ARIA/`aria-required` hold the card (once-per-card log); the "More allow options" button is ignored. Does not change the opt-in `holdRisky` rule. | approve.test (14) |
| H4 | The loop would keep visiting an expired account, and clicking nothing. | `needs-login`: sign-in page URL on a muse.ai tab, or the existing `looksLoggedOut` / `lostCredentials` guards, or a switch that rolls back, flags the account (session storage), skips it until the user re-saves it with ↻, and tags it in the popup. Nothing is ever typed or submitted. | integration (4), popup (1) |
| H5 | One stalled account could hold up the loop. | `loop-timeout`: caps on the switch (20 s), dwell (150 s), vanished tab (15 s) and the whole round (45 min); the log names the account and reason. Lock mid-loop ends the loop cleanly. | integration (6) |
| H6 | A page-side message could log any decision string. | `approve:log` decisions are allow-listed; `stale`, `needs-login`, `loop-timeout` are background-only. | integration (1) |

### Remaining gaps after 0.4.0

- **Real browser: unverified.** Selectors for the watchdog controls, the needs-input detection, the 3 s card-gone check, and the
  `/login` / `/sign-in` URL match are guesses from the fixtures and earlier real runs. None was checked against live Muse or a real
  expired session. `tabs.query` returning `url` for host-permitted tabs, and `tabs.onRemoved`, are assumed from docs.
- **Needs-input can over-hold.** Every visible empty field counts, including optional ones (an unticked checkbox). It fails safe (no click)
  but a harmless card may need a manual click. Real Muse cards have not been surveyed for such fields.
- **Watchdog false positives.** Any muse.ai tab with none of the known controls (login page, marketing page, a long-idle background tab
  whose timers are throttled) will raise the warning after 10 minutes while auto-approve is on.
- **Click verification is element-based.** If Muse re-renders the next card into the same DOM node, the check cannot tell and may
  report `stuck` or `confirmed` wrongly. Retries still stop at 3 clicks.
- **needsLogin lives in session storage**, so it is forgotten at browser restart; the next loop re-detects it at the cost of one dwell.
  The login-page check reads the tab URL once, when leaving an account, so a sign-in redirect that happens later is caught a round late.
- **Whole-loop cap has no resume.** When the 45-minute cap ends a round, the next round starts again from the first account, so very
  late accounts in a very long list could be starved. A hung switch is abandoned but the stuck vault operation behind it is not cancelled.
- **Rollback flagged as needs-login.** A switch whose cookies all fail to restore is treated as an expired session; a permissions or
  browser-side failure would be mislabelled the same way.

<!-- labeler check, throwaway -->
