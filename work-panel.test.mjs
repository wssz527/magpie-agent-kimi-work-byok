import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { WorkPanel } from './work-panel.mjs';

const roots = [];
const models = [{ id: 'lab/child', name: '<script>synthetic</script>', protocol: 'responses', tools: true }];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-work-panel-')); roots.push(root);
  const calls = [];
  const adapter = { stateDir: root, configFile: path.join(root, 'config.json'),
    rpcCall: async (...args) => { calls.push(args); } };
  const file = path.join(root, 'runtime-state.js');
  return { root, calls, adapter, file, panel: new WorkPanel(adapter, { file }) };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
test('main selection waits for idle, binds the native alias and consumes requests across restarts', async () => {
  const { panel, adapter, calls, file } = fixture();
  const request = { id: 'main-selection-0001', at: Date.now(), model: 'lab/child' };
  expect((await panel.selectMain(request, models, { lifecycleStatus: 'running', activeKernelTurns: ['turn'] })).state).toBe('waiting-idle');
  expect(calls).toHaveLength(0);
  expect((await panel.selectMain(request, models, { lifecycleStatus: 'running' })).state).toBe('requested');
  expect(calls[0][1]).toBe('conversations.setModel'); expect(calls[0][2]).toEqual({ modelAlias: 'byok-kth-resp/lab/child' });
  const second = { ...request, id: 'main-selection-0002' };
  await panel.selectMain(second, models, { lifecycleStatus: 'running' });
  const replacement = new WorkPanel(adapter, { file });
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
test('the sandbox asset only publishes allowlisted metadata, never keys or raw errors', () => {
  const { panel, adapter, file } = fixture();
  fs.writeFileSync(adapter.configFile, JSON.stringify({ credentials: { apiKey: 'synthetic-private-key' }, model: { current: 'byok-kth-resp/lab/child' } }));
  panel.publish({ code: 'native_byok_ready', url: 'private-address', subagents: { policy: { mode: 'pool', hidden: 'synthetic-private-key' },
    runtime: { state: 'file-applied', reason: 'raw error synthetic-private-key', transport: 'native-config' } } }, models);
  const source = fs.readFileSync(file, 'utf8');
  expect(source).not.toContain('synthetic-private-key'); expect(source).not.toContain('private-address'); expect(source).not.toContain('<script>');
  const scope = { dispatchEvent() {}, Event: class {} }; vm.runInNewContext(source, scope);
  expect(scope.KIMI_WORK_STATE.models[0].id).toBe('lab/child');
  expect(scope.KIMI_WORK_STATE.subagents.state).toBe('file-applied');
});
test('panel publication preserves symlink targets and reports an unwritable panel', () => {
  const { panel, file, root } = fixture(); const target = path.join(root, 'untouched'); fs.writeFileSync(target, 'keep');
  try { fs.symlinkSync(target, file); } catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; }
  panel.publish({}, models); expect(panel.publication.state).toBe('unavailable'); expect(fs.readFileSync(target, 'utf8')).toBe('keep');
});
