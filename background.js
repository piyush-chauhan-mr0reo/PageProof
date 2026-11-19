/*
 * PageProof – background.js (Manifest V3 service worker)
 * - Performs all LanguageTool requests (host permissions live here, so pages'
 *   CSP/CORS can't interfere).
 * - Enforces a shared per-minute request/byte budget across all tabs.
 * - Keeps the toolbar badge in sync with each tab's error count.
 * No page text is stored: requests are made and immediately forgotten.
 */
importScripts('settings.js', 'grammar.js');

const { settings: SETTINGS, grammar } = self.PageProof;
const limiter = new grammar.RateLimiter();
let limiterRestored = null;
let cachedSettings = null;

SETTINGS.onChange(() => { cachedSettings = null; });

async function getSettings() {
  if (!cachedSettings) cachedSettings = await SETTINGS.load();
  return cachedSettings;
}

function restoreLimiter() {
  if (!limiterRestored) {
    limiterRestored = chrome.storage.session.get('pp_limiter')
      .then((r) => limiter.restore(r.pp_limiter))
      .catch(() => {});
  }
  return limiterRestored;
}

function persistLimiter() {
  chrome.storage.session.set({ pp_limiter: limiter.snapshot() }).catch(() => {});
}

const VARIANTS = new Set(['en-US', 'en-GB', 'en-AU', 'en-CA', 'en-NZ', 'en-ZA', 'de-DE', 'de-AT', 'de-CH',
  'pt-PT', 'pt-BR', 'pt-AO', 'pt-MZ', 'ca-ES']);

function preferredVariants(s, pageLang) {
  const map = new Map();
  for (const v of String(s.preferredVariants || 'en-US').split(',')) {
    const t = v.trim();
    if (VARIANTS.has(t)) map.set(t.split('-')[0], t);
  }
  if (pageLang) {
    const parts = pageLang.replace('_', '-').split('-');
    const candidate = parts[0].toLowerCase() + (parts[1] ? '-' + parts[1].toUpperCase() : '');
    if (VARIANTS.has(candidate)) map.set(parts[0].toLowerCase(), candidate);
  }
  return Array.from(map.values()).join(',');
}

async function handleCheck(msg) {
  const s = await getSettings();
  const limits = SETTINGS.limitsFor(s);
  const text = String(msg.text || '');
  if (!text.trim()) return { ok: true, matches: [] };
  const bytes = grammar.byteLength(text);
  if (bytes > limits.maxRequestBytes) return { ok: false, code: 'TOO_LARGE', error: 'A text block was too large to check.' };

  let endpoint = SETTINGS.endpointFor(s);
  try {
    const u = new URL(endpoint);
    if (!/^https?:$/.test(u.protocol)) throw new Error('bad');
    if (s.apiMode === 'custom') {
      const allowed = await chrome.permissions.contains({ origins: [u.origin + '/*'] });
      if (!allowed) return { ok: false, code: 'NO_PERMISSION', error: 'PageProof needs permission to reach your custom LanguageTool server. Open Settings and save the server URL again.' };
    }
    endpoint = u.href;
  } catch (_) {
    return { ok: false, code: 'BAD_ENDPOINT', error: 'The custom LanguageTool server URL is invalid. Check PageProof settings.' };
  }
  if (s.apiMode === 'premium' && !(s.premiumUsername && s.premiumApiKey)) {
    return { ok: false, code: 'AUTH', error: 'LanguageTool Premium is selected but the username or API key is missing.' };
  }

  await restoreLimiter();
  const slot = limiter.tryAcquire(bytes, limits);
  if (!slot.ok) return { ok: false, code: 'THROTTLED', retryAfterMs: slot.waitMs };
  persistLimiter();

  try {
    const result = await grammar.LanguageToolClient.check({
      endpoint,
      text,
      language: s.language || 'auto',
      preferredVariants: preferredVariants(s, msg.pageLang),
      picky: !!s.pickyMode,
      username: s.apiMode === 'premium' ? s.premiumUsername : '',
      apiKey: s.apiMode === 'premium' ? s.premiumApiKey : ''
    });
    return Object.assign({ ok: true }, result);
  } catch (e) {
    if (e && e.code === 'RATE_LIMITED') { limiter.penalise(e.retryAfterMs || 60000); persistLimiter(); }
    return { ok: false, code: (e && e.code) || 'UNKNOWN', error: (e && e.message) || 'Unknown error', retryAfterMs: e && e.retryAfterMs };
  } finally {
    limiter.release();
  }
}

function updateBadge(tabId, status) {
  if (tabId == null || !status) return;
  const total = (status.counts && status.counts.total) || 0;
  let text = '';
  let color = '#e5484d';
  if (status.state === 'scanning' && !total) { text = '…'; color = '#5b21b6'; }
  else if (status.state === 'error' && !total) { text = '!'; color = '#b42318'; }
  else if (total) text = total > 999 ? '999+' : String(total);
  else if (status.state === 'done') { text = '✓'; color = '#1a7f4b'; }
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'PP_CHECK') {
    handleCheck(msg).then(sendResponse, (e) => sendResponse({ ok: false, code: 'UNKNOWN', error: String(e && e.message || e) }));
    return true; // async response
  }
  if (msg.type === 'PP_PROGRESS' && sender.tab) {
    updateBadge(sender.tab.id, msg.status);
    return false;
  }
  return false;
});

// A navigation unloads the content script, so the badge must reset too.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.storage.local.set({ pp_installedAt: Date.now() }).catch(() => {});
});
