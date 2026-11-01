import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSubagentJSON, writeSubagentJSON } from './vendor/kimi-work-gateway/subagent-policy.mjs';

// A local service the plugin's Magpie page opens. The panel frame the host
// draws is sandboxed to scripts alone and its policy reaches no network
// (pagePolicy: connect-src 'none', frame-src 'none'), so the page it serves
// is only a shell that navigates this frame here, and the editor is drawn
// by this service. Nothing is written beside the installed plugin: the
// state is in memory, and settings go through the adapter's two callbacks.
const defaultUIDir = fileURLToPath(new URL('./ui/', import.meta.url));
const BODY_LIMIT = 64 * 1024;
const MAX_MODELS = 200;
const RATE = { windowMs: 10000, max: 120 };
const MODES = ['inherit', 'force', 'pool'];
// What the host reports as a subagent runtime state, and the codes it gives
// as a reason: both are shown as they are, and nothing else is.
const KNOWN_STATES = ['inherit', 'file-applied', 'waiting-config', 'restored', 'conflict', 'blocked',
  'unverified', 'unsupported', 'waiting-launch', 'not-prepared', 'prepared', 'starting', 'outdated',
  'policy-unavailable', 'scope-conflict', 'heartbeat-stale', 'waiting-kimi-exit', 'unavailable', 'observed-schema'];
const KNOWN_REASONS = ['subagent_native_bundle_unavailable', 'subagent_native_contract_unavailable',
  'subagent_native_contract_unverified', 'subagent_native_config_failed', 'subagent_policy_owner_conflict',
  'bundle_override_probe_failed', 'invalid_policy', 'models_missing', 'no_managed_block', 'managed_block_missing',
  'ownership_superseded', 'receipt_unverified', 'handoff_pending', 'kimi_control_rejected',
  'model_not_enabled_for_kimi', 'subagent_policy_blocked'];
const PLAIN = /^[a-z][a-z0-9_-]{0,100}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MESSAGES = {
  unauthorized: '面板会话已失效，请重新打开 Kimi Work 模型设置。',
  origin_refused: '请求来源不受信任，已拒绝。',
  host_refused: '请求地址不受信任，已拒绝。',
  json_required: '保存请求需为 JSON。',
  invalid_json: '请求内容不是有效的 JSON。',
  request_too_large: '请求内容过大。',
  method_not_allowed: '请求方法不受支持。',
  not_found: '请求的地址不存在。',
  panel_busy: '上一次保存仍在进行，请稍候。',
  panel_rate_limited: '操作过于频繁，请稍后再试。',
  panel_request_failed: '操作未完成，请稍后重试。',
  panel_assets_unavailable: '面板页面文件缺失，请重新安装插件。',
  panel_port_unavailable: '本机 3428 端口已被占用，模型设置页无法启动。',
  work_settings_unavailable: '无法读取当前设置，请确认 Kimi Work BYOK 已启用。',
  work_settings_invalid: '当前设置格式无效，请重新打开面板。',
  work_settings_conflict: '设置已在别处修改，已重新载入最新内容。',
  work_settings_stopping: '插件正在停止，请稍后重试。',
  work_not_connected: 'Kimi Work BYOK 尚未启用，无法保存模型设置。',
  model_not_enabled_for_kimi: '所选模型已不在当前目录中。',
  invalid_work_settings: '请至少修改一项设置。',
  invalid_subagent_policy: '子代理策略格式无效。',
  invalid_subagent_pool: '请选择 1–32 个候选模型，且默认模型须在池中。',
  invalid_subagent_description: '请为每个候选模型填写 1–1000 字的用途说明。',
  invalid_subagent_effort: '所选模型不支持该思考档位。',
  subagent_target_required: '请先在 Agent 卡片上的模型选择器里选定子代理目标。',
  subagent_model_unavailable: '所选模型已不在当前目录中，请重新选择。',
  subagent_model_tools_required: '此模型不支持工具调用，无法用作子代理。',
  invalid_main_model: '所选主模型已不在当前目录中。',
  save_failed: '保存未完成，请稍后重试。',
};
const SAVE_CODES = new Set(['work_settings_conflict', 'work_settings_unavailable', 'work_settings_invalid',
  'work_settings_stopping', 'work_not_connected', 'model_not_enabled_for_kimi',
  'invalid_work_settings', 'invalid_subagent_policy', 'invalid_subagent_pool', 'invalid_subagent_description',
  'invalid_subagent_effort', 'invalid_main_model', 'subagent_model_unavailable', 'subagent_model_tools_required']);

const plain = value => typeof value === 'string' && PLAIN.test(value) ? value : undefined;
const effort = value => typeof value === 'string' && EFFORT.test(value) ? value : undefined;
const modelID = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !CONTROL.test(value) ? value : undefined;
const refusal = (status, code) => Object.assign(Error(code), { status, code });
const statusFor = code => code === 'work_settings_conflict' || code === 'work_not_connected' ? 409
  : /^invalid_/.test(code) || /^subagent_(model_|target_)/.test(code) || code === 'model_not_enabled_for_kimi' ? 400
    : code === 'work_settings_stopping' ? 503 : 503;
// A refused call may carry its code as `.code` or as its message, which is
// how the adapter's own errors are written; nothing else is passed on.
const failureCode = error => [error?.code, error?.message].find(value => typeof value === 'string' && PLAIN.test(value));

function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function readJSON(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw refusal(415, 'json_required');
  if (Number(req.headers['content-length']) > BODY_LIMIT) throw refusal(413, 'request_too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw refusal(413, 'request_too_large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw refusal(400, 'invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refusal(400, 'invalid_json');
  return value;
}

export class WorkPanel {
  constructor(adapter, { file, port = 3428, uiDir = defaultUIDir } = {}) {
    this.adapter = adapter;
    // Accepted for older callers; this panel writes nothing there any more.
    this.file = file;
    this.defaultPort = port;
    this.uiDir = uiDir;
    this.receipt = path.join(adapter.stateDir, 'panel-model-receipt.json');
    // One per process: only the document this service hands out carries it.
    this.token = crypto.randomBytes(32).toString('hex');
    this.published = null;
    this.revision = null;
    this.bucket = { at: Date.now(), count: 0 };
    this.publication = { state: 'stopped' };
  }

  async start({ port = this.defaultPort } = {}) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('invalid_panel_port');
    if (this.server) return this.url;
    let document;
    try {
      const template = fs.readFileSync(path.join(this.uiDir, 'service.html'), 'utf8');
      if (!template.includes('{{TOKEN}}')) throw Error();
      document = template.split('{{TOKEN}}').join(this.token);
    } catch { throw Error('panel_assets_unavailable'); }
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    } catch {
      server.close();
      this.publication = { state: 'unavailable', reason: 'panel_port_unavailable' };
      throw Error('panel_port_unavailable');
    }
    this.server = server;
    this.document = document;
    this.host = '127.0.0.1:' + server.address().port;
    this.origin = 'http://' + this.host;
    this.url = this.origin + '/';
    this.publication = { state: 'ready', url: this.url };
    return this.url;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.document = null;
    this.host = null;
    this.origin = null;
    this.url = null;
    this.publication = { state: 'stopped' };
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }

  async selectMain(request, models, runner) {
    if (!request) return;
    if (typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(request.id)
      || !Number.isFinite(request.at) || typeof request.model !== 'string') return this.mainStatus = { state: 'invalid-request' };
    let history = [];
    try {
      const receipt = readSubagentJSON(this.receipt);
      if (receipt.schemaVersion !== 1 || !Array.isArray(receipt.history) || receipt.history.length > 128
        || receipt.history.some(row => !row || typeof row.id !== 'string' || typeof row.model !== 'string' || !Number.isFinite(row.at))) throw Error();
      history = receipt.history;
    } catch (error) { if (error.code !== 'ENOENT') return this.mainStatus = { state: 'conflict' }; }
    const previous = history.find(row => row.id === request.id);
    if (previous) return this.mainStatus = previous.model !== request.model || previous.at !== request.at
      ? { state: 'conflict' } : previous.result || { state: 'interrupted' };
    if (Math.abs(Date.now() - request.at) > 300000) return this.mainStatus = { state: 'expired-request' };
    const model = models.find(row => row.id === request.model);
    if (!model) return this.mainStatus = { state: 'blocked', reason: 'model_not_enabled_for_kimi' };
    if (runner?.lifecycleStatus !== 'running') return this.mainStatus = { state: 'waiting-kimi' };
    if ((runner.activeKernelTurns?.length || Number(runner.activeKernelTurns) || 0)
      || (runner.activeKernelToolCalls?.length || Number(runner.activeKernelToolCalls) || 0)) return this.mainStatus = { state: 'waiting-idle' };
    history = history.filter(row => Date.now() - row.at < 300000);
    if (history.length >= 128) return this.mainStatus = { state: 'too-many-requests' };
    const record = { id: request.id, at: request.at, model: model.id };
    history.push(record);
    writeSubagentJSON(this.receipt, { schemaVersion: 1, history });
    try {
      const aliases = this.adapter.nativeIntegrationStatus?.aliases;
      const alias = aliases ? aliases[model.id] : (model.protocol === 'chat' ? 'byok-kth-kimi/' : 'byok-kth-resp/') + model.id;
      if (!alias) throw Error('native_model_missing');
      await this.adapter.rpcCall(runner, 'conversations.setModel', { modelAlias: alias });
      this.mainStatus = { state: 'requested', model: model.id };
    } catch { this.mainStatus = { state: 'failed', reason: 'kimi_control_rejected' }; }
    record.result = this.mainStatus;
    writeSubagentJSON(this.receipt, { schemaVersion: 1, history });
    return this.mainStatus;
  }

  // Only allowlisted fields of what the host reported reach a page, and
  // only in memory: no credential, address or raw error text.
  publish(status = {}, models = []) {
    try {
      const rows = [];
      for (const row of Array.isArray(models) ? models : []) {
        if (rows.length >= MAX_MODELS) break;
        const id = modelID(row?.id);
        if (!id) continue;
        const efforts = Array.isArray(row.reasoningEfforts) ? row.reasoningEfforts.map(effort).filter(Boolean).slice(0, 16) : [];
        rows.push({ id, name: typeof row.name === 'string' && row.name ? row.name.slice(0, 200) : id,
          tools: row.tools === true, reasoningEfforts: efforts,
          ...(effort(row.defaultEffort) ? { defaultEffort: effort(row.defaultEffort) } : {}) });
      }
      const policy = status?.subagents?.policy || {};
      const runtime = status?.subagents?.runtime || {};
      const main = this.mainStatus ? { state: plain(this.mainStatus.state),
        ...(rows.some(row => row.id === this.mainStatus.model) ? { model: this.mainStatus.model } : {}),
        ...(plain(this.mainStatus.reason) ? { reason: plain(this.mainStatus.reason) } : {}) } : undefined;
      const current = modelID(status?.currentModel) || this.currentModelFromKimi();
      this.published = { at: Date.now(), code: plain(status?.code), models: rows,
        ...(current ? { currentModel: current } : {}), ...(main ? { main } : {}),
        revision: this.revision,
        runtime: { mode: MODES.includes(policy.mode) || policy.mode === 'blocked' ? policy.mode : undefined,
          // Both are codes the host reports, not free text: anything else is
          // dropped rather than shown.
          state: KNOWN_STATES.includes(runtime.state) ? runtime.state : undefined,
          reason: KNOWN_REASONS.includes(runtime.reason) ? runtime.reason : undefined,
          observed: runtime.observed?.state === 'observed-schema',
          transport: runtime.transport === 'runtime-copy' ? 'runtime-copy' : 'native-config' } };
    } catch {
      this.published = { at: Date.now(), models: [], runtime: { transport: 'native-config' } };
    }
  }

  // Work's current model, as Kimi's own configuration names it. Only that
  // field is read: no credential is ever opened here.
  currentModelFromKimi() {
    try {
      const doc = JSON.parse(fs.readFileSync(this.adapter.configFile, 'utf8'));
      const value = doc?.model?.current;
      return typeof value === 'string' && value.length <= 2048 ? value : undefined;
    } catch { return undefined; }
  }

  // The adapter's own view of the saved settings: an opaque revision (null
  // before anything is stored), and the subagent policy with the native
  // picker's target in `model` even while the mode is inherit. A failure is
  // reported as a code only.
  async workSettings() {
    if (typeof this.adapter?.workSettings !== 'function') return { ok: false, reason: 'work_settings_unavailable' };
    let value;
    try { value = await this.adapter.workSettings(); } catch (error) {
      return { ok: false, reason: failureCode(error) || 'work_settings_unavailable' };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'work_settings_invalid' };
    const revision = value.revision === null || value.revision === undefined ? null
      : typeof value.revision === 'string' && value.revision.length > 0 && value.revision.length <= 256 ? value.revision : undefined;
    if (revision === undefined) return { ok: false, reason: 'work_settings_invalid' };
    this.revision = revision;
    if (this.published) this.published.revision = revision;
    return { ok: true, revision, subagents: this.readPolicy(value.subagents) };
  }

  readPolicy(value) {
    const policy = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const mode = MODES.includes(policy.mode) || policy.mode === 'blocked' ? policy.mode : 'inherit';
    const target = modelID(policy.model);
    if (mode === 'inherit' || mode === 'blocked') return { mode, ...(target ? { model: target } : {}) };
    const level = effort(policy.effort);
    if (mode === 'force') return { mode, ...(target ? { model: target } : {}), ...(level ? { effort: level } : {}) };
    const rows = [];
    for (const row of Array.isArray(policy.models) ? policy.models : []) {
      if (rows.length >= 32) break;
      const id = modelID(row?.id);
      if (!id) continue;
      rows.push({ id, description: typeof row.description === 'string' ? row.description.slice(0, 1000) : '' });
    }
    return { mode, ...(target ? { model: target } : {}), models: rows };
  }

  async state() {
    const settings = await this.workSettings();
    const published = this.published || { at: 0, models: [], runtime: {} };
    const policy = settings.ok ? settings.subagents : { mode: published.runtime?.mode || 'inherit' };
    return {
      schemaVersion: 2,
      at: published.at || 0,
      ...(published.code ? { code: published.code } : {}),
      models: published.models || [],
      ...(published.currentModel ? { currentModel: published.currentModel } : {}),
      ...(published.main ? { main: published.main } : {}),
      subagents: { ...policy, state: published.runtime?.state, reason: published.runtime?.reason,
        observed: published.runtime?.observed === true, transport: published.runtime?.transport || 'native-config' },
      settings: settings.ok ? 'available' : settings.reason,
      revision: settings.ok ? settings.revision : null,
      connection: { state: plain(this.adapter.nativeIntegrationStatus?.state),
        imported: this.adapter.nativeIntegrationStatus?.imported === true,
        reason: plain(this.adapter.nativeIntegrationStatus?.nativeImport?.reason === 'native_bridge_waiting_launch'
          ? this.adapter.desktop?.inspect()?.reason || 'native_bridge_waiting_launch'
          : this.adapter.nativeIntegrationStatus?.nativeImport?.reason || this.adapter.nativeIntegrationStatus?.reason),
        preparing: Boolean(this.adapter.onboardingTask), preparation: plain(this.adapter.onboardingStatus?.state),
        retryAvailable: typeof this.adapter.requestNativeConnection === 'function' },
      service: { state: this.publication.state, ...(this.publication.reason ? { reason: this.publication.reason } : {}) },
    };
  }

  // Saving is the adapter's own model switch and native picker, never
  // magpie.options.set: a shared host restart would cut the turn in flight.
  async save(input) {
    const settings = await this.workSettings();
    if (!settings.ok) throw refusal(statusFor(settings.reason), settings.reason);
    if (input.revision !== settings.revision || (input.revision !== null && typeof input.revision !== 'string')) {
      throw refusal(409, 'work_settings_conflict');
    }
    if (typeof this.adapter?.saveWorkSettings !== 'function') throw refusal(503, 'work_settings_unavailable');
    try { await this.adapter.saveWorkSettings(input); }
    catch (failure) {
      const reported = failureCode(failure);
      const code = reported && SAVE_CODES.has(reported) ? reported : 'save_failed';
      throw refusal(statusFor(code), code);
    }
    if (this.published) this.published.at = Date.now();
    this.revision = null;
    return this.state();
  }

  // The fixed target comes from the native picker, so a policy is checked
  // here only for shape, the visible catalog and the target's presence;
  // the host validates the rest against the model it really picked.
  validatePolicy(value, settings) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw refusal(400, 'invalid_subagent_policy');
    for (const key of Object.keys(value)) if (!['mode', 'transport', 'model', 'effort', 'models'].includes(key)) throw refusal(400, 'invalid_subagent_policy');
    if (value.transport !== undefined && value.transport !== 'native-config') throw refusal(400, 'invalid_subagent_policy');
    const mode = value.mode ?? 'inherit';
    if (!MODES.includes(mode)) throw refusal(400, 'invalid_subagent_policy');
    const catalog = this.published?.models || [];
    const tools = catalog.filter(row => row.tools);
    const target = value.model === undefined ? modelID(settings.subagents?.model) : modelID(value.model);
    if (value.model !== undefined && !target) throw refusal(400, 'subagent_model_unavailable');
    const resolve = id => {
      if (!catalog.length) return undefined;
      const row = catalog.find(model => model.id === id);
      if (!row) throw refusal(400, 'subagent_model_unavailable');
      if (!row.tools) throw refusal(400, 'subagent_model_tools_required');
      return row;
    };
    if (mode === 'inherit') {
      for (const key of ['model', 'effort', 'models']) if (value[key] !== undefined) throw refusal(400, 'invalid_subagent_policy');
      return { mode, transport: 'native-config' };
    }
    if (!target) throw refusal(400, 'subagent_target_required');
    resolve(target);
    if (mode === 'force') {
      if (value.models !== undefined) throw refusal(400, 'invalid_subagent_policy');
      let level;
      if (value.effort !== undefined) {
        level = effort(value.effort);
        if (!level) throw refusal(400, 'invalid_subagent_effort');
        const row = tools.find(model => model.id === target);
        if (row && level !== 'off' && !row.reasoningEfforts.includes(level)) throw refusal(400, 'invalid_subagent_effort');
      }
      return { mode, transport: 'native-config', model: target, ...(level ? { effort: level } : {}) };
    }
    if (value.effort !== undefined) throw refusal(400, 'invalid_subagent_effort');
    if (!Array.isArray(value.models) || !value.models.length || value.models.length > 32) throw refusal(400, 'invalid_subagent_pool');
    const seen = new Set(), rows = [];
    for (const row of value.models) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw refusal(400, 'invalid_subagent_pool');
      for (const key of Object.keys(row)) if (key !== 'id' && key !== 'description') throw refusal(400, 'invalid_subagent_pool');
      const id = modelID(row.id);
      if (!id || seen.has(id)) throw refusal(400, 'invalid_subagent_pool');
      seen.add(id);
      resolve(id);
      if (typeof row.description !== 'string' || !row.description.trim() || row.description.length > 1000
        || CONTROL.test(row.description)) throw refusal(400, 'invalid_subagent_description');
      rows.push({ id, description: row.description.trim() });
    }
    if (!seen.has(target)) throw refusal(400, 'invalid_subagent_pool');
    return { mode, transport: 'native-config', model: target, models: rows };
  }

  validateMainModel(value) {
    const id = modelID(value);
    if (!id) throw refusal(400, 'invalid_main_model');
    const catalog = this.published?.models || [];
    if (catalog.length && !catalog.some(row => row.id === id)) throw refusal(400, 'invalid_main_model');
    return id;
  }

  limited() {
    const now = Date.now();
    if (now - this.bucket.at > RATE.windowMs) this.bucket = { at: now, count: 0 };
    return ++this.bucket.count > RATE.max;
  }

  refuse(res, status, code, extra = {}) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify({ error: { code, message: MESSAGES[code] || MESSAGES.panel_request_failed } }));
  }

  reply(res, status, value, extra = {}) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(value));
  }

  ownOrigin(origin) { return origin === this.origin || origin === 'null'; }

  async handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (req.headers.host !== this.host) return this.refuse(res, 403, 'host_refused');
      let pathname;
      try { pathname = new URL(req.url, this.origin).pathname; } catch { return this.refuse(res, 404, 'not_found'); }
      if (pathname.startsWith('/api/')) return await this.api(req, res, pathname);
      if (pathname === '/') return this.documentResponse(req, res);
      return this.refuse(res, 404, 'not_found');
    } catch { this.refuse(res, 500, 'panel_request_failed'); }
  }

  // The document carries the token, so it is handed only to a frame
  // navigation: no CORS header, so no other site can read it out, and no
  // request a page makes for itself (a fetch, a subresource).
  documentResponse(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.refuse(res, 405, 'method_not_allowed');
    if (req.headers.origin) return this.refuse(res, 403, 'origin_refused');
    const mode = req.headers['sec-fetch-mode'];
    if (mode && mode !== 'navigate') return this.refuse(res, 403, 'origin_refused');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // The host sandboxes the frame to scripts alone, so its origin stays
      // opaque even after this navigation: 'self' matches nothing there, so
      // this service's own address is named as well, and 'self' keeps a
      // browser that reaches it through a reverse proxy working.
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self' "
        + this.origin + "; base-uri 'none'; form-action 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : this.document);
  }

  async api(req, res, pathname) {
    const origin = req.headers.origin;
    // A sandboxed frame asks with Origin: null; the service's own page,
    // opened in place, asks with its own origin. Nothing else may ask.
    if (origin && !this.ownOrigin(origin)) return this.refuse(res, 403, 'origin_refused');
    const cors = origin === 'null' ? { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': 'null',
        'Access-Control-Allow-Headers': 'content-type, x-kimi-panel-token',
        'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
      res.end();
      return;
    }
    if (!sameSecret(req.headers['x-kimi-panel-token'], this.token)) return this.refuse(res, 401, 'unauthorized', cors);
    if (this.limited()) return this.refuse(res, 429, 'panel_rate_limited', cors);
    if (pathname === '/api/state') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return this.refuse(res, 405, 'method_not_allowed', cors);
      this.reply(res, 200, await this.state(), cors);
      return;
    }
    if (pathname === '/api/connect') {
      if (req.method !== 'POST') return this.refuse(res, 405, 'method_not_allowed', cors);
      const input = await readJSON(req);
      if (Object.keys(input).length) return this.refuse(res, 400, 'invalid_json', cors);
      if (typeof this.adapter.requestNativeConnection !== 'function') return this.refuse(res, 503, 'work_not_connected', cors);
      this.reply(res, 202, { ok: true, operation: this.adapter.requestNativeConnection() }, cors);
      return;
    }
    if (pathname !== '/api/subagents' && pathname !== '/api/settings') return this.refuse(res, 404, 'not_found', cors);
    if (req.method !== 'POST') return this.refuse(res, 405, 'method_not_allowed', cors);
    if (this.saving) return this.refuse(res, 429, 'panel_busy', cors);
    this.saving = true;
    try {
      const body = await readJSON(req);
      for (const key of Object.keys(body)) if (key !== 'revision' && key !== 'subagents' && key !== 'mainModel') throw refusal(400, 'invalid_json');
      if (body.revision !== null && typeof body.revision !== 'string') throw refusal(400, 'invalid_json');
      const input = { revision: body.revision ?? null };
      if (body.subagents !== undefined) {
        const settings = await this.workSettings();
        input.subagents = this.validatePolicy(body.subagents, settings.ok ? settings : { subagents: {} });
      }
      if (body.mainModel !== undefined) input.mainModel = this.validateMainModel(body.mainModel);
      if (input.subagents === undefined && input.mainModel === undefined) throw refusal(400, 'invalid_work_settings');
      // The adapter stores the policy with the model switch, so a request
      // that only switches the main model carries the saved policy along.
      if (input.subagents === undefined) {
        const settings = await this.workSettings();
        if (!settings.ok) throw refusal(statusFor(settings.reason), settings.reason);
        input.subagents = { mode: settings.subagents.mode === 'blocked' ? 'inherit' : settings.subagents.mode,
          transport: 'native-config',
          ...(settings.subagents.model ? { model: settings.subagents.model } : {}),
          ...(settings.subagents.effort ? { effort: settings.subagents.effort } : {}),
          ...(settings.subagents.models ? { models: settings.subagents.models } : {}) };
      }
      this.reply(res, 200, { ok: true, state: await this.save(input) }, cors);
    } catch (failure) {
      const reported = failureCode(failure);
      const code = reported && MESSAGES[reported] ? reported : 'panel_request_failed';
      this.refuse(res, failure?.status || 503, code, cors);
    } finally { this.saving = false; }
  }
}
