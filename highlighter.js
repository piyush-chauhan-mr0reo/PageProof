/*
 * PageProof – highlighter.js
 * Paints errors with the CSS Custom Highlight API. No elements are inserted
 * into the page and no text nodes are wrapped, so site layout, page-builder
 * editors and framework re-renders are unaffected. Highlights are bound to live
 * DOM Ranges, so they stay aligned while scrolling, resizing and reflowing.
 */
(function (root) {
  'use strict';
  const PP = (root.PageProof = root.PageProof || {});
  if (PP.highlighter) return;

  const CATEGORIES = ['spelling', 'grammar', 'punctuation', 'style'];
  const NAME = (c) => 'pageproof-' + c;
  const ACTIVE = 'pageproof-active';

  const supported = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  const errors = new Map();          // id -> error
  const nodeIndex = new Map();       // Text node -> Set<error>
  const byRange = new WeakMap();     // Range -> error
  const highlights = {};
  let activeHL = null;
  let enabled = true;
  let activeError = null;

  function init() {
    if (!supported || highlights.spelling) return supported;
    for (const c of CATEGORIES) {
      highlights[c] = new Highlight();
      highlights[c].priority = 1;
    }
    activeHL = new Highlight();
    activeHL.priority = 10;
    register();
    return true;
  }

  function register() {
    if (!supported) return;
    for (const c of CATEGORIES) {
      if (enabled) CSS.highlights.set(NAME(c), highlights[c]);
      else CSS.highlights.delete(NAME(c));
    }
    if (enabled) CSS.highlights.set(ACTIVE, activeHL);
    else CSS.highlights.delete(ACTIVE);
  }

  function add(err) {
    if (!supported) return false;
    init();
    errors.set(err.id, err);
    byRange.set(err.range, err);
    highlights[err.category].add(err.range);
    for (const n of err.nodes) {
      let set = nodeIndex.get(n);
      if (!set) nodeIndex.set(n, (set = new Set()));
      set.add(err);
    }
    return true;
  }

  function remove(err) {
    if (!errors.has(err.id)) return;
    errors.delete(err.id);
    if (highlights[err.category]) highlights[err.category].delete(err.range);
    for (const n of err.nodes) {
      const set = nodeIndex.get(n);
      if (set) { set.delete(err); if (!set.size) nodeIndex.delete(n); }
    }
    if (activeError === err) setActive(null);
  }

  function removeWhere(pred) {
    const removed = [];
    for (const err of Array.from(errors.values())) {
      if (pred(err)) { remove(err); removed.push(err); }
    }
    return removed;
  }

  function clear() {
    setActive(null);
    errors.clear();
    nodeIndex.clear();
    if (supported && highlights.spelling) for (const c of CATEGORIES) highlights[c].clear();
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) setActive(null);
    if (highlights.spelling) register();
  }

  function setActive(err) {
    activeError = err || null;
    if (!activeHL) return;
    activeHL.clear();
    if (err && enabled) activeHL.add(err.range);
  }

  /** True if the client point lies inside one of the range's line boxes. */
  function rangeHit(range, x, y) {
    const rects = range.getClientRects();
    for (const r of rects) {
      if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 2 && y <= r.bottom + 3) return r;
    }
    return null;
  }

  function errorAtPoint(x, y) {
    if (!enabled || !errors.size) return null;

    // Native hit-testing (Chrome 140+)
    if (CSS.highlights && typeof CSS.highlights.highlightsFromPoint === 'function') {
      try {
        const hits = CSS.highlights.highlightsFromPoint(x, y);
        for (const hit of hits || []) {
          for (const r of hit.ranges || []) {
            const err = byRange.get(r);
            if (err && errors.has(err.id)) return err;
          }
        }
        return null;
      } catch (_) { /* fall through */ }
    }

    // Fallback: caret position -> text node -> candidate errors -> geometry check
    let node = null, offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node) return null;
    const candidates = nodeIndex.get(node);
    if (!candidates) return null;
    for (const err of candidates) {
      let inRange = false;
      try { inRange = err.range.isPointInRange(node, offset); } catch (_) { inRange = false; }
      if (inRange && rangeHit(err.range, x, y)) return err;
    }
    return null;
  }

  /**
   * Drop errors whose text was removed or edited by the page.
   * Returns the number of removed errors.
   */
  function prune(normalise) {
    const dead = removeWhere((err) => {
      if (err.range.collapsed) return true;
      for (const n of err.nodes) if (!n.isConnected) return true;
      return normalise(err.range.toString()) !== err.text;
    });
    return dead.length;
  }

  /** Return an existing error covering exactly the same text span, if any. */
  function findSame(range) {
    const set = nodeIndex.get(range.startContainer);
    if (!set) return null;
    for (const err of set) {
      try {
        if (err.range.compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
            err.range.compareBoundaryPoints(Range.END_TO_END, range) === 0) return err;
      } catch (_) { /* different trees */ }
    }
    return null;
  }

  function counts() {
    const c = { total: 0, spelling: 0, grammar: 0, punctuation: 0, style: 0 };
    for (const err of errors.values()) { c.total++; c[err.category]++; }
    return c;
  }

  PP.highlighter = {
    supported, init, add, remove, removeWhere, clear, setEnabled, setActive, errorAtPoint,
    prune, counts, rangeHit, findSame,
    get: (id) => errors.get(id),
    all: () => Array.from(errors.values()),
    get size() { return errors.size; },
    get enabled() { return enabled; },
    get active() { return activeError; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
