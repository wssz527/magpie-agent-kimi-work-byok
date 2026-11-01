import crypto from 'node:crypto';
import path from 'node:path';
import { normalizeSubagentPolicy } from './vendor/kimi-work-gateway/index.mjs';
import { readSubagentJSON, writeSubagentJSON } from './vendor/kimi-work-gateway/subagent-policy.mjs';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nativeKey = value => value === undefined ? undefined : digest({ mode: value?.model ? 'force' : 'inherit', model: value?.model || '' });
const intent = value => ({ mode: value?.mode || 'inherit', transport: 'native-config',
  ...(['force', 'pool'].includes(value?.mode) ? { model: value.model,
    ...(value.mode === 'pool' ? { models: value.models.map(row => ({ id: row.id, description: row.description })) } : {}),
    ...(value.effort === undefined ? {} : { effort: value.effort }) } : {}) });
const conflict = code => Object.assign(Error(code), { status: 409 });

export class WorkSettings {
  constructor({ stateDir }) { this.file = path.join(stateDir, 'work-settings.json'); }

  read() {
    let value;
    try { value = readSubagentJSON(this.file); } catch (error) { if (error.code === 'ENOENT') return null; throw conflict('work_settings_conflict'); }
    if (value?.schemaVersion !== 1 || !value.subagents || !['inherit', 'force', 'pool'].includes(value.subagents.mode)
      || value.nativeSelection !== null && !/^[a-f0-9]{64}$/.test(value.nativeSelection)
      || value.revision !== digest({ subagents: value.subagents, nativeSelection: value.nativeSelection })) throw conflict('work_settings_conflict');
    return value;
  }

  persist(previous, subagents, nativeSelection) {
    if (this.read()?.revision !== previous?.revision) throw conflict('work_settings_conflict');
    const fields = { subagents: intent(subagents), nativeSelection: nativeSelection ?? null };
    const document = { schemaVersion: 1, ...fields, revision: digest(fields) };
    writeSubagentJSON(this.file, document);
    return document;
  }

  resolve(nativeSelection, legacySelection) {
    const previous = this.read(), key = nativeKey(nativeSelection);
    let document = previous;
    if (!previous) {
      const selected = legacySelection?.mode === 'pool' ? legacySelection : nativeSelection ?? legacySelection;
      document = this.persist(null, selected, key);
    } else if (key !== undefined && key !== previous.nativeSelection) {
      document = this.persist(previous, nativeSelection, key);
    }
    this.nativeSelection = key ?? document.nativeSelection;
    return document.subagents;
  }

  snapshot() {
    const current = this.read();
    return current ? { revision: current.revision, subagents: current.subagents }
      : { revision: null, subagents: { mode: 'inherit', transport: 'native-config' } };
  }

  save(input, models, nativeSelection) {
    const current = this.read();
    if (!current || typeof input?.revision !== 'string' || input.revision !== current.revision) throw conflict('work_settings_conflict');
    if (!input.subagents || typeof input.subagents !== 'object' || Array.isArray(input.subagents)) throw Error('invalid_subagent_policy');
    const normalized = normalizeSubagentPolicy({ ...input.subagents, transport: 'native-config' }, models);
    const key = nativeKey(nativeSelection) ?? this.nativeSelection ?? current.nativeSelection;
    this.persist(current, normalized, key);
    this.nativeSelection = key;
    return this.snapshot();
  }
}
