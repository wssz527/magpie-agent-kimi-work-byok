import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SUBAGENT_HOOK_VERSION = 2;

// A blocked policy is reported to the kernel as an empty `[secondary_model]`
// section. The kernel reads `{}` as "no section at all": it advertises no
// model pool (`exposesSubagentModelChoice` is false) and resolves no forced
// binding, so the parent keeps its own model. `{ models: {} }` is the wrong
// marker — the kernel treats it as a configured-but-empty pool, which
// publishes an "Available models: primary" hint and fails the kernel's own
// section validation (`default_model required`). The empty object also carries
// no identity, so a clone, merge or cached copy of it stays equally inert.
const blockedSection = () => ({});

const RESTORE_HINT = ': restore a valid gateway policy before using subagents';
// Policy text can reach a model-visible error message, so only a plain
// identifier shape is ever echoed back.
const reasonText = reason => /^[a-z_]{1,80}$/.test(reason ?? '') ? reason : 'subagent_policy_blocked';
const blockedError = reason => Error(reasonText(reason) + RESTORE_HINT);
const blockedPolicy = (homeDir, reason) => ({ mode: 'blocked', reason, homeDir, revision: '0'.repeat(64) });

export function createSubagentRuntimeHook({ policyPath, receiptPath, runtimeId, sourceHash }) {
  let observed;
  // The home this hook was asked to configure and whose policy file matched.
  // Legacy two-argument guards fall back to it; an explicit homeDir never does.
  let managedHomeDir;
  // The home this process actually runs under when it is *not* the one this
  // policy file describes. Guards for that home stay out of the way, so a Kimi
  // under another home keeps its own subagent model.
  let foreignHomeDir;
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
  const publish = next => {
    if (JSON.stringify(observed) !== JSON.stringify(next)) receiptAt = 0;
    observed = next;
    writeReceipt();
    if (!timer) { timer = setInterval(writeReceipt, 5000); timer.unref?.(); }
  };
  // What a receipt may say about a policy. Only known fields are copied, so a
  // hand-written policy file cannot smuggle extra content into a receipt.
  const summary = value => ({ homeDir: value.homeDir, revision: value.revision, mode: value.mode,
    ...(value.mode === 'force' ? { modelAlias: value.modelAlias } : {}),
    ...(value.mode === 'blocked' ? { reason: reasonText(value.reason) } : {}) });

  // Reads the policy from disk *now*. `scope` is the absolute home being
  // answered; a missing or unreadable file becomes a blocked policy for that
  // same scope, so a lost policy file can never be read as "no gateway here".
  const readPolicy = scope => {
    let value;
    try {
      const stat = fs.lstatSync(policyPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error();
      value = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
      if (value?.schemaVersion !== 1 || !['inherit', 'force', 'blocked'].includes(value.mode)
        || typeof value.homeDir !== 'string' || !path.isAbsolute(value.homeDir)
        || !/^[a-f0-9]{64}$/.test(value.revision)) throw Error();
    } catch {
      return blockedPolicy(scope, 'subagent_policy_unavailable');
    }
    if (value.mode === 'force' && (typeof value.modelAlias !== 'string' || !value.modelAlias
      || value.modelAlias.length > 2048 || /[\u0000-\u001f\u007f]/.test(value.modelAlias)
      || (value.effort !== undefined && (typeof value.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.effort))))) {
      return { ...value, mode: 'blocked', reason: 'invalid_subagent_policy' };
    }
    return value;
  };

  // Which policy governs this call, if any. `undefined` means this gateway has
  // no say here, so the caller's own behaviour stands.
  //
  // The verdict comes from the policy on disk and from the scope being asked
  // about, never from the identity of the section object the kernel happens to
  // hold. A cloned, merged or cached section therefore cannot lift a block and
  // cannot downgrade a forced binding: only the disk decides.
  //
  // An explicit `homeDir` states the scope, so the disk policy governs even
  // when the kernel hands over no section at all. The legacy two-argument
  // shape can only fall back to the scope `configuration(homeDir)` recorded,
  // and it needs a section to be in play: with no section this gateway's
  // configuration was never consulted, so guessing a home could wrongly
  // police a Kimi running somewhere else.
  const governedPolicy = (homeDir, section) => {
    let scope;
    if (homeDir !== undefined) {
      if (typeof homeDir !== 'string' || !homeDir || !path.isAbsolute(homeDir)) {
        throw Error('subagent_scope_invalid: homeDir must be a non-empty absolute path');
      }
      scope = path.resolve(homeDir);
      // A home this process already declared foreign, or one this hook has
      // never served, is not ours to police.
      if (scope === foreignHomeDir) return undefined;
      if (managedHomeDir !== undefined && scope !== managedHomeDir) return undefined;
    } else {
      if (!section || typeof section !== 'object') return undefined;
      // No scope stated and none recorded: this gateway supplied nothing.
      if (managedHomeDir === undefined) return undefined;
      scope = managedHomeDir;
    }
    const value = readPolicy(scope);
    // The scope is the one we serve, but the file names another home: it
    // cannot be trusted here, so fail closed instead of silently inheriting.
    return path.resolve(value.homeDir) === scope ? value
      : blockedPolicy(scope, 'subagent_policy_unavailable');
  };
  const readSection = config => {
    try { return config?.get?.('secondaryModel'); } catch { return undefined; }
  };

  return {
    configuration(homeDir) {
      if (typeof homeDir !== 'string' || !homeDir) return;
      const scope = path.resolve(homeDir);
      const value = readPolicy(scope);
      if (path.resolve(value.homeDir) !== scope) {
        // This Kimi runs under another home: apply nothing there, but leave a
        // receipt the parent runtime can tell apart from a corrupt policy
        // instead of waiting for a launch that will never report.
        foreignHomeDir = scope;
        publish({ homeDir: scope, revision: value.revision, mode: 'blocked', reason: 'subagent_scope_mismatch' });
        return;
      }
      managedHomeDir = scope;
      publish(summary(value));
      if (value.mode === 'blocked') return blockedSection();
      if (value.mode !== 'force') return;
      return { force: true, defaultModel: value.modelAlias,
        ...(value.effort === undefined ? {} : { defaultEffort: value.effort }) };
    },
    assertSpawn(config, input, homeDir) {
      const section = readSection(config);
      const policy = governedPolicy(homeDir, section);
      if (policy?.mode === 'blocked') throw blockedError(policy.reason);
      if (input?.fork === true && policy?.mode === 'force') {
        throw Error('subagent_policy_fork_conflict: fork inherits the parent model; create a new subagent without fork');
      }
    },
    assertModel(config, modelAlias, homeDir) {
      const section = readSection(config);
      const policy = governedPolicy(homeDir, section);
      if (policy?.mode === 'blocked') throw blockedError(policy.reason);
      const expected = policy?.mode === 'force' ? policy.modelAlias : undefined;
      if (typeof expected === 'string' && modelAlias !== expected) {
        throw Error('subagent_policy_resume_conflict: the saved subagent uses another model; create a new subagent');
      }
      if (policy === undefined) return;
      const previousAlias = lastSpawn?.modelAlias;
      lastSpawn = { modelAlias, at: Date.now() };
      if (previousAlias !== modelAlias) receiptAt = 0;
      publish(summary(policy));
    },
    dispose() { clearInterval(timer); timer = undefined; },
  };
}
