/*
 * PageProof – suggestions.js
 * The floating correction card. Rendered inside a closed shadow root attached
 * to a single host element on <html>, so page CSS cannot leak in and our CSS
 * cannot leak out. All page-derived strings are inserted with textContent.
 */
(function (root) {
  'use strict';
  const PP = (root.PageProof = root.PageProof || {});
  if (PP.suggestions) return;

  const HOST_ID = 'pageproof-root';
  let host = null, shadow = null, card = null;
  let current = null;        // { err, pinned, opts, selected }
  let handlers = {};
  let fontsLoaded = false;

  const CAT_COLORS = { spelling: '#e5484d', grammar: '#e5484d', punctuation: '#e5484d', style: '#7c5cff' };

  function loadFonts() {
    if (fontsLoaded) return;
    fontsLoaded = true;
    try {
      const weights = { 400: 'inter-latin-400-normal', 500: 'inter-latin-500-normal', 600: 'inter-latin-600-normal', 700: 'inter-latin-700-normal' };
      for (const [w, file] of Object.entries(weights)) {
        const face = new FontFace('PageProof Inter', `url(${chrome.runtime.getURL('fonts/' + file + '.woff2')}) format("woff2")`, { weight: w, style: 'normal', display: 'swap' });
        face.load().then((f) => document.fonts.add(f)).catch(() => {});
      }
    } catch (_) { /* fall back to system fonts */ }
  }

  const CSS_TEXT = `
    :host { all: initial; }
    .card {
      position: fixed; z-index: 2147483647; box-sizing: border-box;
      width: 344px; max-width: calc(100vw - 16px);
      background: #ffffff; color: #1c1530; border-radius: 14px;
      border: 1px solid rgba(76, 29, 149, 0.10);
      box-shadow: 0 18px 48px -12px rgba(36, 18, 77, 0.35), 0 4px 12px rgba(36, 18, 77, 0.08);
      font: 400 13px/1.45 "PageProof Inter", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      padding: 14px 14px 12px; opacity: 0; transform: translateY(4px);
      transition: opacity .12s ease, transform .12s ease; pointer-events: auto;
      -webkit-font-smoothing: antialiased; text-align: left; letter-spacing: normal;
    }
    .card.open { opacity: 1; transform: none; }
    .card * { box-sizing: border-box; font-family: inherit; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .label { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #4c1d95; flex: 1; }
    .close { all: unset; cursor: pointer; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 6px; color: #6b6480; font-size: 16px; line-height: 1; }
    .close:hover { background: #f3f0fa; color: #1c1530; }
    .msg { color: #3b3452; margin: 0 0 10px; font-size: 13px; }
    .row { display: flex; align-items: baseline; gap: 8px; margin: 4px 0; }
    .key { flex: none; width: 74px; font-size: 11px; font-weight: 600; color: #8a83a0; text-transform: uppercase; letter-spacing: .05em; }
    .wrong { color: #c62a2f; text-decoration: line-through; text-decoration-color: rgba(198, 42, 47, .55); word-break: break-word; font-weight: 500; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { all: unset; cursor: pointer; padding: 3px 9px; border-radius: 999px; background: #f3f0fa; color: #3b1a86; font-weight: 600; font-size: 12.5px; border: 1px solid transparent; word-break: break-word; }
    .chip:hover { background: #ebe5fb; }
    .chip.sel { background: #5b21b6; color: #fff; }
    .chip:focus-visible, .btn:focus-visible, .close:focus-visible, .link:focus-visible { outline: 2px solid #7c3aed; outline-offset: 2px; }
    .none { color: #8a83a0; font-style: italic; }
    .actions { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
    .btn { all: unset; cursor: pointer; padding: 7px 11px; border-radius: 8px; font-weight: 600; font-size: 12.5px; border: 1px solid #e4dff0; color: #2d2445; background: #fff; }
    .btn:hover { background: #f7f5fc; }
    .btn.primary { background: #5b21b6; color: #fff; border-color: #5b21b6; }
    .btn.primary:hover { background: #4c1d95; }
    .btn[disabled] { opacity: .45; cursor: not-allowed; }
    .note { margin-top: 10px; font-size: 11px; color: #8a83a0; }
    .rule { font-size: 11px; color: #a39cb8; margin-top: 2px; }
    .toast { margin-top: 8px; font-size: 12px; color: #1a7f4b; font-weight: 600; }
  `;

  function ensureHost() {
    if (host && host.isConnected) return;
    loadFonts();
    host = document.createElement('pageproof-root');
    host.id = HOST_ID;
    host.setAttribute('style', 'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;');
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    shadow.appendChild(style);
    card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'PageProof suggestion');
    card.hidden = true;
    shadow.appendChild(card);
    card.addEventListener('pointerenter', () => handlers.onCardEnter && handlers.onCardEnter());
    card.addEventListener('pointerleave', () => handlers.onCardLeave && handlers.onCardLeave());
    card.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    (document.documentElement || document.body).appendChild(host);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render() {
    const { err, opts } = current;
    card.textContent = '';

    const head = el('div', 'head');
    const dot = el('span', 'dot');
    dot.style.background = CAT_COLORS[err.category] || '#e5484d';
    head.append(dot, el('span', 'label', err.label));
    const close = el('button', 'close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => hide());
    head.append(close);
    card.append(head);

    if (err.message) card.append(el('p', 'msg', err.message));

    const wrongRow = el('div', 'row');
    wrongRow.append(el('span', 'key', 'Incorrect'), el('span', 'wrong', err.display || err.text));
    card.append(wrongRow);

    const sugRow = el('div', 'row');
    sugRow.append(el('span', 'key', 'Suggested'));
    const chips = el('div', 'chips');
    if (err.replacements.length) {
      err.replacements.slice(0, 5).forEach((rep, i) => {
        const chip = el('button', 'chip' + (i === current.selected ? ' sel' : ''), rep === '' ? '(remove)' : rep);
        chip.addEventListener('click', () => { current.selected = i; render(); });
        chips.append(chip);
      });
    } else {
      chips.append(el('span', 'none', 'No suggestion available'));
    }
    sugRow.append(chips);
    card.append(sugRow);

    const actions = el('div', 'actions');
    const hasRep = err.replacements.length > 0;
    const canApply = hasRep && opts.canApply;
    if (hasRep && !opts.canApply && opts.reason === 'multi-node') {
      const copy = el('button', 'btn primary', 'Copy fix');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(err.replacements[current.selected]);
          flash('Copied to clipboard');
        } catch (_) { flash('Copy blocked by this page'); }
      });
      actions.append(copy);
    } else {
      const apply = el('button', 'btn primary', 'Apply correction');
      if (!canApply) apply.disabled = true;
      apply.addEventListener('click', () => {
        if (!canApply) return;
        handlers.onApply && handlers.onApply(err, err.replacements[current.selected]);
      });
      actions.append(apply);
    }

    const ignore = el('button', 'btn', 'Ignore');
    ignore.addEventListener('click', () => handlers.onIgnore && handlers.onIgnore(err));
    actions.append(ignore);

    if (err.category === 'spelling') {
      const dict = el('button', 'btn', 'Add to dictionary');
      dict.addEventListener('click', () => handlers.onAddDictionary && handlers.onAddDictionary(err));
      actions.append(dict);
    } else if (err.ruleId) {
      const rule = el('button', 'btn', 'Ignore rule');
      rule.title = 'Never show this type of suggestion again';
      rule.addEventListener('click', () => handlers.onIgnoreRule && handlers.onIgnoreRule(err));
      actions.append(rule);
    }
    card.append(actions);

    let note = '';
    if (opts.reason === 'editor') note = `${opts.editorName || 'Editor'} detected – read-only mode. Fix this in the editor itself.`;
    else if (opts.reason === 'multi-node') note = 'This text spans several elements, so it can’t be replaced safely. Copy the fix instead.';
    else if (canApply) note = 'Applies to this page view only – update your site or source to make it permanent.';
    if (note) card.append(el('div', 'note', note));
    if (err.ruleDescription) card.append(el('div', 'rule', err.ruleDescription));
  }

  function flash(text) {
    const t = el('div', 'toast', text);
    card.append(t);
    setTimeout(() => t.remove(), 1600);
  }

  function position() {
    if (!current || !card) return;
    const rects = Array.from(current.err.range.getClientRects());
    if (!rects.length) { hide(); return; }
    let anchor = rects[0];
    if (current.point) {
      const hit = rects.find((r) => current.point.y >= r.top - 2 && current.point.y <= r.bottom + 3);
      if (hit) anchor = hit;
    }
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = innerHeight;
    const cw = card.offsetWidth || 344, ch = card.offsetHeight || 180;
    let left = Math.min(Math.max(8, anchor.left), vw - cw - 8);
    let top = anchor.bottom + 8;
    if (top + ch > vh - 8 && anchor.top - ch - 8 > 8) top = anchor.top - ch - 8;
    if (anchor.bottom < 0 || anchor.top > vh) { hide(); return; }
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
  }

  function show(err, opts) {
    ensureHost();
    const same = current && current.err === err;
    current = { err, opts: opts || {}, selected: same ? current.selected : 0, pinned: !!(opts && opts.pinned) || (same && current.pinned), point: opts && opts.point };
    render();
    card.hidden = false;
    position();
    requestAnimationFrame(() => card && card.classList.add('open'));
  }

  function hide() {
    if (!current) return;
    const err = current.err;
    current = null;
    if (card) { card.classList.remove('open'); card.hidden = true; card.textContent = ''; }
    handlers.onHide && handlers.onHide(err);
  }

  function isHostEvent(e) {
    return !!host && (e.target === host || (e.composedPath && e.composedPath().includes(host)));
  }

  function destroy() {
    hide();
    if (host) host.remove();
    host = shadow = card = null;
  }

  PP.suggestions = {
    show, hide, position, destroy, isHostEvent,
    setHandlers: (h) => { handlers = Object.assign({}, handlers, h); },
    get host() { return host; },
    get current() { return current && current.err; },
    get pinned() { return !!(current && current.pinned); },
    pin: () => { if (current) current.pinned = true; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
