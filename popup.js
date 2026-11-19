/* PageProof – popup.js */
(function () {
  'use strict';
  const SETTINGS = globalThis.PageProof.settings;
  const CONTENT_FILES = ['settings.js', 'grammar.js', 'scanner.js', 'highlighter.js', 'suggestions.js', 'content.js'];
  const $ = (id) => document.getElementById(id);

  let tab = null;
  let injected = false;
  let restricted = null;
  let lastIssuesFetch = 0;
  let lastStatus = null;

  /* ---------------------------------------------------------------- utils */
  function restrictionFor(url) {
    if (!url) return 'PageProof can’t read this page.';
    if (/^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-extension|chrome-search|chrome-untrusted):/i.test(url)) return 'Browser pages can’t be scanned. Open a website to use PageProof.';
    if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) return 'The Chrome Web Store doesn’t allow extensions to run.';
    if (/\.pdf($|[?#])/i.test(url)) return 'PDF files are shown by Chrome’s PDF viewer and can’t be scanned.';
    return null;
  }

  function hostOf(url) {
    try { const u = new URL(url); return u.hostname || (u.protocol === 'file:' ? 'Local file' : u.protocol); } catch (_) { return '—'; }
  }

  function send(msg) {
    return new Promise((resolve) => {
      if (!tab) return resolve(null);
      try {
        chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 }, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch (_) { resolve(null); }
    });
  }

  async function ensureInjected() {
    if (injected) return true;
    const pong = await send({ type: 'PP_PING' });
    if (pong && pong.ok) { injected = true; return true; }
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    injected = true;
    return true;
  }

  function banner(text, kind) {
    const b = $('banner');
    if (!text) { b.hidden = true; return; }
    b.textContent = text;
    b.className = 'banner' + (kind ? ' ' + kind : '');
    b.hidden = false;
  }

  /* --------------------------------------------------------------- render */
  const STATE_LABEL = { idle: 'Not scanned', scanning: 'Scanning…', done: 'Complete', partial: 'Partial', error: 'Failed', cleared: 'Cleared' };

  function render(s) {
    lastStatus = s;
    const c = (s && s.counts) || { total: 0, spelling: 0, grammar: 0, punctuation: 0, style: 0 };
    $('total').textContent = c.total;
    $('total').classList.toggle('has', c.total > 0);
    for (const k of ['spelling', 'grammar', 'punctuation', 'style']) $('c-' + k).textContent = c[k];

    const state = (s && s.state) || 'idle';
    const pill = $('statePill');
    pill.textContent = STATE_LABEL[state] || state;
    pill.className = 'pill ' + state;

    const busy = state === 'scanning';
    const scanBtn = $('scanBtn');
    scanBtn.classList.toggle('busy', busy);
    scanBtn.disabled = busy || !!restricted;
    const scanned = c.total > 0 || ['done', 'partial', 'error'].includes(state);
    $('scanLabel').textContent = busy ? 'Scanning…' : (scanned ? 'Rescan Page' : 'Scan This Page');
    $('clearBtn').disabled = !!restricted || (!c.total && !busy && !['done', 'partial', 'error'].includes(state));

    const prog = $('progress');
    if (busy) {
      prog.hidden = false;
      const pct = s.chunksTotal ? Math.round((s.chunksDone / s.chunksTotal) * 100) : 0;
      prog.classList.toggle('indeterminate', !s.chunksTotal);
      $('bar').style.width = s.chunksTotal ? Math.max(4, pct) + '%' : '';
    } else {
      prog.hidden = true;
    }

    if (s && s.message) $('statusText').textContent = s.message;

    if (s && typeof s.highlightsEnabled === 'boolean') $('hlToggle').checked = s.highlightsEnabled;

    if (!restricted) {
      if (s && s.supported === false) banner('Your Chrome version is too old for in-page highlights. Please update Chrome.', 'error');
      else if (s && s.editorName) banner(`${s.editorName} detected – PageProof runs read-only here and never edits the editor’s content. Scan the live/preview page for in-place corrections.`, 'info');
      else banner(null);
    }

    const last = $('lastScan');
    if (s && s.finishedAt && state !== 'cleared') {
      const t = new Date(s.finishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const bits = [`Last scan ${t}`, `${s.segments || 0} text blocks`];
      if (s.chunksTotal) bits.push(`${s.chunksTotal} request${s.chunksTotal === 1 ? '' : 's'}`);
      if (s.language) bits.push(s.language);
      last.textContent = bits.join(' · ');
    } else {
      last.textContent = '';
    }
  }

  function renderIssues(list) {
    const wrap = $('issuesWrap');
    const ul = $('issues');
    ul.textContent = '';
    if (!list || !list.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    for (const it of list) {
      const li = document.createElement('li');
      li.tabIndex = 0;
      const dot = document.createElement('span');
      dot.className = 'dot' + (it.category === 'style' ? ' style' : '');
      const body = document.createElement('div');
      body.className = 'body';
      const l1 = document.createElement('div');
      l1.className = 'line1';
      const bad = document.createElement('span'); bad.className = 'bad'; bad.textContent = it.text;
      l1.append(bad);
      if (it.suggestion) {
        const ar = document.createElement('span'); ar.className = 'arrow'; ar.textContent = '→';
        const good = document.createElement('span'); good.className = 'good'; good.textContent = it.suggestion;
        l1.append(ar, good);
      }
      const l2 = document.createElement('div');
      l2.className = 'line2';
      l2.textContent = it.label + (it.message ? ' · ' + it.message : '');
      body.append(l1, l2);
      li.append(dot, body);
      const go = async () => { await send({ type: 'PP_FOCUS', id: it.id }); window.close(); };
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      ul.append(li);
    }
    const total = lastStatus && lastStatus.counts ? lastStatus.counts.total : list.length;
    if (total > list.length) {
      const more = document.createElement('li');
      more.className = 'more';
      more.textContent = `+ ${total - list.length} more on the page`;
      ul.append(more);
    }
  }

  async function refreshFull() {
    const s = await send({ type: 'PP_STATUS' });
    lastIssuesFetch = Date.now();
    if (s) { injected = true; render(s); renderIssues(s.issues); }
    return s;
  }

  /* ---------------------------------------------------------------- init */
  async function init() {
    const s = await SETTINGS.load();
    $('hlToggle').checked = !!s.highlightsEnabled;
    $('dynToggle').checked = !!s.dynamicScanning;
    $('engineName').textContent = s.apiMode === 'custom' ? 'your LanguageTool server' : (s.apiMode === 'premium' ? 'LanguageTool Premium' : 'LanguageTool (languagetool.org)');

    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { banner('No active tab found.', 'error'); return; }
    $('site').textContent = hostOf(tab.url);
    $('site').title = tab.url || '';
    restricted = restrictionFor(tab.url);
    if (restricted) {
      banner(restricted, 'error');
      render({ state: 'idle', message: 'This page can’t be scanned.' });
      return;
    }
    const st = await refreshFull();
    if (!st) render({ state: 'idle', message: 'Click “Scan This Page” to check spelling and grammar.' });
  }

  /* ------------------------------------------------------------- events */
  $('scanBtn').addEventListener('click', async () => {
    if (!tab || restricted) return;
    render(Object.assign({}, lastStatus || {}, { state: 'scanning', message: 'Starting scan…', chunksTotal: 0, chunksDone: 0 }));
    try {
      await ensureInjected();
    } catch (e) {
      const m = String(e && e.message || e);
      let text = 'PageProof can’t access this page.';
      if (/file:/.test(tab.url || '') || /Cannot access contents of url "file/.test(m)) text = 'To scan local files, enable “Allow access to file URLs” for PageProof in chrome://extensions.';
      else if (/Cannot access|cannot be scripted|extensions gallery/i.test(m)) text = 'Chrome doesn’t allow extensions to run on this page.';
      banner(text, 'error');
      render({ state: 'error', message: text });
      return;
    }
    const r = await send({ type: 'PP_SCAN' });
    if (!r) render({ state: 'error', message: 'Could not start the scan. Reload the page and try again.' });
  });

  $('clearBtn').addEventListener('click', async () => {
    await send({ type: 'PP_CLEAR' });
    await refreshFull();
  });

  $('hlToggle').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await SETTINGS.save({ highlightsEnabled: on });
    if (injected) await send({ type: 'PP_SET_HIGHLIGHTS', enabled: on });
  });

  $('dynToggle').addEventListener('change', async (e) => {
    await SETTINGS.save({ dynamicScanning: e.target.checked });
  });

  $('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'PP_PROGRESS' || !sender.tab || !tab || sender.tab.id !== tab.id) return;
    if (sender.frameId && sender.frameId !== 0) return;
    render(msg.status);
    const finished = msg.status.state !== 'scanning';
    if (finished || Date.now() - lastIssuesFetch > 900) refreshFull();
  });

  init();
})();
