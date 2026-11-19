# PageProof – Spelling & Grammar Checker for any webpage

PageProof is a Chrome extension (Manifest V3) that scans the readable text of a webpage, checks it with
[LanguageTool](https://languagetool.org), and highlights spelling, grammar, punctuation, capitalization and
style issues directly on the page. Hover or click a highlight to see the explanation and suggested fixes.

No build step is needed: plain HTML, CSS and JavaScript.

---

## Install (Developer Mode)

1. Extract the ZIP. You get a folder called `PageProof` containing `manifest.json`.
2. Open Chrome and go to **chrome://extensions**.
3. Turn on **Developer mode** (top-right switch).
4. Click **Load unpacked** and select the extracted `PageProof` folder (the one that contains `manifest.json`).
5. Pin PageProof from the puzzle-piece menu so the icon stays in your toolbar.

Requires Chrome 105 or newer (CSS Custom Highlight API). Shortcut: **Alt+Shift+P** opens the popup.

## Use

1. Open any website and click the PageProof icon.
2. Click **Scan This Page**. Progress shows in the popup, and highlights appear as each section is checked.
3. Hover over a highlighted word (or click it to pin the card) to see:
   - **Incorrect** text and **Suggested** corrections (click a suggestion to choose it)
   - **Apply correction** (where it can be applied safely), **Ignore**, and **Add to dictionary** (spelling) or **Ignore rule** (other issues)
4. Click any item in the popup's **Issues** list to scroll to it.
5. **Rescan Page** re-checks the page. Unchanged text is not sent again. **Clear Highlights** removes everything.

| Highlight | Meaning |
|---|---|
| Red wavy underline | Spelling |
| Red solid underline + tint | Grammar / word usage |
| Red dotted underline + tint | Punctuation / typography |
| Purple dashed underline | Capitalization & style |

> **Apply correction only changes what you see in this tab.** It does not edit your website. To fix a WordPress or
> Elementor page permanently, edit it in your editor. PageProof shows you exactly where to look.

## Settings

Open the settings page with the gear icon in the popup, or right-click the icon and choose **Options**.

- **Language**: auto-detect (default) or a fixed language, and the English variant (US/UK/AU/CA/NZ/ZA). A page's `lang="en-GB"` is respected automatically.
- **Grammar service**:
  - *LanguageTool public API* (default, free).
  - *LanguageTool Premium*: your username (email) + API key, with higher limits.
  - *Custom / self-hosted server*, e.g. `http://localhost:8081/v2/check` for a [local LanguageTool server](https://dev.languagetool.org/http-server). With this option no text leaves your machine.
- **Live scanning**: after a scan, newly loaded or revealed content (infinite scroll, accordions, tabs, SPAs) is checked incrementally.
- **Skip navigation**, **Ignore brand-like words** (WordPress, SEO, iOS…), **Picky mode**, **maximum text per page**.
- **Personal dictionary**, **Ignored words**, **Ignored rules**: manage them in the settings page.

---

## How the tricky parts work

### 1. Accurate highlight positioning (even across elements)
- `scanner.js` walks the DOM with a `TreeWalker`, grouping text nodes that render in the **same block box**
  (using computed `display`). For `<p>A <b>profes</b><i>ional</i> team</p>` it produces the segment
  `"A profesional team"`.
- Every character of the segment stores its **source text node and offset** (typed arrays). Whitespace is
  collapsed the way the browser renders it, and `<br>` becomes a space.
- A LanguageTool match `(offset, length)` maps back to an exact DOM `Range`, even when it starts in `<b>`
  and ends in `<i>`. Before highlighting, the range text is compared with the expected text. If they don't match, the
  highlight is skipped, so the wrong word is never marked.
- Highlights use the **CSS Custom Highlight API** (`CSS.highlights`). Highlights are painted by the browser on live
  ranges, so they stay aligned while scrolling, resizing, zooming and reflowing. No `<span>` wrappers are inserted.

### 2. WordPress / Elementor / Gutenberg compatibility
- **No page DOM is modified during scanning.** (The test suite checks that `body.innerHTML` is byte-for-byte identical
  before and after a scan.) The only element PageProof adds is one `<pageproof-root>` host on `<html>`, holding the
  correction card in a *closed shadow root*, and it is created only when the card is first shown.
- The extension is **injected only when you click Scan** (via `activeTab`), only into the top frame. Elementor's preview
  iframe and Gutenberg's editor canvas iframe are never touched.
- `contenteditable` regions, inputs, textareas, password fields, code blocks, hidden/screen-reader-only text, the WP admin
  bar, the Elementor panel/navigator and Gutenberg sidebars/popovers are excluded.
- When an editor is detected (`elementor-editor-active`, `block-editor-page`, `/wp-admin/`, `?elementor-preview`, other page
  builders), PageProof switches to **read-only mode**: it highlights issues but never applies corrections.
- All event listeners are passive. PageProof never calls `preventDefault()` or `stopPropagation()`, so site click handlers,
  sliders and menus behave normally.
- The `MutationObserver` ignores attribute churn (styles/classes used by animations). It only watches text/child changes and
  disclosure attributes (`hidden`, `open`, `aria-expanded`, `aria-hidden`). It ignores PageProof's own edits and
  permanently ignores regions that change constantly (clocks, tickers, counters).

### 3. LanguageTool limits
The public API allows about **20 requests/minute, 75 KB/minute and 20 KB per request** per IP.
- Text is split into **chunks** of ≤ 5,500 characters / 18 KB (larger for Premium or self-hosted), packed by paragraph.
  Long paragraphs are split at sentence boundaries.
- The service worker enforces a **shared sliding-window budget** (18 req/min, 68 KB/min) across all tabs, with at most 2
  requests in flight. When the budget is used up, the content script waits and the popup shows *"Pacing requests…"*.
- **HTTP 429** responses honour `Retry-After` and are retried up to 3 times. Timeouts, network errors and 5xx responses are retried with
  backoff. Auth errors, invalid custom URLs and missing permissions stop the scan with a clear message. A partial scan
  is reported as *Partial*, with the reason.
- **Identical text blocks are sent only once**, and results are cached in memory by a **hash** of the text (not the text
  itself). Rescans and live scans therefore only send new or changed text.
- Text near the viewport is checked first, so you see results immediately on long pages.
- Pages are capped at 250k characters by default (configurable).

## Privacy
- Runs only after you click **Scan This Page**, and only in that tab.
- Only readable page text is sent, to the grammar service you choose. Form values and password fields are never read.
- No page text is stored. The cache keeps hashes and match metadata in memory only, and Clear removes it.
- Stored in `chrome.storage.local`: your settings, dictionary and ignore lists.
- `credentials: 'omit'` on API requests (no cookies sent).

## Permissions
| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Inject the checker into the current tab when you click Scan |
| `storage` | Settings, dictionary, ignore lists |
| `https://api.languagetool.org/*`, `https://api.languagetoolplus.com/*` | Call LanguageTool (public / Premium) |
| optional `http(s)://*/*` | Requested only for the custom server URL you enter |

## Project structure
```
PageProof/
├── manifest.json        MV3 manifest
├── background.js        Service worker: API calls, rate limiting, badge
├── settings.js          Shared settings store (popup, options, content, worker)
├── grammar.js           LanguageTool client, rate limiter, chunking, classification
├── scanner.js           TreeWalker text extraction + char→DOM mapping + Range builder
├── highlighter.js       CSS Custom Highlight API registry + hit-testing
├── suggestions.js       Floating correction card (closed shadow DOM)
├── content.js           Orchestrator: scan pipeline, live scanning, card actions, messaging
├── content.css          ::highlight() styles
├── popup.html/.css/.js  Toolbar popup
├── options.html/.css/.js Settings page
├── icons/               16, 32, 48, 128 px
└── fonts/               Inter (SIL OFL 1.1)
```

## Troubleshooting
- **"Browser pages can't be scanned"**: chrome://, the Web Store and PDF viewer pages don't allow extensions.
- **Local files**: enable *Allow access to file URLs* for PageProof in chrome://extensions.
- **Rate limit messages on very long pages**: this is normal on the free API. Wait for it to finish, lower the maximum text
  per page, or use Premium or a self-hosted server.
- **After updating/reloading the extension**: refresh open tabs before scanning again.
- **Words you removed from the dictionary aren't flagged yet**: click Rescan Page.

## Tested
The extension was tested in Chrome 153 against a mock LanguageTool server using the real API response format, on:
a regular article, an Elementor-style page (`data-elementor-*` markup, admin bar, nav menu, accordion, live ticker),
an editor page (`elementor-editor-active` + contenteditable), and a 138k-character long page with a simulated HTTP 429 response.
The tests checked:
- split-element highlight alignment
- that excluded content is never sent
- that the page DOM is unchanged by scanning
- that page click handlers still fire
- incremental scanning of new content and accordion content
- pruning of removed content
- that scrolling keeps highlights aligned
- apply, ignore and dictionary actions
- read-only mode in editors
- chunking, retry after 429, and the request-budget logic

The live LanguageTool API itself could not be reached from the build environment, so do a quick real-world scan after installing.
