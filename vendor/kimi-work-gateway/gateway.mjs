import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { applySharedInstructions } from './instructions.mjs';

const BODY_LIMIT = 32 * 1024 * 1024;
const CATALOG_LIMIT = 8 * 1024 * 1024;
const ALIASES = ['byok-kth-kimi/', 'byok-kth-resp/'];
const PROTOCOLS = new Set(['chat', 'responses']);
const DEFAULT_FORWARD_HEADERS = ['x-msh-version', 'r-timezone', 'x-session-id', 'session_id'];
const METADATA_KINDS = new Set(['preset', 'discovery', 'manual']);
const METADATA_FIELDS = new Set(['kind', 'url', 'checkedAt']);

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

// A declared length over the limit is refused before any byte is buffered. The
// body is still drained first: answering while the client is mid-write makes
// Bun drop the status line, and the caller would see an empty 200 instead of
// the rejection. `true` means the body ended or the client went away; `false`
// means the wait timed out with a client that stopped sending.
async function drain(stream, timeoutMs = 2000) {
  return new Promise(resolve => {
    let done = false;
    const stop = ended => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const name of ['end', 'error', 'close']) stream.removeListener(name, listener);
      resolve(ended);
    };
    const listener = () => stop(true);
    const timer = setTimeout(() => stop(false), timeoutMs);
    stream.on('end', listener);
    stream.on('error', listener);
    stream.on('close', listener);
    stream.resume();
  });
}

const text = value => typeof value === 'string' && value.length <= 2048 && !/[\x00-\x1f]/.test(value) ? value : '';
const positive = value => Number.isSafeInteger(value) && value > 0;
const lastSegment = id => id.slice(id.lastIndexOf('/') + 1).toLowerCase();

// Request records are the panel's only telemetry: which route was used, how
// long it took and what the upstream reported. Nothing here keeps a prompt, a
// key or a response body, and a number the upstream did not report stays
// unknown instead of becoming a zero.
const USAGE_SCAN_LIMIT = 256 * 1024;
const USAGE_LINE_LIMIT = 64 * 1024;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cached = count(value.prompt_tokens_details?.cached_tokens)
    ?? count(value.input_tokens_details?.cached_tokens);
  const usage = {
    inputTokens: count(value.prompt_tokens) ?? count(value.input_tokens),
    outputTokens: count(value.completion_tokens) ?? count(value.output_tokens),
    totalTokens: count(value.total_tokens),
    cachedInputTokens: cached,
  };
  const known = Object.fromEntries(Object.entries(usage).filter(([, number]) => number !== undefined));
  return Object.keys(known).length ? known : null;
}

// Both envelope shapes carry the usage inside `usage`; a Responses stream only
// reports it on the terminal event, so the last one seen wins.
function usageFromJSON(payload) {
  return usageOf(payload?.usage) ?? usageOf(payload?.response?.usage);
}

// A bounded, streaming reader for the real usage numbers. It never buffers the
// whole response. The two protocols are bounded differently on purpose:
//
// - JSON arrives as one document, so a total byte budget is the only bound that
//   makes sense: past it the metric is dropped, not the reply.
// - An SSE stream is a sequence of independent events, and the terminal usage
//   arrives last. Bounding the whole stream would lose the usage of any long but
//   ordinary answer, so SSE is bounded per event instead: a runaway single line
//   is skipped up to its newline and scanning resumes with the next event.
class UsageScanner {
  constructor(kind) {
    this.kind = kind;
    this.decoder = new StringDecoder('utf8');
    this.remainder = '';
    this.body = '';
    this.seen = 0;
    this.skipping = false;
    this.usage = null;
  }

  push(chunk) {
    if (!this.kind || this.kind === 'json' && this.seen > USAGE_SCAN_LIMIT) return;
    const value = this.decoder.write(Buffer.from(chunk));
    if (this.kind === 'json') {
      this.seen += chunk.length;
      if (this.seen > USAGE_SCAN_LIMIT) { this.body = ''; return; }
      this.body += value;
      return;
    }
    this.#lines(this.remainder + value);
  }

  #lines(value) {
    const parts = value.split('\n');
    this.remainder = parts.pop() ?? '';
    for (const part of parts) {
      // A line that was cut off mid-way belongs to an event already abandoned;
      // only the lines after it are real events again.
      if (this.skipping) { this.skipping = false; continue; }
      this.#line(part);
    }
    // An unfinished line already past the per-event bound is never going to
    // parse: stop holding it, and resume at the next event boundary.
    if (this.remainder.length > USAGE_LINE_LIMIT) {
      this.remainder = '';
      this.skipping = true;
    }
  }

  #line(raw) {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    if (data.length > USAGE_LINE_LIMIT) return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    const usage = usageFromJSON(payload);
    if (usage) this.usage = usage;
  }

  finish() {
    const tail = this.decoder.end();
    if (this.kind === 'json') {
      if (this.seen <= USAGE_SCAN_LIMIT && tail) this.body += tail;
      try { this.usage = usageFromJSON(JSON.parse(this.body)) ?? this.usage; } catch {}
    } else if (this.kind === 'sse') {
      const value = this.remainder + tail;
      if (value && !this.skipping) this.#line(value);
    }
    this.body = '';
    this.remainder = '';
    this.skipping = false;
    return this.usage;
  }
}

function scannerFor(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('text/event-stream')) return new UsageScanner('sse');
  if (type.includes('json')) return new UsageScanner('json');
  return new UsageScanner(null);
}

// `usedTokens` is the complete input of the request just served, so this is a
// measurement of the last request, never an estimate of a running session.
function contextOf(usage, limitTokens) {
  if (!positive(limitTokens) || !Number.isSafeInteger(usage?.inputTokens)) return null;
  return { usedTokens: usage.inputTokens, limitTokens,
    ratio: Math.round((usage.inputTokens / limitTokens) * 1000) / 1000, source: 'upstream_usage' };
}

// Average output rate over the whole request, which is what a user actually
// waits through: it includes the time before the first byte. It is deliberately
// NOT a per-token or time-to-first-token figure, and `basis` says so. A
// cancelled or failed request, a missing usage count, or a zero duration has no
// honest rate to report, so none is invented.
function rateOf(record, usage) {
  if (!record || record.status < 200 || record.status >= 300 || record.error) return null;
  if (!Number.isSafeInteger(usage?.outputTokens) || !(record.ms > 0)) return null;
  return { averageOutputTokensPerSecond: Math.round((usage.outputTokens / (record.ms / 1000)) * 100) / 100,
    basis: 'total_request_time' };
}

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
    // `contextLimit` is the vendor's own hard maximum when it is actually
    // documented; `contextWindow` is the budget the user chose and may be
    // smaller. A budget above a known limit is refused here, so a plan tier
    // that cannot serve 1M tokens never gets saved as if it could.
    if (row.contextLimit !== undefined) {
      if (!positive(row.contextLimit)) throw Error('invalid_models');
      if (row.contextWindow > row.contextLimit) throw Error('context_window_exceeds_limit');
    }
    if (row.metadataSource !== undefined) {
      if (!row.metadataSource || typeof row.metadataSource !== 'object' || Array.isArray(row.metadataSource)
        || Object.keys(row.metadataSource).some(key => !METADATA_FIELDS.has(key))
        || !METADATA_KINDS.has(row.metadataSource.kind)) throw Error('invalid_models');
      if (row.metadataSource.url !== undefined && !text(row.metadataSource.url)) throw Error('invalid_models');
      if (row.metadataSource.checkedAt !== undefined
        && !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/.test(row.metadataSource.checkedAt)) throw Error('invalid_models');
    }
    // A connection reference is stored, never resolved here: the gateway picks
    // the endpoint per request and a catalog entry must keep working while a
    // connection is being edited. `upstreamModelId` is what the upstream sees,
    // so it is validated as an opaque identifier rather than re-derived from
    // the Kimi-facing `id`.
    if (row.connectionId !== undefined && (typeof row.connectionId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.connectionId))) throw Error('invalid_models');
    if (row.upstreamModelId !== undefined && !text(row.upstreamModelId)) throw Error('invalid_models');
    const model = { id, protocol: row.protocol, contextWindow: row.contextWindow };
    if (row.contextLimit !== undefined) model.contextLimit = row.contextLimit;
    if (row.metadataSource !== undefined) {
      model.metadataSource = { kind: row.metadataSource.kind,
        ...(row.metadataSource.url === undefined ? {} : { url: row.metadataSource.url }),
        ...(row.metadataSource.checkedAt === undefined ? {} : { checkedAt: row.metadataSource.checkedAt }) };
    }
    if (row.connectionId !== undefined) model.connectionId = row.connectionId;
    if (row.upstreamModelId !== undefined) model.upstreamModelId = row.upstreamModelId;
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
        // The rate needs the finished measurement and the final status, so it is
        // computed here rather than while the stream is still being read.
        const rate = rateOf(record, record.usage);
        if (rate) record.rate = rate;
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
    // A client that hangs up before the response finished is a cancellation,
    // and it is remembered separately: the socket can go away at the same
    // instant the upstream ends, and `res.destroyed` alone would miss it.
    let clientGone = false;
    req.once('aborted', () => { clientGone = true; controller.abort(); });
    res.once('close', () => {
      if (!res.writableEnded) { clientGone = true; controller.abort(); }
    });
    try {
      const models = await this.catalog(controller.signal);
      if (isCatalog) {
        const payload = req.url === '/v1/models/api.json' ? nativeCatalog(models) : openAIModels(models);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
        return;
      }
      let payload;
      try {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > BODY_LIMIT) {
          // The body is drained once here; the catch below must not drain a
          // second time, which would double the wait for a stalled client.
          const ended = await drain(req);
          const failure = Error('request_too_large');
          failure.drained = true;
          throw failure;
        }
        payload = JSON.parse(await limited(req, BODY_LIMIT));
      } catch (failure) {
        const tooLarge = failure.message === 'request_too_large';
        // `drained` is set as soon as a drain was attempted, timed out or not:
        // a stalled client must not be drained twice.
        if (tooLarge && failure.drained === undefined && !req.readableEnded) await drain(req);
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
      const record = req.gatewayRecord;
      if (record) {
        record.model = selected.id;
        record.connectionId = selected.connectionId ?? null;
        record.upstreamModelId = selected.upstreamModelId ?? null;
      }
      const protocol = req.url === '/v1/responses' ? 'responses' : 'chat';
      if (selected.protocol !== protocol) { error(409, 'model_protocol_mismatch'); return; }
      // The local id is Kimi's route; the upstream receives the exact model it
      // declared. A route without `upstreamModelId` keeps its own id, which is
      // the single-upstream behaviour unchanged.
      const upstreamModel = selected.upstreamModelId ?? model;
      payload = { ...payload, model: upstreamModel };
      const connectionId = selected.connectionId ?? null;
      // The live backend is the authority on which endpoints this process can
      // reach; a saved-but-not-restarted connection must fail here rather than
      // during the upstream write.
      if (connectionId !== null && !(typeof this.backend.has === 'function' && this.backend.has(connectionId))) {
        error(503, 'connection_unavailable');
        return;
      }
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
        signal: controller.signal, headers, connectionId,
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
      // `firstByteMs` is the first byte the upstream sent, not the first token:
      // TTFT would need SSE event parsing, which is not done here, so the field
      // says what it actually measured. Usage is read from the same stream
      // without changing it: the chunk is forwarded before it is scanned.
      const started = Date.now();
      const scanner = upstream.ok ? scannerFor(replyHeaders['Content-Type']) : null;
      let firstByte = true;
      for await (const chunk of upstream.body || []) {
        if (firstByte) {
          firstByte = false;
          if (record) record.firstByteMs = Date.now() - started;
        }
        scanner?.push(chunk);
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      res.end();
      // A client that goes away mid-stream does not always surface as a throw:
      // the body reader may simply end. The remembered disconnect is the proof,
      // and a partial stream never reported the complete request's usage.
      const cancelled = clientGone || controller.signal.aborted || res.destroyed;
      if (record && cancelled) {
        record.status = 499;
        record.error = 'request_cancelled';
      } else if (record && scanner) {
        const usage = scanner.finish();
        if (usage) {
          record.usage = usage;
          const context = contextOf(usage, selected.contextWindow);
          if (context) record.context = context;
        }
      }
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
