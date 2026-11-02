import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { NativeTranslation } from './native-translation.mjs';
import { WorkPanel } from './work-panel.mjs';
import { normalizeTranslationConfig, TRANSLATION_DEFAULTS }
  from './vendor/kimi-work-gateway/translation-config.mjs';
import { translationRevision } from './vendor/kimi-work-gateway/translation-runtime.mjs';
import { readSubagentJSON } from './vendor/kimi-work-gateway/subagent-policy.mjs';

const roots = [], running = [];
const settingsFile = root => path.join(root, 'translation-settings.json');
const custom = { enabled: true, provider: 'custom', targetLanguage: 'en', view: 'original',
  customEndpoint: 'https://translator.example.invalid/v1/chat/completions', customModel: 'synthetic-model',
  apiKeyEnv: 'SYNTHETIC_TRANSLATION_KEY' };

function fixture({ stored, homeDir, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-translation-'));
  roots.push(root);
  const runtimeState = { value: { state: 'disabled' } };
  const calls = { configure: [], inspect: 0 };
  const desktop = {
    inspect: () => { calls.inspect++; return runtimeState.value; },
    configure(settings) {
      calls.configure.push(settings);
      if (runtimeState.failure) throw runtimeState.failure;
      const normalized = normalizeTranslationConfig(settings);
      fs.writeFileSync(settingsFile(root), JSON.stringify({ schemaVersion: 1,
        homeDir: homeDir || path.resolve(path.join(root, 'kimi')), settings: normalized,
        revision: translationRevision(normalized, homeDir || path.resolve(path.join(root, 'kimi'))) }));
      return normalized;
    },
    runtime: {
      desiredSettings() {
        if (runtimeState.readFailure) throw runtimeState.readFailure;
        const value = readSubagentJSON(settingsFile(root));
        const settings = normalizeTranslationConfig(value.settings);
        if (value.revision !== translationRevision(settings, value.homeDir)) throw Error('translation_settings_conflict');
        return { ...value, settings };
      },
    },
  };
  if (stored !== undefined) {
    const settings = normalizeTranslationConfig(stored);
    const home = homeDir || path.resolve(path.join(root, 'kimi'));
    fs.writeFileSync(settingsFile(root), JSON.stringify({ schemaVersion: 1, homeDir: home, settings,
      revision: translationRevision(settings, home) }));
  }
  const translation = new NativeTranslation({ desktop, env });
  return { root, calls, desktop, runtimeState, translation,
    adapter: { stateDir: root, translationSettings: () => translation.read(),
      saveTranslationSettings: input => {
        if (runtimeState.stopping) throw Object.assign(Error('translation_settings_stopping'), { status: 503 });
        return translation.save(input);
      },
      translationStatus: () => translation.status() } };
}

afterEach(async () => {
  for (const panel of running.splice(0)) await panel.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function request(panel, { path: target = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: new URL(panel.url).port, path: target, method,
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

const get = (panel, extra = {}) => request(panel, { path: '/api/translation',
  headers: { 'X-Kimi-Panel-Token': panel.token, ...extra } });
const post = (panel, value, extra = {}) => request(panel, { path: '/api/translation', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Kimi-Panel-Token': panel.token, ...extra },
  body: JSON.stringify(value) });

test('a missing settings file is the documented default and reading never writes it', () => {
  const f = fixture();
  expect(f.translation.read()).toEqual({ revision: null, settings: { ...TRANSLATION_DEFAULTS } });
  expect(f.translation.read().settings.enabled).toBe(false);
  expect(fs.readdirSync(f.root)).toEqual([]);
  expect(f.calls.configure).toHaveLength(0);
});

test('an existing standalone configuration is read as it is and never rewritten by a read', () => {
  const stored = { enabled: true, provider: 'google', targetLanguage: 'ja', view: 'translated' };
  const f = fixture({ stored });
  const before = fs.readFileSync(settingsFile(f.root), 'utf8');
  const read = f.translation.read();
  expect(read.settings).toMatchObject({ enabled: true, provider: 'google', targetLanguage: 'ja' });
  expect(typeof read.revision).toBe('string');
  expect(fs.readFileSync(settingsFile(f.root), 'utf8')).toBe(before);
});

test('a save writes exactly the reviewed revision through the embedded runtime', () => {
  const f = fixture({ stored: { enabled: false, provider: 'bing' } });
  const first = f.translation.read();
  const saved = f.translation.save({ revision: first.revision, settings: custom });
  expect(saved.settings).toEqual(custom);
  expect(saved.revision).not.toBe(first.revision);
  expect(f.calls.configure).toHaveLength(1);
  expect(f.calls.configure[0]).toEqual(custom);
  expect(JSON.parse(fs.readFileSync(settingsFile(f.root), 'utf8')).settings).toEqual(custom);
  // The next save needs the revision this one answered with.
  expect(() => f.translation.save({ revision: first.revision, settings: { ...custom, targetLanguage: 'ko' } }))
    .toThrow('translation_settings_conflict');
  expect(f.calls.configure).toHaveLength(1);
  const next = f.translation.save({ revision: saved.revision, settings: { ...custom, targetLanguage: 'ko' } });
  expect(next.settings.targetLanguage).toBe('ko');
});

test('a stale revision is refused with 409 before anything reaches the runtime', () => {
  const f = fixture({ stored: { enabled: false } });
  for (const revision of ['stale-revision', 42, undefined]) {
    let failure;
    try { f.translation.save({ revision, settings: custom }); } catch (error) { failure = error; }
    expect(failure?.status).toBe(409);
    expect(failure?.message).toBe('translation_settings_conflict');
  }
  expect(f.calls.configure).toHaveLength(0);
});

test('invalid settings answer with their own code and never touch the stored file', () => {
  const f = fixture({ stored: { enabled: false } });
  const revision = f.translation.read().revision;
  const before = fs.readFileSync(settingsFile(f.root), 'utf8');
  for (const [settings, code] of [
    [{ ...custom, provider: 'openai' }, 'invalid_translation_config'],
    [{ ...custom, targetLanguage: 'xx' }, 'invalid_translation_config'],
    [{ ...custom, customEndpoint: '' }, 'translation_endpoint_required'],
    [{ ...custom, customEndpoint: 'http://translator.example.invalid/v1' }, 'invalid_translation_endpoint'],
    [{ ...custom, apiKeyEnv: 'lower-case' }, 'invalid_translation_config'],
    [{ ...custom, apiKeyEnv: 'PATH' }, 'invalid_translation_config'],
    [{ ...custom, secret: 'synthetic' }, 'invalid_translation_config'],
  ]) {
    let failure;
    try { f.translation.save({ revision, settings }); } catch (error) { failure = error; }
    expect(failure?.status).toBe(400);
    expect(failure?.message).toBe(code);
  }
  expect(f.calls.configure).toHaveLength(0);
  expect(fs.readFileSync(settingsFile(f.root), 'utf8')).toBe(before);
});

test('the reported status is the runtime\'s own, allowlisted, and never carries an environment value', () => {
  const f = fixture({ stored: custom, env: { SYNTHETIC_TRANSLATION_KEY: 'synthetic-secret-value' } });
  f.runtimeState.value = { state: 'active', reason: 'translation_waiting_work_view', version: '3.2.21',
    application: '/synthetic/Kimi', pid: 4242 };
  const status = f.translation.status();
  expect(status).toEqual({ state: 'active', reason: 'translation_waiting_work_view', version: '3.2.21', keySet: true });
  const text = JSON.stringify(status);
  expect(text).not.toContain('synthetic-secret-value');
  expect(text).not.toContain('synthetic/Kimi');
  expect(text).not.toContain('4242');
});

test('the translation state is separate from the BYOK connection and reports an unknown runtime as such', () => {
  const f = fixture({ stored: { enabled: true, provider: 'bing' } });
  f.runtimeState.value = { state: 'waiting-kimi-exit', reason: 'translation_kimi_running' };
  expect(f.translation.status()).toEqual({ state: 'waiting-kimi-exit', reason: 'translation_kimi_running' });
  f.runtimeState.value = { state: 'not-a-real-state', secret: 'synthetic' };
  expect(f.translation.status()).toEqual({ state: 'unavailable' });
});

test('the panel answers GET and POST with revision, settings and status, and 409s a stale revision', async () => {
  const f = fixture({ stored: { enabled: true, provider: 'bing', targetLanguage: 'zh' } });
  const panel = new WorkPanel(f.adapter);
  await panel.start({ port: 0 });
  running.push(panel);
  const read = await get(panel);
  expect(read.status).toBe(200);
  const body = JSON.parse(read.text);
  expect(Object.keys(body).sort()).toEqual(['revision', 'settings', 'status']);
  expect(body.settings).toEqual({ enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'translated',
    customEndpoint: '', customModel: '', apiKeyEnv: 'KIMI_WORK_TRANSLATION_API_KEY' });
  expect(body.status.state).toBe('disabled');
  const saved = await post(panel, { revision: body.revision, settings: custom });
  expect(saved.status).toBe(200);
  const next = JSON.parse(saved.text);
  expect(next.settings).toEqual(custom);
  expect(next.revision).not.toBe(body.revision);
  const conflict = await post(panel, { revision: body.revision, settings: custom });
  expect(conflict.status).toBe(409);
  expect(JSON.parse(conflict.text).error.code).toBe('translation_settings_conflict');
  const invalid = await post(panel, { revision: next.revision, settings: { ...custom, provider: 'nope' } });
  expect(invalid.status).toBe(400);
  expect(JSON.parse(invalid.text).error.code).toBe('invalid_translation_config');
});

test('the translation endpoint keeps the panel\'s existing guards and returns no secret', async () => {
  const f = fixture({ stored: custom, env: { SYNTHETIC_TRANSLATION_KEY: 'synthetic-secret-value' } });
  const panel = new WorkPanel(f.adapter);
  await panel.start({ port: 0 });
  running.push(panel);
  expect((await request(panel, { path: '/api/translation' })).status).toBe(401);
  expect((await get(panel, { 'X-Kimi-Panel-Token': 'x'.repeat(64) })).status).toBe(401);
  expect((await get(panel, { Origin: 'https://example.invalid' })).status).toBe(403);
  expect((await request(panel, { path: '/api/translation', headers: { 'X-Kimi-Panel-Token': panel.token,
    Host: 'example.invalid' } })).status).toBe(403);
  expect((await get(panel, { Origin: 'null' })).headers['access-control-allow-origin']).toBe('null');
  expect((await request(panel, { path: '/api/translation', method: 'DELETE',
    headers: { 'X-Kimi-Panel-Token': panel.token } })).status).toBe(405);
  expect((await request(panel, { path: '/api/translation', method: 'POST',
    headers: { 'X-Kimi-Panel-Token': panel.token }, body: '{}' })).status).toBe(415);
  expect((await request(panel, { path: '/api/translation', method: 'POST',
    headers: { 'X-Kimi-Panel-Token': panel.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: null, settings: custom, token: 'leak' }) })).status).toBe(400);
  expect((await request(panel, { path: '/api/translation', method: 'POST',
    headers: { 'X-Kimi-Panel-Token': panel.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: null, settings: custom, pad: 'x'.repeat(70 * 1024) }) })).status).toBe(413);
  const body = JSON.parse((await get(panel)).text);
  expect(body.status.keySet).toBe(true);
  expect(JSON.stringify(body)).not.toContain('synthetic-secret-value');
  panel.bucket = { at: Date.now(), count: 120 };
  expect((await get(panel)).status).toBe(429);
});

test('an in-flight translation save is refused rather than queued', async () => {
  const f = fixture({ stored: { enabled: false, provider: 'bing' } });
  const panel = new WorkPanel(f.adapter);
  await panel.start({ port: 0 });
  running.push(panel);
  const revision = JSON.parse((await get(panel)).text).revision;
  panel.translationSaving = true;
  const response = await post(panel, { revision, settings: custom });
  expect(response.status).toBe(429);
  expect(JSON.parse(response.text).error.code).toBe('panel_busy');
  panel.translationSaving = false;
  expect((await post(panel, { revision, settings: custom })).status).toBe(200);
});

test('a stopping or losing adapter reports its own code and the panel never invents success', async () => {
  const f = fixture({ stored: { enabled: false, provider: 'bing' } });
  const panel = new WorkPanel({ stateDir: f.root,
    translationSettings: () => f.translation.read(),
    saveTranslationSettings: () => { throw Object.assign(Error('translation_settings_stopping'), { status: 503 }); },
    translationStatus: () => ({ state: 'disabled' }) });
  await panel.start({ port: 0 });
  running.push(panel);
  const revision = JSON.parse((await get(panel)).text).revision;
  const stopping = await post(panel, { revision, settings: custom });
  expect(stopping.status).toBe(503);
  expect(JSON.parse(stopping.text).error.code).toBe('translation_settings_stopping');
  const raw = new WorkPanel({ stateDir: f.root, translationSettings: () => f.translation.read(),
    saveTranslationSettings: () => { throw Error('raw upstream detail'); },
    translationStatus: () => ({ state: 'disabled' }) });
  await raw.start({ port: 0 });
  running.push(raw);
  const unknown = await post(raw, { revision, settings: custom });
  expect(unknown.status).toBe(503);
  expect(JSON.parse(unknown.text).error.code).toBe('save_failed');
  expect(unknown.text).not.toContain('raw upstream detail');
});

test('without an adapter callback the page is told translation is unavailable and writes are refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-translation-none-'));
  roots.push(root);
  const panel = new WorkPanel({ stateDir: root });
  await panel.start({ port: 0 });
  running.push(panel);
  const body = JSON.parse((await get(panel)).text);
  expect(body.settings).toBeNull();
  expect(body.revision).toBeNull();
  expect(body.unavailable).toBe('translation_settings_unavailable');
  expect(body.status.state).toBe('unavailable');
  expect((await post(panel, { revision: null, settings: custom })).status).toBe(503);
});

// The controller is what the panel really talks to, so its own checks —
// stopping, ownership and the revision — are exercised on it directly.
test('the controller refuses a save while stopping or when another host owns the lock', async () => {
  const { LocalKimiAdapter } = await import('./native-controller.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-translation-controller-'));
  roots.push(root);
  const adapter = new LocalKimiAdapter({ stateDir: root, kimiDir: path.join(root, 'kimi'), flagFile: path.join(root, 'flag.json'),
    stabilityMs: 0, lookupFn: async () => ({ address: '10.0.0.2' }) });
  try {
    // Nothing is configured yet: reading is the documented default.
    expect(adapter.translationSettings()).toEqual({ revision: null, settings: { ...TRANSLATION_DEFAULTS } });
    // This fixture's Kimi directory is not the user's real one, so the desktop
    // runtime reports the scope as unverified instead of claiming a state.
    expect(adapter.translationStatus()).toEqual({ state: 'unverified', reason: 'native_scope_unverified' });
    expect(fs.existsSync(settingsFile(root))).toBe(false);
    adapter.stopping = true;
    await expect(async () => adapter.saveTranslationSettings({ revision: null, settings: custom }))
      .toThrow('translation_settings_stopping');
    adapter.stopping = false;
    // Another live host holds the lock, so this one must not overwrite the
    // shared state; the check happens before the settings file is touched.
    fs.writeFileSync(adapter.lockFile, JSON.stringify({ pid: process.pid, ownerID: 'synthetic-other-owner' }));
    await expect(async () => adapter.saveTranslationSettings({ revision: null, settings: custom }))
      .toThrow('translation_settings_owner_conflict');
    expect(fs.existsSync(settingsFile(root))).toBe(false);
  } finally {
    adapter.desktop.close();
    fs.rmSync(root, { recursive: true, force: true });
    roots.splice(roots.indexOf(root), 1);
  }
});

test('the controller saves through the embedded host once it owns the lock', async () => {
  const { LocalKimiAdapter } = await import('./native-controller.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-translation-controller-'));
  roots.push(root);
  fs.mkdirSync(root, { recursive: true });
  const adapter = new LocalKimiAdapter({ stateDir: root, kimiDir: path.join(root, 'kimi'), flagFile: path.join(root, 'flag.json'),
    stabilityMs: 0, lookupFn: async () => ({ address: '10.0.0.2' }) });
  try {
    adapter.ownLock = () => true;
    expect(adapter.translationSettings()).toEqual({ revision: null, settings: { ...TRANSLATION_DEFAULTS } });
    const saved = adapter.saveTranslationSettings({ revision: null, settings: custom });
    expect(saved.settings).toEqual(custom);
    const stored = JSON.parse(fs.readFileSync(settingsFile(root), 'utf8'));
    expect(stored.settings).toEqual(custom);
    expect(stored.homeDir).toBe(path.resolve(path.join(root, 'kimi')));
    await expect(async () => adapter.saveTranslationSettings({ revision: null, settings: { ...custom, view: 'original' } }))
      .toThrow('translation_settings_conflict');
    expect(adapter.translationSettings().settings).toEqual(custom);
  } finally {
    adapter.desktop.close();
    fs.rmSync(root, { recursive: true, force: true });
    roots.splice(roots.indexOf(root), 1);
  }
});

// `shared` is the desktop runtime's bridge-takeover pickup; it is passed
// through so the page can label it honestly, and it never becomes `active`
// evidence for translation on its own.
test('a shared host pickup is reported as its own state and does not claim attachment', () => {
  const f = fixture({ stored: { enabled: true, provider: 'bing' } });
  f.runtimeState.value = { state: 'active', shared: true };
  expect(f.translation.status()).toEqual({ state: 'active', shared: true });
  f.runtimeState.value = { state: 'inactive', shared: true, job: 'synthetic' };
  expect(f.translation.status()).toEqual({ state: 'inactive', shared: true });
});

// Per-surface detail is what tells "Chat has no reasoning block on screen"
// apart from "the selectors drifted" and from "the engine is running fine".
// The shape is decided by the embedded core, so this layer neither invents
// fields nor forwards any it does not recognise.
test('the runtime\'s per-surface summary reaches the status through the core allowlist', () => {
  const f = fixture({ stored: { enabled: true, provider: 'bing' } });
  f.runtimeState.value = { state: 'active', surfaces: {
    work: { state: 'active', structure: 'matched', blocks: 2, seenBlocks: 2 },
    chat: { state: 'active', structure: 'none', blocks: 0, seenBlocks: 0, injected: 7, pid: 99 },
    sidebar: { state: 'active', structure: 'matched', blocks: 40 },
  } };
  expect(f.translation.status()).toEqual({ state: 'active', surfaces: {
    work: { state: 'active', structure: 'matched', blocks: 2, seenBlocks: 2 },
    chat: { state: 'active', structure: 'none', blocks: 0, seenBlocks: 0 },
  } });
  // An inactive page keeps its own aggregate but still says why per surface.
  f.runtimeState.value = { state: 'active', surfaces: {
    work: { state: 'inactive' }, chat: { state: 'failed', structure: 'partial', blocks: 1, seenBlocks: 3 },
  } };
  expect(f.translation.status().surfaces).toEqual({ work: { state: 'inactive' },
    chat: { state: 'failed', structure: 'partial', blocks: 1, seenBlocks: 3 } });
});

// A receipt or an adapter written before the surfaces field existed must keep
// working: the field is simply absent, and nothing invents one.
test('an older runtime without surfaces, or with a malformed one, is still read as before', () => {
  const f = fixture({ stored: { enabled: true, provider: 'bing' } });
  f.runtimeState.value = { state: 'inactive', reason: 'translation_waiting_work_view' };
  expect(f.translation.status()).toEqual({ state: 'inactive', reason: 'translation_waiting_work_view' });
  for (const surfaces of [null, 'active', [], {}, { chat: { state: 'unknown' } }]) {
    f.runtimeState.value = { state: 'active', surfaces };
    expect(f.translation.status()).toEqual({ state: 'active' });
  }
  // A recognised state with an out-of-range count keeps the state and drops
  // only that count, exactly as the core's own reader does.
  f.runtimeState.value = { state: 'active', surfaces: { chat: { state: 'active', blocks: -1, seenBlocks: 2 } } };
  expect(f.translation.status()).toEqual({ state: 'active', surfaces: { chat: { state: 'active', seenBlocks: 2 } } });
});

test('the panel hands the page the same allowlisted surfaces the runtime reported', async () => {
  const f = fixture({ stored: { enabled: true, provider: 'bing' } });
  f.runtimeState.value = { state: 'active', surfaces: { chat: { state: 'active', structure: 'matched',
    blocks: 1, seenBlocks: 1, secret: 'synthetic' } } };
  const panel = new WorkPanel(f.adapter);
  await panel.start({ port: 0 });
  running.push(panel);
  const body = JSON.parse((await get(panel)).text);
  expect(body.status.surfaces).toEqual({ chat: { state: 'active', structure: 'matched', blocks: 1, seenBlocks: 1 } });
  const text = JSON.stringify(body);
  expect(text).not.toContain('secret');
  // An adapter that was updated before the core does the same filtering, so a
  // raw inspect result cannot smuggle structure through this second layer.
  const raw = new WorkPanel({ stateDir: f.root, translationSettings: () => f.translation.read(),
    translationStatus: () => ({ state: 'active', surfaces: { work: { state: 'active', structure: 'bogus',
      seenBlocks: '3', cookie: 'x' }, chat: { state: 'active', structure: 'none' } } }) });
  await raw.start({ port: 0 });
  running.push(raw);
  const second = JSON.parse((await get(raw)).text);
  expect(second.status.surfaces).toEqual({ work: { state: 'active' }, chat: { state: 'active', structure: 'none' } });
  expect(JSON.stringify(second)).not.toContain('cookie');
});
