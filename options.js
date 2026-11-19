/* PageProof – options.js */
(function () {
  'use strict';
  const SETTINGS = globalThis.PageProof.settings;
  const $ = (id) => document.getElementById(id);
  const FIELDS_SELECT = ['language', 'preferredVariants', 'maxPageChars'];
  const FIELDS_TEXT = ['customApiUrl', 'premiumUsername', 'premiumApiKey'];
  const FIELDS_CHECK = ['pickyMode', 'dynamicScanning', 'skipNavigation', 'ignoreBrandLikeWords', 'highlightsEnabled'];
  const LISTS = ['personalDictionary', 'ignoredWords', 'ignoredRules'];

  function setStatus(text, kind) {
    const el = $('saveStatus');
    el.textContent = text;
    el.className = kind || '';
    if (kind === 'ok') setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2500);
  }

  function apiMode() {
    const r = document.querySelector('input[name=apiMode]:checked');
    return r ? r.value : 'public';
  }

  function syncApiFields() {
    const m = apiMode();
    $('premiumFields').hidden = m !== 'premium';
    $('customFields').hidden = m !== 'custom';
  }

  function renderList(key, values) {
    const ul = $('list-' + key);
    ul.textContent = '';
    if (!values.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing here yet.';
      ul.append(li);
      return;
    }
    for (const v of values) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = v;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '×';
      rm.title = 'Remove';
      rm.setAttribute('aria-label', 'Remove ' + v);
      rm.addEventListener('click', async () => {
        const list = await SETTINGS.removeFromList(key, v);
        renderList(key, list);
        setStatus('Removed. Rescan the page to see the change.', 'ok');
      });
      li.append(span, rm);
      ul.append(li);
    }
  }

  async function load() {
    const s = await SETTINGS.load();
    for (const k of FIELDS_SELECT) $(k).value = String(s[k]);
    for (const k of FIELDS_TEXT) $(k).value = s[k] || '';
    for (const k of FIELDS_CHECK) $(k).checked = !!s[k];
    const radio = document.querySelector(`input[name=apiMode][value="${s.apiMode}"]`);
    if (radio) radio.checked = true;
    syncApiFields();
    for (const k of LISTS) renderList(k, s[k] || []);
  }

  async function save() {
    const patch = {};
    for (const k of FIELDS_SELECT) patch[k] = k === 'maxPageChars' ? parseInt($(k).value, 10) : $(k).value;
    for (const k of FIELDS_TEXT) patch[k] = $(k).value.trim();
    for (const k of FIELDS_CHECK) patch[k] = $(k).checked;
    patch.apiMode = apiMode();

    if (patch.apiMode === 'custom') {
      let origin;
      try {
        const u = new URL(patch.customApiUrl);
        if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
        origin = u.origin + '/*';
      } catch (_) {
        setStatus('Enter a valid http(s) server URL, e.g. http://localhost:8081/v2/check', 'err');
        return;
      }
      const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
      if (!granted) { setStatus('Permission to contact the server was not granted.', 'err'); return; }
    }
    if (patch.apiMode === 'premium' && !(patch.premiumUsername && patch.premiumApiKey)) {
      setStatus('Enter your LanguageTool username and API key for Premium.', 'err');
      return;
    }
    await SETTINGS.save(patch);
    setStatus('Settings saved.', 'ok');
  }

  document.querySelectorAll('input[name=apiMode]').forEach((r) => r.addEventListener('change', syncApiFields));
  $('saveBtn').addEventListener('click', save);

  document.querySelectorAll('form.adder').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const v = input.value.trim();
      if (!v) return;
      const list = await SETTINGS.addToList(form.dataset.list, v);
      input.value = '';
      renderList(form.dataset.list, list);
      setStatus('Added.', 'ok');
    });
  });

  // keep lists fresh if the user adds words from a page while this tab is open
  SETTINGS.onChange(async (changed) => {
    for (const k of LISTS) if (k in changed) renderList(k, changed[k] || []);
  });

  load();
})();
