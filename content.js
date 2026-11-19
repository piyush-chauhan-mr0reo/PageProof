/*
 * PageProof – content.js
 * Orchestrates scanning, checking, highlighting, the correction card and
 * incremental re-scanning of dynamic content. Injected on demand (only after
 * the user clicks Scan), and only into the top frame.
 */
(function () {
  'use strict';
  if (window.__pageproofLoaded) return;
  window.__pageproofLoaded = true;

  const PP = globalThis.PageProof;
  const { scanner, grammar, highlighter, suggestions } = PP;
  const SETTINGS = PP.settings;
  const norm = scanner.normaliseWS;

  /* ------------------------------------------------------------------ state */
  let settings = Object.assign({}, SETTINGS.DEFAULTS);
  let lists = { dict: new Set(), words: new Set(), rules: new Set() };
  let scanning = false;
  let scanningFull = false;
  let scanToken = 0;
  let idSeq = 0;
  const segCache = new Map();          // hash(text)+lang -> matches (offsets local to segment)
  const sessionIgnored = new Set();    // ruleId|text ignored for this page view
  const editorName = scanner.detectEditor();
  let listenersOn = false;
  let observer = null;
  let observerActive = false;

  const status = {
    state: 'idle', message: 'Ready to scan.', chunksTotal: 0, chunksDone: 0, chunksFailed: 0,
    segments: 0, chars: 0, truncated: false, startedAt: 0, finishedAt: 0, language: null, lastError: null
  };

  /* --------------------------------------------------------------- helpers */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function rebuildLists() {
    const low = (a) => new Set((a || []).map((x) => String(x).toLowerCase()));
    lists = { dict: low(settings.personalDictionary), words: low(settings.ignoredWords), rules: new Set(settings.ignoredRules || []) };
  }

  function cacheKey(text) {
    return grammar.hash(text) + '|' + settings.language + '|' + (settings.pickyMode ? 'p' : 'n');
  }

  function looksLikeBrandOrCode(t) {
    return /\d/.test(t) || /^[A-Z][A-Z0-9]+s?$/.test(t) || /[a-z][A-Z]/.test(t) || /[_@#/\\=<>{}]/.test(t) || /\w\.\w/.test(t);
  }

  function isFiltered(err) {
    const low = err.text.toLowerCase();
    if (err.ruleId && lists.rules.has(err.ruleId)) return true;
    if (lists.words.has(low)) return true;
    if (sessionIgnored.has(err.ruleId + '|' + low)) return true;
    if (err.category === 'spelling') {
      if (lists.dict.has(low)) return true;
      if (settings.ignoreBrandLikeWords && looksLikeBrandOrCode(err.text)) return true;
    }
    return false;
  }

  function safety(err) {
    if (editorName) return { canApply: false, reason: 'editor', editorName };
    if (err.nodes.length !== 1 || err.range.startContainer !== err.range.endContainer) return { canApply: false, reason: 'multi-node' };
    const p = err.range.startContainer.parentElement;
    if (!p || p.isContentEditable || p.closest('[contenteditable]')) return { canApply: false, reason: 'editor', editorName: 'Editable region' };
    return { canApply: true };
  }

  function snapshot() {
    return Object.assign({}, status, {
      counts: highlighter.counts(),
      editorName,
      highlightsEnabled: settings.highlightsEnabled,
      supported: highlighter.supported,
      dynamic: observerActive,
      host: location.hostname || location.protocol.replace(':', '')
    });
  }

  let lastReport = 0, reportTimer = null;
  function report(force) {
    const send = () => {
      lastReport = Date.now();
      reportTimer = null;
      try { chrome.runtime.sendMessage({ type: 'PP_PROGRESS', status: snapshot() }).catch(() => {}); } catch (_) { /* extension reloaded */ }
    };
    if (force) { if (reportTimer) clearTimeout(reportTimer); send(); return; }
    if (reportTimer) return;
    const wait = Math.max(0, 250 - (Date.now() - lastReport));
    reportTimer = setTimeout(send, wait);
  }

  function issuesList(limit) {
    const all = highlighter.all();
    all.sort((a, b) => {
      try { return a.range.compareBoundaryPoints(Range.START_TO_START, b.range); } catch (_) { return 0; }
    });
    return all.slice(0, limit).map((e) => ({
      id: e.id, text: e.display || e.text, category: e.category, label: e.label,
      message: e.shortMessage || e.message, suggestion: e.replacements[0] || ''
    }));
  }

  /* --------------------------------------------------------- API requests */
  async function sendToBackground(msg) {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await chrome.runtime.sendMessage(msg);
        if (res) return res;
      } catch (e) {
        if (String(e && e.message).includes('Extension context invalidated')) {
          return { ok: false, code: 'RELOADED', error: 'PageProof was updated or reloaded. Refresh the page and scan again.' };
        }
      }
      await sleep(400 * (i + 1));
    }
    return { ok: false, code: 'NO_WORKER', error: 'PageProof’s background service did not respond.' };
  }

  async function requestCheck(text, token) {
    let rateRetries = 0, netRetries = 0;
    const started = Date.now();
    for (;;) {
      if (token !== scanToken) throw { code: 'CANCELLED' };
      const res = await sendToBackground({
        type: 'PP_CHECK', text,
        pageLang: (document.documentElement.getAttribute('lang') || '').trim()
      });
      if (res.ok) return res;
      if (res.code === 'THROTTLED') {
        if (Date.now() - started > 6 * 60000) throw { code: 'TIMEOUT', error: 'Timed out waiting for the API rate limit.' };
        const secs = Math.ceil(res.retryAfterMs / 1000);
        if (secs >= 2) { status.message = `Pacing requests to respect LanguageTool limits… resuming in ${secs}s`; report(); }
        await sleep(res.retryAfterMs);
        continue;
      }
      if (res.code === 'RATE_LIMITED' && rateRetries < 3) {
        rateRetries++;
        const ms = Math.min(Math.max(res.retryAfterMs || 60000, 5000), 120000);
        status.message = `LanguageTool rate limit reached – retrying in ${Math.round(ms / 1000)}s`;
        report(true);
        await sleep(ms);
        continue;
      }
      if (['TIMEOUT', 'NETWORK', 'NO_WORKER'].includes(res.code) || /^HTTP_5/.test(res.code || '')) {
        if (netRetries < 2) { netRetries++; await sleep(2000 * netRetries); continue; }
      }
      throw res;
    }
  }

  /* ------------------------------------------------------- match handling */
  function applyMatches(seg, matches) {
    let added = 0;
    for (const m of matches) {
      if (m.length <= 0 || m.offset < 0 || m.offset + m.length > seg.text.length) continue;
      const raw = seg.text.substr(m.offset, m.length);
      const text = norm(raw);
      if (!text) continue;
      const cls = grammar.classify(m);
      const proto = {
        text, display: /^\s|\s$/.test(raw) ? raw.replace(/^\s+|\s+$/g, '␣') : text,
        category: cls.category, label: cls.label,
        ruleId: m.rule && m.rule.id, ruleDescription: m.rule && m.rule.description,
        message: m.message, shortMessage: m.shortMessage,
        replacements: (m.replacements || []).filter((r) => r !== raw).slice(0, 5)
      };
      if (isFiltered(proto)) continue;
      const mapped = scanner.makeRange(seg, m.offset, m.offset + m.length);
      if (!mapped) continue;
      if (norm(mapped.range.toString()) !== text) continue; // mapping drifted – never mark the wrong text
      if (highlighter.findSame(mapped.range)) continue;
      const err = Object.assign(proto, { id: ++idSeq, range: mapped.range, nodes: mapped.nodes });
      if (highlighter.add(err)) added++;
    }
    return added;
  }

  function nearViewportFirst(segments) {
    const vh = innerHeight;
    const rectCache = new Map();
    const score = (seg) => {
      let s = rectCache.get(seg.block);
      if (s === undefined) {
        const r = seg.block.getBoundingClientRect();
        s = (r.bottom > -vh && r.top < vh * 2) ? 0 : 1;
        rectCache.set(seg.block, s);
      }
      return s;
    };
    return segments.map((seg, i) => ({ seg, i, s: score(seg) }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map((x) => x.seg);
  }

  /* ------------------------------------------------------------- scanning */
  async function runScan(opts) {
    opts = opts || {};
    const roots = opts.roots || null;
    if (scanning) {
      if (roots) roots.forEach((r) => pendingRoots.add(r));
      return { busy: true };
    }
    if (!highlighter.supported) {
      Object.assign(status, { state: 'error', message: 'This Chrome version lacks the CSS Custom Highlight API (Chrome 105+ required).' });
      report(true);
      return { error: status.message };
    }
    if (!document.body) return { error: 'This page has no readable content.' };

    scanning = true;
    const token = ++scanToken;
    const full = !roots;
    scanningFull = full;
    settings = await SETTINGS.load();
    rebuildLists();
    highlighter.init();
    highlighter.setEnabled(settings.highlightsEnabled);
    attachListeners();

    if (full) {
      highlighter.clear();
      suggestions.hide();
      Object.assign(status, {
        state: 'scanning', message: 'Reading page text…', chunksTotal: 0, chunksDone: 0, chunksFailed: 0,
        segments: 0, chars: 0, truncated: false, startedAt: Date.now(), finishedAt: 0, lastError: null
      });
      report(true);
    } else {
      highlighter.removeWhere((err) => roots.some((r) => r.contains(err.nodes[0])));
    }

    try {
      // 1. Extract
      let segments = [];
      let total = 0, truncated = false;
      for (const r of roots || [document.body]) {
        if (!r.isConnected) continue;
        const res = scanner.extract(r, { skipNavigation: settings.skipNavigation, maxChars: full ? settings.maxPageChars : Infinity, startChars: total });
        segments = segments.concat(res.segments);
        total = res.totalChars;
        truncated = truncated || res.truncated;
      }
      if (full) {
        segments = nearViewportFirst(segments);
        Object.assign(status, { segments: segments.length, chars: total, truncated });
      }

      // 2. Reuse cached results; dedupe identical text blocks
      const groups = new Map(); // key -> segments[]
      for (const seg of segments) {
        const key = cacheKey(seg.text);
        if (segCache.has(key)) { applyMatches(seg, segCache.get(key)); continue; }
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(seg);
      }
      const pending = Array.from(groups.values()).map((g) => g[0]);
      const limits = SETTINGS.limitsFor(settings);
      const chunks = grammar.buildChunks(pending, limits);

      if (full) {
        status.chunksTotal = chunks.length;
        status.message = chunks.length ? `Checking text… (0/${chunks.length})` : 'Checking text…';
        report(true);
      } else if (!chunks.length) {
        report();
        return { ok: true };
      }

      // 3. Check chunks (the service worker enforces API rate limits)
      let fatal = null;
      let next = 0;
      const worker = async () => {
        while (next < chunks.length && !fatal) {
          const chunk = chunks[next++];
          try {
            const res = await requestCheck(chunk.text, token);
            if (token !== scanToken) return;
            if (res.language) status.language = res.languageName || res.language;
            const perSeg = new Map(chunk.parts.map((p) => [p, []]));
            for (const m of res.matches) {
              const part = grammar.partForOffset(chunk, m.offset);
              if (!part) continue;
              const local = m.offset - part.start;
              if (local + m.length > part.seg.text.length) continue; // crosses a block boundary
              perSeg.get(part).push(Object.assign({}, m, { offset: local }));
            }
            for (const [part, ms] of perSeg) {
              const key = cacheKey(part.seg.text);
              segCache.set(key, ms);
              for (const seg of groups.get(key) || [part.seg]) applyMatches(seg, ms);
            }
          } catch (e) {
            if (e && e.code === 'CANCELLED') return;
            status.chunksFailed++;
            status.lastError = (e && (e.error || e.message)) || 'Unknown error';
            if (['AUTH', 'RELOADED', 'NO_PERMISSION', 'BAD_ENDPOINT'].includes(e && e.code) || (e && e.code === 'NETWORK')) fatal = e;
          }
          status.chunksDone++;
          if (full) status.message = `Checking text… (${status.chunksDone}/${chunks.length})`;
          report();
        }
      };
      await Promise.all([worker(), worker()]);
      if (token !== scanToken) return { cancelled: true };

      if (full) {
        status.finishedAt = Date.now();
        const c = highlighter.counts().total;
        if (fatal || (status.chunksFailed && status.chunksFailed === status.chunksTotal)) {
          status.state = 'error';
          status.message = status.lastError || 'The scan failed.';
        } else if (status.chunksFailed) {
          status.state = 'partial';
          status.message = `Partially checked – ${status.chunksFailed} of ${status.chunksTotal} sections failed. ${status.lastError || ''}`.trim();
        } else {
          status.state = 'done';
          status.message = c ? `Found ${c} issue${c === 1 ? '' : 's'}.` : 'No issues found. Nice writing!';
          if (truncated) status.message += ' Very long page – checked the first ' + Math.round(settings.maxPageChars / 1000) + 'k characters.';
        }
      }
      if (settings.dynamicScanning) startObserver(); else stopObserver();
      return { ok: true };
    } catch (e) {
      status.state = 'error';
      status.message = 'Scan failed: ' + ((e && e.message) || e);
      return { error: status.message };
    } finally {
      if (token === scanToken) { scanning = false; scanningFull = false; }
      report(true);
      if (pendingRoots.size && !scanning) scheduleFlush(600);
    }
  }

  function clearAll() {
    scanToken++;
    scanning = false;
    scanningFull = false;
    stopObserver();
    suggestions.destroy();
    highlighter.clear();
    segCache.clear();
    sessionIgnored.clear();
    pendingRoots.clear();
    detachListeners();
    Object.assign(status, { state: 'cleared', message: 'Highlights cleared.', chunksTotal: 0, chunksDone: 0, chunksFailed: 0, finishedAt: Date.now() });
    report(true);
  }

  /* ---------------------------------------------- dynamic content (incremental) */
  const pendingRoots = new Set();
  let flushTimer = null, maxTimer = null, needsPrune = false;
  const noisy = new WeakMap();
  const tooNoisy = new WeakSet();     // regions that change constantly (clocks, tickers, counters)

  function isOurs(node) {
    const host = suggestions.host;
    return !!host && (node === host || host.contains(node));
  }

  function blockOf(el) {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const d = getComputedStyle(e).display;
      if (d !== 'inline' && d !== 'contents') return e;
    }
    return document.body;
  }

  function onMutations(list) {
    let relevant = false;
    for (const m of list) {
      const t = m.target;
      if (isOurs(t)) continue;
      if (m.type === 'childList') {
        const nodes = [...m.addedNodes, ...m.removedNodes];
        if (nodes.length && nodes.every((n) => isOurs(n) || (n.nodeType === 3 && !n.data.trim()) || n.nodeType === 8)) continue;
      }
      const el = t.nodeType === 1 ? (m.type === 'attributes' ? t.parentElement || t : t) : t.parentElement;
      if (!el || el === document.documentElement) continue;
      // regions that change constantly (clocks, tickers, counters) are ignored
      if (tooNoisy.has(el)) continue;
      const now = Date.now();
      const n = noisy.get(el) || { c: 0, since: now };
      if (now - n.since > 30000) { n.c = 0; n.since = now; }
      n.c++;
      noisy.set(el, n);
      if (n.c > 8) { tooNoisy.add(el); pendingRoots.delete(el); continue; }
      if (m.type === 'characterData' || (m.type === 'childList' && m.removedNodes.length)) needsPrune = true;
      pendingRoots.add(el);
      relevant = true;
    }
    if (relevant) scheduleFlush(1500);
  }

  function scheduleFlush(delay) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, delay);
    if (!maxTimer) maxTimer = setTimeout(flush, 5000);
  }

  function flush() {
    clearTimeout(flushTimer); clearTimeout(maxTimer);
    flushTimer = maxTimer = null;
    if (scanning) { scheduleFlush(1500); return; }
    if (suggestions.pinned) { scheduleFlush(2000); return; } // don't yank the card away
    if (needsPrune) {
      needsPrune = false;
      if (highlighter.prune(norm)) report();
    }
    if (!pendingRoots.size) return;
    // Expand to block containers and drop roots nested inside other roots.
    const blocks = new Set();
    for (const r of pendingRoots) if (r.isConnected && !tooNoisy.has(r)) blocks.add(blockOf(r));
    pendingRoots.clear();
    const roots = Array.from(blocks).filter((r) => !Array.from(blocks).some((o) => o !== r && o.contains(r)));
    if (roots.length) runScan({ roots });
  }

  function startObserver() {
    if (observerActive || !document.body) return;
    observer = observer || new MutationObserver(onMutations);
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['hidden', 'open', 'aria-hidden', 'aria-expanded']
    });
    observerActive = true;
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observerActive = false;
    clearTimeout(flushTimer); clearTimeout(maxTimer);
    flushTimer = maxTimer = null;
  }

  /* ------------------------------------------------------ hover / click UI */
  let hoverErr = null, showTimer = null, hideTimer = null, overCard = false;
  let rafPending = false, lastX = 0, lastY = 0;

  function openCard(err, extra) {
    highlighter.setActive(err);
    suggestions.show(err, Object.assign({}, safety(err), extra));
  }

  function evaluatePointer() {
    rafPending = false;
    const err = highlighter.errorAtPoint(lastX, lastY);
    if (err) {
      clearTimeout(hideTimer);
      if (err !== hoverErr) {
        hoverErr = err;
        if (!suggestions.pinned) highlighter.setActive(err);
        clearTimeout(showTimer);
        if (suggestions.current !== err && !suggestions.pinned) {
          const point = { x: lastX, y: lastY };
          showTimer = setTimeout(() => openCard(err, { point }), 280);
        }
      }
    } else if (hoverErr) {
      hoverErr = null;
      clearTimeout(showTimer);
      if (!suggestions.pinned && !overCard) {
        if (suggestions.current) hideTimer = setTimeout(() => suggestions.hide(), 350);
        else highlighter.setActive(null);
      }
    }
  }

  function onPointerMove(e) {
    if (!highlighter.size || !highlighter.enabled) return;
    if (suggestions.isHostEvent(e)) return;
    lastX = e.clientX; lastY = e.clientY;
    if (!rafPending) { rafPending = true; requestAnimationFrame(evaluatePointer); }
  }

  function onClick(e) {
    if (!highlighter.size || suggestions.isHostEvent(e)) return;
    const err = highlighter.errorAtPoint(e.clientX, e.clientY);
    if (err) {
      clearTimeout(showTimer); clearTimeout(hideTimer);
      openCard(err, { pinned: true, point: { x: e.clientX, y: e.clientY } });
    } else if (suggestions.current) {
      suggestions.hide();
    }
  }

  let repositionPending = false;
  function onScrollOrResize() {
    if (!suggestions.current || repositionPending) return;
    repositionPending = true;
    requestAnimationFrame(() => { repositionPending = false; suggestions.position(); });
  }

  function onKey(e) { if (e.key === 'Escape' && suggestions.current) suggestions.hide(); }

  function attachListeners() {
    if (listenersOn) return;
    listenersOn = true;
    const o = { passive: true, capture: true };
    document.addEventListener('pointermove', onPointerMove, o);
    document.addEventListener('click', onClick, o);
    document.addEventListener('scroll', onScrollOrResize, o);
    window.addEventListener('resize', onScrollOrResize, { passive: true });
    document.addEventListener('keydown', onKey, o);
  }

  function detachListeners() {
    if (!listenersOn) return;
    listenersOn = false;
    const o = { passive: true, capture: true };
    document.removeEventListener('pointermove', onPointerMove, o);
    document.removeEventListener('click', onClick, o);
    document.removeEventListener('scroll', onScrollOrResize, o);
    window.removeEventListener('resize', onScrollOrResize, { passive: true });
    document.removeEventListener('keydown', onKey, o);
  }

  /* ----------------------------------------------------- card actions */
  function applyCorrection(err, replacement) {
    const s = safety(err);
    if (!s.canApply || typeof replacement !== 'string') return;
    if (norm(err.range.toString()) !== err.text) { highlighter.remove(err); suggestions.hide(); report(); return; }
    const node = err.range.startContainer;
    const start = err.range.startOffset;
    const len = err.range.endOffset - start;
    node.replaceData(start, len, replacement);
    if (observer && observerActive) observer.takeRecords(); // our own edit is not "new content"
    highlighter.remove(err);
    suggestions.hide();
    report();
  }

  function removeMatching(pred) {
    highlighter.removeWhere(pred);
    if (suggestions.current && !highlighter.get(suggestions.current.id)) suggestions.hide();
    report();
  }

  suggestions.setHandlers({
    onApply: applyCorrection,
    onIgnore(err) {
      const low = err.text.toLowerCase();
      sessionIgnored.add(err.ruleId + '|' + low);
      removeMatching((e) => e.ruleId === err.ruleId && e.text.toLowerCase() === low);
    },
    async onAddDictionary(err) {
      const low = err.text.toLowerCase();
      lists.dict.add(low);
      removeMatching((e) => e.category === 'spelling' && e.text.toLowerCase() === low);
      await SETTINGS.addToList('personalDictionary', err.text);
    },
    async onIgnoreRule(err) {
      lists.rules.add(err.ruleId);
      removeMatching((e) => e.ruleId === err.ruleId);
      await SETTINGS.addToList('ignoredRules', err.ruleId);
    },
    onCardEnter() { overCard = true; clearTimeout(hideTimer); },
    onCardLeave() {
      overCard = false;
      if (!suggestions.pinned) hideTimer = setTimeout(() => suggestions.hide(), 350);
    },
    onHide() { highlighter.setActive(null); hoverErr = null; }
  });

  /* ---------------------------------------------------- settings changes */
  SETTINGS.onChange((changed) => {
    Object.assign(settings, changed);
    if ('highlightsEnabled' in changed) {
      highlighter.setEnabled(changed.highlightsEnabled);
      if (!changed.highlightsEnabled) suggestions.hide();
    }
    if ('personalDictionary' in changed || 'ignoredWords' in changed || 'ignoredRules' in changed || 'ignoreBrandLikeWords' in changed) {
      rebuildLists();
      removeMatching(isFiltered);
    }
    if ('language' in changed || 'pickyMode' in changed || 'apiMode' in changed) segCache.clear();
    if ('dynamicScanning' in changed && highlighter.size + status.chunksTotal > 0) {
      if (changed.dynamicScanning) startObserver(); else stopObserver();
    }
    report(true);
  });

  /* -------------------------------------------------------- messaging */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return;
    switch (msg.type) {
      case 'PP_PING':
        sendResponse({ ok: true });
        return;
      case 'PP_STATUS':
        sendResponse(Object.assign(snapshot(), { issues: issuesList(200), scanning: scanningFull }));
        return;
      case 'PP_SCAN':
        if (scanning && scanningFull) { sendResponse({ busy: true }); return; }
        if (scanning) { scanToken++; scanning = false; } // supersede a background incremental scan
        runScan({});
        sendResponse({ started: true });
        return;
      case 'PP_CLEAR':
        clearAll();
        sendResponse({ ok: true });
        return;
      case 'PP_SET_HIGHLIGHTS':
        settings.highlightsEnabled = !!msg.enabled;
        highlighter.setEnabled(!!msg.enabled);
        if (!msg.enabled) suggestions.hide();
        report(true);
        sendResponse({ ok: true });
        return;
      case 'PP_FOCUS': {
        const err = highlighter.get(msg.id);
        if (!err) { sendResponse({ ok: false }); return; }
        if (!highlighter.enabled) { highlighter.setEnabled(true); settings.highlightsEnabled = true; SETTINGS.save({ highlightsEnabled: true }); }
        const target = err.range.startContainer.parentElement;
        if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(() => openCard(err, { pinned: true }), 500);
        sendResponse({ ok: true });
        return;
      }
      default:
    }
  });

  rebuildLists();
})();
