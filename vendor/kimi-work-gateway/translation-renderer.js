// Kimi reasoning translation - CDP renderer payload (gateway edition).
//
// One engine, two surfaces. The host injects this IIFE into a page it has
// classified, and the same queue, cache, concurrency limit, quiet window, epoch
// cancellation and code/link protection serve both: only the DOM contract and
// the moment that counts as "finished" differ.
//
// Work (local renderer, verified on 3.2.21 / 3.2.23):
//
//   .think-block
//     .think-summary          collapse toggle, aria-expanded
//     .think-body-wrap
//       .think-body           v-if: only exists while expanded
//         .chat-markdown
//
// Chat (https://www.kimi.com, verified against release a045362):
//
//   .toolcall-container.thinking-container     root; expanded adds is-expanded
//     .toolcall-title-container
//     .resize-container[.enable-grow-animation] height animation; present while
//                                               the block is still running
//       .slot-container
//         .toolcall-content
//           .toolcall-content-text
//             .markdown-container
//               .markdown
//
// The two disagree in ways that decide the implementation:
//  * collapse: Work drops the body from the DOM, Chat keeps it and animates
//    height/opacity. A collapsed Chat block still holds its full text, so it is
//    never read into a dispatch: the text is present but the user cannot see it.
//  * expansion state: an aria-expanded button on Work, a class on the Chat root.
//  * streaming: Work is inferred from the label wording plus a content-quiet
//    window; Chat exposes its running prop as .enable-grow-animation. The quiet
//    window applies to both, so partially streamed text is never paid for.
//
// The surface is derived from the live location, never from the host's claim
// alone. A new-document script runs in every later document of the same target,
// so a page that navigated away must not mount, and a SPA route change (which
// creates no new document) must retire what is on screen.
//
// The mirror is anchored to the surface root, not to the text node, because
// both surfaces rebuild their content subtree: Work on collapse, Chat on every
// re-render.
//
// The selectors above describe the builds this file was written against; they
// are not trusted as a compatibility proof. `status()` reports how many roots
// the page actually contains (`seenBlocks`) and how many exposed the expected
// structure (`blocks`), so the host can distinguish an empty conversation from
// a drifted DOM instead of presenting an unmatched page as a working
// translation.
(() => {
  'use strict';
  const VERSION = 1;
  const ENGINE = '__kwgTranslation';
  const NS = 'kwg';
  const WORK_PROTOCOLS = ['file:', 'app:', 'kimi:'];
  const CHAT_ORIGIN = 'https://www.kimi.com';
  const CHAT_PATHS = [/^\/chat\/[A-Za-z0-9_-]{1,128}$/, /^\/chat\/history$/, /^\/$/];

  const CLASS = {
    bar: `${NS}-bar`, btn: `${NS}-btn`, view: `${NS}-view-btn`, status: `${NS}-status`,
    note: `${NS}-note`, translated: `${NS}-translated`, hiding: `${NS}-hiding-source`,
    style: `${NS}-style`,
  };
  const ATTR = `data-${NS}`;
  const SETTLE_MS = 260;
  const QUIET_MS = 900;
  const SCAN_MS = 400;
  const REPLY_TIMEOUT_MS = 150000;
  const MAX_REPLY_CHARS = 400000;
  const MAX_PROTECTED_ITEMS = 200;
  const MAX_PROTECTED_CHARS = 24000;
  const MAX_CACHE_ENTRIES = 120;
  const MAX_CACHE_CHARS = 400000;
  const MAX_ACTIVE = 2;
  const FAILURE_TTL_MS = 15000;
  const PROVIDERS = ['bing', 'google', 'custom'];
  const LANGUAGES = ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru'];
  const VIEWS = ['translated', 'original'];
  const ERROR_LABELS = {
    translation_timeout: '翻译超时',
    translation_aborted: '已取消',
    translation_unavailable: '网关未连接',
    translation_http_error: '服务不可用',
    translation_invalid_response: '译文格式不符',
    translation_response_too_large: '译文过大',
    translation_text_too_large: '思考文本过长',
    translation_invalid_config: '翻译配置无效',
    translation_endpoint_required: '未配置端点',
    translation_network_error: '网络错误',
  };

  const WORK = {
    name: 'work',
    root: '.think-block',
    // A Work block accepts a mirror when it carries either half of the
    // summary/body pair; the other half is what a collapse removes.
    structured(block) {
      return !!(block.querySelector('.think-summary') || block.querySelector('.think-body'));
    },
    source(block) {
      const body = block.querySelector('.think-body');
      const scope = body || block;
      return scope.querySelector('.chat-markdown') || body || null;
    },
    expanded(block) {
      const summary = block.querySelector('.think-summary');
      if (!summary) return true;
      const value = summary.getAttribute ? summary.getAttribute('aria-expanded') : summary.ariaExpanded;
      return value !== 'false';
    },
    // Work publishes no streaming flag, so it is read from the label wording.
    // A future Kimi that renames the status still cannot stream partial text
    // into a paid request: the content-quiet window below is wording-blind.
    settled(block) {
      const label = block.querySelector('.think-label') || block.querySelector('.think-summary');
      const text = (label?.textContent || '').trim();
      if (!text) return true;
      if (/thinking|思考中/i.test(text) && !/thought|done|complete|完成/i.test(text)) return false;
      return true;
    },
    anchor(block) {
      const wrap = block.querySelector('.think-body-wrap');
      return wrap && wrap.parentNode === block ? wrap : null;
    },
    barAnchor(block) {
      const summary = block.querySelector('.think-summary');
      return summary && summary.parentNode === block ? summary : null;
    },
  };

  const CHAT = {
    name: 'chat',
    root: '.toolcall-container.thinking-container',
    structured(block) {
      return !!(block.querySelector('.resize-container') && block.querySelector('.toolcall-content'));
    },
    source(block) {
      const content = block.querySelector('.toolcall-content-text') || block.querySelector('.toolcall-content');
      return content ? content.querySelector('.markdown') || content : null;
    },
    // The Thinking component puts the expanded state on its own root; its title
    // container carries no aria-expanded, so the Work rule cannot read it.
    expanded(block) {
      return !!(block.classList && block.classList.contains('is-expanded'));
    },
    // `running` is the only stable streaming signal: ContainerBlock renders a
    // thinking block outside .toolcall-flow whenever the container holds more
    // than thinking, so an is-streaming ancestor is absent in that layout while
    // the grow class is present in both.
    settled(block) {
      return !block.querySelector('.resize-container.enable-grow-animation');
    },
    anchor(block) {
      const resize = block.querySelector('.resize-container');
      return resize && resize.parentNode === block ? resize : null;
    },
    barAnchor(block) {
      const resize = block.querySelector('.resize-container');
      return resize && resize.parentNode === block ? resize : null;
    },
  };

  const SURFACES = { work: WORK, chat: CHAT };

  // The host decides what to attach to; this decides what may mount. Both are
  // evaluated, so a script that survives into another document of the same
  // target can never mount on a page the host did not classify as this surface.
  function surfaceOf(href) {
    let url;
    try { url = new URL(href); } catch { return 'other'; }
    if (WORK_PROTOCOLS.includes(url.protocol)) return /\/kimi-agent\.html$/.test(url.pathname) ? 'work' : 'other';
    if (url.protocol === 'https:' && url.origin === CHAT_ORIGIN
      && CHAT_PATHS.some(pattern => pattern.test(url.pathname))) return 'chat';
    return 'other';
  }

  function currentHref() {
    const location = globalThis.location;
    if (typeof location === 'string') return location;
    if (typeof location?.href !== 'string') return '';
    // The test realms and older embeddings hand over a plain object. Resolving
    // it against itself keeps a relative href meaningful and never throws.
    try { return new URL(location.href, location.href).href; } catch { return location.href; }
  }

  const TOP = (() => {
    try { return !globalThis.top || globalThis.top === globalThis; } catch { return false; }
  })();
  // The surface the host classified the target as, and the surface the live
  // location actually shows. The observed one wins when it exists, so a script
  // that survives into a later document — or a SPA route change — can never
  // mount the selectors of a page it is no longer looking at. The declaration is
  // only used where no location exists at all, which is not a browser document.
  const HREF = currentHref();
  const DECLARED = SURFACES[globalThis.__kwgTranslationConfig?.surface]
    ? globalThis.__kwgTranslationConfig.surface : 'work';
  const SURFACE = HREF ? surfaceOf(HREF) : DECLARED;
  const SURFACE_DEF = SURFACES[SURFACE] || null;
  const GENERATION = Number.isInteger(globalThis.__kwgTranslationGeneration)
    ? globalThis.__kwgTranslationGeneration : 0;

  const engine = { version: VERSION, configure, stop, status };
  const doc = globalThis.document;
  let legacy = globalThis.__kctWork || globalThis.window?.__kctWork;
  if (legacy?.version >= 4 && typeof legacy.dispose === 'function') {
    try { legacy.dispose(); } catch {}
    legacy = globalThis.__kctWork || globalThis.window?.__kctWork;
  }

  function statusObject(state) {
    return { state, version: VERSION };
  }

  // Declared here so the early-return paths below can report an empty
  // capability snapshot without touching the engine state that does not exist
  // yet on those paths.
  let state = null;

  function install(value) {
    try {
      Object.defineProperty(globalThis, ENGINE, { value, configurable: true, writable: true, enumerable: false });
    } catch {
      try { globalThis[ENGINE] = value; } catch { /* host will report inactive */ }
    }
    return value;
  }

  // A page that is not the declared surface, or not the top-level document,
  // gets an engine that reports why and refuses to do anything: no observer, no
  // DOM, no binding traffic.
  if (SURFACE === 'other' || !SURFACE_DEF || !TOP) {
    install({
      version: VERSION,
      configure: () => statusReport('inactive'),
      stop: () => statusReport('inactive'),
      status: () => statusReport('inactive'),
    });
    return statusReport('inactive');
  }

  // Capability snapshot for the host. `blocks` counts the roots that still show
  // the expected interior structure; `seenBlocks` counts every root the page
  // renders. seen > blocks proves the selectors drifted from the running build,
  // and seen === 0 is an empty conversation, not verified structure: the host
  // must be able to tell those apart instead of reading both as "working".
  function capability() {
    if (!doc || typeof doc.querySelectorAll !== 'function' || !state) return null;
    const seen = doc.querySelectorAll(SURFACE_DEF.root)?.length || 0;
    const structured = [...state.live].filter(ctx => ctx.block.isConnected
      && ctx.surface.structured(ctx.block)).length;
    return {
      blocks: structured,
      seenBlocks: seen,
      structure: !seen ? 'none' : structured < seen ? 'partial' : 'matched',
    };
  }

  function statusReport(state) {
    const value = statusObject(state);
    value.surface = SURFACE;
    value.top = TOP;
    const snapshot = capability();
    if (snapshot) Object.assign(value, snapshot);
    return value;
  }

  // A re-injection happens on every attach (renderer reload, pipe restart). The
  // previous engine must be stopped first, and its DOM removed, or the page
  // would accumulate bars, mirrors and observers across injections. Its bounded
  // cache is carried over so a re-injection does not re-request paid text.
  function retirePrevious() {
    const previous = globalThis[ENGINE];
    // Duck-typed: a re-injection can land in a different realm where the old
    // Map is not `instanceof` this context's Map.
    const cache = previous && previous.__cache;
    const carried = cache && typeof cache.get === 'function' && typeof cache.set === 'function' ? cache : new Map();
    if (previous && typeof previous.stop === 'function') {
      try { previous.stop(); } catch { /* a hostile/unrelated object is replaced below */ }
    }
    const style = doc.getElementById ? doc.getElementById(`${NS}-style`) : null;
    if (style && typeof style.remove === 'function') style.remove();
    for (const node of doc.querySelectorAll?.(`[${ATTR}]`) || []) {
      if (node.getAttribute?.(ATTR) && typeof node.remove === 'function') node.remove();
    }
    // Both surfaces hide their own content with this class; whichever one the
    // previous engine touched has to be released, or the page keeps a blank
    // reasoning area after translation is withdrawn.
    for (const block of doc.querySelectorAll?.(`.${CLASS.hiding}`) || []) {
      if (block.classList?.contains(CLASS.hiding)) block.classList.remove(CLASS.hiding);
    }
    return carried;
  }

  // retirePrevious() reads the old engine, so it must run before the new one is
  // installed; when there is no document at all there is nothing to retire.
  if (legacy) {
    install({
      version: VERSION,
      configure: () => statusObject('legacy-running'),
      stop: () => statusObject('legacy-running'),
      status: () => statusObject('legacy-running'),
    });
    return statusObject('legacy-running');
  }

  if (!doc || typeof doc.createElement !== 'function' || !doc.body) {
    // Nothing can be translated without a document to translate in, but the
    // answer still states which surface this script believes it is in and
    // whether it is the top-level one: the host refuses a payload that cannot
    // prove either, and "no document" must not read as "some other page".
    install({
      version: VERSION,
      configure: () => statusReport('inactive'),
      stop: () => statusReport('inactive'),
      status: () => statusReport('inactive'),
    });
    return statusReport('inactive');
  }

  const carriedCache = retirePrevious();
  state = {
    active: false,
    // Every start() gets a new epoch. Anything captured under an older epoch
    // (a pending reply, a queued task, a timer callback) is dead: it may not
    // touch the DOM, the cache, the counters or the queue of the new run.
    epoch: 0,
    settings: readSettings(globalThis.__kwgTranslationConfig),
    cache: carriedCache,
    cacheChars: [...carriedCache.values()].reduce((total, value) => total + (typeof value === 'string' ? value.length : 0), 0),
    failures: new Map(),
    waiters: new Map(),
    queue: [],
    activeRequests: 0,
    seq: 0,
    live: new Set(),
    ctxs: new WeakMap(),
    observer: null,
    scanTimer: 0,
    startupTimer: 0,
    bootHandler: null,
    style: null,
    route: null,
    leftSurface: false,
  };

  // ---------------------------------------------------------------- settings
  function readSettings(value) {
    const out = { enabled: false, provider: 'bing', targetLanguage: 'zh', view: 'translated' };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    if (typeof value.enabled === 'boolean') out.enabled = value.enabled;
    if (PROVIDERS.includes(value.provider)) out.provider = value.provider;
    if (LANGUAGES.includes(value.targetLanguage)) out.targetLanguage = value.targetLanguage;
    if (VIEWS.includes(value.view)) out.view = value.view;
    return out;
  }

  function failure(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function safeCode(value) {
    return typeof value === 'string' && /^translation_[a-z_]{1,40}$/.test(value) ? value : 'translation_failed';
  }

  function labelFor(code) {
    return ERROR_LABELS[code] || '翻译失败';
  }

  // ------------------------------------------------------------------- cache
  function cacheKey(text) {
    return `${state.settings.provider}|${state.settings.targetLanguage}|${text}`;
  }

  function remember(key, text) {
    if (state.cache.has(key)) return;
    state.cache.set(key, text);
    state.cacheChars += text.length;
    while (state.cache.size > MAX_CACHE_ENTRIES || state.cacheChars > MAX_CACHE_CHARS) {
      const oldest = state.cache.keys().next();
      if (oldest.done) break;
      state.cacheChars -= (state.cache.get(oldest.value) || '').length;
      state.cache.delete(oldest.value);
    }
  }

  function recentFailure(key) {
    const at = state.failures.get(key);
    if (!at) return false;
    if (Date.now() - at < FAILURE_TTL_MS) return true;
    state.failures.delete(key);
    return false;
  }

  // -------------------------------------------------------------- host bridge
  function nextId() {
    state.seq += 1;
    return `${NS}-${state.seq.toString(36)}-${Date.now().toString(36)}`;
  }

  // The CDP binding is fire-and-forget: it returns nothing, so the reply is
  // matched by id through __kwgTranslationReceive and bounded by a timer. The
  // host stamps every injection with a generation and drops a request that
  // carries an older one, so a reply can never cross a navigation boundary.
  function requestTranslation(text, protectedTexts) {
    if (text.length > 120000) return Promise.reject(failure('translation_text_too_large'));
    const binding = globalThis.__kwgTranslate;
    if (typeof binding !== 'function') return Promise.reject(failure('translation_unavailable'));
    const id = nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state.waiters.delete(id)) reject(failure('translation_timeout'));
      }, REPLY_TIMEOUT_MS);
      state.waiters.set(id, { resolve, reject, timer });
      try {
        binding(JSON.stringify({ type: 'translate', id, generation: GENERATION, text, protectedTexts }));
      } catch {
        clearTimeout(timer);
        state.waiters.delete(id);
        reject(failure('translation_unavailable'));
      }
    });
  }

  const receive = (id, payload) => {
    // Host failures must never surface as exceptions inside the evaluation.
    try {
      if (typeof id !== 'string' || !id) return;
      let message = payload;
      if (typeof message === 'string') {
        try { message = JSON.parse(message); } catch { message = null; }
      }
      if (!message || typeof message !== 'object') return;
      if (message.id !== undefined && message.id !== id) return;
      const waiter = state.waiters.get(id);
      if (!waiter) return;
      state.waiters.delete(id);
      clearTimeout(waiter.timer);
      if (typeof message.error === 'string' && message.error) {
        waiter.reject(failure(safeCode(message.error)));
        return;
      }
      if (typeof message.text !== 'string' || message.text.length > MAX_REPLY_CHARS) {
        waiter.reject(failure('translation_invalid_response'));
        return;
      }
      waiter.resolve(message.text);
    } catch { /* ignore malformed host messages */ }
  };
  try {
    Object.defineProperty(globalThis, '__kwgTranslationReceive', {
      value: receive, configurable: true, writable: true, enumerable: false,
    });
  } catch {
    globalThis.__kwgTranslationReceive = receive;
  }

  // ------------------------------------------------------------------ source
  function visibleText(node) {
    if (!node) return '';
    if (typeof node.innerText === 'string' && node.innerText.trim()) return node.innerText;
    return typeof node.textContent === 'string' ? node.textContent : '';
  }

  // While the translation is shown, the engine's own hiding rule removes the
  // source from layout. In a real DOM innerText of a hidden subtree falls back
  // to textContent, which loses the block boundaries a rendered <p>/<pre>
  // contributes, so the next scan would read slightly different text and
  // retranslate the same content. The class is removed for the duration of the
  // read and restored immediately, so layout never paints in between.
  function readSourceText(block, surface) {
    const node = surface.source(block);
    if (!node) return '';
    const hidden = block.classList.contains(CLASS.hiding);
    if (hidden) block.classList.remove(CLASS.hiding);
    try {
      return visibleText(node).replace(/\r\n?/g, '\n').trim();
    } finally {
      if (hidden) block.classList.add(CLASS.hiding);
    }
  }

  // pre/code/a keep their visible text verbatim. innerText already carries the
  // code text without Markdown fences, so the service protects these exact
  // strings instead of guessing from formatting.
  //
  // Protection is bounded as a whole, never by silently dropping entries: if
  // the code blocks exceed the budget the caller must show the original rather
  // than send code to a translator.
  function protectedTexts(block, surface) {
    const node = surface.source(block);
    if (!node) return { values: [], overflow: false };
    const collected = [];
    const seen = new Set();
    let chars = 0;
    for (const selector of ['pre', 'code', 'a']) {
      const list = node.querySelectorAll(selector) || [];
      for (const element of list) {
        const value = visibleText(element);
        if (!value.trim() || seen.has(value)) continue;
        seen.add(value);
        if (collected.length >= MAX_PROTECTED_ITEMS || chars + value.length > MAX_PROTECTED_CHARS) {
          return { values: [], overflow: true };
        }
        collected.push(value);
        // The trimmed form is what actually appears in the extracted source.
        const trimmed = value.trim();
        if (trimmed !== value) {
          if (chars + trimmed.length > MAX_PROTECTED_CHARS) return { values: [], overflow: true };
          collected.push(trimmed);
        }
        chars += value.length;
      }
    }
    const values = [...new Set(collected)];
    let total = 0;
    for (const value of values) total += value.length;
    if (values.length > MAX_PROTECTED_ITEMS || total > MAX_PROTECTED_CHARS) return { values: [], overflow: true };
    return { values, overflow: false };
  }

  // ------------------------------------------------------------------ mirror
  function detach(node) {
    if (!node) return;
    if (node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node);
    else if (typeof node.remove === 'function') node.remove();
  }

  function ensureMirror(ctx) {
    if (ctx.mirror && ctx.mirror.parentNode === ctx.block) return;
    detach(ctx.mirror);
    const mirror = doc.createElement('div');
    mirror.className = CLASS.translated;
    mirror.setAttribute(ATTR, 'translated');
    const reference = ctx.surface.anchor(ctx.block);
    ctx.block.insertBefore(mirror, reference);
    ctx.mirror = mirror;
  }

  // A collapsed block never shows a translation: Work has no body left to
  // replace, and Chat keeps the body in the DOM but animates it out of sight,
  // so leaving the mirror visible would put text on screen that the user did
  // not expand.
  function syncVisibility(ctx) {
    const show = state.settings.view === 'translated' && !!ctx.translation && ctx.surface.expanded(ctx.block);
    if (ctx.mirror) {
      ctx.mirror.hidden = !show;
      if (ctx.mirror.textContent !== ctx.translation) ctx.mirror.textContent = ctx.translation;
    }
    if (show) ctx.block.classList.add(CLASS.hiding);
    else ctx.block.classList.remove(CLASS.hiding);
    ctx.rendered = show;
    updateButtons(ctx);
  }

  function updateButtons(ctx) {
    for (const button of ctx.buttons) {
      const target = button.dataset.view;
      button.setAttribute('aria-pressed', String(target === state.settings.view));
    }
  }

  function setStatus(ctx, text, kind) {
    ctx.statusEl.textContent = text;
    if (kind) ctx.statusEl.dataset.state = kind;
    else delete ctx.statusEl.dataset.state;
  }

  function applyTranslation(ctx, value) {
    ctx.translation = value;
    ensureMirror(ctx);
    syncVisibility(ctx);
    setStatus(ctx, '', '');
  }

  function clearTranslation(ctx) {
    ctx.translation = '';
    ctx.rendered = false;
    detach(ctx.mirror);
    ctx.mirror = null;
    ctx.block.classList.remove(CLASS.hiding);
    setStatus(ctx, '', '');
  }

  // ------------------------------------------------------------------ engine
  function ensureStyles() {
    if (state.style && state.style.parentNode) return;
    const existing = doc.getElementById ? doc.getElementById(CLASS.style) : null;
    if (existing) { state.style = existing; return; }
    const style = doc.createElement('style');
    style.id = CLASS.style;
    style.textContent = `
.${CLASS.bar}{display:flex;align-items:center;gap:2px;margin:2px 0 0;font:12px/18px var(--font-ui,system-ui);color:var(--Labels-Secondary,#888)}
.${CLASS.btn}{font:inherit;color:inherit;background:transparent;border:0;padding:0 5px;border-radius:4px;cursor:pointer;white-space:nowrap}
.${CLASS.btn}:hover{background:var(--Fills-F2,rgba(128,128,128,.12));color:var(--Labels-Primary,inherit)}
.${CLASS.btn}[aria-pressed="true"]{color:var(--Labels-Primary,inherit);font-weight:600}
.${CLASS.status}{opacity:.75;border:0;background:transparent;color:inherit;font:inherit;padding:0 4px}
.${CLASS.status}[data-state="error"]{color:var(--Labels-Danger,#b9433e);opacity:1}
.${CLASS.status}[data-state="busy"]{opacity:.55}
.${CLASS.note}{margin-left:auto;opacity:.5;font-size:11px;white-space:nowrap}
.${CLASS.hiding} > .think-body-wrap{display:none !important}
.${CLASS.hiding} > .resize-container{display:none !important}
.think-block:not(:has(> .think-summary[aria-expanded="true"])) > .${CLASS.translated}{display:none !important}
.toolcall-container.thinking-container:not(.is-expanded) > .${CLASS.translated}{display:none !important}
.${CLASS.translated}{max-height:340px;overflow-y:auto;overscroll-behavior-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--markdown-B1_Content-font-size,14px);line-height:var(--markdown-B1_Content-line-height,1.65);color:var(--Labels-Primary,inherit)}
.${CLASS.translated}[hidden]{display:none !important}
`;
    (doc.head || doc.body).appendChild(style);
    state.style = style;
  }

  function mount(block) {
    if (state.ctxs.has(block)) return state.ctxs.get(block);
    if (!SURFACE_DEF.structured(block)) return null;
    const bar = doc.createElement('div');
    bar.className = CLASS.bar;
    bar.setAttribute(ATTR, 'bar');
    const makeButton = (view, text) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = `${CLASS.btn} ${CLASS.view}`;
      button.dataset.view = view;
      button.textContent = text;
      button.setAttribute('aria-pressed', String(view === state.settings.view));
      return button;
    };
    const translatedBtn = makeButton('translated', '译文');
    const originalBtn = makeButton('original', '原文');
    const retryBtn = doc.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = CLASS.btn;
    retryBtn.textContent = '重译';

    const statusEl = doc.createElement('span');
    statusEl.className = CLASS.status;
    statusEl.setAttribute('role', 'status');

    const note = doc.createElement('span');
    note.className = CLASS.note;
    note.textContent = '由网关管理';
    note.title = '翻译服务、密钥与目标语言在网关面板中设置';

    bar.append(translatedBtn, originalBtn, retryBtn, statusEl, note);

    // The bar goes above the reasoning content and below the surface's own
    // header, so the header keeps its click target and the controls stay with
    // the block they belong to.
    block.insertBefore(bar, SURFACE_DEF.barAnchor(block));

    const ctx = {
      block, bar, statusEl, buttons: [translatedBtn, originalBtn], retryBtn,
      surface: SURFACE_DEF,
      source: '', translation: '', rendered: false, mirror: null,
      token: 0, timer: 0, pending: [], lastMutation: NaN,
    };
    state.ctxs.set(block, ctx);
    state.live.add(ctx);

    const stop = event => { if (event?.preventDefault) event.preventDefault(); if (event?.stopPropagation) event.stopPropagation(); };
    translatedBtn.addEventListener('click', (event) => {
      stop(event);
      if (state.settings.view === 'translated') return;
      state.settings.view = 'translated';
      applyView();
    });
    originalBtn.addEventListener('click', (event) => {
      stop(event);
      if (state.settings.view === 'original') return;
      state.settings.view = 'original';
      applyView();
    });
    // A retranslation is a new request: the cached value and any in-flight
    // reply become stale, so the current token is retired first.
    retryBtn.addEventListener('click', (event) => {
      stop(event);
      ctx.token += 1;
      ctx.translation = '';
      const key = cacheKey(ctx.source);
      state.cache.delete(key);
      state.failures.delete(key);
      detach(ctx.mirror);
      ctx.mirror = null;
      block.classList.remove(CLASS.hiding);
      state.settings.view = 'translated';
      applyView();
      schedule(ctx, 0);
    });

    return ctx;
  }

  function drop(ctx) {
    clearTimeout(ctx.timer);
    ctx.timer = 0;
    // Retiring the token makes every reply still in flight for this context
    // stale, so a late answer cannot repaint a block that is no longer ours.
    ctx.token += 1;
    ctx.pending = [];
    detach(ctx.mirror);
    ctx.mirror = null;
    detach(ctx.bar);
    ctx.block.classList.remove(CLASS.hiding);
    state.ctxs.delete(ctx.block);
    state.live.delete(ctx);
  }

  function applyView() {
    for (const ctx of [...state.live]) {
      if (!ctx.block.isConnected) { drop(ctx); continue; }
      syncVisibility(ctx);
      if (!ctx.translation && ctx.source) schedule(ctx, 0);
    }
  }

  // --------------------------------------------------------------- scheduling
  function schedule(ctx, delay = SETTLE_MS) {
    if (!state.active) return;
    const epoch = state.epoch;
    clearTimeout(ctx.timer);
    ctx.timer = setTimeout(() => {
      ctx.timer = 0;
      if (state.epoch !== epoch || !state.active) return;
      refresh(ctx);
    }, delay);
  }

  function refresh(ctx) {
    if (!state.active) return;
    if (!ctx.block.isConnected) { drop(ctx); return; }
    const surface = ctx.surface;
    const text = readSourceText(ctx.block, surface);
    // Collapsing Work removes .think-body (a v-if node), so a missing source
    // while the block is still present means "temporarily collapsed", not
    // "empty": the mirror is anchored to the block and must survive the
    // collapse. Chat keeps the text in a collapsed block, so the expansion
    // state below is what decides there.
    if (!text) {
      if (!ctx.source) clearTranslation(ctx);
      else syncVisibility(ctx);
      return;
    }
    if (text !== ctx.source) {
      // Any content change retires replies and the mirror for the old text.
      ctx.token += 1;
      ctx.source = text;
      ctx.translation = '';
      detach(ctx.mirror);
      ctx.mirror = null;
      ctx.block.classList.remove(CLASS.hiding);
      setStatus(ctx, '', '');
    }
    // A collapsed block is not visible, whatever its DOM contains. Keeping its
    // existing translation is right; sending the text it hides is not.
    if (!surface.expanded(ctx.block)) { syncVisibility(ctx); return; }
    // Chat marks a still-running block with .enable-grow-animation; Work's
    // equivalent is the label heuristic below.
    if (!surface.settled(ctx.block)) { syncVisibility(ctx); return; }
    // Content-quiet window, independent of the settle heuristic: text that
    // mutated inside QUIET_MS is still streaming (or mutating under a future
    // Kimi whose label wording the heuristic cannot read), so dispatching it
    // would pay for a partial translation that is immediately invalidated.
    // A freshly mounted context starts inside the window (NaN comparison is
    // always false, so the explicit flag below), because a mount can land in
    // the middle of a stream. A held dispatch reschedules itself once, for the
    // remaining window — a block at rest is sent, a streaming block keeps being
    // pushed forward until the mutations stop.
    const quietFor = Number.isFinite(ctx.lastMutation) ? QUIET_MS - (Date.now() - ctx.lastMutation) : 0;
    if (quietFor > 0) { schedule(ctx, quietFor + 50); return; }
    const key = cacheKey(text);
    if (state.cache.has(key)) { applyTranslation(ctx, state.cache.get(key)); return; }
    if (recentFailure(key)) { setStatus(ctx, '稍后重试', 'error'); return; }
    if (ctx.translation) return;
    // Only the same text is de-duplicated. A newer text is dispatched at once
    // with the new token, so the older reply can never match this context.
    const pending = ctx.pending.filter(entry => entry.token === ctx.token);
    ctx.pending = pending;
    if (pending.some(entry => entry.key === key)) return;
    const protectedSet = protectedTexts(ctx.block, surface);
    // Unbounded code cannot be protected, so the text is left as the original
    // with an explicit error instead of being sent to a translator unprotected.
    if (protectedSet.overflow) { setStatus(ctx, '代码内容过长，未翻译', 'error'); return; }
    const task = { ctx, epoch: state.epoch, token: ctx.token, key, text, protected: protectedSet.values };
    ctx.pending.push(task);
    enqueue(task);
  }

  function enqueue(task) {
    state.queue.push(task);
    pump();
  }

  // The counter is a local of the current run: jobs of a retired run decrement
  // their own counter, never the one belonging to the run that replaced them.
  // Without that, a teardown that resets the counter and a late finally that
  // decrements it again would push it negative and let a new run exceed
  // MAX_ACTIVE.
  function pump() {
    while (state.active && state.activeRequests < MAX_ACTIVE && state.queue.length) {
      const task = state.queue.shift();
      if (!isCurrent(task)) continue;
      const run = task.epoch;
      state.activeRequests += 1;
      setStatus(task.ctx, '翻译中…', 'busy');
      execute(task).catch(() => {}).finally(() => {
        if (state.epoch !== run) return;
        state.activeRequests = Math.max(0, state.activeRequests - 1);
        if (state.active) pump();
      });
    }
  }

  // A queued or in-flight task is only allowed to finish current work: the run
  // must be the same epoch, the context must still be mounted and connected,
  // and its token must not have been retired in the meantime.
  function isCurrent(task) {
    return state.active && task.epoch === state.epoch && task.token === task.ctx.token
      && state.live.has(task.ctx);
  }

  async function execute(task) {
    const { ctx, token, key, text } = task;
    let reply = '';
    let code = '';
    try {
      reply = await requestTranslation(text, task.protected);
    } catch (error) {
      code = safeCode(error?.code || error?.message);
    }
    ctx.pending = ctx.pending.filter(entry => entry !== task);
    // A retired run or a retired context must not write cache, status or mirror.
    if (!isCurrent(task)) return;
    if (code) {
      state.failures.set(key, Date.now());
      if (ctx.token === token) setStatus(ctx, labelFor(code), 'error');
    } else {
      remember(key, reply);
      state.failures.delete(key);
      if (ctx.token === token && ctx.source === text) applyTranslation(ctx, reply);
    }
  }

  // ------------------------------------------------------------------- route
  // Chat is a SPA: moving to /settings or another conversation keeps the same
  // document, so no new-document script runs and no execution context is
  // cleared. Without this the engine would keep bars and mirrors on a page that
  // no longer shows reasoning at all. When there is no location to read, the
  // document that was already classified at boot is still the one in front of
  // us; there is no route to leave.
  function onSurface() {
    const href = currentHref();
    return !href || surfaceOf(href) === SURFACE;
  }

  function leaveSurface() {
    teardown();
    state.settings = { ...state.settings, enabled: false };
    state.leftSurface = true;
  }

  function watchRoute() {
    const target = globalThis;
    if (state.route || typeof target.addEventListener !== 'function') return;
    const handler = () => scheduleScan(40);
    const route = { handler, owner: null, pushState: null, replaceState: null };
    target.addEventListener('popstate', handler);
    target.addEventListener('hashchange', handler);
    const history = target.history;
    if (history && typeof history.pushState === 'function' && typeof history.replaceState === 'function') {
      for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        const wrapped = function (...args) {
          const result = original.apply(this, args);
          try { handler(); } catch { /* the next scan reports the route anyway */ }
          return result;
        };
        try { history[name] = wrapped; route[name] = original; route.owner = history; } catch { /* frozen history */ }
      }
    }
    state.route = route;
  }

  function unwatchRoute() {
    const route = state.route;
    if (!route) return;
    state.route = null;
    globalThis.removeEventListener?.('popstate', route.handler);
    globalThis.removeEventListener?.('hashchange', route.handler);
    if (route.owner) {
      try { route.owner.pushState = route.pushState; route.owner.replaceState = route.replaceState; } catch {}
    }
  }

  // ---------------------------------------------------------------- observer
  function scan() {
    if (!state.active) return;
    if (!onSurface()) { leaveSurface(); return; }
    const blocks = doc.querySelectorAll(SURFACE_DEF.root) || [];
    for (const block of blocks) mount(block);
    for (const ctx of [...state.live]) {
      if (!ctx.block.isConnected) { drop(ctx); continue; }
      refresh(ctx);
    }
  }

  function scheduleScan(delay = SCAN_MS) {
    if (!state.active) return;
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => { state.scanTimer = 0; scan(); }, delay);
  }

  // A mutation inside a tracked context marks its content as freshly mutated
  // (for the quiet window). Mutations the engine itself caused (any node with
  // our attribute, including toolbar buttons and mirrors) are ignored, so our
  // own painting can never reschedule or retranslate: without this, a mirror
  // update would restart the quiet window after every reply and repeatedly
  // delay or duplicate the next dispatch. A childList mutation on a container
  // (the conversation list itself) is also relevant: that is how new reasoning
  // blocks are appended, and the target is not inside any block.
  function trackedTarget(record) {
    const target = record?.target;
    if (!target || typeof target.closest !== 'function') return null;
    if (target.closest(`[${ATTR}]`)) return null;
    const block = target.closest(SURFACE_DEF.root);
    if (block) return block;
    if (record.type === 'childList'
      && [...record.addedNodes || [], ...record.removedNodes || []]
        .some(node => node && typeof node.matches === 'function' && node.matches(SURFACE_DEF.root))) return target;
    return null;
  }

  function onMutations(records) {
    if (!state.active) return;
    let relevant = false;
    for (const record of records) {
      const block = trackedTarget(record);
      if (!block) continue;
      relevant = true;
      const ctx = state.ctxs.get(block);
      if (ctx && record.type !== 'attributes') ctx.lastMutation = Date.now();
    }
    if (relevant) scheduleScan();
  }

  function start() {
    if (state.active || !doc.body) return;
    if (!onSurface()) { state.leftSurface = true; return; }
    state.active = true;
    state.epoch += 1;
    ensureStyles();
    if (SURFACE === 'chat') watchRoute();
    if (!state.observer && typeof globalThis.MutationObserver === 'function') {
      state.observer = new globalThis.MutationObserver(onMutations);
      state.observer.observe(doc.body, {
        childList: true, subtree: true, characterData: true, attributes: true,
        // aria-expanded is the Work collapse signal; class carries the Chat
        // equivalents (is-expanded, enable-grow-animation).
        attributeFilter: ['aria-expanded', 'class'],
      });
    }
    scan();
    clearTimeout(state.startupTimer);
    const epoch = state.epoch;
    state.startupTimer = setTimeout(() => {
      state.startupTimer = 0;
      if (state.epoch === epoch && state.active) scan();
    }, 1200);
  }

  function teardown(resetFailures = false) {
    state.active = false;
    // Retiring the epoch makes every timer, queued task and pending reply of
    // this run dead, even if the next run starts before they settle.
    state.epoch += 1;
    unwatchRoute();
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    clearTimeout(state.scanTimer);
    clearTimeout(state.startupTimer);
    state.scanTimer = 0;
    state.startupTimer = 0;
    for (const ctx of [...state.live]) drop(ctx);
    state.live.clear();
    for (const waiter of state.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(failure('translation_aborted'));
    }
    state.waiters.clear();
    state.queue.length = 0;
    state.activeRequests = 0;
    // The cache is bounded in memory and holds only finished translations, so
    // it survives a stop: re-enabling must not re-request text already paid for.
    // Failures are scoped to the settings that produced them, so a configure
    // with a new provider/language starts clean; a plain stop keeps them until
    // their TTL expires.
    if (resetFailures) state.failures.clear();
    if (state.style) { detach(state.style); state.style = null; }
    if (state.bootHandler) {
      doc.removeEventListener?.('DOMContentLoaded', state.bootHandler);
      state.bootHandler = null;
    }
  }

  // __kwgTranslationConfig belongs to the host: it is read at boot and never
  // written back, so a stop here cannot change what the next injection sees.
  //
  // A configure that changes what a translation means (provider or target
  // language) starts a new scope: cached translations and recorded failures
  // measured under the old scope are dropped together with the contexts, so a
  // late reply of the old scope can neither paint nor poison the new one.
  function configure(settings) {
    const next = readSettings(settings && typeof settings === 'object' ? settings : {});
    const rescope = next.provider !== state.settings.provider || next.targetLanguage !== state.settings.targetLanguage;
    if (state.active) teardown(rescope);
    if (rescope) { state.cache.clear(); state.cacheChars = 0; }
    state.settings = next;
    if (next.enabled && !state.leftSurface) start();
    return statusReport(state.active ? 'active' : 'inactive');
  }

  function stop() {
    teardown();
    state.settings = { ...state.settings, enabled: false };
    return statusReport('inactive');
  }

  function status() {
    return statusReport(state.active ? 'active' : 'inactive');
  }

  // Exposed for the next injection only: the bounded cache survives a reload of
  // this script so already-translated text is not requested (and paid) twice.
  Object.defineProperty(engine, '__cache', { value: state.cache, enumerable: false });

  install(engine);

  if (!state.settings.enabled) return statusReport('inactive');
  if (doc.body) start();
  else {
    state.bootHandler = () => { state.bootHandler = null; start(); };
    doc.addEventListener?.('DOMContentLoaded', state.bootHandler, { once: true });
  }
  return statusReport(state.active ? 'active' : 'inactive');
})();
