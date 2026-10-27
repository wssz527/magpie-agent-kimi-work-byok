import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { normalizeModels } from './catalog.mjs';
import { nativeCatalog } from './native-byok.mjs';
import { inspectKimiContract, probeModels, summarizeKimiContract } from './vendor/kimi-work-gateway/index.mjs';

const archive = '/Applications/Kimi.app/Contents/Resources/app.asar';
const hasKimi = process.platform === 'darwin' && fs.existsSync(archive);

// The probe finds Kimi's catalog parser by shape rather than by the
// obfuscated name it happens to have in one build, so this test asserts the
// contract and not a particular release. A bundle it cannot read reports
// `unverified`, which is not a failure: the plugin only emits the documented
// api.json shape and never patches Kimi.
test.skipIf(!hasKimi)('installed Kimi accepts every model this plugin generates', () => {
  const result = inspectKimiContract();
  expect(['verified', 'unverified', 'unavailable']).toContain(result.state);
  if (result.state !== 'verified') return;
  expect(result.skipped).toHaveLength(0);
  expect(result.accepted.sort()).toEqual(probeModels().map(row => row.id).sort());
  // Every family Kimi can place must be produced from the probe's own models.
  expect(new Set(Object.values(result.families))).toEqual(new Set(['kimi', 'gpt', 'generic']));
});

test.skipIf(!hasKimi)('the plugin catalog survives the installed parser unchanged', () => {
  const ids = ['group/kimi-k3.1-rpro', 'group/gpt-6-1-sol', 'group/glm-5-3-flash',
    'group/deepseek-v4-1-flash', 'group/opus-5-5', 'group/step-5'];
  const data = ids.map(id => ({ id, display_name: id, context_window: 131072, max_output_tokens: 32768,
    reasoning: true, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
    modalities: { input: ['text', 'image'] } }));
  const models = normalizeModels({ data });
  const result = inspectKimiContract({ models: models.map(row => ({
    id: row.id,
    name: row.menu.displayName,
    protocol: row.id.toLowerCase().split('/').pop().startsWith('kimi-') ? 'chat' : 'responses',
    contextWindow: row.runtime.maxContextSize,
    tools: true,
  })) });
  if (result.state !== 'verified') return;
  expect(result.skipped).toHaveLength(0);
  expect(result.accepted.sort()).toEqual([...ids].sort());
});

test('the plugin splits protocols with the same naming rule Kimi itself applies', () => {
  const models = normalizeModels({ data: [
    { id: 'group/kimi-k3.1-rpro', display_name: 'Kimi K3.1 Pro', context_window: 131072 },
    { id: 'group/glm-5-3-flash', display_name: 'GLM 5.3 Flash', context_window: 131072 },
    { id: 'vendor/plain-id', display_name: 'Plain', context_window: 8192 },
  ] });
  const groups = nativeCatalog(models);
  expect(Object.keys(groups).sort()).toEqual(['kimi', 'responses']);
  expect(Object.keys(groups.kimi.models)).toEqual(['group/kimi-k3.1-rpro']);
  expect(Object.keys(groups.responses.models).sort())
    .toEqual(['group/glm-5-3-flash', 'vendor/plain-id']);
});

test('summarize explains every probe state without throwing', () => {
  for (const state of ['verified', 'incompatible', 'unverified', 'unavailable']) {
    expect(summarizeKimiContract({ state, reason: 'synthetic', accepted: [], skipped: [] }).length)
      .toBeGreaterThan(0);
  }
});
