// The popup only ever handles names and metadata. Cookie values stay inside
// the background worker and the encrypted vault.

const app = document.getElementById('app');
const OPTIONAL = ['facebook.com', 'meta.ai', 'meta.com'];

/* ---------- tiny DOM helper (text nodes only; never innerHTML) ---------- */
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled') e[k] = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

/** Replace the popup contents. Unlike replaceChildren, flattens arrays and skips null/false. */
function mount(...kids) {
  const nodes = [];
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    nodes.push(k.nodeType ? k : document.createTextNode(String(k)));
  }
  app.replaceChildren(...nodes);
}

async function call(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('No response from the background worker.');
  if (!res.ok) {
    const e = new Error(res.error || 'Something went wrong.');
    e.code = res.code;
    throw e;
  }
  return res;
}

let notice = null;
function setNotice(text, kind = 'ok') { notice = { text, kind }; }
const noticeEl = () => (notice ? h('div', { class: `msg ${notice.kind}` }, notice.text) : null);

async function guarded(fn) {
  try {
    await fn();
  } catch (e) {
    if (e.code === 'LOCKED') { notice = null; return render(); }
    setNotice(e.message, 'err');
    render();
  }
}

function confirmButton(label, armedLabel, onConfirm, cls = 'danger') {
  let armed = false;
  let armedAt = 0;
  let timer;
  const b = h('button', { class: cls }, label);
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      armedAt = Date.now();
      b.textContent = armedLabel;
      b.classList.add('armed');
      timer = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('armed'); }, 3000);
    } else if (Date.now() - armedAt > 600) { // a double-click must not confirm
      clearTimeout(timer);
      onConfirm();
    }
  });
  return b;
}

/** Destructive wipe: the user has to type ERASE. Works even when locked or corrupt. */
function eraseControl() {
  const box = h('input', { type: 'text', placeholder: 'Type ERASE to enable', autocomplete: 'off' });
  const btn = h('button', {
    class: 'danger wide', disabled: true,
    onclick: () => guarded(async () => { await call('wipe'); notice = null; view = 'main'; await render(); })
  }, 'Erase vault and all saved accounts');
  box.addEventListener('input', () => { btn.disabled = box.value !== 'ERASE'; });
  return h('div', {}, box, btn);
}

const ago = (t) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 48) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
};

/* ---------------------------- views ---------------------------- */

let view = 'main';
let state = null;
let importDraft = null; // { text, pass, preview } while waiting for confirmation

async function render() {
  try {
    state = await call('status');
  } catch (e) {
    mount(h('div', { class: 'msg err' }, e.message));
    return;
  }
  if (state.state === 'nosetup') return renderSetup();
  if (state.state === 'corrupt') return renderCorrupt();
  if (state.state === 'locked') return renderLocked();
  if (view === 'settings') return renderSettings();
  return renderMain();
}

function renderSetup() {
  const p1 = h('input', { type: 'password', placeholder: 'Passphrase (12+ characters)', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', placeholder: 'Repeat passphrase', autocomplete: 'new-password' });
  const go = async () => {
    if (p1.value !== p2.value) { setNotice('Passphrases do not match.', 'err'); return render(); }
    await guarded(async () => { await call('setup', { pass: p1.value }); notice = null; await render(); });
  };
  p2.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  mount(
    h('header', {}, h('h1', {}, 'Switchyard')),
    h('p', {}, 'Create a passphrase to encrypt your saved sessions. Use 12+ characters, ideally four unrelated words. It is never stored and cannot be recovered. If you lose it, the vault is gone.'),
    p1, p2,
    h('button', { class: 'primary wide', onclick: go }, 'Create vault'),
    noticeEl()
  );
  p1.focus();
}

function renderLocked() {
  const p = h('input', { type: 'password', placeholder: 'Passphrase', autocomplete: 'current-password' });
  const go = () => guarded(async () => { await call('unlock', { pass: p.value }); notice = null; view = 'main'; await render(); });
  p.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  mount(
    h('header', {}, h('h1', {}, 'Switchyard'), h('span', {}, 'Locked')),
    p,
    h('button', { class: 'primary wide', onclick: go }, 'Unlock'),
    noticeEl(),
    h('h2', {}, 'Forgot the passphrase?'),
    h('p', { class: 'small' }, 'There is no recovery. You can erase the vault and start over; sign in to your accounts again afterwards.'),
    eraseControl()
  );
  p.focus();
}

function renderCorrupt() {
  mount(
    h('header', {}, h('h1', {}, 'Switchyard')),
    h('div', { class: 'msg err' }, state.message),
    state.code === 'ROLLBACK'
      ? h('p', {}, 'If you restored a backup on purpose, lock and unlock to accept the older vault. Otherwise treat this as tampering: erase the vault and sign out of muse.ai everywhere.')
      : h('p', {}, 'The vault cannot be read. If you have an encrypted export, erase this vault, set up again, and import it.'),
    h('button', { class: 'wide', onclick: () => guarded(async () => { await call('lock'); notice = null; await render(); }) }, 'Lock (then unlock again)'),
    h('h2', {}, 'Erase'),
    eraseControl()
  );
}

function profileCard(p, active) {
  const nameBox = h('div', { class: 'name' },
    h('b', {}, p.name, active ? h('span', { class: 'badge' }, 'active') : null, p.needsLogin ? h('span', { class: 'badge relogin' }, 'needs re-login') : null),
    h('span', {}, `saved ${ago(p.updated)} · ${p.cookieCount} cookies`),
    p.needsLogin ? h('span', { class: 'warn' }, 'Its session expired, so the account loop skips it. Switch to it, sign in, then press ↻ to re-save.') : null,
    p.warn ? h('span', { class: 'warn' }, p.warn) : null
  );

  const rename = () => {
    const input = h('input', { type: 'text', value: p.name, maxlength: 60 });
    const save = () => guarded(async () => { await call('rename', { id: p.id, name: input.value }); await render(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') render(); });
    nameBox.replaceChildren(input);
    input.focus();
    input.select();
  };

  return h('div', { class: `card${active ? ' active' : ''}` },
    nameBox,
    h('button', {
      class: 'primary', disabled: active,
      onclick: () => guarded(async () => {
        const r = await call('switch', { id: p.id });
        if (r.rolledBack) setNotice('That saved session could not be restored (expired?). Your previous session was put back. Sign in again and press ↻ to re-save it.', 'err');
        else setNotice(r.failed ? `Switched (${r.failed} cookie(s) could not be restored).` : 'Switched.');
        await render();
      })
    }, 'Switch'),
    h('button', {
      class: 'icon', title: 'Overwrite this saved copy with what the browser has now', 'aria-label': 'Refresh saved copy',
      onclick: () => guarded(async () => { await call('refresh', { id: p.id }); setNotice('Saved copy refreshed.'); await render(); })
    }, '↻'),
    h('button', { class: 'icon', title: 'Rename', 'aria-label': 'Rename account', onclick: rename }, '✎'),
    confirmButton('✕', '?', () => guarded(async () => { await call('remove', { id: p.id }); setNotice('Removed.'); await render(); }))
  );
}

function renderMain() {
  const name = h('input', { type: 'text', placeholder: 'Name for the account that is signed in now', maxlength: 60 });
  const save = () => guarded(async () => {
    await call('saveCurrent', { name: name.value });
    setNotice('Saved.');
    await render();
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

  const cards = state.profiles.length
    ? state.profiles.map((p) => profileCard(p, p.id === state.activeId))
    : [h('p', {}, 'No saved accounts yet. Sign in to muse.ai, then save it below.'),
       h('button', { class: 'wide', onclick: () => chrome.tabs.create({ url: 'https://muse.ai/' }) }, 'Open muse.ai')];

  const frozen = state.frozen
    ? h('div', { class: 'msg err' },
        'Auto-save is paused: cookies were removed in the browser (a sign-out or a login outside Switchyard). ',
        state.activeId ? 'If this browser is still signed in as the active account, press ↻ on it to resume. Otherwise save it as a new account or switch.' : '')
    : null;

  mount(
    h('header', {},
      h('h1', {}, 'Switchyard'),
      h('button', { class: 'icon', title: 'Settings', 'aria-label': 'Settings', onclick: () => { view = 'settings'; notice = null; render(); } }, '⚙'),
      h('button', { class: 'icon', title: 'Lock', 'aria-label': 'Lock vault', onclick: () => guarded(async () => { await call('lock'); notice = null; await render(); }) }, '🔒')
    ),
    frozen,
    h('h2', {}, 'Accounts'),
    cards,
    h('h2', {}, 'Save current session'),
    h('div', { class: 'row' }, name, h('button', { class: 'primary', onclick: save }, 'Save')),
    h('p', { class: 'small' }, 'Keep a muse.ai tab open when saving so page storage is captured too.'),
    h('h2', {}, 'Add another account'),
    h('p', { class: 'small' }, 'Sign out here (saved accounts are not touched), then log in as the new account and save it.'),
    confirmButton('Sign out of browser', 'Click again to sign out', () => guarded(async () => {
      await call('signOut');
      setNotice('Signed out in the browser. Log in to the next account.');
      await render();
    }), 'wide danger'),
    noticeEl()
  );
}


/* ---------- auto-approve section (loads its own state, saves on every change) ---------- */
function approveSection() {
  const box = h('div', {});
  const logBox = h('div', { class: 'log', hidden: true });
  const keepNote = h('p', { class: 'small', hidden: true });
  let a = null;
  let stale = false;

  const save = async (patch) => {
    try {
      const r = await call('setApprove', { approve: { ...a, ...patch } });
      a = r.approve;
      draw();
    } catch (e) { setNotice(e.message, 'err'); render(); }
  };
  const check = (key, title, hint, extra = {}) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: a[key], disabled: extra.disabled, onchange: (e) => save({ [key]: e.target.checked }) }),
    h('div', {}, title, hint ? h('small', {}, hint) : null));

  // How each decision reads in the log. Unknown values (the log is stored data) fall back to a neutral style.
  const DECISIONS = {
    approved: 'APPROVED (clicked)', retry: 'RETRY', confirmed: 'CONFIRMED (card closed)', stuck: 'STUCK (card did not close)',
    skipped: 'SKIPPED', held: 'HELD', learn: 'LEARN', 'rate-limited': 'RATE-LIMITED', 'needs-input': 'NEEDS INPUT (left for you)',
    stale: 'WARNING', 'needs-login': 'NEEDS RE-LOGIN', 'loop-timeout': 'LOOP TIMEOUT'
  };
  const showLog = () => guarded(async () => {
    const r = await call('approveLog');
    const when = (t) => new Date(t).toLocaleString();
    const line = (e) => {
      const known = Object.prototype.hasOwnProperty.call(DECISIONS, e.decision);
      return h('div', { class: `logline d-${known ? e.decision : 'other'}` },
        `${when(e.t)}  ${known ? DECISIONS[e.decision] : String(e.decision).toUpperCase()}  ${e.category ? '[' + e.category + '] ' : ''}${e.title}${e.task ? '  (' + e.task + ')' : ''}${e.account ? '  as ' + e.account : ''}`);
    };
    logBox.replaceChildren(...(r.log.length ? r.log.map(line) : ['Nothing logged yet.']));
    logBox.hidden = false;
  });

  function draw() {
    const off = !a.enabled;
    box.replaceChildren(...[
      stale ? h('div', { class: 'msg err' }, 'Warning: Muse’s page layout may have changed; auto-approve could not find its controls on an open muse.ai tab. Check that tab, or reload it. This clears itself once the controls are seen again.') : null,
      check('enabled', 'Auto-approve is on', 'Master switch. While off, nothing is clicked. Works on muse.ai tabs only.'),
      check('all', 'Approve everything', 'Clicks Allow on any approval card, including types Switchyard has not seen before.', { disabled: off }),
      check('messages', 'Approve messages', 'Cards that send a Messenger / chat message (for example your Marketplace auto-replies).', { disabled: off || a.all }),
      check('listings', 'Approve Marketplace listings', 'Cards that publish or renew a listing.', { disabled: off || a.all }),
      check('holdRisky', 'Hold money, deletes and credentials for me', 'Off by default: every card is approved. Turn on to leave cards about payments, purchases, deleting things or passwords for you to click.', { disabled: off }),
      check('learn', 'Learn mode', 'Logs what it would approve and clicks nothing. Use it to check a new card type first.', { disabled: off }),
      check('loop', 'Loop through all saved accounts', 'Every few minutes: switch to each account, clear its approvals, move to the next. Reloads muse.ai tabs and needs the vault unlocked.', { disabled: off }),
      h('div', { class: 'field' }, h('span', {}, 'Loop every (minutes)'),
        h('input', { type: 'number', min: 2, max: 240, value: a.loopMinutes, disabled: off || !a.loop, onchange: (e) => save({ loopMinutes: Number(e.target.value) }) })),
      h('p', { class: 'small' }, 'Approving removes a safety check. Approval cards can contain text that came from other people, such as a buyer’s message. The hold setting above is the only guard against that.'),
      h('p', { class: 'small' }, 'The browser may put an inactive muse.ai tab to sleep (Chrome: Memory Saver, Edge: sleeping tabs), which stops auto-approve. Add muse.ai to its “keep active / never sleep” list. Extensions cannot edit that list, so this button opens the page and copies the site name for you to paste after clicking Add.'),
      h('button', { class: 'wide', onclick: async () => {
        try { await navigator.clipboard.writeText('muse.ai'); } catch { /* clipboard blocked: the name is shown below */ }
        const edge = /\bEdg\//.test(navigator.userAgent);
        try { await chrome.tabs.create({ url: edge ? 'edge://settings/system/managePerformance' : 'chrome://settings/performance' }); } catch { /* ignore */ }
        keepNote.textContent = edge
          ? 'Copied “muse.ai”. On the page that opened, find “Always keep these sites active”, click Add site, paste muse.ai, then Add.'
          : 'Copied “muse.ai”. On the page that opened: under “Always keep these sites active” click Add, paste muse.ai, then Add.';
        keepNote.hidden = false;
      } }, 'Keep muse.ai tabs awake…'),
      keepNote,
      h('button', { class: 'wide', onclick: showLog }, 'Show what was approved'),
      h('button', { class: 'wide', onclick: () => guarded(async () => { await call('clearApproveLog'); logBox.hidden = true; }) }, 'Clear the log'),
      logBox
    ]);
  }

  call('getApprove').then((r) => { a = r.approve; stale = !!r.stale; draw(); }).catch((e) => { box.textContent = e.message; });
  return box;
}

function renderSettings() {
  const s = state.settings;
  const keep = h('input', { type: 'number', min: 0, max: 400, value: s.keepAliveDays });
  const persist = h('input', { type: 'checkbox', checked: s.persistSession });
  const sync = h('input', { type: 'checkbox', checked: s.autoSync });
  const reload = h('input', { type: 'checkbox', checked: s.reloadAfterSwitch });
  const clearLock = h('input', { type: 'checkbox', checked: s.clearOnLock });
  const lockMin = h('input', { type: 'number', min: 1, max: 1440, value: s.autoLockMinutes });

  const saveAll = () => guarded(async () => {
    await call('setSettings', {
      settings: {
        ...s,
        keepAliveDays: Number(keep.value), persistSession: persist.checked,
        autoSync: sync.checked, reloadAfterSwitch: reload.checked, clearOnLock: clearLock.checked,
        autoLockMinutes: Number(lockMin.value)
      }
    });
    setNotice('Settings saved.');
    await render();
  });

  const extra = s.domains.filter((d) => OPTIONAL.includes(d));
  const chips = h('div', { class: 'chips' }, extra.map((d) =>
    h('span', { class: 'chip' }, d, h('button', {
      title: 'Stop including this site',
      onclick: () => guarded(async () => {
        await call('setSettings', { settings: { ...s, domains: s.domains.filter((x) => x !== d) } });
        await render();
      })
    }, '×'))
  ));
  const addable = OPTIONAL.filter((d) => !s.domains.includes(d));
  const addRow = h('div', { class: 'chips' }, addable.map((d) =>
    h('button', {
      // permissions.request must run directly inside the click handler
      onclick: async () => {
        try {
          const granted = await chrome.permissions.request({ origins: [`https://*.${d}/*`] });
          if (!granted) { setNotice('Permission was not granted.', 'err'); return render(); }
          await call('setSettings', { settings: { ...s, domains: [...s.domains, d] } });
          setNotice(`${d} cookies are now included.`);
          render();
        } catch (e) { setNotice(e.message, 'err'); render(); }
      }
    }, `+ ${d}`)
  ));

  /* export / import */
  const exportCurrent = h('input', { type: 'password', placeholder: 'Your current vault passphrase', autocomplete: 'current-password' });
  const exportPass = h('input', { type: 'password', placeholder: 'New passphrase for the export file (12+)', autocomplete: 'new-password' });
  const exportRepeat = h('input', { type: 'password', placeholder: 'Repeat the export passphrase', autocomplete: 'new-password' });
  const doExport = () => guarded(async () => {
    const r = await call('exportVault', { pass: exportPass.value, repeat: exportRepeat.value, currentPass: exportCurrent.value });
    const url = URL.createObjectURL(new Blob([r.text], { type: 'application/json' }));
    const a = h('a', { href: url, download: `switchyard-${new Date().toISOString().slice(0, 10)}.enc.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    exportPass.value = '';
    exportRepeat.value = '';
    exportCurrent.value = '';
    setNotice('Encrypted export downloaded.');
    render();
  });
  const importPass = h('input', { type: 'password', placeholder: 'Passphrase of the file you are importing', autocomplete: 'off' });
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  const doPreview = () => guarded(async () => {
    const f = file.files && file.files[0];
    if (!f) throw new Error('Choose a file first.');
    if (f.size > 20_000_000) throw new Error('That file is too large to be a Switchyard export.');
    const text = await f.text();
    const r = await call('importVault', { text, pass: importPass.value });
    importDraft = { text, pass: importPass.value, preview: r.preview, skipped: r.skipped };
    render();
  });
  const doConfirmImport = () => guarded(async () => {
    const d = importDraft;
    importDraft = null;
    const r = await call('importVault', { text: d.text, pass: d.pass, confirm: true });
    setNotice(`Imported ${r.imported} account(s)${r.skipped ? `, skipped ${r.skipped} invalid` : ''}. Review them before switching.`);
    await render();
  });
  const draftBox = importDraft
    ? h('div', { class: 'msg' },
        h('b', {}, 'Review before importing'),
        h('p', { class: 'small' }, 'Switching to an imported account signs this browser in as whoever that file says. Only import files you made yourself.'),
        importDraft.preview.length
          ? importDraft.preview.map((p) => h('div', { class: 'small' }, `${p.name}: ${p.cookieCount} cookies (${p.domains.join(', ')})`))
          : h('p', { class: 'small' }, 'Nothing valid in that file.'),
        h('div', { class: 'row' },
          importDraft.preview.length ? h('button', { class: 'primary', onclick: doConfirmImport }, 'Import these') : null,
          h('button', { onclick: () => { importDraft = null; render(); } }, 'Cancel')))
    : null;

  /* change passphrase */
  const oldP = h('input', { type: 'password', placeholder: 'Current passphrase', autocomplete: 'current-password' });
  const newP = h('input', { type: 'password', placeholder: 'New passphrase (12+ characters)', autocomplete: 'new-password' });

  const out = h('pre', { hidden: true });
  const inspect = () => guarded(async () => {
    const r = await call('inspect');
    const lines = r.cookies.map((c) =>
      `${c.name}  ${c.domain}${c.path}  ${c.session ? 'session' : 'exp ' + c.expires}  len=${c.valueLen}` +
      `${c.secure ? ' secure' : ''}${c.httpOnly ? ' httpOnly' : ''}${c.hostOnly ? ' hostOnly' : ''}${c.partitioned ? ' partitioned' : ''}`);
    for (const s2 of r.storage) {
      lines.push('', `[${s2.origin}]`, `localStorage: ${s2.local.join(', ') || '(none)'}`, `sessionStorage: ${s2.session.join(', ') || '(none)'}`);
    }
    out.textContent = lines.join('\n') || 'Nothing found. Open a muse.ai tab and sign in.';
    out.hidden = false;
  });

  mount(
    h('header', {},
      h('button', { class: 'icon', onclick: () => { view = 'main'; notice = null; render(); } }, '←'),
      h('h1', {}, 'Settings')
    ),

    h('h2', {}, 'Auto-approve'),
    approveSection(),

    h('h2', {}, 'Session lifetime'),
    h('div', { class: 'field' }, h('span', {}, 'Keep cookies alive for (days, 0 = off)'), keep),
    h('label', { class: 'check' }, persist, h('div', {}, 'Make session cookies persistent', h('small', {}, 'Otherwise they vanish when the browser closes.'))),
    h('p', { class: 'small' }, 'This only stops the browser from dropping cookies. If the server expires a session, you will still be asked to sign in.'),

    h('h2', {}, 'Behaviour'),
    h('label', { class: 'check' }, sync, h('div', {}, 'Auto-save refreshed tokens', h('small', {}, 'Keeps the active account’s saved copy current when the site rotates its cookies.'))),
    h('label', { class: 'check' }, reload, h('div', {}, 'Reload muse.ai tabs after switching')),
    h('div', { class: 'field' }, h('span', {}, 'Auto-lock after (minutes idle). Also locks when your screen locks.'), lockMin),
    h('label', { class: 'check' }, clearLock, h('div', {}, 'Sign out of muse.ai when the vault locks', h('small', {}, 'The signed-in account otherwise stays in Chrome’s own cookie store, unencrypted.'))),
    h('p', { class: 'small' }, 'Shortcut: Alt+Shift+S cycles to the next account (change it at chrome://extensions/shortcuts).'),
    h('button', { class: 'primary wide', onclick: saveAll }, 'Save settings'),

    h('h2', {}, 'Extra sites'),
    h('p', { class: 'small' }, 'muse.ai signs in through Meta. If switching still asks for a code, include the Meta sites. That also swaps your Facebook login.'),
    chips, addRow,

    h('h2', {}, 'Encrypted backup'),
    exportCurrent, exportPass, exportRepeat,
    h('button', { class: 'wide', onclick: doExport }, 'Export'),
    h('h2', {}, 'Import'),
    file, importPass,
    h('button', { class: 'wide', onclick: doPreview }, 'Preview import'),
    draftBox,

    h('h2', {}, 'Change passphrase'),
    oldP, newP,
    h('button', { class: 'wide', onclick: () => guarded(async () => {
      await call('changePass', { oldPass: oldP.value, newPass: newP.value });
      setNotice('Passphrase changed.');
      await render();
    }) }, 'Change'),

    h('h2', {}, 'Diagnostics'),
    h('button', { class: 'wide', onclick: inspect }, 'Show what is stored right now'),
    out,

    h('h2', {}, 'Danger zone'),
    eraseControl(),
    noticeEl()
  );
}

render();
