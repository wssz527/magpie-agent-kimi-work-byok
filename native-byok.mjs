import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { normalizeModels } from './catalog.mjs';
import { applyInstructions, applyResponsesInstructions } from './library.mjs';

const LIMIT = 32 * 1024 * 1024;
const CATALOG_LIMIT = 8 * 1024 * 1024;
const UA = 'Desktop Kimi Work';
const ALIASES = ['byok-kth-kimi/', 'byok-kth-resp/'];

function validGateway(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('invalid_gateway'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) throw Error('invalid_gateway');
  return url.href.replace(/\/$/, '');
}

function authorized(actual, key) {
  if (typeof key !== 'string' || !key) return false;
  const left = Buffer.from(actual || ''), right = Buffer.from('Bearer ' + key);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function limited(stream, limit) {
  let length = 0;
  const chunks = [];
  for await (const chunk of stream || []) {
    length += chunk.length;
    if (length > limit) throw Error('request_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function nativeCatalog(models) {
  const groups = {
    kimi: { type: 'kimi', models: Object.create(null) },
    responses: { type: 'openai_responses', models: Object.create(null) },
  };
  for (const row of models) {
    const runtime = row.runtime, capabilities = runtime.capabilities;
    const family = row.id.slice(row.id.lastIndexOf('/') + 1).toLowerCase().startsWith('kimi-') ? 'kimi' : 'responses';
    groups[family].models[row.id] = {
      name: row.menu.displayName,
      limit: { context: runtime.maxContextSize, ...(runtime.maxOutputSize ? { output: runtime.maxOutputSize } : {}) },
      tool_call: capabilities.includes('dynamically_loaded_tools'),
      reasoning: capabilities.includes('thinking'),
      modalities: { input: capabilities.includes('image_in') ? ['text', 'image'] : ['text'], output: ['text'] },
      ...(runtime.supportEfforts ? { support_efforts: runtime.supportEfforts, default_effort: runtime.defaultEffort } : {}),
    };
  }
  return Object.fromEntries(Object.entries(groups).filter(([, group]) => Object.keys(group.models).length));
}

export class NativeByokGateway {
  constructor({ fetchImpl = globalThis.fetch, instructionsFile, timeoutMs = 300000, catalogTimeoutMs = 6000 } = {}) {
    Object.assign(this, { fetchImpl, instructionsFile, timeoutMs, catalogTimeoutMs });
    this.inflight = new Set();
    this.models = [];
  }

  async configure({ url, key, port = 3426 }) {
    const target = validGateway(url);
    if (typeof key !== 'string' || !key || !Number.isInteger(port) || port < 0 || port > 65535) throw Error('invalid_connection');
    if (this.server && this.port !== port) {
      if (this.inflight.size) throw Error('waiting_kimi_idle');
      await this.stop();
    }
    this.connection = { target, key };
    if (!this.server) {
      const server = http.createServer((req, res) => { void this.forward(req, res); });
      server.requestTimeout = this.timeoutMs;
      server.headersTimeout = 15000;
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
      } catch {
        this.connection = null;
        throw Error('native_byok_port_unavailable');
      }
      this.port = port;
      this.server = server;
      this.url = 'http://127.0.0.1:' + server.address().port + '/v1';
    }
    return this.url;
  }

  async catalog(connection = this.connection, signal) {
    if (!connection) throw Error('kimi_not_connected');
    const timeout = AbortSignal.timeout(this.catalogTimeoutMs);
    const response = await this.fetchImpl(connection.target + '/models', {
      method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer ' + connection.key, 'User-Agent': UA },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error', proxy: '',
    });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > CATALOG_LIMIT) {
      await response.body?.cancel();
      throw Error('catalog_unavailable');
    }
    let models;
    try { models = normalizeModels(JSON.parse(await limited(response.body, CATALOG_LIMIT)), { allowEmpty: true }); }
    catch { throw Error('catalog_unavailable'); }
    this.models = models;
    return models;
  }

  async forward(req, res) {
    const error = (status, code) => {
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { type: 'kimi_adapter_error', code, message: code } }));
    };
    const isCatalog = req.method === 'GET' && ['/v1/models', '/v1/models/api.json'].includes(req.url);
    const isInference = req.method === 'POST' && ['/v1/chat/completions', '/v1/responses'].includes(req.url);
    if (!isCatalog && !isInference) { error(404, 'not_found'); return; }
    const active = this.connection;
    if (!active) { error(503, 'kimi_not_connected'); return; }
    if (isCatalog) {
      const attempt = { at: new Date().toISOString(), authorized: authorized(req.headers.authorization, active.key),
        hasOrigin: Boolean(req.headers.origin), fetchSite: ['none', 'same-origin', 'same-site', 'cross-site'].includes(req.headers['sec-fetch-site']) ? req.headers['sec-fetch-site'] : req.headers['sec-fetch-site'] ? 'other' : 'absent' };
      this.lastCatalogRequest = attempt;
      res.once('finish', () => { attempt.status = res.statusCode; });
    }
    if (!authorized(req.headers.authorization, active.key)) { error(401, 'unauthorized'); return; }
    if (req.headers.origin || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none') { error(403, 'browser_request_refused'); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.inflight.add(controller);
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const models = await this.catalog(active, controller.signal);
      if (isCatalog) {
        const payload = req.url === '/v1/models/api.json' ? nativeCatalog(models) : { object: 'list', data: models.map(row => ({
          id: row.id, object: 'model', context_length: row.runtime.maxContextSize,
          supports_tool_call: row.runtime.capabilities.includes('dynamically_loaded_tools'),
          supports_reasoning: row.runtime.capabilities.includes('thinking'),
          supports_image_in: row.runtime.capabilities.includes('image_in'),
        })) };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
        return;
      }
      let payload;
      try { payload = JSON.parse(await limited(req, LIMIT)); }
      catch (failure) { error(failure.message === 'request_too_large' ? 413 : 400, failure.message === 'request_too_large' ? 'request_too_large' : 'invalid_json'); return; }
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') { error(400, 'invalid_json'); return; }
      let model = payload.model;
      if (typeof model !== 'string') { error(400, 'invalid_model'); return; }
      const prefix = ALIASES.find(value => model.startsWith(value));
      if (prefix) model = model.slice(prefix.length);
      if (!models.some(row => row.id === model)) { error(409, 'model_not_enabled_for_kimi'); return; }
      payload = { ...payload, model };
      try {
        if (this.instructionsFile) payload = req.url === '/v1/responses'
          ? applyResponsesInstructions(payload, this.instructionsFile) : applyInstructions(payload, this.instructionsFile);
      } catch (failure) {
        error(['invalid_messages', 'invalid_input'].includes(failure.message) ? 400 : 503, failure.message);
        return;
      }
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + active.key, 'User-Agent': UA };
      for (const name of ['x-msh-version', 'r-timezone', 'x-session-id', 'session_id']) {
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      }
      const upstream = await this.fetchImpl(active.target + req.url.slice('/v1'.length), {
        method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error', proxy: '',
      });
      const replyHeaders = {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no',
      };
      for (const name of ['retry-after', 'x-request-id', 'request-id']) {
        if (upstream.headers.has(name)) replyHeaders[name] = upstream.headers.get(name);
      }
      res.writeHead(upstream.status, replyHeaders);
      res.flushHeaders();
      for await (const chunk of upstream.body || []) {
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      res.end();
    } catch (failure) {
      if (res.headersSent) res.destroy();
      else error(controller.signal.aborted ? 499 : 503,
        controller.signal.aborted ? 'request_cancelled' : failure.message === 'catalog_unavailable' ? 'catalog_unavailable' : 'upstream_connection_failed');
    } finally {
      clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  async stop() {
    this.connection = null;
    for (const controller of this.inflight) controller.abort();
    if (this.server) {
      const server = this.server;
      this.server = null;
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    this.models = [];
  }
}
