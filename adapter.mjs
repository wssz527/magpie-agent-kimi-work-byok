import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { rpc } from './rpc.mjs';
import { normalizeModels, mergeRuntimeModels, isMenuAlias } from './catalog.mjs';
import { prepareLibrary, applyInstructions } from './library.mjs';

const PROVIDER = 'daimon-kimi-code';
const TOOL_ORIGIN = 'https://agent-gw.kimi.com';
const BODY_LIMIT = 32 * 1024 * 1024;
const HEADERS = ['user-agent', 'x-msh-version', 'r-timezone', 'x-session-id', 'session_id'];
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const baseURL = doc => doc?.model?.providers?.[PROVIDER]?.baseUrl;
const activeCount = value => Array.isArray(value) ? value.length : Number(value) || 0;
const busy = runner => activeCount(runner?.activeKernelTurns) + activeCount(runner?.activeKernelToolCalls) > 0;

function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch { /* Renamed. */ } }
}

function gatewayURL(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('invalid_gateway'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) {
    throw Error('invalid_gateway');
  }
  return url.href.replace(/\/$/, '');
}

function officialURL(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('unsupported_kimi_config'); }
  if (url.origin !== TOOL_ORIGIN || url.pathname !== '/coding/v1'
      || url.username || url.password || url.search || url.hash) throw Error('unsupported_kimi_config');
  return url.href;
}

function authenticated(actual, key) {
  if (!key || typeof key !== 'string') return false;
  const left = Buffer.from(actual || ''), right = Buffer.from('Bearer ' + key);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function defaultKimiDirectory(home = os.homedir()) {
  const support = process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
  return path.join(support, 'kimi-desktop', 'daimon-share', 'daimon');
}

export class KimiAdapter {
  constructor({ home = os.homedir(), stateDir, kimiDir, intervalMs = 1000, stabilityMs = 2000,
    rpcCall = rpc, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
    this.stateDir = stateDir || path.join(home, '.config', 'magpie-kimi');
    this.kimiDir = kimiDir || defaultKimiDirectory(home);
    this.configFile = path.join(this.kimiDir, 'config.json');
    this.runnerFile = path.join(this.kimiDir, 'agents', 'main', 'runner.state.json');
    this.connectionFile = path.join(this.stateDir, 'connection.json');
    this.stateFile = path.join(this.stateDir, 'adapter-state.json');
    this.lockFile = path.join(this.stateDir, 'adapter-owner.json');
    this.statusFile = path.join(this.stateDir, 'status.json');
    this.catalogFile = path.join(this.stateDir, 'menu-catalog.json');
    this.modelBackupFile = path.join(this.stateDir, 'before-menu-models.json');
    this.instructionsFile = path.join(this.stateDir, 'AGENTS.md');
    this.catalog = [];
    Object.assign(this, { intervalMs, stabilityMs, rpcCall, fetchImpl, log });
    this.ownerID = crypto.randomUUID();
    this.status = {};
    this.running = false;
    this.live = null;
    this.stopping = false;
    this.state = null;
    this.inflight = new Set();
  }

  bootstrap() {
    if (!fs.existsSync(this.configFile)) return false;
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    prepareLibrary(this.stateDir, this.kimiDir);
    if (!fs.existsSync(this.connectionFile)) {
      try {
        fs.writeFileSync(this.connectionFile, JSON.stringify({ schemaVersion: 1, enabled: false,
          model: '', gateway: { url: '', key: '' } }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return true;
  }

  ownLock() {
    if (this.locked) {
      try { return readJSON(this.lockFile).ownerID === this.ownerID; } catch { this.locked = false; }
    }
    try {
      const before = fs.readFileSync(this.lockFile, 'utf8'), owner = JSON.parse(before);
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
      if (alive) return false;
      if (fs.readFileSync(this.lockFile, 'utf8') !== before) return false;
      fs.unlinkSync(this.lockFile);
    } catch (error) { if (error.code !== 'ENOENT') return false; }
    try {
      fs.writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, ownerID: this.ownerID }), { flag: 'wx', mode: 0o600 });
      this.locked = true;
      try { this.state = readJSON(this.stateFile); } catch { this.state = { active: false }; }
      return true;
    } catch { return false; }
  }

  releaseLock() {
    try { if (readJSON(this.lockFile).ownerID === this.ownerID) fs.unlinkSync(this.lockFile); } catch { /* Not ours. */ }
    this.locked = false;
  }

  report(code, details = {}) {
    const next = { code, ...details };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    if (fs.existsSync(this.stateDir)) atomicJSON(this.statusFile, { ...next, at: new Date().toISOString() });
    if (code.endsWith('_failed') || code === 'kimi_config_changed') this.log(code);
  }

  saveState() { atomicJSON(this.stateFile, this.state); }

  async gatewayCatalog(target, key) {
    // Magpie applies this agent's visibility and model selection. The key
    // and registered User-Agent identify it; no credential/config file read.
    const response = await this.fetchImpl(target + '/models', {method: 'GET', headers: {
      Accept: 'application/json', Authorization: 'Bearer ' + key, 'User-Agent': 'Desktop Kimi Work',
    }, signal: AbortSignal.timeout(6000), redirect: 'error', proxy: ''});
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 8 * 1024 * 1024) throw Error('catalog_unavailable');
    const text = await response.text();
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw Error('catalog_unavailable');
    return normalizeModels(JSON.parse(text), {allowEmpty: true});
  }

  publishCatalog(desired) {
    atomicJSON(this.catalogFile,{schemaVersion:1,enabled:true,exclusive:true,updatedAt:new Date().toISOString(),
      selectedAlias:this.catalog.find(x=>x.id===desired.model)?.alias||'',models:this.catalog.map(x=>x.menu)});
  }

  // Change one field in the newest document; never restore stale login tokens.
  changeBase(expected, replacement) {
    const before = fs.readFileSync(this.configFile), doc = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''));
    if (baseURL(doc) !== expected) throw Error('kimi_config_changed');
    if (expected === replacement) return doc;
    doc.model.providers[PROVIDER].baseUrl = replacement;
    if (!fs.readFileSync(this.configFile).equals(before)) throw Error('kimi_config_changed');
    atomicJSON(this.configFile, doc);
    return doc;
  }

  async listen() {
    if (this.server) return;
    const server = http.createServer((req, res) => { void this.forward(req, res); });
    server.requestTimeout = 300000;
    server.headersTimeout = 15000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.server = server;
    this.bridgeURL = 'http://127.0.0.1:' + server.address().port + '/v1';
  }

  async forward(req, res) {
    const error = (status, code) => {
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { type: 'kimi_adapter_error', code, message: code } }));
    };
    if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/search', '/v1/fetch'].includes(req.url)) {
      error(404, 'not_found'); return;
    }
    const active = this.live;
    if (!active) { error(503, 'kimi_not_connected'); return; }
    let doc;
    try { doc = readJSON(this.configFile); } catch { error(503, 'kimi_config_unavailable'); return; }
    if (!authenticated(req.headers.authorization, doc.credentials?.kimiCode?.apiKey)) {
      error(401, 'unauthorized'); return;
    }
    if (req.headers.origin || req.headers['sec-fetch-site']) { error(403, 'browser_request_refused'); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);
    this.inflight.add(controller);
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    req.once('aborted', () => controller.abort());
    try {
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > BODY_LIMIT) { error(413, 'request_too_large'); return; }
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { error(400, 'invalid_json'); return; }
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') { error(400, 'invalid_json'); return; }
      const inference = req.url === '/v1/chat/completions';
      if (inference) {
        const selected = this.catalog.find(x => x.alias === payload.model);
        if (!selected && isMenuAlias(payload.model)) { error(409, 'model_no_longer_available'); return; }
        const model=selected?.id||active.model;
        let allowed;
        try { allowed = await this.gatewayCatalog(active.gatewayURL, active.gatewayKey); }
        catch { error(503, 'catalog_unavailable'); return; }
        if (!allowed.some(row => row.id === model)) { error(409, 'model_not_enabled_for_kimi'); return; }
        payload.model = model;
        try { payload = applyInstructions(payload, this.instructionsFile); }
        catch (failure) { error(failure.message === 'invalid_messages' ? 400 : 503, failure.message); return; }
      }
      const headers = { 'Content-Type': 'application/json',
        Authorization: inference ? 'Bearer ' + active.gatewayKey : req.headers.authorization };
      for (const name of HEADERS) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      if (!headers['user-agent']) headers['user-agent'] = 'Desktop Kimi Work';
      const url = inference ? active.gatewayURL + '/chat/completions'
        : officialURL(active.originalBase) + req.url.slice('/v1'.length);
      const upstream = await this.fetchImpl(url, { method: 'POST', headers,
        body: JSON.stringify(payload), signal: controller.signal, redirect: 'error' });
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      if (upstream.body) for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      res.end();
    } catch {
      if (res.headersSent) res.destroy();
      else error(controller.signal.aborted ? 499 : 502, controller.signal.aborted ? 'request_cancelled' : 'upstream_connection_failed');
    } finally {
      clearTimeout(timeout);
      this.inflight.delete(controller);
    }
  }

  async restore({ reload = true } = {}) {
    if (!this.state?.active) return;
    let doc = readJSON(this.configFile);
    let modelsRestored = false;
    if (reload && baseURL(doc) === this.state.bridgeURL) {
      try {
        const runner = readJSON(this.runnerFile);
        const current = await this.rpcCall(runner, 'conversations.getKimiModelList');
        const native = (current?.models || []).filter(x => !isMenuAlias(x.model));
        if (native.length) {
          if (isMenuAlias(doc.model.current)) {
            let original;
            try {original=readJSON(this.modelBackupFile).current;} catch {}
            const alias=native.some(x => x.model === original) ? original : native[0].model;
            await this.rpcCall(runner,'conversations.setModel',{modelAlias:alias});
          }
          if (native.length !== current.models.length) await this.rpcCall(runner,'conversations.updateKimiModelList',{models:native});
          doc=readJSON(this.configFile);
          modelsRestored = true;
        }
      } catch { this.report('restored_waiting_kimi'); }
    }
    let changed = false;
    if (baseURL(doc) === this.state.bridgeURL) {
      this.changeBase(this.state.bridgeURL, this.state.originalBase);
      changed = true;
    }
    this.live = null;
    if (fs.existsSync(this.catalogFile)) atomicJSON(this.catalogFile, {schemaVersion: 1, enabled: false, models: [], updatedAt: new Date().toISOString()});
    this.state.active = false;
    this.saveState();
    if (changed && reload) {
      try {
        const current = readJSON(this.configFile);
        await this.rpcCall(readJSON(this.runnerFile), 'conversations.setModel', { modelAlias: current.model.current });
      } catch { this.report('restored_waiting_kimi'); }
    }
    // Only model fields were saved, never the full credentials-bearing config.
    if (modelsRestored) {
      try { fs.unlinkSync(this.modelBackupFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  async syncCatalog(runner, desired, target) {
    if (Date.now() < (this.catalogAfter || 0)) return;
    this.catalogAfter = Date.now() + 10000;
    if (busy(runner)) {
      // Long Work turns must retain their menu entries. Refresh the local
      // liveness timestamp without changing models or reloading a busy runtime.
      try {
        const keep = new Set((await this.gatewayCatalog(target, desired.gateway.key)).map(x => x.id));
        this.catalog=this.catalog.filter(x=>keep.has(x.id));
        const saved=readJSON(this.catalogFile);
        if(saved.enabled) this.publishCatalog(desired);
      } catch { /* Initial connection waits until idle. */ }
      return;
    }
    try {
      const catalog = await this.gatewayCatalog(target, desired.gateway.key);
      const current = await this.rpcCall(runner, 'conversations.getKimiModelList');
      if (!Array.isArray(current?.models)) throw Error('catalog_unavailable');
      const merged = mergeRuntimeModels(current.models, catalog);
      const same = merged.length === current.models.length && catalog.every(wanted => {
        const found = current.models.find(x => x.model === wanted.alias);
        return found && Object.entries(wanted.runtime).every(([key,value]) => {
          const left = Array.isArray(value) ? [...value].sort() : value;
          const right = Array.isArray(found[key]) ? [...found[key]].sort() : found[key];
          return JSON.stringify(left) === JSON.stringify(right);
        });
      });
      if (!same) {
        if (!fs.existsSync(this.modelBackupFile)) {
          atomicJSON(this.modelBackupFile, {models: current.models, current: readJSON(this.configFile).model.current});
        }
        await this.rpcCall(runner, 'conversations.updateKimiModelList', {models: merged});
      }
      this.catalog = catalog;
      this.publishCatalog(desired);
      this.catalogError = null;
    } catch { this.catalogError = 'catalog_sync_failed'; }
  }

  async tick() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      if (!this.bootstrap()) return;
      if (!this.ownLock()) return;
      const desired = readJSON(this.connectionFile);
      let runner;
      try { runner = readJSON(this.runnerFile); } catch { /* Kimi isn't running yet. */ }
      if (!desired.enabled || !desired.model) {
        if (this.state.active && busy(runner)) { this.report('waiting_kimi_idle'); return; }
        await this.restore();
        this.pausedSignature = null;
        this.retryAfter = 0;
        this.report('disconnected');
        return;
      }
      const target = gatewayURL(desired.gateway?.url);
      if (typeof desired.gateway?.key !== 'string' || !desired.gateway.key
          || typeof desired.model !== 'string' || !desired.model.includes('/') || desired.model.length > 1024) {
        throw Error('invalid_connection');
      }
      if (!runner || runner.lifecycleStatus !== 'running') { this.report('waiting_kimi'); return; }
      const bytes = fs.readFileSync(this.configFile), doc = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      const generation = sha(JSON.stringify([runner.daemonGeneration, runner.control?.endpoint?.url,
        runner.control?.endpoint?.startedAt, runner.control?.endpoint?.pid]));
      const signature = sha(JSON.stringify([desired.model, target, desired.gateway.key]));
      const fingerprint = sha(bytes);
      if (fingerprint !== this.fingerprint) { this.fingerprint = fingerprint; this.stableSince = Date.now(); }
      const unchanged = this.state.active && this.state.generation === generation && this.state.signature === signature;
      if (unchanged && baseURL(doc) === this.bridgeURL && this.live) {
        await this.syncCatalog(runner, desired, target);
        this.report('connected', { model: desired.model, models: this.catalog.length, ...(this.catalogError ? {catalog: this.catalogError} : {}) }); return;
      }
      if (this.pausedSignature === signature) { this.report('kimi_config_changed'); return; }
      if (unchanged && this.live && baseURL(doc) !== this.bridgeURL) {
        this.pausedSignature = signature;
        this.live = null;
        this.report('kimi_config_changed');
        return;
      }
      if (busy(runner)) { this.report('waiting_kimi_idle'); return; }
      if (Date.now() - this.stableSince < this.stabilityMs) { this.report('waiting_kimi_ready'); return; }
      if (Date.now() < (this.retryAfter || 0)) return;
      this.retryAfter = Date.now() + 5000;
      const oldBase = baseURL(doc);
      const originalBase = this.state.active && oldBase === this.state.bridgeURL
        ? officialURL(this.state.originalBase) : officialURL(oldBase);
      if (!doc.model.models?.[doc.model.current] || typeof doc.credentials?.kimiCode?.apiKey !== 'string') {
        throw Error('unsupported_kimi_config');
      }
      await this.rpcCall(runner, 'models.current');
      await this.listen();
      if (!fs.readFileSync(this.configFile).equals(bytes)) throw Error('kimi_config_changed');
      const previous = this.state;
      this.state = { active: true, originalBase, bridgeURL: this.bridgeURL, generation, signature, model: desired.model };
      // Persist recovery ownership before writing the Kimi file.
      this.saveState();
      this.changeBase(oldBase, this.bridgeURL);
      try {
        await this.rpcCall(runner, 'conversations.setModel', { modelAlias: doc.model.current });
      } catch (error) {
        this.changeBase(this.bridgeURL, oldBase);
        this.state = previous;
        this.saveState();
        throw error;
      }
      this.live = { model: desired.model, gatewayURL: target, gatewayKey: desired.gateway.key, originalBase };
      await this.syncCatalog(runner, desired, target);
      this.pausedSignature = null;
      this.report('connected', { model: desired.model });
    } catch (error) {
      const codes = new Set(['invalid_gateway', 'invalid_connection', 'unsupported_kimi_config',
        'library_path_conflict',
        'kimi_config_changed', 'kimi_control_unavailable', 'kimi_control_timeout', 'kimi_control_closed', 'kimi_control_rejected']);
      const code = codes.has(error.message) ? error.message : 'adapter_failed';
      this.report(code);
    } finally { this.running = false; }
  }

  async start() {
    await this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  async stop() {
    clearInterval(this.timer);
    this.stopping = true;
    while (this.running) await new Promise(resolve => setTimeout(resolve, 20));
    if (this.locked) {
      try { await this.restore(); } catch { /* Never write a changed third-party configuration. */ }
      this.report('disconnected');
      this.releaseLock();
    }
    for (const pending of this.inflight) pending.abort();
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
  }

  restoreFileOnExit() {
    if (!this.locked) return;
    try {
      if (this.state?.active && baseURL(readJSON(this.configFile)) === this.state.bridgeURL) {
        this.changeBase(this.state.bridgeURL, this.state.originalBase);
      }
    } catch { /* Leave a changed configuration alone. */ }
    try { atomicJSON(this.catalogFile, {schemaVersion:1, enabled:false, models:[], updatedAt:new Date().toISOString()}); } catch { /* Exiting. */ }
    this.releaseLock();
  }
}
