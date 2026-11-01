import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkSettings } from './work-settings.mjs';

const models = ['first', 'second'].map(id => ({ id, protocol: 'responses', contextWindow: 128000, tools: true }));
const fixture = () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-work-settings-'));
  return { store: new WorkSettings({ stateDir }), stateDir, close: () => fs.rmSync(stateDir, { recursive: true, force: true }) };
};

test('native card selection wins over stale legacy options and survives a connection-file rebuild', () => {
  const f = fixture();
  try {
    const native = { mode: 'force', model: 'first' };
    expect(f.store.resolve(native, { mode: 'force', model: 'second' })).toMatchObject({ model: 'first', transport: 'native-config' });
    expect(new WorkSettings({ stateDir: f.stateDir }).resolve(undefined)).toMatchObject({ model: 'first' });
    expect(f.store.resolve({ mode: 'force', model: 'second' })).toMatchObject({ model: 'second' });
  } finally { f.close(); }
});

test('pool purposes and default persist across restarts; an explicit native picker change supersedes the pool', () => {
  const f = fixture();
  try {
    const native = { mode: 'force', model: 'first' };
    f.store.resolve(native);
    const saved = f.store.save({ revision: f.store.snapshot().revision,
      subagents: { mode: 'pool', model: 'second', models: [{ id: 'first', description: 'Implementation' }, { id: 'second', description: 'Review' }] } }, models);
    const restarted = new WorkSettings({ stateDir: f.stateDir });
    expect(restarted.resolve(native)).toEqual(saved.subagents);
    expect(restarted.resolve({ mode: 'inherit' })).toEqual({ mode: 'inherit', transport: 'native-config' });
  } finally { f.close(); }
});

test('legacy pools migrate with their own default, and saving a pool can update the native-card baseline', () => {
  const f = fixture();
  try {
    const native = { mode: 'force', model: 'first' };
    const pool = { mode: 'pool', model: 'second', models: [{ id: 'first', description: 'Build' }, { id: 'second', description: 'Review' }] };
    expect(f.store.resolve(native, pool)).toMatchObject(pool);
    const changedCard = { mode: 'force', model: 'second' };
    const saved = f.store.save({ revision: f.store.snapshot().revision, subagents: pool }, models, changedCard);
    expect(new WorkSettings({ stateDir: f.stateDir }).resolve(changedCard)).toEqual(saved.subagents);
  } finally { f.close(); }
});

test('settings reject stale writes and unavailable defaults without overwriting the durable intent', () => {
  const f = fixture();
  try {
    f.store.resolve({ mode: 'force', model: 'first' });
    const initial = f.store.snapshot();
    f.store.save({ revision: initial.revision, subagents: { mode: 'force', model: 'second' } }, models);
    expect(() => f.store.save({ revision: initial.revision, subagents: { mode: 'inherit' } }, models)).toThrow('work_settings_conflict');
    expect(() => f.store.save({ revision: f.store.snapshot().revision, subagents: { mode: 'force', model: 'gone' } }, models)).toThrow('subagent_model_unavailable');
    expect(f.store.snapshot().subagents.model).toBe('second');
    expect(fs.readFileSync(f.store.file, 'utf8')).not.toContain('apiKey');
  } finally { f.close(); }
});
