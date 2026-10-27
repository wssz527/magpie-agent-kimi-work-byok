import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SUBAGENT_HOOK_VERSION = 1;

export function createSubagentRuntimeHook({ policyPath, receiptPath, runtimeId, sourceHash }) {
  let observed;
  let timer;
  let lastSpawn;
  let receiptAt = 0;
  const writeReceipt = () => {
    if (!observed || Date.now() - receiptAt < 1000) return;
    const temporary = receiptPath + '.' + randomUUID() + '.tmp';
    try {
      if (fs.lstatSync(path.dirname(receiptPath)).isSymbolicLink()) return;
      try { if (!fs.lstatSync(receiptPath).isFile() || fs.lstatSync(receiptPath).isSymbolicLink()) return; } catch (error) { if (error.code !== 'ENOENT') return; }
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, pid: process.pid, runtimeId, sourceHash,
        ...observed, ...(lastSpawn ? { lastSpawn } : {}), at: Date.now() }) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, receiptPath);
      receiptAt = Date.now();
    } catch {} finally { try { fs.unlinkSync(temporary); } catch {} }
  };
  const blockedSections = new WeakMap();
  const policy = homeDir => {
    let value;
    try {
      const stat = fs.lstatSync(policyPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error();
      value = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
      if (value?.schemaVersion !== 1 || !['inherit', 'force', 'blocked'].includes(value.mode)
        || typeof value.homeDir !== 'string' || !path.isAbsolute(value.homeDir)
        || !/^[a-f0-9]{64}$/.test(value.revision)) throw Error();
    } catch {
      value = { mode: 'blocked', reason: 'subagent_policy_unavailable', homeDir: path.resolve(homeDir), revision: '0'.repeat(64) };
    }
    if (path.resolve(homeDir) !== path.resolve(value.homeDir)) return;
    if (value.mode === 'force' && (typeof value.modelAlias !== 'string' || !value.modelAlias
      || value.modelAlias.length > 2048 || /[\u0000-\u001f\u007f]/.test(value.modelAlias)
      || (value.effort !== undefined && (typeof value.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.effort))))) {
      value = { ...value, mode: 'blocked', reason: 'invalid_subagent_policy' };
    }
    const next = { homeDir: value.homeDir, revision: value.revision, mode: value.mode,
      ...(value.mode === 'force' ? { modelAlias: value.modelAlias } : {}),
      ...(value.mode === 'blocked' ? { reason: /^[a-z_]{1,80}$/.test(value.reason) ? value.reason : 'subagent_policy_blocked' } : {}) };
    if (JSON.stringify(observed) !== JSON.stringify(next)) receiptAt = 0;
    observed = next;
    writeReceipt();
    if (!timer) { timer = setInterval(writeReceipt, 5000); timer.unref?.(); }
    return value;
  };
  const assertAvailable = section => {
    if (section && blockedSections.has(section)) throw Error(blockedSections.get(section) + ': restore a valid gateway policy before using subagents');
  };
  return {
    configuration(homeDir) {
      const value = policy(homeDir);
      if (value?.mode === 'blocked') {
        const section = { models: {} };
        blockedSections.set(section, observed.reason);
        return section;
      }
      if (value?.mode !== 'force') return;
      return { force: true, defaultModel: value.modelAlias,
        ...(value.effort === undefined ? {} : { defaultEffort: value.effort }) };
    },
    assertSpawn(config, input) {
      const section = config.get('secondaryModel');
      assertAvailable(section);
      if (input.fork && section?.force) {
        throw Error('subagent_policy_fork_conflict: fork inherits the parent model; create a new subagent without fork');
      }
    },
    assertModel(config, modelAlias) {
      const section = config.get('secondaryModel');
      assertAvailable(section);
      if (section?.force && modelAlias !== (section.defaultModel ?? section.model)) {
        throw Error('subagent_policy_resume_conflict: the saved subagent uses another model; create a new subagent');
      }
      lastSpawn = { modelAlias, at: Date.now() };
      receiptAt = 0;
      writeReceipt();
    },
    dispose() { clearInterval(timer); timer = undefined; },
  };
}
