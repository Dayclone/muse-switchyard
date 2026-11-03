// Switchyard auto-approve: runs on muse.ai pages. Finds approval cards (a card holding both an
// approve button (Allow, or Send on message cards) and a deny button (Deny, or Don't send)) and clicks
// the approve button when the rules allow it. Message cards show a split button: Send plus a chevron menu.
// Classic script (content scripts cannot be ES modules); wrapped so nothing leaks onto the page.
(() => {
  'use strict';
  if (window.__switchyardApprove) return;
  Object.defineProperty(window, '__switchyardApprove', { value: true });

  const DEFAULTS = {
    enabled: false, // master switch
    all: false, // approve every card (still subject to holdRisky)
    messages: false, // "Send ... message" cards
    listings: false, // Marketplace listing cards
    holdRisky: false, // opt-in: leave payments, deletes, credentials for the user
    learn: false, // log what would happen, click nothing
    alwaysAllow: false, // opt-in: for non-risky message cards pick "Always allow for this conversation" from the Send menu
    maxPerMinute: 12,
    idleSeconds: 20
  };
  const APPROVE_LABELS = ['allow', 'allow once', 'approve', 'yes, allow', 'confirm', 'send'];
  const DENY_LABELS = ['deny', "don't send", 'do not send'];
  const ALWAYS_LABEL = 'always allow for this conversation';
  // Matched against the request title + action line only (never the message body, which is
  // buyer-facing text and would false-positive on words like "price" or "finance").
  const RISKY = /\b(pay|payment|purchase|checkout|buy|order|card|cvv|password|passcode|credential|one-time code|otp|wire|transfer|send money|bank|refund|delete|erase|remove account|cancel (?:subscription|account)|unsubscribe|share (?:my )?(?:contacts|files|calendar|location))\b/i;
  const IS_MESSAGE = /\b(message|messenger|reply|dm|whatsapp|sms|text)\b/i;
  const IS_LISTING = /\b(marketplace|listing|listings|publish|renew)\b/i;

  let cfg = { ...DEFAULTS };
  const clicked = new WeakMap(); // button -> {n, at, reported}
  const recent = []; // timestamps of approvals, for the rate limit
  let lastPending = Date.now();
  let idleSent = false;
  let lastReviewClick = 0;
  // Timings are constants; tests may shorten them through the test hook only.
  const timing = { staleMs: 10 * 60000, staleResendMs: 30 * 60000, verifyMs: 3000, retryLimit: 3, menuWaitMs: 1500, menuPollMs: 150 };
  let lastControls = Date.now(); // last time any of Muse's known controls was visible
  let lastStale = 0;
  let staleSent = false;

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // Lower-cased button text with curly apostrophes folded to straight ones ("Don’t send" -> "don't send").
  const label = (el) => norm(el.textContent).replace(/[\u2018\u2019\u02bc]/g, "'").toLowerCase();
  const visible = (el) => !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  function sanitize(s) {
    const o = s && typeof s === 'object' ? s : {};
    const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    return {
      enabled: o.enabled === true,
      all: o.all === true,
      messages: o.messages === true,
      listings: o.listings === true,
      holdRisky: o.holdRisky === true,
      learn: o.learn === true,
      alwaysAllow: o.alwaysAllow === true,
      maxPerMinute: int(o.maxPerMinute, 1, 120, DEFAULTS.maxPerMinute),
      idleSeconds: int(o.idleSeconds, 5, 300, DEFAULTS.idleSeconds)
    };
  }

  /** Pull title / action / task / category out of an approval card's text. Pure. */
  function classify(text) {
    const lines = String(text || '').split('\n').map(norm).filter(Boolean);
    const title = lines.find((l) => /\?$/.test(l)) || lines[0] || '';
    const ai = lines.findIndex((l) => l.toLowerCase() === 'action');
    const action = ai >= 0 && lines[ai + 1] ? lines[ai + 1] : '';
    const m = /\bfor (?:the )?(?:scheduled task )?[“"]?([^”"?]+?)[”"]?\?$/i.exec(title);
    const head = `${title} ${action}`;
    // Category comes from the action line when there is one; otherwise from the title with the
    // scheduled-task name removed (a task called "Marketplace Auto Replies" must not look like a listing).
    const what = action || (m ? title.replace(m[1], ' ') : title);
    let category = 'other';
    if (IS_LISTING.test(what)) category = 'listings';
    else if (IS_MESSAGE.test(what)) category = 'messages';
    return {
      title: title.slice(0, 160), action: action.slice(0, 80), task: m ? m[1].slice(0, 80) : '',
      category, risky: RISKY.test(head)
    };
  }

  function decide(info, now = Date.now()) {
    while (recent.length && now - recent[0] > 60000) recent.shift();
    if (!cfg.enabled) return 'off';
    if (cfg.holdRisky && info.risky) return 'held';
    const wanted = cfg.all || (info.category === 'messages' && cfg.messages) || (info.category === 'listings' && cfg.listings);
    if (!wanted) return 'skipped'; // left for the user
    if (recent.length >= cfg.maxPerMinute) return 'rate-limited';
    if (cfg.learn) return 'learn';
    return 'approve';
  }

  /** One line per text node: keeps the card's structure (and the Action field) even when details are collapsed. */
  function cardText(el) {
    const out = [];
    const w = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
    for (let n = w.nextNode(); n; n = w.nextNode()) for (const part of String(n.nodeValue).split('\n')) { const t = norm(part); if (t) out.push(t); }
    return out.join('\n');
  }

  const MENU_BTN = /more (?:allow|send) options|(?:allow|send) options|more options/i;
  const PLACEHOLDER = /^(select|choose|pick)\b|^(\u2026|\.\.\.)/i;

  /** Is this required-looking control filled in? Returns null when it does not apply. Pure DOM reads only. */
  function inputSatisfied(e, card) {
    const tag = e.tagName.toLowerCase();
    const role = norm(e.getAttribute('role')).toLowerCase();
    const type = norm(e.getAttribute('type') || (tag === 'input' ? 'text' : '')).toLowerCase();
    const required = e.getAttribute('aria-required') === 'true';
    if (tag === 'select') return e.selectedIndex >= 0 && norm(e.value) !== '';
    if (tag === 'textarea') return norm(e.value) !== '';
    if (tag === 'input') {
      if (type === 'radio') return [...card.querySelectorAll('input[type="radio"]')].some((r) => r.name === e.name && r.checked);
      if (type === 'checkbox') return e.checked;
      if (type === 'text' || required) return norm(e.value) !== '';
      return null; // hidden, button, submit...
    }
    if (role === 'radio') {
      const scope = e.closest('[role="radiogroup"]') || card;
      return [...scope.querySelectorAll('[role="radio"]')].some((r) => r.getAttribute('aria-checked') === 'true');
    }
    if (e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true') return true;
    if (typeof e.value === 'string' && norm(e.value)) return true;
    if (norm(e.getAttribute('aria-valuetext')) || norm(e.getAttribute('data-value'))) return true;
    if (role === 'listbox' || role === 'radiogroup' || role === 'group') return !!e.querySelector('[aria-selected="true"], [aria-checked="true"], input:checked');
    if (role === 'combobox') { const t = norm(e.textContent); return !!t && !PLACEHOLDER.test(t); }
    return false; // aria-required on something we cannot read: hold, do not guess
  }

  /**
   * True when the card holds a visible, enabled, required-looking input that is still empty. Such a card is
   * left for the user: clicking Allow / Send would submit an unanswered question. The split-button chevron ("More allow options")
   * button is not an input. Reads structure and values only; nothing is stored or sent.
   */
  function needsInput(card) {
    for (const e of card.querySelectorAll('select, input, textarea, [role="radio"], [role="combobox"], [role="listbox"], [aria-required="true"]')) {
      const btn = e.closest('button');
      if (MENU_BTN.test(e.getAttribute('aria-label') || '') || (btn && MENU_BTN.test(btn.getAttribute('aria-label') || ''))) continue;
      if (!visible(e) || e.disabled || e.getAttribute('aria-disabled') === 'true') continue;
      if (inputSatisfied(e, card) === false) return true;
    }
    return false;
  }

  /**
   * The split-button chevron next to the approve button: a visible, text-less button that is neither the
   * approve nor the deny button. Searched only in Send's own wrapper, then one level up, and never in an
   * element that holds the question line (that is the card body, which also has the details expander icon). Within each level a menu-like aria-label wins, then
   * aria-haspopup, then a text-less button holding an <svg> (the markup Muse ships today). Tolerant on
   * purpose; the exact markup is Muse's to change.
   */
  function findMenuBtn(el, approve, deny) {
    const ok = (x) => x !== approve && x !== deny && visible(x) && el.contains(x);
    // A scope that already holds the question line is the card body, not the button row: never search there.
    const scopes = [approve.parentElement, approve.parentElement && approve.parentElement.parentElement]
      .filter((s) => s && !/\?$/m.test(cardText(s)));
    for (const scope of scopes) {
      const cands = [...scope.querySelectorAll('button, [role="button"]')].filter(ok);
      const pick = cands.find((x) => MENU_BTN.test(x.getAttribute('aria-label') || '')) ||
        cands.find((x) => /^(menu|true|listbox)$/i.test(x.getAttribute('aria-haspopup') || '')) ||
        cands.find((x) => !norm(x.textContent) && x.querySelector('svg'));
      if (pick) return pick;
    }
    // Last resort: the element right after Send, if it is (or wraps) a text-less icon button.
    const next = approve.nextElementSibling;
    const nb = next && (next.matches('button, [role="button"]') ? next : next.querySelector('button, [role="button"]'));
    return nb && ok(nb) && !norm(nb.textContent) && nb.querySelector('svg') ? nb : null;
  }

  function findCards(root = document) {
    const cards = [];
    for (const b of root.querySelectorAll('button')) {
      if (!APPROVE_LABELS.includes(label(b)) || !visible(b)) continue;
      let el = b.parentElement;
      let deny = null;
      for (let i = 0; el && i < 10; i++, el = el.parentElement) {
        deny = [...el.querySelectorAll('button')].find((x) => DENY_LABELS.includes(label(x)));
        if (deny) break;
      }
      if (!deny) continue;
      // The button row is usually a sibling of the question and details: climb until the question
      // ("...?") is inside, but never into an ancestor that holds another card's approve button.
      const approveCount = (n) => [...n.querySelectorAll('button')].filter((x) => APPROVE_LABELS.includes(label(x))).length;
      let text = cardText(el);
      for (let i = 0; i < 8 && !/\?$/m.test(text) && el.parentElement && approveCount(el.parentElement) <= 1; i++) {
        el = el.parentElement;
        text = cardText(el);
      }
      cards.push({ approve: b, deny, el, text, menu: findMenuBtn(el, b, deny) });
    }
    return cards;
  }

  function send(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* extension reloaded */ }
  }
  const log = (entry) => send({ type: 'approve:log', entry: { t: Date.now(), ...entry } });

  let lastTabClick = 0;
  /**
   * Muse opens its right pane on "Activity"; approval cards only exist while "Approvals" is selected.
   * Check first, every scan, and switch if needed (a view change only, rate limited).
   */
  function ensureApprovalsTab() {
    const tab = document.querySelector('button[aria-label="Approvals"]');
    if (!tab || tab.getAttribute('aria-pressed') === 'true') return false;
    if (Date.now() - lastTabClick < 1500) return true; // just clicked: give the pane time to render
    lastTabClick = Date.now();
    tab.click();
    return true;
  }

  /** A card disappearing is the proof that Allow / Send worked; one that survives every retry is reported as stuck. */
  function verifyLater(c, info, n) {
    setTimeout(() => {
      if (!visible(c.el)) log({ decision: 'confirmed', ...info });
      else if (n >= timing.retryLimit) log({ decision: 'stuck', ...info });
    }, timing.verifyMs);
  }

  /**
   * Markup-drift watchdog: if none of the controls this script depends on has been visible for staleMs
   * while auto-approve is on, tell the background once (rate limited). Carries no page text.
   */
  function watchdog() {
    const now = Date.now();
    if (controlsVisible()) {
      lastControls = now;
      if (staleSent) { staleSent = false; send({ type: 'approve:controls' }); }
      return;
    }
    if (now - lastControls >= timing.staleMs && now - lastStale >= timing.staleResendMs) {
      lastStale = now;
      staleSent = true;
      send({ type: 'approve:stale' });
    }
  }

  /** A visible menu entry reading "Always allow for this conversation", anywhere in the document (menus are portaled). */
  function findAlwaysItem() {
    const sel = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], button, [role="button"]';
    return [...document.querySelectorAll(sel)].find((e) => visible(e) && label(e) === ALWAYS_LABEL) || null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const acting = new WeakSet(); // approve buttons with an always-allow run in flight

  /**
   * Opt-in path for non-risky message cards: open the Send menu and pick "Always allow for this conversation".
   * If the entry never shows up, close the menu and fall back to a plain click on the approve button.
   * Logs 'always-allowed' or the normal 'approved' / 'retry'. Never reads or logs message text.
   */
  async function alwaysAllowRun(c, info, n) {
    if (acting.has(c.approve)) return;
    acting.add(c.approve);
    try {
      c.menu.click();
      const polls = Math.max(1, Math.ceil(timing.menuWaitMs / Math.max(1, timing.menuPollMs)));
      let item = findAlwaysItem();
      for (let i = 0; !item && i < polls; i++) { await sleep(timing.menuPollMs); item = findAlwaysItem(); }
      if (item) {
        item.click();
        log({ decision: 'always-allowed', ...info });
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        if (c.menu.getAttribute('aria-expanded') === 'true') c.menu.click();
        c.approve.click();
        log({ decision: n > 1 ? 'retry' : 'approved', ...info });
      }
      verifyLater(c, info, n);
    } finally { acting.delete(c.approve); }
  }

  function scan() {
    if (!cfg.enabled) return;
    watchdog();
    if (ensureApprovalsTab()) { soon(); return; }
    const cards = findCards();
    if (cards.length) { lastPending = Date.now(); idleSent = false; }
    for (const c of cards) {
      const info = classify(c.text);
      let verdict = decide(info);
      if ((verdict === 'approve' || verdict === 'learn') && needsInput(c.el)) verdict = 'needs-input';
      const seen = clicked.get(c.approve) || { n: 0, at: 0, reported: false };
      if (verdict === 'approve') {
        if (seen.n >= timing.retryLimit || Date.now() - seen.at < 4000) continue;
        recent.push(Date.now());
        clicked.set(c.approve, { n: seen.n + 1, at: Date.now(), reported: true });
        if (cfg.alwaysAllow && info.category === 'messages' && !info.risky && c.menu) {
          if (acting.has(c.approve)) continue;
          alwaysAllowRun(c, info, seen.n + 1).catch(() => {});
          continue;
        }
        c.approve.click();
        log({ decision: seen.n ? 'retry' : 'approved', ...info });
        verifyLater(c, info, seen.n + 1);
      } else if (!seen.reported) {
        clicked.set(c.approve, { ...seen, reported: true });
        log({ decision: verdict, ...info });
      }
    }
    if (!cards.length && !openReviewBar()) openPanel();
  }

  let lastPanelClick = 0;
  /**
   * In the chat-only view the right pane is closed. Muse's avatar at the top centre opens it.
   * Found by shape and position, never by its name (the name is user-editable). Only clicked while
   * no pane controls exist, so an open pane is never toggled shut.
   */
  function findAvatar() {
    return [...document.querySelectorAll('[role="button"]')].filter((e) => {
      if (!visible(e) || !/\baspect-square\b/.test(e.className) || !/\brounded-full\b/.test(e.className)) return false;
      const r = e.getBoundingClientRect();
      return r.top >= 0 && r.top < 100 && r.width >= 32 && r.width <= 96 && Math.abs(r.width - r.height) <= 2;
    }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
  }

  function openPanel() {
    if (document.querySelector('button[aria-label="Approvals"], button[data-pel-click="status_close_panel"]')) return false;
    if (Date.now() - lastPanelClick < 4000) return false;
    const avatar = findAvatar();
    if (!avatar) return false;
    lastPanelClick = Date.now();
    avatar.click();
    return true;
  }

  /** The pane may sit on another tab; the "A task needs review -> Review" bar opens the approvals. */
  function findReviewBtn() {
    // Muse tags this button; fall back to text + a nearby "needs review" label if the tag ever changes.
    const nearLabel = (b) => { let e = b; for (let i = 0; i < 3 && e.parentElement; i++) { e = e.parentElement; if (/needs review/i.test(e.textContent || '')) return true; } return false; };
    return [...document.querySelectorAll('button')].find((b) => visible(b) &&
      (b.getAttribute('data-pel-click') === 'chat_background_approval_review' || (norm(b.textContent) === 'Review' && nearLabel(b))));
  }

  function openReviewBar() {
    if (Date.now() - lastReviewClick < 20000) return true; // opened a moment ago: let the pane render
    const btn = findReviewBtn();
    if (btn) { lastReviewClick = Date.now(); btn.click(); return true; }
    return false;
  }

  /** Any of the controls the watcher relies on: Approvals tab, pane close button, avatar, review bar, or a card. */
  function controlsVisible() {
    const seen = (sel) => [...document.querySelectorAll(sel)].some(visible);
    return seen('button[aria-label="Approvals"]') || seen('button[data-pel-click="status_close_panel"]') ||
      !!findAvatar() || !!findReviewBtn() || findCards().length > 0;
  }

  function idleCheck() {
    if (!cfg.enabled || idleSent) return;
    if (Date.now() - lastPending >= cfg.idleSeconds * 1000) { idleSent = true; send({ type: 'approve:idle' }); }
  }

  function applyCfg(next) {
    // The watchdog counts only time spent with auto-approve on: restart it when the switch turns on.
    if (!cfg.enabled && next.enabled) { lastControls = Date.now(); staleSent = false; }
    cfg = next; lastPending = Date.now(); idleSent = false;
  }

  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(scan, 300); };

  function start() {
    new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true });
    // Re-read the settings on every tick instead of trusting a change event: a missed event (or an
    // extension reload) must never leave this tab acting on stale settings.
    const tick = setInterval(async () => {
      try {
        const { approve } = await chrome.storage.local.get('approve');
        const next = sanitize(approve);
        if (JSON.stringify(next) !== JSON.stringify(cfg)) { applyCfg(next); }
      } catch {
        clearInterval(tick); // extension was reloaded or removed: this copy is orphaned, a tab reload gives a fresh one
        return;
      }
      scan();
      idleCheck();
    }, 2000);
    soon();
  }

  try {
    chrome.storage.local.get('approve').then(({ approve }) => { cfg = sanitize(approve); soon(); }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.approve) { applyCfg(sanitize(ch.approve.newValue)); soon(); }
    });
  } catch { /* ignore */ }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  if (window.__SY_TEST__) window.__SY_TEST__.approve = { classify, decide, findCards, sanitize, scan, ensureApprovalsTab, openPanel, needsInput, controlsVisible, findAlwaysItem,
    setCfg: (c) => applyCfg(sanitize(c)), setTiming: (t) => Object.assign(timing, t) };
})();
