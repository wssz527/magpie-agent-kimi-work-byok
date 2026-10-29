import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { applySharedInstructions } from './instructions.mjs';

const BODY_LIMIT = 32 * 1024 * 1024;
const CATALOG_LIMIT = 8 * 1024 * 1024;
const ALIASES = ['byok-kth-kimi/', 'byok-kth-resp/'];
const PROTOCOLS = new Set(['chat', 'responses']);
const DEFAULT_FORWARD_HEADERS = ['x-msh-version', 'r-timezone', 'x-session-id', 'session_id'];

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

const text = value => typeof value === 'string' && value.length <= 2048 && !/[\x00-\x1f]/.test(value) ? value : '';
const positive = value => Number.isSafeInteger(value) && value > 0;
const lastSegment = id => id.slice(id.lastIndexOf('/') + 1).toLowerCase();

// Kimi decides the API a model talks to from its own name, not from a field:
// a last segment starting with `kimi-` goes to the Chat endpoint, everything
// else to Responses. A model that declares the other protocol would be routed
// somewhere it cannot answer, so the contradiction is rejected here instead of
// being silently dropped during import.
export function modelFamily(id) {
  return lastSegment(id).startsWith('kimi-') ? 'chat' : 'responses';
}

export function validateModels(models) {
  if (!Array.isArray(models)) throw Error('invalid_models');
  const seen = new Set();
  const result = models.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('invalid_models');
    const id = text(row.id);
    if (!id || seen.has(id)) throw Error('invalid_models');
    seen.add(id);
    if (!PROTOCOLS.has(row.protocol)) throw Error('invalid_models');
    if (modelFamily(id) !== row.protocol) throw Error('protocol_conflict');
    if (!positive(row.contextWindow)) throw Error('invalid_models');
    if (row.maxOutputTokens !== undefined && !positive(row.maxOutputTokens)) throw Error('invalid_models');
    if (row.tools !== undefined && typeof row.tools !== 'boolean') throw Error('invalid_models');
    if (row.reasoning !== undefined && typeof row.reasoning !== 'boolean') throw Error('invalid_models');
    if (row.inputModalities !== undefined && (!Array.isArray(row.inputModalities)
      || row.inputModalities.some(value => !['text', 'image'].includes(value)))) throw Error('invalid_models');
    if (row.reasoningEfforts !== undefined && (!Array.isArray(row.reasoningEfforts)
      || row.reasoningEfforts.some(value => !text(value) || value.length > 64))) throw Error('invalid_models');
    if (row.defaultEffort !== undefined && (typeof row.defaultEffort !== 'string' || row.defaultEffort.length > 64
      || !row.reasoningEfforts?.includes(row.defaultEffort))) {
      throw Error('invalid_models');
    }
    const model = { id, protocol: row.protocol, contextWindow: row.contextWindow };
    const name = text(row.name);
    if (name) model.name = name;
    if (row.maxOutputTokens !== undefined) model.maxOutputTokens = row.maxOutputTokens;
    if (row.tools !== undefined) model.tools = row.tools;
    if (row.reasoning !== undefined) model.reasoning = row.reasoning;
    if (row.inputModalities !== undefined) model.inputModalities = [...new Set(row.inputModalities)];
    if (row.reasoningEfforts !== undefined) model.reasoningEfforts = [...new Set(row.reasoningEfforts)];
    if (row.defaultEffort !== undefined && row.reasoningEfforts?.includes(row.defaultEffort)) {
      model.defaultEffort = row.defaultEffort;
    }
    return model;
  });
  return result;
}

export function nativeCatalog(models) {
  const groups = {
    kimi: { type: 'kimi', models: Object.create(null) },
    responses: { type: 'openai_responses', models: Object.create(null) },
  };
  for (const row of models) {
    const group = row.protocol === 'chat' ? groups.kimi : groups.responses;
    group.models[row.id] = {
      name: row.name || row.id,
      limit: { context: row.contextWindow, ...(row.maxOutputTokens ? { output: row.maxOutputTokens } : {}) },
      tool_call: row.tools === true,
      reasoning: row.reasoning === true,
      modalities: { input: row.inputModalities?.includes('image') ? ['text', 'image'] : ['text'], output: ['text'] },
      ...(row.reasoningEfforts?.length
        ? { support_efforts: row.reasoningEfforts, default_effort: row.defaultEffort || row.reasoningEfforts[0] } : {}),
    };
  }
  return Object.fromEntries(Object.entries(groups).filter(([, group]) => Object.keys(group.models).length));
}

export function openAIModels(models) {
  return { object: 'list', data: models.map(row => ({
    id: row.id, object: 'model', context_length: row.contextWindow,
    supports_tool_call: row.tools === true,
    supports_reasoning: row.reasoning === true,
    supports_image_in: row.inputModalities?.includes('image') === true,
  })) };
}

export class KimiWorkGateway {
  constructor({ backend, instructionsFile, timeoutMs = 300000, catalogTimeoutMs = 6000,
    fetchImpl = globalThis.fetch, forwardHeaders = DEFAULT_FORWARD_HEADERS, recordRequests = false } = {}) {
    if (!backend || typeof backend.listModels !== 'function' || typeof backend.request !== 'function') {
      throw Error('invalid_backend');
    }
    Object.assign(this, { backend, instructionsFile, timeoutMs, catalogTimeoutMs, fetchImpl, forwardHeaders, recordRequests });
    this.inflight = new Set();
    this.models = [];
    this.metrics = { startedAt: Date.now(), requests: 0, failures: 0, recent: [] };
  }

  async observe(req, res) {
    const record = this.recordRequests && req.method === 'POST' && ['/v1/chat/completions', '/v1/responses'].includes(req.url)
      && authorized(req.headers.authorization, this.connection?.key) && !req.headers.origin
      && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'none')
      ? { at: Date.now(), model: '', protocol: req.url === '/v1/responses' ? 'responses' : 'chat' } : null;
    if (record) req.gatewayRecord = record;
    try { await this.forward(req, res); }
    finally {
      if (record) {
        record.status ??= res.writableEnded ? res.statusCode : 499;
        record.ms = Math.max(0, Date.now() - record.at);
        this.metrics.requests++;
        if (record.status >= 400) this.metrics.failures++;
        this.metrics.recent.unshift(record);
        this.metrics.recent.length = Math.min(20, this.metrics.recent.length);
      }
    }
  }

  async configure({ key, port = 3426 } = {}) {
    if (typeof key !== 'string' || !key || !Number.isInteger(port) || port < 0 || port > 65535) throw Error('invalid_connection');
    if (this.server && this.port !== port) {
      if (this.inflight.size) throw Error('waiting_kimi_idle');
      await this.stop();
    }
    this.connection = { key };
    if (!this.server) {
      const server = http.createServer((req, res) => { void this.observe(req, res); });
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

  async catalog(signal) {
    if (!this.backend) throw Error('kimi_not_connected');
    const timeout = AbortSignal.timeout(this.catalogTimeoutMs);
    const models = validateModels(await this.backend.listModels({
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }));
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
        hasOrigin: Boolean(req.headers.origin),
        fetchSite: ['none', 'same-origin', 'same-site', 'cross-site'].includes(req.headers['sec-fetch-site'])
          ? req.headers['sec-fetch-site'] : req.headers['sec-fetch-site'] ? 'other' : 'absent' };
      this.lastCatalogRequest = attempt;
      res.once('finish', () => { attempt.status = res.statusCode; });
    }
    if (!authorized(req.headers.authorization, active.key)) { error(401, 'unauthorized'); return; }
    if (req.headers.origin || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none') {
      error(403, 'browser_request_refused'); return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.inflight.add(controller);
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const models = await this.catalog(controller.signal);
      if (isCatalog) {
        const payload = req.url === '/v1/models/api.json' ? nativeCatalog(models) : openAIModels(models);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
        return;
      }
      let payload;
      try { payload = JSON.parse(await limited(req, BODY_LIMIT)); }
      catch (failure) {
        const tooLarge = failure.message === 'request_too_large';
        error(tooLarge ? 413 : 400, tooLarge ? 'request_too_large' : 'invalid_json');
        return;
      }
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') { error(400, 'invalid_json'); return; }
      let model = payload.model;
      if (typeof model !== 'string') { error(400, 'invalid_model'); return; }
      const prefix = ALIASES.find(value => model.startsWith(value));
      if (prefix) model = model.slice(prefix.length);
      const selected = models.find(row => row.id === model);
      if (!selected) { error(409, 'model_not_enabled_for_kimi'); return; }
      if (req.gatewayRecord) req.gatewayRecord.model = selected.id;
      const protocol = req.url === '/v1/responses' ? 'responses' : 'chat';
      if (selected.protocol !== protocol) { error(409, 'model_protocol_mismatch'); return; }
      payload = { ...payload, model };
      const blocked = await this.beforeRequest?.(protocol, payload);
      if (blocked) {
        if (blocked.status === 503) res.setHeader('Retry-After', '1');
        error(blocked.status, blocked.code);
        return;
      }
      if (this.instructionsFile) {
        try { payload = applySharedInstructions(payload, this.instructionsFile, req.url); }
        catch (failure) {
          error(['invalid_messages', 'invalid_input'].includes(failure.message) ? 400 : 503, failure.message);
          return;
        }
      }
      const headers = {};
      for (const name of this.forwardHeaders) {
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      }
      const upstream = await this.backend.request(req.url === '/v1/responses' ? 'responses' : 'chat', payload, {
        signal: controller.signal, headers,
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
      if (req.gatewayRecord) {
        req.gatewayRecord.status = controller.signal.aborted ? 499 : 503;
        req.gatewayRecord.error = controller.signal.aborted ? 'request_cancelled' : 'upstream_connection_failed';
      }
      if (res.headersSent) res.destroy();
      else error(controller.signal.aborted ? 499 : 503,
        controller.signal.aborted ? 'request_cancelled'
          : failure.message === 'catalog_unavailable' ? 'catalog_unavailable' : 'upstream_connection_failed');
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
