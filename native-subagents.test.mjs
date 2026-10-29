import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeSubagents } from './native-subagents.mjs';
import { agent, connect } from './kimi-desktop.agent.js';

const roots = [];
const models = [{ id: 'group/deepseek-v4-1-flash', protocol: 'responses', contextWindow: 128000, tools: true }];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-magpie-subagents-'));
  roots.push(root);
  const calls = [];
  const runtime = { prepare() { calls.push('prepare'); return { state: 'prepared' }; },
    async launch() { calls.push('launch'); return { state: 'waiting-kimi-exit' }; },
    inspect() { return { state: 'waiting-launch' }; } };
  const options = { stateDir: path.join(root, 'state'), kimiDir: path.join(root, 'kimi'), runtime };
  return { options, calls, runtime, control: new NativeSubagents(options) };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test('the Magpie native selector targets subagents and keeps the Work main-model setting separate', () => {
  expect(agent.model).toBe('subagents.model');
  const gateway = { v1: 'http://127.0.0.1:3425/v1', key: 'synthetic-agent-key' };
  const selected = connect({ gateway, model: { id: models[0].id } });
  expect(selected['subagents.mode']).toBe('force');
  expect(selected.model).toBeUndefined();
  expect(selected['gateway.key']).toBe(gateway.key);
  expect(connect({ gateway })['subagents.mode']).toBe('inherit');
});

test('the selected native child model is validated against Magpie visibility and restored by its owner', async () => {
  const { control } = fixture();
  const desired = { mode: 'force', model: models[0].id };
  const status = await control.update(desired, models);
  expect(status.policy).toMatchObject({ mode: 'force', modelAlias: 'byok-kth-resp/' + models[0].id });
  expect(status.runtime.state).toBe('waiting-launch');
  expect(read(control.policy.file).model).toBe(models[0].id);
  const blocked = await control.update(desired, []);
  expect(blocked.policy).toEqual({ mode: 'blocked', reason: 'subagent_model_unavailable' });
  expect(read(control.policy.file).mode).toBe('blocked');
  control.close();
  expect(read(control.policy.file).mode).toBe('inherit');
});

test('old native configs without subagents inherit and legacy model fields cannot select a child', async () => {
  const { control } = fixture();
  const old = { model: models[0].id, mode: 'native-byok' };
  expect((await control.update(old.subagents, models)).policy).toEqual({ mode: 'inherit' });
  expect(read(control.policy.file).model).toBeUndefined();
});

test('runtime operations require fresh requests and stay consumed across option reloads', async () => {
  const { control, options, calls } = fixture();
  for (const request of [undefined, { id: 'prepare-too-old-0001', action: 'prepare', at: 0 },
    { id: 'prepare-wrong-action', action: 'kill', at: Date.now() }]) {
    await control.update(undefined, models, request);
  }
  expect(calls).toEqual([]);
  const prepare = { id: 'prepare-native-0001', action: 'prepare', at: Date.now() };
  expect((await control.update(undefined, models, prepare)).operation.state).toBe('prepared');
  await control.update(undefined, models, prepare);
  const replacement = new NativeSubagents(options);
  await replacement.update(undefined, models, prepare);
  const launch = { id: 'launch-native-00001', action: 'launch', at: Date.now() };
  expect((await replacement.update(undefined, models, launch)).operation.state).toBe('waiting-kimi-exit');
  await replacement.update(undefined, models, prepare);
  expect(calls).toEqual(['prepare', 'launch']);
});

test('interrupted operations are reported without replaying a launch', async () => {
  const { control, calls } = fixture();
  const request = { id: 'launch-interrupted-001', action: 'launch', at: Date.now() };
  fs.mkdirSync(path.dirname(control.receiptFile), { recursive: true });
  fs.writeFileSync(control.receiptFile, JSON.stringify({ schemaVersion: 1, history: [request] }));
  const status = await control.update(undefined, models, request);
  expect(status.operation.state).toBe('interrupted');
  expect(calls).toEqual([]);
});

test('a failed runtime operation does not disable the gateway policy or leak raw errors', async () => {
  const { control, runtime, calls } = fixture();
  runtime.prepare = () => { calls.push('prepare'); throw Error('private path and synthetic-secret'); };
  const request = { id: 'prepare-failure-0001', action: 'prepare', at: Date.now() };
  const status = await control.update({ mode: 'force', model: models[0].id }, models, request);
  expect(status.policy.mode).toBe('force');
  expect(status.operation).toEqual({ state: 'failed', reason: 'subagent_operation_failed' });
  await control.update(undefined, models, request);
  expect(calls).toEqual(['prepare']);
  expect(fs.readFileSync(control.receiptFile, 'utf8')).not.toContain('synthetic-secret');
});

test('an unavailable selected child blocks an explicit launch while keeping preparation possible', async () => {
  const { control, calls } = fixture();
  const status = await control.update({ mode: 'force', model: 'removed/model' }, models,
    { id: 'launch-blocked-00001', action: 'launch', at: Date.now() });
  expect(status.policy.mode).toBe('blocked');
  expect(status.operation).toEqual({ state: 'failed', reason: 'subagent_policy_blocked' });
  expect(calls).toEqual([]);
});

test('explicit native pools bypass the disabled copy launcher and retain revocation checks', async () => {
  const { options, calls } = fixture(); const updates = [];
  const native = { update(policy) { updates.push(policy); return { state: 'file-applied', transport: 'native-config' }; },
    beforeRequest() { return updates.at(-1).mode === 'blocked' ? { status: 409, code: 'subagent_model_unavailable' } : undefined; }, close() { calls.push('restore-native'); } };
  const control = new NativeSubagents({ ...options, native });
  const desired = { mode: 'pool', model: models[0].id, models: [{ id: models[0].id, description: 'Independent review' }] };
  expect((await control.update(desired, models, { id: 'prepare-native-0001', action: 'prepare', at: Date.now() })).runtime.state).toBe('file-applied');
  expect(updates.at(-1).modelAlias).toBe('byok-kth-resp/' + models[0].id); expect(calls).toEqual([]);
  expect((await control.update(desired, [])).policy.mode).toBe('blocked');
  expect(control.beforeRequest('responses', {})).toEqual({ status: 409, code: 'subagent_model_unavailable' });
  await control.update({ mode: 'inherit', transport: 'native-config' }, models);
  expect(updates.at(-1).mode).toBe('inherit'); control.close(); expect(calls).toEqual(['restore-native']);
});

test('native restore conflicts remain visible on disable', async () => {
  const { options } = fixture();
  const native = { update: () => ({ state: 'inherit' }), close: () => ({ state: 'conflict', reason: 'modified_block' }) };
  const control = new NativeSubagents({ ...options, native });
  await control.update({ mode: 'inherit', transport: 'native-config' }, models);
  expect(() => control.close()).toThrow('subagent_native_restore_conflict');
  expect(read(control.policy.file).mode).toBe('inherit');
  const legacy = new NativeSubagents({ ...options, native });
  await legacy.update(undefined, models);
  expect(() => legacy.close()).not.toThrow();
});
