import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';
import { normalizeNativeUrl } from './native-work-integration.mjs';
import { publicRemoteRuntime } from './remote-runtime-state.mjs';

const FILE = '.kimi-work-desktop-bridge.json';
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const safeCode = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,80}$/.test(value) ? value : 'native_bridge_failed';
const safeTarget = target => {
  if (target?.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    return url.protocol === 'app:' && url.hostname === 'localhost'
      && ['/kimi-agent.html', '/desktopclaw.html', '/work-settings.html'].includes(url.pathname);
  } catch { return false; }
};
const localGateway = value => {
  const normalized = normalizeNativeUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && url.port && url.pathname === '/v1' ? normalized : null;
};

export class NativeDesktopBridge {
  constructor({ kimiDir, pipe, applicationPid, fetchImpl = fetch, getRemoteState = () => undefined } = {}) {
    this.file = path.join(path.resolve(kimiDir), FILE);
    this.pipe = pipe;
    this.applicationPid = applicationPid;
    this.fetchImpl = fetchImpl;
    this.getRemoteState = getRemoteState;
    this.id = crypto.randomUUID();
    this.token = crypto.randomBytes(32).toString('hex');
    this.sessions = new Map();
    this.pending = false;
  }

  remoteStatus() {
    try { return publicRemoteRuntime(this.getRemoteState()); }
    catch { return { state: 'unverified', reason: 'remote_runtime_state_unavailable' }; }
  }

  async evaluate(sessionId, expression) {
    const result = await this.pipe.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, 30000);
    if (result.exceptionDetails) throw Error('native_bridge_contract_changed');
    return result.result?.value;
  }

  async targets() {
    const { targetInfos = [] } = await this.pipe.send('Target.getTargets');
    const targets = targetInfos.filter(safeTarget);
    for (const [id, session] of this.sessions) if (!targets.some(row => row.targetId === id)) {
      this.sessions.delete(id);
      await this.pipe.send('Target.detachFromTarget', { sessionId: session }).catch(() => {});
    }
    const entries = [];
    for (const target of targets) {
      let sessionId = this.sessions.get(target.targetId);
      if (!sessionId) {
        const attached = await this.pipe.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        if (typeof attached.sessionId !== 'string') continue;
        sessionId = attached.sessionId;
        this.sessions.set(target.targetId, sessionId);
      }
      entries.push({ target, sessionId });
    }
    return entries;
  }

  async importModels(input) {
    const baseUrl = localGateway(input?.url);
    if (!baseUrl || typeof input.token !== 'string' || !input.token || input.token.length > 4096) {
      return { ok: false, reason: 'native_bridge_invalid_request' };
    }
    const { NativeAccountContext } = await import('./native-account-context.mjs');
    const current = new NativeAccountContext({ kimiDir: path.dirname(this.file) }).read();
    if (!input.expectedAccountKey || input.expectedAccountKey !== current.profileKey) {
      return { ok: false, reason: 'native_import_account_changed' };
    }
    let entries = await this.targets();
    let settings;
    for (const entry of entries) {
      if (await this.evaluate(entry.sessionId, 'typeof globalThis.clawBridgeAPI?.importByokModels === "function"')) { settings = entry; break; }
    }
    if (!settings) {
      const work = entries.find(entry => new URL(entry.target.url).pathname === '/kimi-agent.html');
      if (!work) return { ok: false, reason: 'native_bridge_waiting_work' };
      const opened = await this.evaluate(work.sessionId, 'typeof globalThis.kimiAgentAPI?.openSettings === "function" && (globalThis.kimiAgentAPI.openSettings("general"), true)');
      if (!opened) return { ok: false, reason: 'native_bridge_contract_changed' };
      return { ok: false, reason: 'native_bridge_waiting_settings' };
    }
    const expression = '(async()=>{const api=globalThis.clawBridgeAPI;'
      + 'if(typeof api?.importByokModels!=="function")return {ok:false,code:"contract-changed"};'
      + 'if(typeof api.revealByok==="function"){const state=await api.revealByok();if(state?.available===false)return {ok:false,code:"feature-disabled"};}'
      + 'const result=await api.importByokModels(' + JSON.stringify(input.token) + ',' + JSON.stringify(baseUrl) + ');'
      + 'return {ok:result?.ok===true,code:result?.code,requiresRestart:result?.requiresRestart===true,restartDeferred:result?.restartDeferred===true,'
      + 'models:Array.isArray(result?.profile?.models)?result.profile.models.length:0};})()';
    const result = await this.evaluate(settings.sessionId, expression);
    return result?.ok === true ? { ok: true, models: result.models, requiresRestart: result.requiresRestart,
      restartDeferred: result.restartDeferred } : { ok: false, reason: 'native_import_' + safeCode(result?.code) };
  }

  async start() {
    if (this.server) return;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('native_bridge_path_conflict');
      const previous = readSubagentJSON(this.file);
      if (Number.isInteger(previous.pid)) {
        let alive = false;
        try { process.kill(previous.pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; }
        if (alive) throw Error('native_bridge_owner_conflict');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.server = http.createServer((request, response) => { void this.handle(request, response); });
    this.server.requestTimeout = 15000;
    this.server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.host = '127.0.0.1:' + this.server.address().port;
    writeSubagentJSON(this.file, { schemaVersion: 1, id: this.id, pid: process.pid, applicationPid: this.applicationPid,
      url: 'http://' + this.host, token: this.token });
  }

  async handle(request, response) {
    const reply = (status, result) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)); };
    if (request.headers.host !== this.host || request.headers.origin || request.headers['sec-fetch-site']
      || !equal(request.headers.authorization, 'Bearer ' + this.token)) return reply(401, { ok: false, reason: 'native_bridge_unauthorized' });
    if (request.method !== 'POST' || !['/status', '/import-models'].includes(request.url)) return reply(404, { ok: false, reason: 'native_bridge_not_found' });
    if (request.url === '/status') {
      const remote = this.remoteStatus();
      return reply(200, { ok: true, state: this.pipe?.closed ? 'disconnected' : 'ready', applicationPid: this.applicationPid,
        ...(remote ? { remote } : {}) });
    }
    if (this.pending) return reply(409, { ok: false, reason: 'native_bridge_busy' });
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return reply(415, { ok: false, reason: 'native_bridge_json_required' });
    this.pending = true;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16384) return reply(413, { ok: false, reason: 'native_bridge_request_too_large' });
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { ok: false, reason: 'native_bridge_invalid_request' }); }
      reply(200, await this.importModels(input));
    } catch (error) { reply(503, { ok: false, reason: safeCode(error.message) }); }
    finally { this.pending = false; }
  }

  async close() {
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
    for (const sessionId of this.sessions.values()) await this.pipe.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    this.sessions.clear();
    try { if (readSubagentJSON(this.file).id === this.id) fs.rmSync(this.file); } catch {}
  }
}

export async function nativeDesktopRequest(kimiDir, operation, input = {}, { fetchImpl = fetch } = {}) {
  if (!['status', 'import-models'].includes(operation)) return { ok: false, reason: 'native_bridge_invalid_request' };
  try {
    const file = path.join(path.resolve(kimiDir), FILE);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || process.platform !== 'win32' && (stat.mode & 0o077)) throw Error();
    const state = readSubagentJSON(file);
    const url = new URL(state.url);
    if (state.schemaVersion !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.pathname !== '/' || url.username || url.password || url.search || url.hash
      || typeof state.token !== 'string' || !/^[a-f0-9]{64}$/.test(state.token)) throw Error();
    const response = await fetchImpl(new URL(operation, url), { method: 'POST', headers: {
      Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json',
    }, body: JSON.stringify(input), signal: AbortSignal.timeout(35000) });
    if (!response.ok) return { ok: false, reason: 'native_bridge_unavailable' };
    return await response.json();
  } catch { return { ok: false, reason: 'native_bridge_unavailable' }; }
}
