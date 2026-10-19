# Switchyard

Switch between multiple [muse.ai](https://muse.ai) accounts in one browser without waiting for a new
email or SMS code every time, and (optionally) auto-approve Muse's approval cards.

Chrome and Edge, Manifest V3. No servers, no analytics, no network calls of its own.

> **Unofficial.** Switchyard is an independent community project. It is not made, endorsed or
> supported by Meta or Muse. "Muse" and "Meta" are their owners' trademarks. Using several accounts or
> automating clicks may be restricted by the service's terms. That is your call and your risk.

## Features

- **Fast account switching.** Save each logged-in account once, then swap with one click or `Alt+Shift+S`.
- **Fewer one-time codes.** Longer cookie lifetimes, captured token rotation, a logged-out guard. See
  [What this cannot do](#what-this-cannot-do) for the honest limits.
- **Encrypted vault.** PBKDF2-SHA256 (600k) to AES-256-GCM, auto-lock, encrypted export/import.
- **Auto-approve (opt-in).** Clicks Allow on Muse approval cards for the types you choose, loops through
  all saved accounts, logs what it approved. See [Auto-approve](#auto-approve-museai-approval-cards).

## Install

Not on a store yet. Load it unpacked:

1. Download `switchyard-vX.Y.Z.zip` from the [Releases](../../releases) page and unzip it to a folder
   you will keep (Chrome and Edge read the extension from there).
2. Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**.
3. **Load unpacked** and pick the unzipped folder. Pin the extension.

**Updating:** unzip the new release over the same folder, click **Reload** on the extension, then reload
open muse.ai tabs. Saved accounts and settings are kept.

## Use

1. Click the icon and create a vault passphrase (12+ characters, not recoverable. If you forget it you
   must erase the vault and re-save your accounts).
2. Log in to account A on muse.ai the normal way. Keep that tab open.
3. Open Switchyard, name the account, **Save**.
4. **Sign out of browser**, log in as account B, **Save** again.
5. From then on **Switch** swaps accounts and reloads the tab.

| Control | What it does |
| --- | --- |
| Switch | Saves the account you are leaving, clears the browser, restores the chosen one |
| ↻ | Overwrites the **active** account's saved copy with what the browser holds now |
| ✎ / ✕ | Rename / delete |
| Sign out of browser | Clears the live session only; saved accounts stay |
| 🔒 | Lock the vault now (it also locks after idle and when the screen locks) |

## How it works

A "session" is the set of cookies (including `httpOnly` ones, read through `chrome.cookies`) plus
`localStorage` / `sessionStorage` of an open muse.ai tab. Switchyard stores a snapshot per account and puts
it back on demand. It does not bypass verification: the first login of each account still needs its code.

### Staying signed in longer

- **Cookie keep-alive.** Restored cookies get a long expiry (default 180 days, capped at the browser's
  400-day limit); session cookies can optionally be made persistent.
- **Rotated tokens are captured.** Cookie changes on the active account are re-saved (debounced about
  30 s), and the account you leave is saved before every switch.
- **Guards.** If the browser looks signed out, or signed in as someone else, auto-save pauses ("frozen")
  instead of overwriting a good saved copy. The pause survives locking and restarts. Use ↻ to resume.
- **Safe switching.** The intent is saved before the browser is touched; a failed restore rolls back.

### What this cannot do

Cookie expiry is only the browser's side of the deal. The server decides whether a session is still valid
and can end it at any time. When that happens you will be asked for a code once, and the new session is
saved like any other. Keep-alive cannot revive a dead session.

muse.ai signs in through Meta. If switching still asks for a code, open **Settings → Extra sites** and add
`meta.ai` and/or `facebook.com` (this also swaps your Facebook login). **Settings → Show what is stored
right now** lists cookie names, flags and value *lengths* (never values) to help find where the session lives.

## Auto-approve (muse.ai approval cards)

Settings → Auto-approve. **Off until you turn on the master switch.**

- **Approve messages / Approve Marketplace listings / Approve everything.** A card is any block on muse.ai
  with an Allow button next to a Deny button. "Everything" also catches card types not seen before.
- **Hold money, deletes and credentials.** Off by default (every card is approved). Turn it on to leave
  payment, purchase, delete and password cards for you to click.
- **Learn mode.** Logs what it would approve and clicks nothing. Use it first on a new setup.
- **Loop through all saved accounts.** Every N minutes: switch to each account, wait for its approvals to
  clear (or 2.5 minutes), move on. Needs the vault unlocked (raise the auto-lock time). Reloads muse.ai tabs.
- **Switches the right pane to "Approvals" itself** before looking for cards.
- **Log** shows card title, action, task and account, never the recipient or message body. Capped at 200.
  After each click it adds a follow-up line about 3 seconds later: `CONFIRMED` when the card closed, or
  `STUCK` when it was still there after the retries. `APPROVED` alone only means Allow was clicked.
- **Cards that need your input are left alone.** If an approval card has an empty required field (a
  dropdown, radio button, checkbox, text box, or anything marked required), nothing is clicked and the log
  says `NEEDS INPUT`. Any empty visible field counts, so a card with an optional unticked checkbox is also
  left for you. It is approved once the field is filled in. This applies even with "Approve everything".
- **Layout-change warning.** If auto-approve is on and a muse.ai tab shows none of the controls it relies on
  (Approvals tab, pane close button, avatar, review bar, a card) for 10 minutes, the toolbar badge reads
  `WARN`, the log gets a `WARNING` line, and Settings shows a banner. It clears when the controls are seen
  again. It cannot tell a changed Muse page from a muse.ai tab that simply has none of those controls
  (a login or marketing page), so close tabs you do not use for approvals. No page text is stored.
- **Expired accounts in the loop.** If an account lands on a sign-in page (or loses its cookies) while the
  loop is on it, the account gets a **needs re-login** tag, the log gets a `NEEDS RE-LOGIN` line, and the
  loop skips it. Switch to it, sign in yourself, and press ↻ to re-save it; the loop includes it again.
  Switchyard never types or submits anything on a sign-in page. The tag is kept until the browser restarts.
- **The loop cannot get stuck.** A closed tab, a page that never says it is done, or a switch that hangs
  skips that account (log: `LOOP TIMEOUT`) instead of blocking the rest. The whole round is capped at 45
  minutes. Locking the vault stops the loop.
- **Keep awake.** Browsers put inactive tabs to sleep. A button in Settings opens the right browser page
  (Chrome: Memory Saver, Edge: `edge://settings/system/managePerformance`) and copies `muse.ai` so you can
  add it to the "always keep active" list. Extensions cannot edit that list themselves.

**Safety.** Auto-approving removes a human check. Text on an approval card can come from other people (for
example a buyer's message) and could be crafted to trigger an action you would not approve. Clicks are rate
limited, but the hold setting above is the only content guard. Muse's own "Always allow for this
conversation" menu item is deliberately not used because it would stop Muse showing later cards at all.

## Security model

- Saved sessions are encrypted at rest; the KDF parameters are authenticated, so tampering fails closed.
- The derived key lives only in `chrome.storage.session` (memory) and is dropped on lock or idle timeout.
- The popup never receives cookie values, only names and counts.
- Permissions are minimal: `cookies`, `storage`, `scripting`, `alarms`, `idle`, and host access to
  `*.muse.ai`. Meta sites are optional and requested only when you add them. No `<all_urls>`, no `tabs`
  permission, strict CSP, no remote code, no `innerHTML`.
- The content script on muse.ai can only report to the extension; it cannot change settings or switch accounts.
- Anyone who can unlock the vault, or who has an active session, can act as you. Do not use this on a
  machine you do not control.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Limits

- Page storage is only captured for muse.ai tabs that are open when you save or switch. IndexedDB is not.
- Chrome may close the popup when the file picker opens (Import); open `popup.html` in a tab if so.
- Verified in real Chrome/Edge so far: switching, auto-approve of message and listing cards. Not verified:
  every Muse card type, partitioned cookies in unusual setups.

## Contributing

Issues and pull requests are welcome. Nothing is merged without a reviewed PR. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first. If you use an AI coding agent, point it at [AGENTS.md](AGENTS.md).

## Develop

```
npm install       # dev dependency: jsdom (only the DOM tests use it)
npm test          # unit + integration + auto-approve DOM + popup tests (Node 20+)
npm run icons     # regenerate icons/ (stdlib Python)
npm run bump -- minor   # bump version in package.json, manifest.json and CHANGELOG.md
```

Layout: `background.js` (vault, snapshot/restore, loop, upkeep), `content/approve.js` (card watcher),
`popup.*` (UI), `lib/` (pure, unit-tested helpers), `tests/` (fake `chrome.*` harness), `docs/` (gap analysis
and red-team notes).

## License

[MIT](LICENSE)
