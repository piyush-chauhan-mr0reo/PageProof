/*
 * PageProof – grammar.js
 * Checking-engine integration, kept modular so another engine can be swapped
 * in later. Loaded in two contexts:
 *   - the service worker (LanguageToolClient + RateLimiter do the network work)
 *   - the content script (chunking, hashing and match classification)
 */
(function (root) {
  'use strict';
  const PP = (root.PageProof = root.PageProof || {});
  if (PP.grammar) return;

  const encoder = new TextEncoder();
  const byteLength = (s) => encoder.encode(s).length;

  /* ---------------- hashing (so cached results never keep page text) ---------------- */
  function hash(str) {
    // cyrb53 – fast 53-bit string hash
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + str.length;
  }

  /* ---------------- classification ---------------- */
  const LABELS = {
    TYPOS: 'Spelling',
    GRAMMAR: 'Grammar',
    CONFUSED_WORDS: 'Word usage',
    COLLOCATIONS: 'Word usage',
    NONSTANDARD_PHRASES: 'Word usage',
    FALSE_FRIENDS: 'Word usage',
    SEMANTICS: 'Logic',
    COMPOUNDING: 'Compound word',
    PUNCTUATION: 'Punctuation',
    TYPOGRAPHY: 'Typography',
    CASING: 'Capitalization',
    REDUNDANCY: 'Redundancy',
    STYLE: 'Style',
    PLAIN_ENGLISH: 'Clarity',
    REPETITIONS: 'Repetition',
    REPETITIONS_STYLE: 'Repetition',
    MISC: 'Grammar'
  };

  const GRAMMAR_CATS = new Set(['GRAMMAR', 'CONFUSED_WORDS', 'COLLOCATIONS', 'NONSTANDARD_PHRASES',
    'FALSE_FRIENDS', 'SEMANTICS', 'COMPOUNDING', 'MISC', 'REPETITIONS']);
  const PUNCT_CATS = new Set(['PUNCTUATION', 'TYPOGRAPHY']);

  /**
   * Map a LanguageTool match to one of four buckets:
   *   spelling | grammar | punctuation | style (capitalization, clarity, style…)
   */
  function classify(match) {
    const rule = match.rule || {};
    const cat = (rule.category && rule.category.id) || '';
    const issue = rule.issueType || '';
    let category;
    if (issue === 'misspelling' || cat === 'TYPOS') category = 'spelling';
    else if (cat === 'CASING') category = 'style';
    else if (PUNCT_CATS.has(cat) || issue === 'whitespace') category = 'punctuation';
    else if (GRAMMAR_CATS.has(cat) || issue === 'grammar' || issue === 'duplication') category = 'grammar';
    else if (issue === 'typographical') category = 'punctuation';
    else category = 'style';

    let label = LABELS[cat] || (rule.category && rule.category.name) || 'Suggestion';
    if (issue === 'duplication') label = 'Repeated word';
    return { category, label };
  }

  /* ---------------- chunking ---------------- */
  const SEPARATOR = '\n\n';

  /**
   * Pack segments ({text}) into API-sized chunks. Each chunk records where every
   * segment starts so match offsets can be mapped back.
   */
  function buildChunks(segments, opts) {
    const maxChars = opts.chunkChars;
    const maxBytes = opts.maxRequestBytes;
    const chunks = [];
    let cur = null;
    for (const seg of segments) {
      const segBytes = byteLength(seg.text);
      if (cur && (cur.text.length + SEPARATOR.length + seg.text.length > maxChars ||
                  cur.bytes + 2 + segBytes > maxBytes)) {
        chunks.push(cur);
        cur = null;
      }
      if (!cur) cur = { text: '', bytes: 0, parts: [] };
      if (cur.parts.length) { cur.text += SEPARATOR; cur.bytes += 2; }
      cur.parts.push({ seg, start: cur.text.length });
      cur.text += seg.text;
      cur.bytes += segBytes;
    }
    if (cur && cur.parts.length) chunks.push(cur);
    return chunks;
  }

  /** Find which part of a chunk a match belongs to (binary search). */
  function partForOffset(chunk, offset) {
    const parts = chunk.parts;
    let lo = 0, hi = parts.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (parts[mid].start <= offset) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans < 0 ? null : parts[ans];
  }

  /* ---------------- rate limiter (service worker) ---------------- */
  class RateLimiter {
    constructor() {
      this.events = [];          // {t, bytes}
      this.cooldownUntil = 0;    // set after HTTP 429
      this.inFlight = 0;
    }
    prune(now) {
      const cutoff = now - 60000;
      while (this.events.length && this.events[0].t < cutoff) this.events.shift();
    }
    /** Returns {ok:true} and records usage, or {ok:false, waitMs}. */
    tryAcquire(bytes, limits) {
      const now = Date.now();
      if (now < this.cooldownUntil) return { ok: false, waitMs: this.cooldownUntil - now };
      if (this.inFlight >= 2) return { ok: false, waitMs: 400 };
      this.prune(now);
      const usedBytes = this.events.reduce((a, e) => a + e.bytes, 0);
      const overCount = this.events.length >= limits.requestsPerMinute;
      const overBytes = usedBytes + bytes > limits.bytesPerMinute && this.events.length > 0;
      if (overCount || overBytes) {
        // wait until enough of the window has expired
        let needBytes = usedBytes + bytes - limits.bytesPerMinute;
        let waitUntil = this.events[0].t + 60000;
        if (overBytes) {
          for (const e of this.events) { needBytes -= e.bytes; waitUntil = e.t + 60000; if (needBytes <= 0) break; }
        }
        return { ok: false, waitMs: Math.max(250, waitUntil - now + 50) };
      }
      this.events.push({ t: now, bytes });
      this.inFlight++;
      return { ok: true };
    }
    release() { this.inFlight = Math.max(0, this.inFlight - 1); }
    penalise(ms) { this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms); }
    snapshot() { return { events: this.events.slice(-200), cooldownUntil: this.cooldownUntil }; }
    restore(s) {
      if (!s) return;
      this.events = Array.isArray(s.events) ? s.events : [];
      this.cooldownUntil = s.cooldownUntil || 0;
    }
  }

  /* ---------------- LanguageTool client (service worker) ---------------- */
  class CheckError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.code = code;
      Object.assign(this, extra || {});
    }
  }

  const BASE_DISABLED_RULES = ['WHITESPACE_RULE', 'PUNCTUATION_PARAGRAPH_END', 'EN_QUOTES', 'DASH_RULE'];

  const LanguageToolClient = {
    async check({ endpoint, text, language, preferredVariants, picky, username, apiKey, timeoutMs = 30000 }) {
      const body = new URLSearchParams();
      body.set('text', text);
      body.set('language', language || 'auto');
      if ((language || 'auto') === 'auto' && preferredVariants) body.set('preferredVariants', preferredVariants);
      body.set('disabledRules', BASE_DISABLED_RULES.join(','));
      if (picky) body.set('level', 'picky');
      if (username && apiKey) { body.set('username', username); body.set('apiKey', apiKey); }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: body.toString(),
          signal: ctrl.signal,
          credentials: 'omit',
          cache: 'no-store'
        });
      } catch (e) {
        if (e && e.name === 'AbortError') throw new CheckError('TIMEOUT', 'The grammar service took too long to respond.');
        throw new CheckError('NETWORK', 'Could not reach the grammar service. Check your connection or API settings.');
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 429) {
        const ra = parseInt(res.headers.get('Retry-After') || '', 10);
        throw new CheckError('RATE_LIMITED', 'LanguageTool rate limit reached.', { retryAfterMs: (isFinite(ra) ? ra : 60) * 1000 });
      }
      if (res.status === 413) throw new CheckError('TOO_LARGE', 'A text block was too large for the grammar service.');
      if (res.status === 401 || res.status === 403) throw new CheckError('AUTH', 'The grammar service rejected the request (check your API username/key).');
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 160); } catch (_) { /* ignore */ }
        throw new CheckError('HTTP_' + res.status, `Grammar service error (${res.status}). ${detail}`.trim());
      }
      let data;
      try { data = await res.json(); } catch (_) {
        throw new CheckError('BAD_RESPONSE', 'The grammar service returned an unreadable response.');
      }
      const lang = data.language || {};
      return {
        matches: (data.matches || []).map((m) => ({
          offset: m.offset,
          length: m.length,
          message: m.message || '',
          shortMessage: m.shortMessage || '',
          replacements: (m.replacements || []).slice(0, 6).map((r) => r.value),
          rule: m.rule ? {
            id: m.rule.id,
            description: m.rule.description,
            issueType: m.rule.issueType,
            category: m.rule.category ? { id: m.rule.category.id, name: m.rule.category.name } : null
          } : null
        })),
        language: (lang.detectedLanguage && lang.detectedLanguage.code) || lang.code || null,
        languageName: (lang.detectedLanguage && lang.detectedLanguage.name) || lang.name || null
      };
    }
  };

  PP.grammar = { hash, classify, buildChunks, partForOffset, byteLength, RateLimiter, LanguageToolClient, CheckError };
})(typeof globalThis !== 'undefined' ? globalThis : self);
