// Appends the effective BYOK rows of the native profile to the official Work
// catalog; the official object is never rewritten.

const BYOK_PREFIXES = ['byok-kth-kimi/', 'byok-kth-resp/'];
const CONTROL = /[\u0000-\u001f\u007f]/;

const isPlain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' && value.length > 0
  && value.length <= limit && !CONTROL.test(value);
const lastSegment = value => value.slice(value.lastIndexOf('/') + 1);
const current = value => value === undefined || value === null || value === false;

// Native order is delisted → effective models → pending, so a pending snapshot
// never blocks an effective row and only a literal `true` disables the profile.
function delistedAliases(profile) {
  const delisted = new Set();
  for (const key of ['pending', 'delisted']) {
    const value = profile[key];
    if (value === true) return null;
    if (Array.isArray(value)) {
      if (key === 'delisted') for (const alias of value) delisted.add(alias);
      continue;
    }
    if (current(value) || (key === 'pending' && isPlain(value))) continue;
    return null;
  }
  return delisted;
}

function usableAlias(row, delisted) {
  if (!isPlain(row) || !current(row.pending) || !current(row.delisted)) return null;
  if (!text(row.alias, 1024) || !text(row.providerId, 512) || !text(row.model, 1024)) return null;
  if (!Number.isSafeInteger(row.maxContextSize) || row.maxContextSize <= 0) return null;
  if (delisted.has(row.alias)) return null;
  const prefix = BYOK_PREFIXES.find(item => row.alias.startsWith(item));
  if (!prefix || row.providerId !== prefix.slice(0, -1)) return null;
  return row.alias.length > prefix.length ? row.alias : null;
}

function descriptor(alias) {
  const id = lastSegment(alias);
  return {
    key: alias,
    displayName: id,
    description: '',
    inputPlaceholder: '',
    label: [],
    scenario: 0,
    modelId: id,
    modelAlias: alias,
    agentMode: 'TYPE_NORMAL',
    kimiPlusId: '',
    switchableTo: [],
    reasoningEffortOptions: [],
    defaultReasoningEffort: 'REASONING_EFFORT_UNSPECIFIED',
    defaultThinkingLevel: '',
  };
}

export function mergeRemoteWorkConfig(workConfig, profile) {
  if (!isPlain(workConfig) || !Array.isArray(workConfig.models)) return workConfig;
  if (workConfig.moreModels !== undefined && !Array.isArray(workConfig.moreModels)) return workConfig;
  if (!isPlain(profile) || (profile.kind !== 'kth' && profile.id !== 'byok-kth')) return workConfig;
  if (!Array.isArray(profile.models)) return workConfig;
  const delisted = delistedAliases(profile);
  if (!delisted) return workConfig;
  const taken = new Set();
  for (const entry of [...workConfig.models, ...(workConfig.moreModels ?? [])]) {
    if (!isPlain(entry)) continue;
    if (typeof entry.key === 'string' && entry.key) taken.add(entry.key);
    if (typeof entry.modelAlias === 'string' && entry.modelAlias) taken.add(entry.modelAlias);
  }
  const added = [];
  for (const row of profile.models) {
    const alias = usableAlias(row, delisted);
    if (!alias || taken.has(alias)) continue;
    taken.add(alias);
    added.push(descriptor(alias));
  }
  if (!added.length) return workConfig;
  return { ...workConfig, models: [...workConfig.models, ...added] };
}
