import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateModels } from './gateway.mjs';

export const SUBAGENT_POLICY_FILE = 'subagent-policy.json';

export function normalizeSubagentPolicy(value, models) {
  if (value === undefined) return { mode: 'inherit' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_subagent_policy');
  const mode = value.mode ?? 'inherit';
  if (!['inherit', 'force'].includes(mode)) throw Error('invalid_subagent_policy');
  if (mode === 'inherit') return { mode };
  if (typeof value.model !== 'string' || !value.model || value.model.length > 1024
    || /[\u0000-\u001f\u007f]/.test(value.model)) throw Error('invalid_subagent_model');
  const model = validateModels(models).find(row => row.id === value.model);
  if (!model) throw Error('subagent_model_unavailable');
  if (!model.tools) throw Error('subagent_model_tools_required');
  const effort = value.effort ?? model.defaultEffort;
  if (effort !== undefined && (typeof effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort)
    || (effort !== 'off' && (!model.reasoning || !model.reasoningEfforts?.includes(effort))))) {
    throw Error('invalid_subagent_effort');
  }
  return { mode, model: model.id, modelAlias: (model.protocol === 'chat' ? 'byok-kth-kimi/' : 'byok-kth-resp/') + model.id,
    ...(effort === undefined ? {} : { effort }) };
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
