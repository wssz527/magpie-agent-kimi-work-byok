import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';
import { readTranslationSettings, translationAlive, sameInstallation, translationRevision } from './translation-runtime.mjs';
import { normalizeTranslationConfig, reservedEnvName } from './translation-config.mjs';
import { TranslationPipe } from './translation-pipe.mjs';
import { translateReasoning } from './translation-service.mjs';
import { NativeDesktopBridge } from './native-desktop-bridge.mjs';
import { readRemoteRuntime, publicRemoteRuntime } from './remote-runtime-state.mjs';

// The standalone package ships the renderer beside this file; the repository
// keeps it under ui/. Either layout is valid, so the first existing one wins.
const RENDERER = [new URL('./translation-renderer.js', import.meta.url), new URL('../ui/translation-renderer.js', import.meta.url)]
  .map(url => fileURLToPath(url)).find(file => fs.existsSync(file)) || fileURLToPath(new URL('./translation-renderer.js', import.meta.url));
const safeReason = error => /^translation_[a-z0-9_-]{1,80}$/.test(error?.message) ? error.message : 'translation_session_failed';
const publicSettings = settings => Object.fromEntries(['enabled', 'provider', 'targetLanguage', 'view'].map(key => [key, settings[key]]));

// Only the desktop Chat origin that was actually observed is accepted. Widen
// this only with evidence from a real desktop session, never "to be safe": a
// defensive extra origin would let any page served there receive the reasoning
// text through this host.
const CHAT_ORIGIN = 'https://www.kimi.com';
const CHAT_PATHS = [/^\/chat\/[A-Za-z0-9_-]{1,128}$/, /^\/chat\/history$/, /^\/$/];

// Which reasoning surface a CDP target is, if any. `work` is the local renderer
// with .think-block; `chat` is the remote Kimi Chat page whose thinking blocks
// use a different component family. Everything else — settings, membership,
// plugins, a lookalike host, an iframe/worker — is `other` and receives no
// script, no binding and no reasoning text.
//
// The decision is repeated in the renderer and again on every binding, because
// a target keeps its CDP session across navigations: classification made once
// at attach time would outlive the page it was made for.
export function classifySurface(target) {
  if (target?.type !== 'page') return 'other';
  let url;
  try { url = new URL(target.url); } catch { return 'other'; }
  if (['file:', 'app:', 'kimi:'].includes(url.protocol)) return /\/kimi-agent\.html$/.test(url.pathname) ? 'work' : 'other';
  if (url.protocol === 'https:' && url.origin === CHAT_ORIGIN
    && CHAT_PATHS.some(pattern => pattern.test(url.pathname))) return 'chat';
  return 'other';
}

export function isTranslationTarget(target) {
  return classifySurface(target) !== 'other';
}

export class TranslationSession {
  constructor({ stateDir, id, env = process.env, spawnApp = spawn, translate = translateReasoning,
    pipeFactory = (readable, writable) => new TranslationPipe(readable, writable), interval = 1000,
    bridgeFactory = options => new NativeDesktopBridge(options), protectedEnvNames = [],
    prepareRemote = async options => {
      const { ensureRemoteCredentials } = await import('./remote-credentials.mjs');
      const { prepareRemoteCompanion } = await import('./remote-companion.mjs');
      const credentials = await ensureRemoteCredentials(options);
      return prepareRemoteCompanion({ ...options, credentials });
    } } = {}) {
    this.prepareRemote = prepareRemote;
    this.stateDir = stateDir;
    this.id = id;
    this.env = env;
    this.spawnApp = spawnApp;
    this.translate = translate;
    this.pipeFactory = pipeFactory;
    this.bridgeFactory = bridgeFactory;
    this.interval = interval;
    this.protectedEnvNames = protectedEnvNames.filter(name => typeof name === 'string' && name && !reservedEnvName(name));
    this.launchFile = path.join(stateDir, 'translation-launch.json');
    this.settingsFile = path.join(stateDir, 'translation-settings.json');
    this.receiptFile = path.join(stateDir, 'translation-runtime.json');
    this.sessions = new Map();
    // Entries whose injection may still receive replies. A retired entry is one
    // whose page is gone; replies for it are dropped instead of written into
    // whatever document now occupies that session.
    this.live = new Set();
    this.jobs = new Map();
    this.status = 'starting';
    this.stopped = false;
  }

  remoteStatus() {
    if (this.request?.remoteModels !== true) return undefined;
    return readRemoteRuntime(this.stateDir, this.id, this.child?.pid)
      || publicRemoteRuntime(this.remotePreparationStatus) || { state: 'starting' };
  }

  record() {
    const owner = readSubagentJSON(this.launchFile);
    if (owner.id !== this.id || owner.homeDir !== this.request.homeDir) throw Error('translation_session_conflict');
    const remote = this.remoteStatus();
    const surfaces = this.surfaceSummary();
    writeSubagentJSON(this.receiptFile, { schemaVersion: 1, id: this.id, pid: process.pid,
      ...(Number.isInteger(this.child?.pid) ? { applicationPid: this.child.pid } : {}),
      ...(this.childApplication ? { runtimeApplication: this.childApplication } : {}),
      ...(remote ? { remote } : {}),
      ...(this.exit ? { exit: this.exit } : {}),
      ...(this.legacyInheritance ? { legacyInheritance: this.legacyInheritance } : {}),
      ...(surfaces ? { surfaces } : {}),
      homeDir: this.request.homeDir, version: this.request.version, revision: this.revision,
      state: this.status, ...(this.reason ? { reason: this.reason } : {}), at: Date.now() });
  }

  // Per-surface counts, so "Work is translating and Chat has no reasoning block
  // on screen" is a reported fact rather than a guess. `structure` comes from
  // the renderer: `none` is an empty conversation and never counts as verified
  // structure, `partial` is a page whose roots did not expose the expected
  // internals — the DOM-drift signal.
  surfaceSummary() {
    const out = {};
    for (const entry of this.sessions.values()) {
      if (!entry.surface || entry.state === undefined) continue;
      out[entry.surface] = { state: entry.state, ...(typeof entry.structure === 'string' ? { structure: entry.structure } : {}),
        ...(Number.isInteger(entry.blocks) ? { blocks: entry.blocks } : {}),
        ...(Number.isInteger(entry.seenBlocks) ? { seenBlocks: entry.seenBlocks } : {}) };
    }
    return Object.keys(out).length ? out : undefined;
  }

  // The waiting reason names the surface that is actually missing. A session
  // where only the Chat page is expected must not report "waiting for the Work
  // thinking page": that reads as a broken attachment instead of "no reasoning
  // block is on screen yet". A Work-only session keeps the existing code, so
  // older panel builds show what they already know how to say.
  waitingReason(entries) {
    return entries.some(entry => entry.surface === 'chat')
      ? 'translation_waiting_chat_view' : 'translation_waiting_work_view';
  }

  // Two lifecycles are kept apart on purpose.
  //
  // The execution world (mainContextId) is only discarded on real evidence that
  // the world ended: `Runtime.executionContextsCleared`, a destroyed context, or
  // a new main-frame document. Everything else — a settings save, a load event,
  // a same-document route change — leaves the world intact, because V8 does not
  // re-report existing contexts: `Runtime.enable` returns immediately once
  // enabled, so re-enabling after clearing our own record would lose a world
  // that is still perfectly valid.
  dropWorld(entry) {
    this.releaseInjection(entry);
    entry.mainContexts.clear();
    entry.mainContextId = undefined;
    entry.mainContextUniqueId = undefined;
    entry.bindingContextId = undefined;
  }

  // Retires the renderer acknowledgement without touching the world: the next
  // tick re-injects into the same world under a new generation, and anything the
  // previous document issued can no longer be delivered.
  invalidateAck(entry) {
    // The receipt of an injection in flight can no longer describe this entry,
    // so its waiters are released now rather than when that evaluation returns.
    this.releaseInjection(entry);
    entry.generation = (entry.generation ?? 0) + 1;
    entry.pendingContext?.clear();
    entry.revision = null;
    entry.state = undefined;
    this.live.delete(entry);
    for (const [key, job] of this.jobs) {
      if (key.startsWith(entry.sessionId + ':')) { job.abort(); this.jobs.delete(key); }
    }
  }

  // A retired entry can no longer receive a reply, and its pending work is
  // cancelled so the concurrency slots are free for the page that replaced it.
  retire(entry) {
    this.invalidateAck(entry);
  }

  // The handshake between an injection and the first request that injection
  // produces.
  //
  // A renderer scans inside the very evaluation that installs it, so its first
  // binding call can reach the host before that evaluation's reply does. At that
  // moment the host has not confirmed the world, and it deliberately does not
  // open the entry early: instead the request waits for the handshake record of
  // the injection it belongs to. Only the receipt at the end of `inject` opens
  // it; failing, being superseded, losing the world or losing the pipe releases
  // the wait so a request can never hang, reach the provider, or be answered
  // for a page the host never confirmed.
  settleInjection(entry, injection, acknowledged = false) {
    if (!injection || injection.settled) return;
    injection.settled = true;
    injection.acknowledged = acknowledged === true;
    if (entry.injection === injection) entry.injection = null;
    for (const settle of [...injection.waiters]) settle(injection.acknowledged);
    injection.waiters.clear();
  }

  releaseInjection(entry) {
    this.settleInjection(entry, entry.injection, false);
  }

  releaseInjections() {
    for (const entry of this.sessions.values()) this.releaseInjection(entry);
  }

  // The pending injection a binding call belongs to, or null when the call is
  // an ordinary one. The generation and the world have to be the ones being
  // injected: a call from any other page state is stale, and waiting for a
  // receipt that will never describe it would only delay that decision.
  startupInjection(entry, input, contextId) {
    const injection = entry.injection;
    if (!injection || injection.settled || this.live.has(entry)) return null;
    if (!Number.isInteger(injection.generation) || input.generation !== injection.generation) return null;
    return injection.contextId === contextId ? injection : null;
  }

  // Resolves true only if the injection was acknowledged. Never rejects: a
  // request that cannot be served is dropped silently, never answered.
  waitForInjection(entry, injection) {
    if (!injection || injection.settled) return Promise.resolve(injection?.acknowledged === true);
    return new Promise(resolve => { injection.waiters.add(resolve); });
  }

  // `contextId` pins an evaluation to one execution world. It is used wherever
  // the result decides something about a specific document: without it a call
  // after a navigation runs in a newer context and answers a question about a
  // page that was never checked.
  async evaluate(sessionId, expression, contextId) {
    const params = { expression, returnByValue: true, awaitPromise: true,
      ...(Number.isInteger(contextId) ? { contextId } : {}) };
    const result = await this.pipe.send('Runtime.evaluate', params, sessionId);
    if (result.exceptionDetails) throw Error('translation_renderer_failed');
    return result.result?.value;
  }

  source(entry) {
    const revision = JSON.stringify(this.revision);
    return 'if(globalThis.__kwgTranslationScope!==' + revision + '){globalThis.__kwgTranslation?.__cache?.clear();'
      + 'globalThis.__kwgTranslationScope=' + revision + ';}\n'
      + 'globalThis.__kwgTranslationGeneration=' + (entry?.generation ?? 0) + ';\n'
      + 'globalThis.__kwgTranslationConfig=' + JSON.stringify({ ...publicSettings(this.settings), surface: entry?.surface })
      + ';\n' + this.payload;
  }

  // One place decides what a CDP event means for the attached pages.
  //
  // Execution contexts are tracked per entry so a binding call can be matched
  // to the main world of the attached page rather than "whatever context the
  // CDP session happened to deliver". The tracking is event-driven because the
  // browser reports a context exactly once: `Runtime.enable` is idempotent in
  // V8 (a second call returns Success without re-reporting), so nothing may
  // depend on re-enabling to refresh our record.
  //
  // A CDP session survives navigation, so when the document is replaced the
  // acknowledgement made by the old one is worthless. That invalidates the ack
  // only — the world is dropped separately, on evidence that it ended.
  handleEvent(message) {
    if (message.method === 'Runtime.bindingCalled') { void this.binding(message).catch(() => {}); return; }
    if (message.method === 'Runtime.executionContextCreated') {
      const context = message.params?.context;
      for (const entry of this.sessions.values()) {
        if (entry.sessionId === message.sessionId) this.trackContext(entry, context);
      }
      return;
    }
    if (message.method === 'Runtime.executionContextDestroyed') {
      const id = message.params?.executionContextId;
      for (const entry of this.sessions.values()) if (entry.sessionId === message.sessionId) this.dropContext(entry, id);
      return;
    }
    // Every context of this session is gone: the page was destroyed or replaced.
    if (message.method === 'Runtime.executionContextsCleared') {
      for (const entry of this.sessions.values()) {
        if (entry.sessionId !== message.sessionId) continue;
        this.dropWorld(entry);
        this.invalidateAck(entry);
      }
      return;
    }
    // A frame that is not the main one never decides whether this page is still
    // the surface: an ad slot or an embedded widget navigating would otherwise
    // retire a translation that is still correct.
    if (message.method === 'Page.frameNavigated') {
      const frame = message.params?.frame;
      if (frame && frame.parentId !== undefined) return;
      for (const entry of this.sessions.values()) {
        if (entry.sessionId !== message.sessionId) continue;
        if (frame && entry.mainFrameId && frame.id !== entry.mainFrameId) continue;
        // A main-frame navigation replaces the document, and with it the world.
        this.dropWorld(entry);
        this.invalidateAck(entry);
      }
      return;
    }
    // A load event or a same-document route change keeps the same world: the
    // renderer acknowledgement may need refreshing, the context identity may
    // not be thrown away.
    if (message.method !== 'Page.loadEventFired' && message.method !== 'Page.navigatedWithinDocument') return;
    for (const entry of this.sessions.values()) {
      if (entry.sessionId === message.sessionId) this.invalidateAck(entry);
    }
  }

  // The main world's context id, if this event describes one. `isDefault`
  // distinguishes the page's own world from isolated worlds created by an
  // extension or a devtools evaluation.
  trackContext(entry, context) {
    if (!context || !Number.isInteger(context.id)) return;
    const aux = context.auxData || {};
    const isMain = aux.isDefault === true && aux.frameId !== undefined && aux.frameId === entry.mainFrameId;
    if (isMain) {
      entry.mainContexts.add(context.id);
      entry.mainContextId = context.id;
      entry.mainContextUniqueId = typeof context.uniqueId === 'string' ? context.uniqueId : undefined;
      // Release anyone waiting for the world to appear.
      for (const settle of [...entry.contextWaiters || []]) settle(context.id);
      return;
    }
    entry.mainContexts.delete(context.id);
    if (entry.mainContextId === context.id) {
      entry.mainContextId = undefined;
      entry.mainContextUniqueId = undefined;
      entry.bindingContextId = undefined;
    }
  }

  dropContext(entry, id) {
    if (!Number.isInteger(id)) return;
    // The world an injection was waiting on is gone; a receipt that names it
    // would describe a document that no longer exists.
    if (entry.injection && entry.injection.contextId === id) this.releaseInjection(entry);
    entry.mainContexts.delete(id);
    if (entry.mainContextId === id) {
      entry.mainContextId = undefined;
      entry.mainContextUniqueId = undefined;
      entry.bindingContextId = undefined;
    }
  }

  async inject(entry) {
    if (this.pipe.closed) throw Error('translation_pipe_closed');
    // A new injection is a new generation: anything issued by the previous
    // document — a queued task, an in-flight request, a reply on the wire — is
    // retired so it cannot paint into the page that is now attached. The world
    // identity is deliberately left alone; only real evidence drops it.
    this.releaseInjection(entry);
    entry.generation = (entry.generation ?? 0) + 1;
    const injection = { generation: entry.generation, contextId: undefined, waiters: new Set(),
      settled: false, acknowledged: false };
    entry.injection = injection;
    this.live.delete(entry);
    try {
      await this.attachAndConfirm(entry, injection);
    } catch (error) {
      // A failed injection confirms nothing: whoever waited for it is released
      // without an answer, so the request cannot spend the provider or hang.
      this.settleInjection(entry, injection, false);
      throw error;
    }
  }

  async attachAndConfirm(entry, injection) {
    for (const [key, job] of this.jobs) {
      if (key.startsWith(entry.sessionId + ':')) { job.abort(); this.jobs.delete(key); }
    }
    await this.pipe.send('Page.enable', {}, entry.sessionId);
    // The main frame is the only frame that may own a translation. Its id also
    // filters subframe navigation events, so an embedded widget reloading does
    // not retire a page that is still exactly what was attached.
    if (!entry.mainFrameId) {
      const tree = await this.pipe.send('Page.getFrameTree', {}, entry.sessionId);
      const mainFrameId = tree?.frameTree?.frame?.id;
      if (typeof mainFrameId !== 'string' || !mainFrameId) throw Error('translation_renderer_unconfirmed');
      entry.mainFrameId = mainFrameId;
    }
    // Enabling is idempotent in the browser: a second call returns success
    // without re-reporting the contexts that already exist. So it is issued
    // once per attach, and a world we already track is never thrown away to
    // "refresh" it.
    if (!entry.runtimeEnabled) {
      await this.pipe.send('Runtime.enable', {}, entry.sessionId);
      entry.runtimeEnabled = true;
    }
    const contextId = await this.waitForMainContext(entry);
    if (!Number.isInteger(contextId)) throw Error('translation_renderer_unconfirmed');
    injection.contextId = contextId;
    // The binding lives as long as the world it was registered in.
    if (entry.bindingContextId !== contextId) {
      await this.pipe.send('Runtime.addBinding', { name: '__kwgTranslate', executionContextId: contextId }, entry.sessionId);
      entry.bindingContextId = contextId;
    }
    if (entry.scriptId) await this.pipe.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId }, entry.sessionId);
    const source = this.source(entry);
    const script = await this.pipe.send('Page.addScriptToEvaluateOnNewDocument', { source }, entry.sessionId);
    entry.scriptId = script.identifier;
    const result = await this.evaluate(entry.sessionId, source, contextId);
    if (!result || result.version !== 1 || !['active', 'inactive', 'legacy-running'].includes(result.state)) {
      throw Error('translation_renderer_unconfirmed');
    }
    // The renderer reports the surface it actually observed, plus whether it
    // runs in the top-level document. A document that is not the surface the
    // host classified, or a frame masquerading as the page, must never be
    // counted as an attached translation.
    if (result.surface !== entry.surface || result.top !== true) throw Error('translation_renderer_unconfirmed');
    // A navigation, load or cleared world during the evaluation already retired
    // this injection and moved the entry to a new generation. Its receipt
    // describes the document that was replaced, so it is not accepted: the next
    // tick injects the page that is there now, and the waiters were released
    // when the entry was invalidated rather than by an acknowledgement that
    // belongs to nobody.
    if (entry.injection !== injection || entry.generation !== injection.generation) return false;
    entry.state = result.state;
    entry.structure = result.structure;
    entry.blocks = result.blocks;
    entry.seenBlocks = result.seenBlocks;
    entry.revision = this.revision;
    entry.injectedUrl = entry.targetUrl;
    this.live.add(entry);
    // The waiters still see the acknowledged entry through `verifyEntry` when
    // they resume, including the world this injection settled on.
    this.settleInjection(entry, injection, true);
  }

  // Waits for the main frame's default world to be reported, bounded by an
  // explicit deadline rather than by spin count. The browser reports a context
  // exactly once, so when one is already tracked there is nothing to wait for;
  // otherwise this resolves as soon as the report arrives. Returns undefined
  // rather than guessing: a made-up context id would scope the binding to a
  // world that does not exist, or silently to none at all.
  waitForMainContext(entry, { timeout = 5000 } = {}) {
    if (Number.isInteger(entry.mainContextId)) return Promise.resolve(entry.mainContextId);
    return new Promise(resolve => {
      let timer = null;
      const settle = id => {
        if (timer) clearTimeout(timer);
        entry.contextWaiters?.delete(settle);
        resolve(Number.isInteger(id) ? id : undefined);
      };
      if (!entry.contextWaiters) entry.contextWaiters = new Set();
      entry.contextWaiters.add(settle);
      timer = setTimeout(() => settle(undefined), timeout);
      // The host process must stay alive for its own reasons, not for this wait;
      // the pending promise is rejected by teardown anyway.
      timer.unref?.();
    });
  }

  async reply(entry, id, value) {
    if (this.pipe.closed || this.stopped) return;
    // Every reply is bound to the generation that asked for it. The renderer
    // ignores an id it did not issue, and a new generation means a new
    // injection whose ids restart, so a late answer cannot reach it either way.
    // The evaluation is pinned to the context the request came from, so it can
    // never be delivered into a document that replaced it.
    if (!entry || !this.live.has(entry)) return;
    const contextId = entry.pendingContext?.get(id) ?? entry.mainContextId;
    const expression = 'globalThis.__kwgTranslationReceive?.(' + JSON.stringify(id) + ',' + JSON.stringify(value) + ')';
    await this.evaluate(entry.sessionId, expression, Number.isInteger(contextId) ? contextId : undefined).catch(() => {});
    entry.pendingContext?.delete(id);
  }

  // The execution context a binding payload was delivered from, if it is the
  // main world of this entry's main frame.
  //
  // CDP's `Runtime.bindingCalled` carries exactly `name`, `payload` and
  // `executionContextId` — there is no `executionContextUniqueId`, so none is
  // consulted here. The membership test against the tracked main world is the
  // whole check. The `context.uniqueId` the browser reports is tracked on the
  // entry, but it is not used here and not used to pin evaluations: `evaluate`
  // pins by `executionContextId` alone, never by `uniqueContextId`.
  contextOf(entry, message) {
    const id = message.params?.executionContextId;
    if (!Number.isInteger(id) || !entry.mainContexts.has(id)) return null;
    return id;
  }

  async binding(message) {
    const sessionId = message.sessionId;
    const entry = [...this.sessions.values()].find(value => value.sessionId === sessionId);
    if (!entry || message.params?.name !== '__kwgTranslate') return;
    // The calling context decides whether this call is the page's own. Without
    // this check `__kwgTranslate` answers any frame of the attached page — a
    // same-origin ad slot or an embedded page could spend the user's paid
    // provider on attacker-chosen text, and the reply would be written back into
    // that frame. A call from an unknown, sub-frame or isolated world is
    // dropped without a reply, because answering it would confirm the engine.
    const contextId = this.contextOf(entry, message);
    if (contextId === null) return;
    let input;
    try {
      if (typeof message.params.payload !== 'string' || Buffer.byteLength(message.params.payload) > 1024 * 1024) return;
      input = JSON.parse(message.params.payload);
    } catch { return; }
    if (!input || input.type !== 'translate' || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) return;
    const reject = code => this.reply(entry, input.id, { error: code });
    if (!this.settings.enabled) { await reject('translation_disabled'); return; }
    // The renderer scans inside the evaluation that installs it, so its first
    // request can arrive before the host has its receipt. Holding it here — bound
    // to that exact injection, generation and world — is what turns the first
    // visible thinking block into a real translation instead of a silent
    // `!live` drop. A request of any other document state is not held, so
    // nothing stale is queued behind an acknowledgement it does not belong to.
    const startup = this.startupInjection(entry, input, contextId);
    if (startup && !await this.waitForInjection(entry, startup)) return;
    // The page a binding call arrives from is verified every time, not once at
    // attach: a target keeps its session across navigations, so the surface that
    // was classified when the entry was created may be a different page now.
    const verified = await this.verifyEntry(entry);
    if (!verified) { await reject('translation_not_target'); return; }
    // The renderer stamps every request with the generation it booted under, and
    // both surfaces send it. A request without one, or with a retired one,
    // belongs to a document that has already been replaced; answering it would
    // paint into the page that is there now.
    if (!Number.isInteger(input.generation) || input.generation !== entry.generation) {
      await reject('translation_stale_generation'); return;
    }
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 131072
      || !Array.isArray(input.protectedTexts) || input.protectedTexts.length > 1024
      || input.protectedTexts.some(value => typeof value !== 'string' || value.length > 131072)
      || input.protectedTexts.reduce((sum, value) => sum + value.length, 0) > 262144) {
      await reject('translation_input_invalid'); return;
    }
    const key = sessionId + ':' + input.id;
    if (this.jobs.size >= 2 || this.jobs.has(key)) { await reject('translation_busy'); return; }
    const controller = new AbortController();
    const revision = this.revision;
    const generation = entry.generation;
    this.jobs.set(key, controller);
    // The reply goes back to the world that asked, even if the page navigates
    // while the translation is in flight.
    if (!entry.pendingContext) entry.pendingContext = new Map();
    entry.pendingContext.set(input.id, contextId);
    try {
      const text = await this.translate(input.text, this.settings, {
        env: this.env, protectedTexts: input.protectedTexts, signal: controller.signal,
      });
      if (typeof text !== 'string' || !text.trim()) throw Error('translation_response_invalid');
      if (revision === this.revision && generation === entry.generation
        && this.live.has(entry) && !controller.signal.aborted) await this.reply(entry, input.id, { text });
    } catch (error) {
      if (revision === this.revision && generation === entry.generation && this.live.has(entry)) {
        await reject(safeReason(error));
      }
    } finally {
      // Only a job that is still the live one may free its slot. A request whose
      // id was reused after a re-injection would otherwise delete the newer
      // job's controller and let a third request exceed the limit.
      if (this.jobs.get(key) === controller) this.jobs.delete(key);
      if (entry.pendingContext?.get(input.id) === contextId) entry.pendingContext.delete(input.id);
    }
  }

  // Confirms, at the moment a call arrives, that the target is still a page of
  // the surface this entry was created for, and that the world the call came
  // from is still the one looking at it.
  //
  // There is deliberately no fallback to the URL recorded by an earlier tick.
  // The query fails exactly when a navigation is under way, which is precisely
  // the moment the snapshot becomes wrong: answering from it would send the
  // reasoning of a page the classifier rejects to a third-party translator. A
  // failure therefore rejects the request; the next tick re-attaches if the page
  // is still a valid surface.
  async verifyEntry(entry) {
    if (!this.live.has(entry)) return false;
    let info;
    try {
      const answer = await this.pipe.send('Target.getTargetInfo', { targetId: entry.targetId }, entry.sessionId);
      info = answer?.targetInfo;
    } catch { return false; }
    if (!info || typeof info.url !== 'string') return false;
    if (info.type !== undefined && info.type !== 'page') return false;
    entry.targetUrl = info.url;
    if (classifySurface({ type: 'page', url: info.url }) !== entry.surface) return false;
    // The target URL describes the page; the pinned world describes what the
    // caller can actually see. A document that navigated without a target URL
    // change (a same-origin SPA route, a rewritten history entry) shows up here
    // and nowhere else.
    return this.verifyWorld(entry);
  }

  // Reads the location from the pinned context itself. Never falls back to a
  // default context: an unpinned read after a navigation answers about a
  // document that was never checked.
  async verifyWorld(entry) {
    const contextId = entry.mainContextId;
    if (!Number.isInteger(contextId)) return false;
    let observed;
    try {
      observed = await this.evaluate(entry.sessionId,
        '(()=>{try{return {href:globalThis.location?.href,top:globalThis.top===globalThis};}catch{return null;}})()',
        contextId);
    } catch { return false; }
    if (!observed || typeof observed.href !== 'string') return false;
    if (observed.top !== true) return false;
    return classifySurface({ type: 'page', url: observed.href }) === entry.surface;
  }

  // Removes translation from every attached view: the injected script is
  // replaced by one that reports disabled, and the new-document script is
  // withdrawn so a reload cannot bring the old behaviour back.
  async detachAll() {
    const disabled = publicSettings({ ...this.settings, enabled: false });
    for (const entry of this.sessions.values()) {
      // Translation is being withdrawn: nobody may stay queued behind an
      // acknowledgement that is about to be revoked.
      this.releaseInjection(entry);
      await this.evaluate(entry.sessionId,
        'globalThis.__kwgTranslation?.configure(' + JSON.stringify(disabled) + ')').catch(() => {});
      if (entry.scriptId) {
        await this.pipe.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId }, entry.sessionId).catch(() => {});
        entry.scriptId = undefined;
      }
      entry.revision = null;
    }
  }

  async inheritLegacyTranslation() {
    if (this.request.inheritLegacyTranslation !== true) return;
    const markerFile = path.join(this.stateDir, 'translation-legacy-import.json');
    try {
      const marker = readSubagentJSON(markerFile);
      if (marker.schemaVersion !== 1 || marker.homeDir !== this.request.homeDir) throw Error('translation_scope_conflict');
      this.request.inheritLegacyTranslation = false;
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { targetInfos = [] } = await this.pipe.send('Target.getTargets');
    const target = targetInfos.find(isTranslationTarget);
    if (!target) return;
    const attached = await this.pipe.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    if (typeof attached.sessionId !== 'string') return;
    let provider;
    try {
      const preferences = await this.evaluate(attached.sessionId,
        '(()=>{try{const raw=globalThis.localStorage?.getItem("kctw:settings:v1");'
        + 'if(!raw)return null;const value={enabled:true,provider:"bing",targetLanguage:"zh",view:"translated",...JSON.parse(raw)};'
        + 'return Object.fromEntries(["enabled","provider","targetLanguage","view"].map(key=>[key,value[key]]));}catch{return false;}})()');
      const current = readTranslationSettings(this.settingsFile, this.request.homeDir);
      this.request.inheritLegacyTranslation = false;
      this.legacyInheritance = preferences === null ? 'absent' : 'unsupported';
      provider = ['bing', 'google', 'custom'].includes(preferences?.provider) ? preferences.provider : undefined;
      if (current.revision !== this.revision) { this.legacyInheritance = 'newer-settings'; return; }
      if (!preferences || !['bing', 'google'].includes(provider)) return;
      let settings;
      try { settings = normalizeTranslationConfig(preferences); } catch { this.legacyInheritance = 'invalid'; return; }
      writeSubagentJSON(this.settingsFile, { schemaVersion: 1, homeDir: this.request.homeDir,
        settings, revision: translationRevision(settings, this.request.homeDir) });
      this.legacyInheritance = 'imported';
    } finally {
      if (this.request.inheritLegacyTranslation === false) writeSubagentJSON(markerFile, {
        schemaVersion: 1, homeDir: this.request.homeDir, state: this.legacyInheritance, ...(provider ? { provider } : {}) });
      await this.pipe.send('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => {});
    }
  }

  async update() {
    if (this.stopped || this.updating) return;
    this.updating = true;
    try {
      await this.inheritLegacyTranslation();
      const desired = readTranslationSettings(this.settingsFile, this.request.homeDir);
      if (desired.revision !== this.revision) {
        for (const job of this.jobs.values()) job.abort();
        this.settings = desired.settings;
        this.revision = desired.revision;
        for (const entry of this.sessions.values()) entry.revision = null;
      }
      // A control-only host maintains the pipe for the native bridge. It injects
      // nothing while translation is off, and applies the renderer normally once
      // translation is enabled — in this same host, without a restart.
      if (this.controlOnly && !this.settings.enabled) {
        await this.detachAll();
        this.sessions.clear();
        this.reason = 'translation_disabled';
        this.status = 'inactive';
        this.record();
        return;
      }
      const { targetInfos = [] } = await this.pipe.send('Target.getTargets');
      const targets = targetInfos.filter(isTranslationTarget).map(target => ({ target, surface: classifySurface(target) }));
      const current = new Map(targets.map(({ target, surface }) => [target.targetId, surface]));
      for (const [targetId, entry] of this.sessions) {
        const surface = current.get(targetId);
        // Leaving the surface (a cross-origin navigation, a SPA route out of
        // /chat, a closed tab) retires the entry and every reply still pending
        // for it, so nothing written for the old page can be delivered.
        if (!surface || surface !== entry.surface) {
          this.retire(entry);
          this.sessions.delete(targetId);
          await this.pipe.send('Target.detachFromTarget', { sessionId: entry.sessionId }).catch(() => {});
        }
      }
      for (const { target, surface } of targets) {
        let entry = this.sessions.get(target.targetId);
        if (!entry) {
          const attached = await this.pipe.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          if (typeof attached.sessionId !== 'string') throw Error('translation_renderer_unconfirmed');
          entry = { sessionId: attached.sessionId, targetId: target.targetId, surface, targetUrl: target.url,
            generation: 0, mainFrameId: undefined, mainContextId: undefined, mainContextUniqueId: undefined,
            mainContexts: new Set(), contextWaiters: new Set(), pendingContext: new Map(),
            runtimeEnabled: false, bindingContextId: undefined };
          this.sessions.set(target.targetId, entry);
        }
        entry.targetUrl = target.url;
        // The document changed under a session that stays attached: a reload, a
        // cross-site navigation back into the surface, or anything else that
        // replaced the page. Whatever the old document acknowledged is gone, so
        // it is replaced by a fresh injection under a new generation.
        if (target.url !== entry.injectedUrl) { entry.revision = null; entry.state = undefined; }
        try {
          if (entry.revision !== this.revision) await this.inject(entry);
          else {
            const observed = await this.evaluate(entry.sessionId, 'globalThis.__kwgTranslation?.status()', entry.mainContextId);
            if (!observed || observed.version !== 1 || !['active', 'inactive', 'legacy-running'].includes(observed.state)
              || observed.surface !== entry.surface) {
              throw Error('translation_renderer_unconfirmed');
            }
            entry.state = observed.state;
            entry.structure = observed.structure;
            entry.blocks = observed.blocks;
            entry.seenBlocks = observed.seenBlocks;
          }
          entry.reason = undefined;
          if (entry.state === 'inactive' && this.settings.enabled) entry.revision = null;
        } catch (error) {
          entry.revision = null;
          entry.state = 'failed'; entry.reason = safeReason(error);
        }
      }
      const entries = [...this.sessions.values()];
      this.reason = undefined;
      if (entries.some(entry => entry.state === 'legacy-running')) {
        this.status = 'legacy-running'; this.reason = 'translation_legacy_running';
      } else if (!this.settings.enabled && entries.every(entry => !['active', 'failed'].includes(entry.state))) {
        this.status = 'inactive';
      } else if (entries.some(entry => entry.state === 'active' && entry.revision === this.revision) && this.settings.enabled) {
        this.status = 'active';
      } else if (entries.some(entry => entry.state === 'failed')) {
        this.status = 'failed'; this.reason = entries.find(entry => entry.state === 'failed').reason;
      } else {
        this.status = 'attaching'; this.reason = this.waitingReason(entries);
      }
      this.record();
    } catch (error) {
      this.status = 'failed'; this.reason = safeReason(error);
      if (this.settings) {
        const disabled = publicSettings({ ...this.settings, enabled: false });
        for (const entry of this.sessions.values()) {
          await this.evaluate(entry.sessionId, 'globalThis.__kwgTranslation?.configure(' + JSON.stringify(disabled) + ')').catch(() => {});
        }
      }
      try { this.record(); } catch {}
    } finally { this.updating = false; }
  }

  async run() {
    await this.runAttempt();
    const remote = this.remoteStatus();
    if (!this.childApplication || !(this.exit?.kind === 'start-failed'
      || this.exit?.code === 78 && remote?.state === 'unverified')) return;
    const owner = readSubagentJSON(this.launchFile);
    if (owner.id !== this.id || owner.homeDir !== this.request.homeDir) throw Error('translation_session_conflict');
    this.remotePreparationStatus = remote?.state === 'unverified' ? remote
      : { state: 'unverified', reason: 'remote_runtime_start_failed' };
    this.fallbackAttempt = true;
    this.stopped = false;
    this.status = 'starting';
    this.childApplication = undefined;
    this.child = undefined;
    this.pipe = undefined;
    this.reason = undefined;
    this.exit = undefined;
    this.sessions.clear();
    this.jobs.clear();
    writeSubagentJSON(this.launchFile, { ...owner, pid: process.pid, handedOff: false, endedAt: undefined });
    await this.runAttempt();
  }

  async runAttempt() {
    this.request = readSubagentJSON(this.launchFile);
    if (this.request.schemaVersion !== 1 || this.request.id !== this.id || !path.isAbsolute(this.request.homeDir)
      || !path.isAbsolute(this.request.application) || typeof this.request.version !== 'string'
      || !this.request.version || this.request.version.length > 128 || /[\u0000-\u001f\u007f]/.test(this.request.version)
      || !this.request.archive || !path.isAbsolute(this.request.archive)
      || !translationAlive(this.request.pid) || !sameInstallation(this.request)) {
      throw Error('translation_launch_invalid');
    }
    const desired = readTranslationSettings(this.settingsFile, this.request.homeDir);
    this.settings = desired.settings;
    this.revision = desired.revision;
    this.controlOnly = this.request.controlOnly === true;
    this.payload = fs.readFileSync(RENDERER, 'utf8');
    this.record();
    const args = ['-remote-debugging-pipe'];
    if (this.request.userDataDir) args.push('--user-data-dir=' + this.request.userDataDir);
    const env = { ...this.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const protectedNames = Array.isArray(this.request.protectedEnvNames) ? this.request.protectedEnvNames : [];
    for (const name of [...this.protectedEnvNames, ...protectedNames, this.settings.apiKeyEnv]) {
      if (typeof name === 'string' && !reservedEnvName(name)) delete env[name];
    }
    if (this.request.bundleDir) env.DAIMON_BUNDLE_DIR = this.request.bundleDir;
    else delete env.DAIMON_BUNDLE_DIR;
    let application = this.request.application;
    if (this.request.remoteModels === true && !this.fallbackAttempt) {
      try {
        const prepared = await this.prepareRemote({ stateDir: this.stateDir, kimiDir: this.request.homeDir,
          sessionID: this.id, installation: this.request, userDataDir: this.request.userDataDir });
        if (!path.isAbsolute(prepared?.application || '') || !Array.isArray(prepared.args)
          || prepared.args.some(value => typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value))) {
          throw Error('remote_runtime_config_invalid');
        }
        application = prepared.application;
        this.childApplication = application;
        args.push(...prepared.args);
      } catch (error) {
        this.remotePreparationStatus = { state: 'unverified', reason: /^remote_[a-z_]{1,80}$/.test(error.message)
          ? error.message : 'remote_runtime_unverified' };
      }
      this.record();
    }
    this.child = this.spawnApp(application, args, { env, detached: false,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: false });
    // One owner for the polling timer. Every exit path — spawn failure, pipe
    // close, attachment failure, application exit — has to stop it, or a
    // detached host outlives its Kimi and keeps probing a disposed pipe.
    let timer;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const ended = new Promise(resolve => {
      this.child.once('exit', (code, signal) => {
        // "exit" without a start failure means the application itself went
        // away: a user quit, a restart from the updater, or an install-package
        // update. The supervisor needs that distinction to decide whether a
        // later instance is a replacement or a deliberate user launch.
        this.exit = { kind: this.reason === 'translation_application_start_failed' ? 'start-failed' : 'application-exit',
          ...(Number.isInteger(code) ? { code } : {}), ...(typeof signal === 'string' ? { signal } : {}) };
        resolve();
      });
      this.child.once('error', () => {
        this.reason = 'translation_application_start_failed';
        this.exit = { kind: 'start-failed' };
        resolve();
      });
    });
    try {
      await new Promise((resolve, reject) => { this.child.once('spawn', resolve); this.child.once('error', reject); });
      this.status = 'attaching';
      this.record();
      if (!this.child.stdio[4] || !this.child.stdio[3]) throw Error('translation_pipe_unavailable');
      this.pipe = this.pipeFactory(this.child.stdio[4], this.child.stdio[3]);
      if (this.request.nativeBridge === true) {
        // The native import bridge shares this host's private pipe: the same
        // process owns the CDP connection, so a second listener is never needed.
        // A bridge that cannot start must not take translation down with it.
        try {
          this.bridge = this.bridgeFactory({ kimiDir: this.request.homeDir, pipe: this.pipe, applicationPid: this.child.pid,
            getRemoteState: () => this.remoteStatus() });
          await this.bridge.start();
        } catch (error) {
          this.bridge = undefined;
          this.bridgeReason = safeReason(error);
        }
      }
      this.pipe.on('message', message => this.handleEvent(message));
      this.pipe.on('closed', reason => {
        stop();
        this.status = 'failed'; this.reason = reason;
        for (const job of this.jobs.values()) job.abort();
        // No receipt can arrive on a disposed pipe, so nobody keeps waiting.
        this.releaseInjections();
        try { this.record(); } catch {}
      });
      timer = setInterval(() => { void this.update(); }, this.interval);
      await this.update();
      await ended;
    } catch (error) {
      this.status = 'failed'; this.reason = safeReason(error);
      try { this.record(); } catch {}
      await ended;
    } finally {
      stop();
      this.stopped = true;
      for (const job of this.jobs.values()) job.abort();
      this.releaseInjections();
      // The bridge must stop before the pipe goes away: it owns HTTP listeners
      // and the descriptor that native-import.mjs reads.
      await this.bridge?.close().catch(() => {});
      this.bridge = undefined;
      this.pipe?.dispose();
      this.status = this.reason === 'translation_application_start_failed' ? 'failed' : 'exited';
      try { this.record(); } catch {}
      // A successful hand-off keeps the record as installation provenance: the
      // supervisor re-reads it to tell whether the next Kimi is a replacement
      // for this exact installation or a foreign one. It is marked handed off,
      // so a later launch treats it as history instead of a live owner.
      try {
        const current = readSubagentJSON(this.launchFile);
        if (current.id === this.id && this.exit?.kind === 'application-exit') {
          writeSubagentJSON(this.launchFile, { ...current, handedOff: true, endedAt: Date.now() });
        } else if (current.id === this.id) fs.rmSync(this.launchFile);
      } catch {}
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stateDir, id] = process.argv.slice(2);
  if (!stateDir || !path.isAbsolute(stateDir) || !/^[a-f0-9-]{36}$/.test(id || '')) process.exitCode = 2;
  else await new TranslationSession({ stateDir, id }).run().catch(() => { process.exitCode = 1; });
}
