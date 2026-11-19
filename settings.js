/*
 * PageProof – settings.js
 * Shared settings store (used by popup, options page, content scripts and the
 * service worker). Everything lives in chrome.storage.local. No page text is
 * ever written to storage.
 */
(function (root) {
  'use strict';
  const PP = (root.PageProof = root.PageProof || {});
  if (PP.settings) return;

  const API_ENDPOINTS = {
    public: 'https://api.languagetool.org/v2/check',
    premium: 'https://api.languagetoolplus.com/v2/check'
  };

  // Conservative limits per API mode. The public LanguageTool API allows
  // 20 requests / 75 KB per minute per IP and 20 KB per request.
  const API_LIMITS = {
    public: { requestsPerMinute: 18, bytesPerMinute: 68000, maxRequestBytes: 18000, chunkChars: 5500 },
    premium: { requestsPerMinute: 70, bytesPerMinute: 900000, maxRequestBytes: 75000, chunkChars: 12000 },
    custom: { requestsPerMinute: 120, bytesPerMinute: 5000000, maxRequestBytes: 150000, chunkChars: 12000 }
  };

  const DEFAULTS = {
    language: 'auto',            // 'auto' or a LanguageTool code such as en-US
    preferredVariants: 'en-US',  // used when language is auto
    apiMode: 'public',           // public | premium | custom
    customApiUrl: 'http://localhost:8081/v2/check',
    premiumUsername: '',
    premiumApiKey: '',
    highlightsEnabled: true,
    dynamicScanning: true,
    skipNavigation: true,
    pickyMode: false,
    ignoreBrandLikeWords: true,  // skip spelling hits such as "WordPress", "API", "iOS"
    maxPageChars: 250000,
    personalDictionary: [],
    ignoredWords: [],
    ignoredRules: []
  };

  const KEYS = Object.keys(DEFAULTS);

  function normaliseList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const v = String(raw || '').trim();
      if (!v) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    return out;
  }

  async function load() {
    try {
      const stored = await chrome.storage.local.get(KEYS);
      return Object.assign({}, DEFAULTS, stored);
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  async function save(patch) {
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (!KEYS.includes(k)) continue;
      clean[k] = Array.isArray(DEFAULTS[k]) ? normaliseList(v) : v;
    }
    await chrome.storage.local.set(clean);
    return clean;
  }

  async function addToList(key, value) {
    const s = await load();
    const list = normaliseList([...(s[key] || []), value]);
    await chrome.storage.local.set({ [key]: list });
    return list;
  }

  async function removeFromList(key, value) {
    const s = await load();
    const target = String(value).toLowerCase();
    const list = (s[key] || []).filter((v) => String(v).toLowerCase() !== target);
    await chrome.storage.local.set({ [key]: list });
    return list;
  }

  function onChange(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const relevant = {};
      let any = false;
      for (const k of Object.keys(changes)) {
        if (KEYS.includes(k)) { relevant[k] = changes[k].newValue; any = true; }
      }
      if (any) cb(relevant);
    });
  }

  function endpointFor(s) {
    if (s.apiMode === 'premium') return API_ENDPOINTS.premium;
    if (s.apiMode === 'custom') return (s.customApiUrl || '').trim() || DEFAULTS.customApiUrl;
    return API_ENDPOINTS.public;
  }

  function limitsFor(s) {
    return API_LIMITS[s.apiMode] || API_LIMITS.public;
  }

  PP.settings = { DEFAULTS, API_ENDPOINTS, API_LIMITS, load, save, addToList, removeFromList, onChange, endpointFor, limitsFor };
})(typeof globalThis !== 'undefined' ? globalThis : self);
