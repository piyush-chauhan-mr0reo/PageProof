/*
 * PageProof – scanner.js
 * Extracts readable text from the page WITHOUT modifying it.
 *
 * Text is grouped into "segments": runs of text nodes that render inside the
 * same block-level box. Every character of a segment remembers the text node
 * and offset it came from, so a match such as "profesional" in
 *   <p>A <b>profes</b><i>ional</i> team</p>
 * maps back to a DOM Range that spans both elements exactly.
 */
(function (root) {
  'use strict';
  const PP = (root.PageProof = root.PageProof || {});
  if (PP.scanner) return;

  const NONE = 0xffffffff;
  const MAX_SEGMENT_CHARS = 3000;

  const EXCLUDED_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'object', 'embed', 'canvas',
    'svg', 'math', 'img', 'picture', 'video', 'audio', 'source', 'track', 'map',
    'textarea', 'input', 'select', 'option', 'optgroup', 'datalist', 'button', 'output',
    'code', 'pre', 'kbd', 'samp', 'var', 'tt', 'head', 'title', 'meta', 'link', 'dialog'
  ]);

  const NAV_ROLES = new Set(['navigation', 'menu', 'menubar', 'menuitem', 'toolbar', 'tablist', 'button', 'search', 'combobox', 'listbox']);

  const HIDDEN_CLASS_RE = /(?:^|\s)(screen-reader-text|sr-only|visually-hidden|elementor-screen-only|skip-link)(?:\s|$)/;

  // Editor chrome that should never be scanned (WordPress / Elementor / page builders).
  const EDITOR_CHROME_SELECTOR = [
    '#wpadminbar', '#adminmenumain', '#elementor-panel', '#elementor-navigator', '#elementor-editor-wrapper-v2',
    '.interface-interface-skeleton__header', '.interface-interface-skeleton__sidebar',
    '.interface-complementary-area', '.components-popover', '.block-editor-block-toolbar',
    '.elementor-editor-element-settings', '.elementor-element-overlay', '#pageproof-root'
  ].join(',');

  const SKIP_CHARS = /[­​‌‍⁠﻿]/;
  const WS_CHARS = /[\s  -   　]/;
  const HAS_LETTER = /\p{L}/u;

  function normaliseWS(s) {
    return String(s).replace(/[­​‌‍⁠﻿]/g, '')
      .replace(/[\s  -   　]+/g, ' ').trim();
  }

  function detectEditor() {
    const b = document.body;
    if (!b) return null;
    const cls = ' ' + (b.className && b.className.baseVal !== undefined ? b.className.baseVal : b.className) + ' ';
    const q = location.search;
    if (/ elementor-editor-(active|preview) /.test(cls) || /[?&]elementor-preview=/.test(q)) return 'Elementor editor';
    if (/ block-editor-page /.test(cls) || document.querySelector('.block-editor, .edit-post-layout, .edit-site')) return 'WordPress block editor';
    if (/\/wp-admin\//.test(location.pathname)) return 'WordPress admin';
    if (/[?&](fl_builder|et_fb=1|bricks=run|ct_builder=true)/.test(q)) return 'Page builder editor';
    if (document.querySelector('.fl-builder-edit, #et-fb-app, .brx-body.iframe')) return 'Page builder editor';
    return null;
  }

  /**
   * Extract segments from `rootEl`.
   * opts: { skipNavigation, maxChars, startChars }
   */
  function extract(rootEl, opts) {
    opts = opts || {};
    const maxChars = opts.maxChars || Infinity;
    const displayCache = new WeakMap();
    const visibleCache = new WeakMap();
    const body = document.body || document.documentElement;

    const displayOf = (el) => {
      let d = displayCache.get(el);
      if (d === undefined) {
        d = getComputedStyle(el).display;
        displayCache.set(el, d);
      }
      return d;
    };

    const blockAncestor = (el) => {
      for (let e = el; e && e !== body; e = e.parentElement) {
        const d = displayOf(e);
        if (d !== 'inline' && d !== 'contents') return e;
      }
      return body;
    };

    const isVisible = (el) => {
      let v = visibleCache.get(el);
      if (v !== undefined) return v;
      if (typeof el.checkVisibility === 'function') {
        v = el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: false });
      } else {
        v = el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      }
      if (v) {
        // visually-hidden helpers (1×1px clipped boxes)
        const r = el.getBoundingClientRect();
        if (r.width <= 1 && r.height <= 1) v = false;
      }
      visibleCache.set(el, v);
      return v;
    };

    const rejectElement = (el) => {
      const tag = el.localName;
      if (EXCLUDED_TAGS.has(tag)) return true;
      if (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return true;
      if (el.hasAttribute('hidden') || el.hasAttribute('inert')) return true;
      if (el.getAttribute('aria-hidden') === 'true') return true;
      if (el.isContentEditable) return true; // editable regions are never touched
      if (el.getAttribute('spellcheck') === 'false' || el.hasAttribute('data-pageproof-ignore')) return true;
      if (el.getAttribute('translate') === 'no') return true;
      const cls = typeof el.className === 'string' ? el.className : '';
      if (cls && HIDDEN_CLASS_RE.test(cls)) return true;
      if (el.matches(EDITOR_CHROME_SELECTOR)) return true;
      if (opts.skipNavigation) {
        if (tag === 'nav') return true;
        const role = el.getAttribute('role');
        if (role && NAV_ROLES.has(role)) return true;
        if (cls && /(?:^|\s)(nav-menu|main-navigation|elementor-nav-menu|elementor-nav-menu--main|breadcrumbs?|rank-math-breadcrumb|pagination|wp-block-navigation|skip-links)(?:\s|$)/.test(cls)) return true;
      }
      return false;
    };

    // Walk ancestors of the root too, so incremental scans respect exclusions.
    for (let a = rootEl; a && a !== body && a.nodeType === 1; a = a.parentElement) {
      if (rejectElement(a)) return { segments: [], totalChars: 0, truncated: false };
    }

    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (node === rootEl) return NodeFilter.FILTER_SKIP;
          if (rejectElement(node)) return NodeFilter.FILTER_REJECT;
          return node.localName === 'br' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        const p = node.parentElement;
        if (!p || !isVisible(p)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const segments = [];
    let totalChars = opts.startChars || 0;
    let truncated = false;
    let cur = null;

    const startSegment = (block) => {
      cur = { block, nodes: [], chars: [], idx: [], off: [] };
    };

    const finishSegment = () => {
      if (!cur) return;
      while (cur.chars.length && cur.chars[cur.chars.length - 1] === ' ') {
        cur.chars.pop(); cur.idx.pop(); cur.off.pop();
      }
      const text = cur.chars.join('');
      if (text.length >= 2 && HAS_LETTER.test(text)) {
        const seg = {
          block: cur.block,
          nodes: cur.nodes,
          text,
          idx: Uint32Array.from(cur.idx),
          off: Uint32Array.from(cur.off)
        };
        for (const piece of splitLong(seg)) segments.push(piece);
        totalChars += text.length;
      }
      cur = null;
    };

    const emit = (ch, ni, off) => {
      cur.chars.push(ch); cur.idx.push(ni); cur.off.push(off);
    };

    let node;
    while ((node = walker.nextNode())) {
      const parent = node.nodeType === 1 ? node.parentElement : node.parentElement;
      const block = blockAncestor(parent);
      if (!cur || cur.block !== block) {
        finishSegment();
        if (totalChars >= maxChars) { truncated = true; break; }
        startSegment(block);
      }
      if (node.nodeType === 1) { // <br>
        if (cur.chars.length && cur.chars[cur.chars.length - 1] !== ' ') emit(' ', NONE, 0);
        continue;
      }
      const data = node.data;
      const ni = cur.nodes.push(node) - 1;
      for (let i = 0; i < data.length; i++) {
        const c = data[i];
        if (SKIP_CHARS.test(c)) continue;
        if (WS_CHARS.test(c)) {
          if (!cur.chars.length || cur.chars[cur.chars.length - 1] === ' ') continue;
          emit(' ', ni, i);
        } else {
          emit(c, ni, i);
        }
      }
    }
    if (!truncated) finishSegment();
    return { segments, totalChars, truncated };
  }

  /** Split very long segments at sentence boundaries so API chunks stay small. */
  function splitLong(seg) {
    if (seg.text.length <= MAX_SEGMENT_CHARS) return [seg];
    const out = [];
    let start = 0;
    const text = seg.text;
    while (start < text.length) {
      let end = Math.min(text.length, start + MAX_SEGMENT_CHARS);
      if (end < text.length) {
        const window = text.slice(start + (MAX_SEGMENT_CHARS >> 1), end);
        let cut = -1;
        const re = /[.!?…]["')\]]?\s/g;
        let m;
        while ((m = re.exec(window))) cut = m.index + m[0].length;
        if (cut < 0) cut = window.lastIndexOf(' ') + 1;
        if (cut > 0) end = start + (MAX_SEGMENT_CHARS >> 1) + cut;
      }
      let s = start, e = end;
      while (s < e && text[s] === ' ') s++;
      while (e > s && text[e - 1] === ' ') e--;
      if (e > s) {
        out.push({
          block: seg.block, nodes: seg.nodes,
          text: text.slice(s, e), idx: seg.idx.subarray(s, e), off: seg.off.subarray(s, e)
        });
      }
      start = end;
    }
    return out;
  }

  /**
   * Build a live DOM Range for characters [start, end) of a segment.
   * Returns { range, nodes } or null when the mapping is no longer valid.
   */
  function makeRange(seg, start, end) {
    let s = start, e = end;
    while (s < e && seg.idx[s] === NONE) s++;
    while (e > s && seg.idx[e - 1] === NONE) e--;
    if (s >= e) return null;
    const firstIdx = seg.idx[s], lastIdx = seg.idx[e - 1];
    const startNode = seg.nodes[firstIdx], endNode = seg.nodes[lastIdx];
    if (!startNode || !endNode || !startNode.isConnected || !endNode.isConnected) return null;
    const endOff = seg.off[e - 1] + 1;
    if (seg.off[s] > startNode.length || endOff > endNode.length) return null;
    const range = document.createRange();
    try {
      range.setStart(startNode, seg.off[s]);
      range.setEnd(endNode, endOff);
    } catch (_) {
      return null;
    }
    return { range, nodes: seg.nodes.slice(firstIdx, lastIdx + 1) };
  }

  PP.scanner = { extract, makeRange, normaliseWS, detectEditor, EDITOR_CHROME_SELECTOR };
})(typeof globalThis !== 'undefined' ? globalThis : self);
