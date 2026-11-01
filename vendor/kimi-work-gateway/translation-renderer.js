// Kimi Work reasoning translation - CDP renderer payload (gateway edition).
//
// The gateway host injects this IIFE and uses its return value as proof that
// the engine is really running in a Kimi renderer. Translation itself happens
// in the host process: this script only forwards the visible reasoning text
// over the `__kwgTranslate` binding and paints what comes back.
//
// Structure verified on 3.2.21:
//
//   .think-block
//     .think-summary          collapse toggle, aria-expanded
//     .think-body-wrap
//       .think-body           v-if: only exists while expanded
//         .chat-markdown      the rendered reasoning
//
// The mirror is anchored to .think-block, not to .think-body, because Vue
// drops the body subtree on collapse and on re-render. Hiding the source hides
// the whole reasoning subtree, so the translation occupies exactly the same
// space with Kimi's own width, scroll area and collapse state.
//
// The selectors above describe the Kimi build this file was written against;
// they are not trusted as a compatibility proof. `status()` reports how many
// `.think-block` nodes the page actually contains (`seenBlocks`) and how many
// exposed the expected summary/body structure (`blocks`), so the host can
// distinguish an empty conversation from a drifted DOM instead of presenting
// an unmatched page as a working translation. Dispatching is additionally
// gated on a content-quiet window that never looks at label wording: a future
// Kimi that renames its "thinking" status cannot turn streamed partial text
// into a paid retranslation every scan.
(() => {
  'use strict';
  const VERSION = 1;
  const ENGINE = '__kwgTranslation';
  const NS = 'kwg';
  const BLOCK = '.think-block';
  const SUMMARY = '.think-summary';
  const LABEL = '.think-label';
  const BODY = '.think-body';
  const BODY_WRAP = '.think-body-wrap';
  const MARKDOWN = '.chat-markdown';

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

  // Capability snapshot for the host. `blocks` counts the mounted contexts that
  // still show the expected summary/body structure; `seenBlocks` counts every
  // `.think-block` the page renders. A page with seenBlocks > blocks proves the
  // selectors drifted from the running Kimi build, which must surface as a
  // structural note instead of a silently "working" engine. DOM readiness is
  // only claimed once the mountable structure was actually seen or the page
  // has none of the blocks at all (an empty conversation is still ready).
  function capability() {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    const seen = doc.querySelectorAll(BLOCK)?.length || 0;
    const structured = [...state.live].filter(ctx => ctx.block.isConnected
      && (ctx.block.querySelector(SUMMARY) || ctx.block.querySelector(BODY))).length;
    return { blocks: structured, seenBlocks: seen };
  }

  function statusReport(state) {
    const value = statusObject(state);
    const snapshot = capability();
    if (snapshot) { value.blocks = snapshot.blocks; value.seenBlocks = snapshot.seenBlocks; }
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
    for (const block of doc.querySelectorAll?.(BLOCK) || []) {
      if (block.classList?.contains(CLASS.hiding)) block.classList.remove(CLASS.hiding);
    }
    return carried;
  }

  function install(value) {
    try {
      Object.defineProperty(globalThis, ENGINE, { value, configurable: true, writable: true, enumerable: false });
    } catch {
      try { globalThis[ENGINE] = value; } catch { /* host will report inactive */ }
    }
    return value;
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
    install({
      version: VERSION,
      configure: () => statusObject('inactive'),
      stop: () => statusObject('inactive'),
      status: () => statusObject('inactive'),
    });
    return statusObject('inactive');
  }

  const carriedCache = retirePrevious();
  const state = {
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
  // matched by id through __kwgTranslationReceive and bounded by a timer.
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
        binding(JSON.stringify({ type: 'translate', id, text, protectedTexts }));
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

  function sourceNode(block) {
    const body = block.querySelector(BODY);
    const scope = body || block;
    return scope.querySelector(MARKDOWN) || body || null;
  }

  // While the translation is shown, the engine's own hiding rule sets
  // `display:none` on .think-body-wrap. In a real DOM innerText of a hidden
  // subtree falls back to textContent, which loses the block boundaries a
  // rendered <p>/<pre> contributes, so the next scan would read slightly
  // different text and retranslate the same content. The class is removed for
  // the duration of the read and restored immediately, so layout never paints
  // in between.
  function readSourceText(block) {
    const node = sourceNode(block);
    if (!node) return '';
    const hidden = block.classList.contains(CLASS.hiding);
    if (hidden) block.classList.remove(CLASS.hiding);
    try {
      return visibleText(node).replace(/\r\n?/g, '\n').trim();
    } finally {
      if (hidden) block.classList.add(CLASS.hiding);
    }
  }

  function sourceText(block) {
    return readSourceText(block);
  }

  // pre/code/a keep their visible text verbatim. innerText already carries the
  // code text without Markdown fences, so the service protects these exact
  // strings instead of guessing from formatting.
  //
  // Protection is bounded as a whole, never by silently dropping entries: if
  // the code blocks exceed the budget the caller must show the original rather
  // than send code to a translator.
  function protectedTexts(block) {
    const node = sourceNode(block);
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

  function isSettled(block) {
    const label = block.querySelector(LABEL) || block.querySelector(SUMMARY);
    const text = (label?.textContent || '').trim();
    if (!text) return true;
    if (/thinking|思考中/i.test(text) && !/thought|done|complete|完成/i.test(text)) return false;
    return true;
  }

  function isExpanded(block) {
    const summary = block.querySelector(SUMMARY);
    if (!summary) return true;
    const value = summary.getAttribute ? summary.getAttribute('aria-expanded') : summary.ariaExpanded;
    return value !== 'false';
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
    const wrap = ctx.block.querySelector(BODY_WRAP);
    const reference = wrap && wrap.parentNode === ctx.block ? wrap : null;
    ctx.block.insertBefore(mirror, reference);
    ctx.mirror = mirror;
  }

  function syncVisibility(ctx) {
    const show = state.settings.view === 'translated' && !!ctx.translation;
    if (ctx.mirror) {
      ctx.mirror.hidden = !show || !isExpanded(ctx.block);
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
.think-block:not(:has(> .think-summary[aria-expanded="true"])) > .${CLASS.translated}{display:none !important}
.${CLASS.translated}{max-height:340px;overflow-y:auto;overscroll-behavior-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--markdown-B1_Content-font-size,14px);line-height:var(--markdown-B1_Content-line-height,1.65);color:var(--Labels-Primary,inherit)}
.${CLASS.translated}[hidden]{display:none !important}
`;
    (doc.head || doc.body).appendChild(style);
    state.style = style;
  }

  function mount(block) {
    if (state.ctxs.has(block)) return state.ctxs.get(block);
    if (!block.querySelector(SUMMARY) && !block.querySelector(BODY)) return null;
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

    const summary = block.querySelector(SUMMARY);
    if (summary && summary.parentNode === block) block.insertBefore(bar, summary);
    else block.insertBefore(bar, block.firstChild);

    const ctx = {
      block, bar, statusEl, buttons: [translatedBtn, originalBtn], retryBtn,
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
    const text = sourceText(ctx.block);
    // Collapsing removes .think-body (a v-if node), so a missing source while
    // the block is still present means "temporarily collapsed", not "empty":
    // the mirror is anchored to the block and must survive the collapse.
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
    // Content-quiet window, independent of the settle heuristic: text that
    // mutated inside QUIET_MS is still streaming (or mutating under a future
    // Kimi whose label wording the heuristic cannot read), so dispatching it
    // would pay for a partial translation that is immediately invalidated.
    // A freshly mounted context starts inside the window (NaN comparison is
    // always false, so the explicit flag below), because a mount can land in
    // the middle of a stream. The check sits after the settled gate, so
    // already-translated or cached blocks never re-enter scheduling, and a
    // held dispatch reschedules itself once, for the remaining window — a
    // block at rest is sent, a streaming block keeps being pushed forward
    // until the mutations stop.
    if (!isSettled(ctx.block)) return;
    // A context whose content was never seen mutating is dispatched at once;
    // the quiet window only guards text that is actively changing, which is
    // exactly the case the settle heuristic cannot cover on a future Kimi.
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
    const protectedSet = protectedTexts(ctx.block);
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

  // ---------------------------------------------------------------- observer
  function scan() {
    if (!state.active) return;
    const blocks = doc.querySelectorAll(BLOCK) || [];
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
  // (the conversation list itself) is also relevant: that is how new think
  // blocks are appended, and the target is not inside any block.
  function trackedTarget(record) {
    const target = record?.target;
    if (!target || typeof target.closest !== 'function') return null;
    if (target.closest(`[${ATTR}]`)) return null;
    const block = target.closest(BLOCK);
    if (block) return block;
    if (record.type === 'childList'
      && [...record.addedNodes || [], ...record.removedNodes || []]
        .some(node => node && typeof node.matches === 'function' && node.matches(BLOCK))) return target;
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
    state.active = true;
    state.epoch += 1;
    ensureStyles();
    if (!state.observer && typeof globalThis.MutationObserver === 'function') {
      state.observer = new globalThis.MutationObserver(onMutations);
      state.observer.observe(doc.body, {
        childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-expanded'],
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
    if (next.enabled) start();
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
