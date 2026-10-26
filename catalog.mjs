import crypto from 'node:crypto';

export const isMenuAlias = value => /^magpie-local-[a-f0-9]{24}$/.test(value || '');
const clean = value => typeof value === 'string' && value.length <= 2048 && !/[\x00-\x1f]/.test(value) ? value.trim() : '';
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
const effortNames = { none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };

export function normalizeModels(payload, {allowEmpty=false}={}) {
  if (!Array.isArray(payload?.data) || payload.has_more || payload.data.length > 50000) throw Error('catalog_invalid');
  const models = new Map();
  for (const row of payload.data) {
    const id = clean(row.id);
    if (!id || !id.includes('/')) continue;
    const alias = 'magpie-local-' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 24);
    const advertised = [...new Set((row.supported_reasoning_levels || []).map(x => clean(x.effort)))];
    const efforts = advertised.filter(x => Object.hasOwn(effortNames, x));
    const thinking = efforts.includes('high') ? 'high' : efforts.includes('medium') ? 'medium' : efforts[0] || '';
    const capabilities = ['dynamically_loaded_tools'];
    if (row.modalities?.input?.includes('image')) capabilities.push('image_in');
    if (row.reasoning) {
      capabilities.push('thinking');
      // A complete, known list without none cannot turn thinking off. An
      // absent/unknown list says nothing about this; keep its prior behavior.
      if (advertised.length && advertised.every(x => Object.hasOwn(effortNames, x) && x !== 'none')) {
        capabilities.push('always_thinking');
      }
    }
    const runtime = { model: alias, maxContextSize: positive(row.context_window || row.context_length, 131072),
      capabilities, ...(row.max_output_tokens ? {maxOutputSize: positive(row.max_output_tokens, 8192)} : {}),
      ...(efforts.length ? {supportEfforts: efforts, defaultEffort: thinking} : {}) };
    const title = clean(row.magpie_label) || clean(row.display_name) || id;
    models.set(id, { id, alias, runtime, menu: {
      key: alias, modelId: alias, modelAlias: alias, displayName: title + ' · Magpie', description: id,
      inputPlaceholder: '尽管问，或做个 Agent 任务…', label: [], scenario: 6, agentMode: 'TYPE_NORMAL',
      kimiPlusId: 'ok-computer', switchableTo: [],
      reasoningEffortOptions: efforts.map(e => ({effort: 'REASONING_EFFORT_' + e.toUpperCase(),
        reasoningEffort: e, thinkingLevel: e, displayName: effortNames[e], description: ''})),
      defaultReasoningEffort: thinking ? 'REASONING_EFFORT_' + thinking.toUpperCase() : 'REASONING_EFFORT_UNSPECIFIED',
      defaultThinkingLevel: thinking,
      daimonModelConfig: {maxContextSize: runtime.maxContextSize, capabilities, supportEfforts: efforts,
        defaultEffort: thinking, protocol: '', betaApi: false, reasoningKey: ''},
    }});
  }
  if (!models.size && !allowEmpty) throw Error('catalog_empty');
  return [...models.values()];
}

export function mergeRuntimeModels(existing, catalog) {
  return [...existing.filter(x => !isMenuAlias(x.model)), ...catalog.map(x => x.runtime)];
}
