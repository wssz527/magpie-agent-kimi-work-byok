import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { WorkPanel } from './work-panel.mjs';

const roots = [], running = [];
const models = [{ id: 'lab/child', name: '<script>synthetic</script>', protocol: 'responses', tools: true,
  reasoningEfforts: ['low', 'high'], defaultEffort: 'high' },
{ id: 'lab/other', name: 'Other', protocol: 'chat', tools: true, reasoningEfforts: [] },
{ id: 'lab/plain', name: 'Plain', protocol: 'chat', tools: false }];

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-work-panel-'));
  roots.push(root);
  const calls = [];
  const saved = [];
  let settings = { revision: 'rev-1', subagents: { mode: 'inherit', model: 'lab/child' } };
  const adapter = {
    stateDir: root,
    configFile: path.join(root, 'config.json'),
    rpcCall: async (...args) => { calls.push(args); },
    workSettings: async () => structuredClone(settings),
    saveWorkSettings: async input => {
      saved.push(structuredClone(input));
      const subagents = input.subagents ?? settings.subagents;
      settings = { revision: 'rev-' + (saved.length + 1), subagents };
      return structuredClone(settings);
    },
    ...overrides,
  };
  return { root, calls, saved, adapter, panel: new WorkPanel(adapter), settings: () => settings };
}

async function serve(panel) {
  await panel.start({ port: 0 });
  running.push(panel);
  return panel;
}

afterEach(async () => {
  for (const panel of running.splice(0)) await panel.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function request(panel, { path = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: new URL(panel.url).port, path, method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) } },
    res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const state = async (panel, extra = {}) => request(panel, { path: '/api/state',
  headers: { 'X-Kimi-Panel-Token': panel.token, ...extra } });

const post = async (panel, value, extra = {}) => request(panel, { path: '/api/settings', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Kimi-Panel-Token': panel.token, ...extra },
  body: JSON.stringify(value) });

test('the service hands its document, with this run\'s token, to a frame navigation only', async () => {
  const { panel } = fixture();
  await serve(panel);
  const root = await request(panel, { headers: { 'Sec-Fetch-Mode': 'navigate' } });
  expect(root.status).toBe(200);
  expect(root.text).toContain('Kimi Work 模型设置');
  expect(root.text).toContain(panel.token);
  expect(root.text).not.toContain('{{TOKEN}}');
  expect(root.headers['access-control-allow-origin']).toBeUndefined();
  expect(root.headers['content-security-policy']).toContain('connect-src');
  expect(root.headers['content-security-policy']).not.toContain('frame-ancestors');
  // Another site cannot read the token out of the document, and a page
  // cannot fetch it for itself.
  expect((await request(panel, { headers: { Origin: 'https://example.invalid' } })).status).toBe(403);
  expect((await request(panel, { headers: { 'Sec-Fetch-Mode': 'cors' } })).status).toBe(403);
  // Nor is the token in anything else the service serves.
  const asset = await request(panel, { path: '/service.html' });
  expect(asset.status).toBe(404);
  expect((await request(panel, { headers: { Host: 'example.invalid' } })).status).toBe(403);
});

test('the private API needs the control token, the loopback Host and no foreign Origin', async () => {
  const { panel } = fixture();
  await serve(panel);
  panel.publish({ code: 'native_byok_ready', currentModel: 'byok-kth-resp/lab/child',
    subagents: { policy: { mode: 'pool' }, runtime: { state: 'file-applied', transport: 'native-config' } } }, models);
  expect((await request(panel, { path: '/api/state' })).status).toBe(401);
  expect((await state(panel, { 'X-Kimi-Panel-Token': 'x'.repeat(64) })).status).toBe(401);
  // A sandboxed frame asks with Origin: null and may read the answer.
  const allowed = await state(panel, { Origin: 'null' });
  expect(allowed.status).toBe(200);
  expect(allowed.headers['access-control-allow-origin']).toBe('null');
  expect(allowed.headers['vary']).toBe('Origin');
  expect((await state(panel, { Origin: 'https://example.invalid' })).status).toBe(403);
  expect((await state(panel, { Host: 'example.invalid' })).status).toBe(403);
  const preflight = await request(panel, { path: '/api/settings', method: 'OPTIONS', headers: { Origin: 'null' } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers['access-control-allow-headers']).toContain('x-kimi-panel-token');
});

test('native connection retry is authenticated and returns without waiting for system authorization', async () => {
  let retries = 0;
  const { panel } = fixture({ requestNativeConnection() { retries++; return { state: 'running' }; },
    nativeIntegrationStatus: { state: 'needs-native-import', imported: false,
      nativeImport: { reason: 'native_import_waiting_login' } } });
  await serve(panel);
  const call = headers => request(panel, { path: '/api/connect', method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  expect((await call({})).status).toBe(401);
  expect(retries).toBe(0);
  expect((await call({ 'X-Kimi-Panel-Token': panel.token, Origin: 'null' })).status).toBe(202);
  expect(retries).toBe(1);
  const body = JSON.parse((await state(panel)).text);
  expect(body.connection).toMatchObject({ retryAvailable: true, imported: false, reason: 'native_import_waiting_login' });
});

test('legacy remote evidence is not published as current desktop or phone support', async () => {
  const { panel } = fixture({ desktop: { inspect: () => ({ state: 'active', enabled: true, version: '3.2.21',
    secret: 'synthetic-desktop-secret',
    remote: { state: 'ready', catalog: 'catalog-extended', added: 5,
      reason: 'remote_runtime_scope_unverified', apiKey: 'synthetic-remote-secret', extra: 'nope' } }) },
    nativeIntegrationStatus: { state: 'ready', imported: true } });
  await serve(panel);
  const body = JSON.parse((await state(panel)).text);
  expect(body.connection.remote).toBeUndefined();
  const text = JSON.stringify(body);
  expect(text).not.toContain('synthetic-desktop-secret');
  expect(text).not.toContain('synthetic-remote-secret');
  expect(text).not.toContain('nope');
  const failing = fixture({ desktop: { inspect: () => { throw Error('synthetic-desktop-secret'); } } }).panel;
  await serve(failing);
  expect(JSON.parse((await state(failing)).text).connection.remote).toBeUndefined();
});

test('the published state is merged with the adapter settings and never leaks a secret', async () => {
  const { panel, adapter, root } = fixture();
  fs.writeFileSync(adapter.configFile, JSON.stringify({ credentials: { apiKey: '{{SECRET_kwgworkpanel}}-key' },
    model: { current: 'byok-kth-resp/lab/child' }, private: 'synthetic-private-key' }));
  panel.publish({ code: 'native_byok_ready', url: 'http://127.0.0.1:3426/v1',
    subagents: { policy: { mode: 'pool', hidden: 'synthetic-private-key' },
      runtime: { state: 'file-applied', reason: 'synthetic-private-key', transport: 'runtime-copy' } } }, models);
  await serve(panel);
  const body = JSON.parse((await state(panel)).text);
  expect(body.schemaVersion).toBe(2);
  expect(body.models.map(row => row.id)).toEqual(['lab/child', 'lab/other', 'lab/plain']);
  expect(body.models[0].name).toBe('<script>synthetic</script>');
  expect(body.models[0].reasoningEfforts).toEqual(['low', 'high']);
  expect(body.currentModel).toBe('byok-kth-resp/lab/child');
  expect(body.subagents.mode).toBe('inherit');
  expect(body.subagents.model).toBe('lab/child');
  expect(body.subagents.transport).toBe('runtime-copy');
  expect(body.revision).toBe('rev-1');
  expect(body.settings).toBe('available');
  const text = JSON.stringify(body);
  expect(text).not.toContain('synthetic-private-key');
  expect(text).not.toContain('3426');
  // Nothing is written beside the installed plugin any more: the state is
  // in memory, and only the fixture's own config file exists.
  expect(fs.readdirSync(root)).toEqual(['config.json']);
});

test('a save needs the current revision, then reaches the adapter with a validated policy', async () => {
  const { panel, saved } = fixture();
  await serve(panel);
  panel.publish({}, models);
  const conflict = await post(panel, { revision: 'rev-0', subagents: { mode: 'force', model: 'lab/child' } });
  expect(conflict.status).toBe(409);
  expect(JSON.parse(conflict.text).error.code).toBe('work_settings_conflict');
  expect(saved).toHaveLength(0);
  const missing = await post(panel, { revision: 'rev-1' });
  expect(missing.status).toBe(400);
  expect(saved).toHaveLength(0);
  const pool = await post(panel, { revision: 'rev-1', subagents: { mode: 'pool', transport: 'native-config', model: 'lab/child',
    models: [{ id: 'lab/child', description: '实现' }, { id: 'lab/other', description: '独立审查' }] } });
  expect(pool.status).toBe(200);
  expect(saved[0]).toEqual({ revision: 'rev-1', subagents: { mode: 'pool', transport: 'native-config', model: 'lab/child',
    models: [{ id: 'lab/child', description: '实现' }, { id: 'lab/other', description: '独立审查' }] } });
  const body = JSON.parse(pool.text);
  expect(body.state.revision).toBe('rev-2');
  expect(body.state.subagents.mode).toBe('pool');
  expect(body.state.subagents.models).toHaveLength(2);
  // The next save needs the revision this one answered with.
  expect((await post(panel, { revision: 'rev-1', subagents: { mode: 'inherit' } })).status).toBe(409);
  expect((await post(panel, { revision: 'rev-2', subagents: { mode: 'inherit' } })).status).toBe(200);
});

test('invalid policies, unknown models and a missing target never reach the adapter', async () => {
  const { panel, saved } = fixture();
  await serve(panel);
  panel.publish({}, models);
  for (const [policy, code] of [
    [{ mode: 'nope' }, 'invalid_subagent_policy'],
    [{ mode: 'force', model: 'gone/model' }, 'subagent_model_unavailable'],
    [{ mode: 'force', model: 'lab/plain' }, 'subagent_model_tools_required'],
    [{ mode: 'force', model: 'lab/child', effort: 'extreme' }, 'invalid_subagent_effort'],
    [{ mode: 'pool', model: 'lab/child', models: [] }, 'invalid_subagent_pool'],
    [{ mode: 'pool', model: 'lab/child', models: [{ id: 'lab/other', description: '审查' }] }, 'invalid_subagent_pool'],
    [{ mode: 'pool', model: 'lab/child', models: [{ id: 'lab/child', description: '  ' }] }, 'invalid_subagent_description'],
    [{ mode: 'inherit', model: 'lab/child' }, 'invalid_subagent_policy'],
  ]) {
    const response = await post(panel, { revision: 'rev-1', subagents: policy });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text).error.code).toBe(code);
  }
  expect(saved).toHaveLength(0);
  expect((await post(panel, { revision: 'rev-1', mainModel: 'gone/model' })).status).toBe(400);
  // A fixed target is only useful once the native picker has chosen one.
  const noTarget = fixture();
  noTarget.panel.publish({}, models);
  await serve(noTarget.panel);
  noTarget.adapter.workSettings = async () => ({ revision: 'rev-1', subagents: { mode: 'inherit' } });
  const response = await post(noTarget.panel, { revision: 'rev-1', subagents: { mode: 'force' } });
  expect(response.status).toBe(400);
  expect(JSON.parse(response.text).error.code).toBe('subagent_target_required');
});

test('the main model switch is handed to the adapter, which owns the native call', async () => {
  const { panel, saved } = fixture();
  await serve(panel);
  panel.publish({}, models);
  const response = await post(panel, { revision: 'rev-1', mainModel: 'lab/child' });
  expect(response.status).toBe(200);
  // The adapter stores the policy with the switch, so the saved one goes along.
  expect(saved[0]).toEqual({ revision: 'rev-1', mainModel: 'lab/child',
    subagents: { mode: 'inherit', transport: 'native-config', model: 'lab/child' } });
  // A rejected save is reported by its code only, never by its message. The
  // adapter writes the code as the error's message.
  const failing = fixture({ saveWorkSettings: async () => { throw Object.assign(Error('work_settings_conflict'), { status: 409 }); } });
  await serve(failing.panel);
  const refused = await post(failing.panel, { revision: 'rev-1', mainModel: 'lab/child' });
  expect(refused.status).toBe(409);
  expect(JSON.parse(refused.text).error.code).toBe('work_settings_conflict');
  const raw = fixture({ saveWorkSettings: async () => { throw Error('raw upstream detail'); } });
  await serve(raw.panel);
  const unknown = await post(raw.panel, { revision: 'rev-1', mainModel: 'lab/child' });
  expect(unknown.status).toBe(503);
  expect(JSON.parse(unknown.text).error.code).toBe('save_failed');
  expect(unknown.text).not.toContain('raw upstream detail');
});

test('a store with no revision yet saves with null, and the next save needs what it answered', async () => {
  const { panel, saved } = fixture();
  panel.adapter.workSettings = async () => ({ revision: null, subagents: { mode: 'inherit', model: 'lab/child' } });
  panel.adapter.saveWorkSettings = async input => {
    saved.push(structuredClone(input));
    panel.adapter.workSettings = async () => ({ revision: 'rev-9', subagents: input.subagents });
  };
  await serve(panel);
  panel.publish({}, models);
  const first = await post(panel, { revision: null, subagents: { mode: 'force', model: 'lab/child' } });
  expect(first.status).toBe(200);
  expect(saved[0]).toEqual({ revision: null, subagents: { mode: 'force', transport: 'native-config', model: 'lab/child' } });
  expect(JSON.parse(first.text).state.revision).toBe('rev-9');
  expect((await post(panel, { revision: null, subagents: { mode: 'inherit' } })).status).toBe(409);
  expect((await post(panel, { revision: 'rev-9', subagents: { mode: 'inherit' } })).status).toBe(200);
});

test('bodies, methods, paths, an in-flight save and a burst of requests are bounded', async () => {
  const { panel, saved } = fixture();
  await serve(panel);
  panel.publish({}, models);
  const token = { 'X-Kimi-Panel-Token': panel.token };
  expect((await request(panel, { path: '/api/state', method: 'POST', headers: token })).status).toBe(405);
  expect((await request(panel, { path: '/api/other', headers: token })).status).toBe(404);
  expect((await request(panel, { path: '/api/settings', method: 'POST', headers: token,
    body: JSON.stringify({ revision: 'rev-1' }) })).status).toBe(415);
  const large = JSON.stringify({ revision: 'rev-1', subagents: { mode: 'inherit' }, pad: 'x'.repeat(70 * 1024) });
  expect((await request(panel, { path: '/api/settings', method: 'POST',
    headers: { ...token, 'Content-Type': 'application/json' }, body: large })).status).toBe(413);
  expect((await request(panel, { path: '/api/settings', method: 'POST',
    headers: { ...token, 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
  expect((await request(panel, { path: '/api/settings', method: 'POST',
    headers: { ...token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: 'rev-1', subagents: { mode: 'inherit' }, token: 'leak' }) })).status).toBe(400);
  expect(saved).toHaveLength(0);
  panel.bucket = { at: Date.now(), count: 120 };
  expect((await state(panel)).status).toBe(429);
  panel.bucket = { at: Date.now(), count: 0 };
  // One save at a time: the second one is told to wait, not queued.
  let release;
  panel.adapter.saveWorkSettings = input => new Promise(resolve => { release = () => resolve(input); });
  const first = post(panel, { revision: 'rev-1', subagents: { mode: 'inherit' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect((await post(panel, { revision: 'rev-1', subagents: { mode: 'inherit' } })).status).toBe(429);
  release();
  expect((await first).status).toBe(200);
});

test('without the adapter callbacks the panel reports a code instead of guessing', async () => {
  const { panel } = fixture({ workSettings: undefined, saveWorkSettings: undefined });
  await serve(panel);
  panel.publish({}, models);
  const body = JSON.parse((await state(panel)).text);
  expect(body.settings).toBe('work_settings_unavailable');
  expect(body.revision).toBeNull();
  const response = await post(panel, { revision: 'rev-1', subagents: { mode: 'inherit' } });
  expect(response.status).toBe(503);
  expect(JSON.parse(response.text).error.code).toBe('work_settings_unavailable');
});

test('a port already taken is reported, and stop releases the one this panel holds', async () => {
  const { panel } = fixture();
  await serve(panel);
  const port = Number(new URL(panel.url).port);
  const twin = fixture().panel;
  await expect(twin.start({ port })).rejects.toThrow('panel_port_unavailable');
  expect(twin.publication).toEqual({ state: 'unavailable', reason: 'panel_port_unavailable' });
  await panel.stop();
  running.splice(running.indexOf(panel), 1);
  const reused = fixture().panel;
  await reused.start({ port });
  running.push(reused);
  expect(new URL(reused.url).port).toBe(String(port));
  expect((await request(reused)).status).toBe(200);
});

test('main selection waits for idle, binds the native alias and consumes requests across restarts', async () => {
  const { panel, adapter, calls } = fixture();
  const request = { id: 'main-selection-0001', at: Date.now(), model: 'lab/child' };
  expect((await panel.selectMain(request, models, { lifecycleStatus: 'running', activeKernelTurns: ['turn'] })).state).toBe('waiting-idle');
  expect(calls).toHaveLength(0);
  expect((await panel.selectMain(request, models, { lifecycleStatus: 'running' })).state).toBe('requested');
  expect(calls[0][1]).toBe('conversations.setModel');
  expect(calls[0][2]).toEqual({ modelAlias: 'byok-kth-resp/lab/child' });
  await panel.selectMain({ ...request, id: 'main-selection-0002' }, models, { lifecycleStatus: 'running' });
  const replacement = new WorkPanel(adapter);
  await replacement.selectMain(request, models, { lifecycleStatus: 'running' });
  expect(calls).toHaveLength(2);
  expect((await replacement.selectMain({ ...request, model: 'other' }, models, { lifecycleStatus: 'running' })).state).toBe('conflict');
});

test('invalid, missing and interrupted main selection requests never call Work', async () => {
  const { panel, calls } = fixture();
  expect((await panel.selectMain({ id: 'bad' }, models, {})).state).toBe('invalid-request');
  const request = { id: 'main-selection-0001', at: Date.now(), model: 'gone' };
  expect((await panel.selectMain(request, models, {})).state).toBe('blocked');
  fs.writeFileSync(panel.receipt, JSON.stringify({ schemaVersion: 1, history: [request] }));
  expect((await panel.selectMain(request, models, { lifecycleStatus: 'running' })).state).toBe('interrupted');
  expect(calls).toHaveLength(0);
});

test('the shipped shell opens the local service and carries the theme, and has no token of its own', () => {
  const ui = new URL('./ui/', import.meta.url);
  const shell = fs.readFileSync(new URL('index.html', ui), 'utf8');
  const script = fs.readFileSync(new URL('panel.js', ui), 'utf8');
  const service = fs.readFileSync(new URL('service.html', ui), 'utf8');
  expect(shell).toContain('_magpie/bridge.js');
  expect(shell).not.toContain('{{TOKEN}}');
  expect(script).toContain("'http://127.0.0.1:3428/'");
  expect(script).toContain('location.replace');
  expect(script).toContain("method: 'hello'");
  // A panel is as tall as what it draws, and only the editor knows that.
  expect(service).toContain("method: 'size'");
  expect(service).toContain('new ResizeObserver');
  expect(service).toContain('{{TOKEN}}');
  expect(service).toContain("parent.postMessage({ magpie: 1, id, method, params }, '*')");
  // The page paints only with the theme the host posts to this frame.
  expect(service).toContain("message.event === 'theme'");
  expect(service).not.toContain('localStorage');
  // Both scripts are valid modules in a browser-like scope.
  for (const source of [script, service.slice(service.indexOf('<script>') + 8, service.lastIndexOf('</script>'))]) {
    expect(() => new vm.Script(source)).not.toThrow();
  }
});

test('the settings page states the official desktop boundary without promising phone sync', () => {
  const source = fs.readFileSync(new URL('./ui/service.html', import.meta.url), 'utf8');
  expect(source).toContain('仅接入本机官方 Kimi 桌面 Work，不同步到 Kimi 手机端');
  expect(source).not.toContain('function renderRemote(');
  expect(source).not.toContain('远程 companion');
  expect(source).not.toContain('远程目录响应已追加');
});

test('a changed runtime publication preserves the complete unsaved pool and its original revision', async () => {
  const source = fs.readFileSync(new URL('./ui/service.html', import.meta.url), 'utf8');
  const row = { dataset: { id: 'lab/child' }, check: { checked: true }, input: { value: '独立审查草稿' },
    querySelector(selector) { return selector.includes('checkbox') ? this.check : this.input; } };
  const fields = {
    mode: { value: 'pool' }, effort: { value: 'high', options: [{ value: '' }, { value: 'high' }] },
    'main-model': { value: 'lab/other', options: [{ value: '' }, { value: 'lab/other' }] },
    pool: { children: [row] },
  };
  const context = vm.createContext({ $: id => fields[id], data: { revision: 'one' }, ready: true, dirty: true,
    revision: 'one', modes() {}, api: async () => ({ revision: 'two', currentModel: 'changed' }),
    render() {
      fields.mode.value = 'force'; fields.effort.value = ''; fields['main-model'].value = '';
      row.check.checked = false; row.input.value = '';
      vm.runInContext('revision = data.revision', context);
    } });
  vm.runInContext(source.slice(source.indexOf('const signatureOf ='), source.indexOf('async function save(')), context);
  await vm.runInContext('load({ keepDraft: true })', context);
  expect(fields.mode.value).toBe('pool');
  expect(fields.effort.value).toBe('high');
  expect(fields['main-model'].value).toBe('lab/other');
  expect(row.check.checked).toBe(true);
  expect(row.input.value).toBe('独立审查草稿');
  expect(vm.runInContext('revision', context)).toBe('one');
});

test('a disconnected panel disables writes, preserves its draft and reconciles after recovery', async () => {
  const source = fs.readFileSync(new URL('./ui/service.html', import.meta.url), 'utf8');
  const row = { dataset: { id: 'lab/child' }, check: { checked: true }, input: { value: '断线前的草稿' },
    querySelector(selector) { return selector.includes('checkbox') ? this.check : this.input; } };
  const fields = {
    runtime: { textContent: '已就绪', dataset: {} }, save: { disabled: false },
    'main-apply': { disabled: false }, reset: { disabled: false },
    mode: { value: 'pool' }, effort: { value: 'high', options: [{ value: 'high' }] },
    'main-model': { value: '', options: [{ value: '' }] }, pool: { children: [row] },
  };
  let failure = Error('network unavailable');
  const context = vm.createContext({ $: id => fields[id], data: { revision: 'one' }, ready: true,
    dirty: true, revision: 'one', modes() {}, api: async () => {
      if (failure) throw failure;
      return { revision: 'two' };
    }, render() {
      fields.mode.value = 'force'; row.check.checked = false; row.input.value = '';
      for (const id of ['save', 'main-apply', 'reset']) fields[id].disabled = false;
      fields.runtime.textContent = '已恢复'; fields.runtime.dataset.error = 'false';
      vm.runInContext('revision = data.revision', context);
    } });
  vm.runInContext(source.slice(source.indexOf('const signatureOf ='), source.indexOf('async function save(')), context);
  await expect(vm.runInContext('load({ keepDraft: true })', context)).rejects.toThrow('network unavailable');
  expect(fields.runtime.textContent).toContain('正在自动重连');
  expect(fields.runtime.dataset.error).toBe('true');
  for (const id of ['save', 'main-apply', 'reset']) expect(fields[id].disabled).toBe(true);
  expect(row.input.value).toBe('断线前的草稿');
  expect(vm.runInContext('revision', context)).toBe('one');
  failure = Object.assign(Error('expired'), { code: 'unauthorized' });
  await expect(vm.runInContext('load({ keepDraft: true })', context)).rejects.toThrow('expired');
  expect(fields.runtime.textContent).toContain('重新打开本页');
  failure = null;
  await vm.runInContext('load({ keepDraft: true })', context);
  expect(fields.mode.value).toBe('pool'); expect(row.check.checked).toBe(true);
  expect(row.input.value).toBe('断线前的草稿');
  expect(vm.runInContext('revision', context)).toBe('one');
  expect(vm.runInContext('ready', context)).toBe(true);
  for (const id of ['save', 'main-apply', 'reset']) expect(fields[id].disabled).toBe(false);
});
