# Red team results

Two independent reviewers attacked Switchyard: one on the attack surface (hostile storage, imports,
messaging, crypto), one on logic, races and data integrity. Every finding was reproduced against the
real `background.js` running on a fake `chrome.*` API before it was fixed, and each fix has a regression test.

## Round 1 - attack surface (all fixed)
Quota and hostile storage, popup opened in a tab as a message sender, passphrase-change race, `__proto__`
ids/keys, corrupt and rolled-back vault recovery, export without re-auth, blind import, weak passphrases,
brute-force back-off, vault size leaking account count (4 KB padding), cookie prefix/expiry/partition
handling, double-click on confirm buttons.

## Round 2 - logic and state (fixed)
| Finding | Fix |
|---|---|
| Freeze flag lived in session storage, cleared by lock, missed while locked or with auto-save off | Persisted in `storage.local`; the cookie listener records it even when locked; lock no longer clears it |
| Anonymous downgrade / overwrite-login slipped past the guards | `lostCredentials()` check; other-login heuristic also covers accounts with only 2 credential cookies |
| Keep-alive ran outside the vault queue and could write stale values | Serialised, re-reads the cookie before writing, never resurrects expired cookies |
| Interrupted switch left a half-restored browser that auto-save could copy into an account | Journal: freeze is set before the browser is touched and cleared only on success or clean rollback |
| Auto-save replaced the saved set, so a missing cookie was lost | Merge: live values win, absent cookies are kept, expired ones pruned |
| Switching to the already-active account overwrote newer tokens with the stale snapshot | Syncs and returns `unchanged` unless the browser is signed out |
| Refresh on a non-active card copied the wrong login into it | Refused with `NOT_ACTIVE` |
| Event suppression (15 s / 4 s) hid genuine site rotations | Trailing window cut to 1.5 s |
| Partial restores were silent | Account gets a visible warning with the count |
| `lock` could hang on a stuck tab call and keep the key alive | Key is dropped after 8 s regardless |
| Two parallel `setup` calls | Serialised, second is rejected |
| Debounce restarted on every cookie event (starvation) | Existing alarm is kept |

## Accepted / not fixable here
- Removing an optional site leaves its cookies in saved accounts; they are ignored on restore (out of scope).
- The 8 s lock timeout test is not automated (real timer).
- The server decides session validity; longer cookie expiry cannot prevent a fresh OTP when the server expires the session.

## Needs verification in real Chrome
Everything above is proven against a fake `chrome.*`. Before relying on it, load the folder unpacked and check:
where the muse.ai session actually lives (Settings -> "Show what is stored right now"; enable Meta sites if needed),
the `cause` values on cookie events, page storage when no tab is open, and partitioned cookies.
