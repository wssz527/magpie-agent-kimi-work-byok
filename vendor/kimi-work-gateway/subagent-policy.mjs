import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateModels } from './gateway.mjs';

export const SUBAGENT_POLICY_FILE = 'subagent-policy.json';

export function normalizeSubagentPolicy(value, models) {
  if (value === undefined) return { mode: 'inherit' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_subagent_policy');
  const mode = value.mode ?? 'inherit';
  if (!['inherit', 'force', 'pool'].includes(mode)) throw Error('invalid_subagent_policy');
  if (value.transport !== undefined && value.transport !== 'native-config') throw Error('invalid_subagent_transport');
  const transport = value.transport === 'native-config' || mode === 'pool' ? { transport: 'native-config' } : {};
  if (mode === 'inherit') return { mode, ...transport };
  const catalog = validateModels(models);
  const resolve = id => {
    if (typeof id !== 'string' || !id || id.length > 1024 || /[\u0000-\u001f\u007f]/.test(id)) throw Error('invalid_subagent_model');
    const model = catalog.find(row => row.id === id);
    if (!model) throw Error('subagent_model_unavailable');
    if (!model.tools) throw Error('subagent_model_tools_required');
    return { model, modelAlias: (model.protocol === 'chat' ? 'byok-kth-kimi/' : 'byok-kth-resp/') + model.id };
  };
  const { model, modelAlias } = resolve(value.model);
  if (mode === 'pool') {
    if (!Array.isArray(value.models) || !value.models.length || value.models.length > 32) throw Error('invalid_subagent_pool');
    const seen = new Set();
    const pool = value.models.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || seen.has(row.id)) throw Error('invalid_subagent_pool');
      seen.add(row.id);
      const resolved = resolve(row.id);
      if (typeof row.description !== 'string' || !row.description.trim() || row.description.length > 1000 || /[\u0000-\u001f\u007f]/.test(row.description)) throw Error('invalid_subagent_description');
      return { id: resolved.model.id, modelAlias: resolved.modelAlias, description: row.description.trim() };
    });
    if (!seen.has(model.id)) throw Error('subagent_pool_default_required');
    if (value.effort !== undefined) throw Error('invalid_subagent_effort');
    return { mode, ...transport, model: model.id, modelAlias, models: pool };
  }
  const effort = value.effort ?? model.defaultEffort;
  if (effort !== undefined && (typeof effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort)
    || (effort !== 'off' && (!model.reasoning || !model.reasoningEfforts?.includes(effort))))) throw Error('invalid_subagent_effort');
  return { mode, ...transport, model: model.id, modelAlias, ...(effort === undefined ? {} : { effort }) };
}

export function readSubagentJSON(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error('subagent_file_conflict');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeSubagentJSON(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw Error('subagent_file_conflict');
  try { readSubagentJSON(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export class SubagentPolicy {
  constructor({ stateDir, kimiDir }) {
    this.file = path.join(path.resolve(stateDir), SUBAGENT_POLICY_FILE);
    this.homeDir = path.resolve(kimiDir, 'runtime', 'kimi-code', 'home');
    this.ownerID = crypto.randomUUID();
  }

  save(policy) {
    const fields = { ...policy, homeDir: this.homeDir };
    const revision = crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    const document = { schemaVersion: 1, ownerID: this.ownerID, revision, ...fields };
    let current;
    try { current = readSubagentJSON(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current?.ownerID !== this.ownerID || current?.revision !== revision) writeSubagentJSON(this.file, document);
    this.value = policy;
    this.revision = revision;
    return policy;
  }

  configure(value, models) {
    let policy;
    try { policy = normalizeSubagentPolicy(value, models); }
    catch (error) { this.save({ mode: 'blocked', reason: error.message }); throw error; }
    return this.save(policy);
  }

  close() {
    let current;
    try { current = readSubagentJSON(this.file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (current.ownerID === this.ownerID) this.save({ mode: 'inherit' });
  }
}
