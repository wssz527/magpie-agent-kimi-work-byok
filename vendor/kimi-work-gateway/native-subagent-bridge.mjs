import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findSubagentInstallation } from './subagent-runtime.mjs';
import { NativeSubagentConfig } from './native-subagent-config.mjs';
import { readSubagentJSON } from './subagent-policy.mjs';

export function inspectNativeSubagentContract(options = {}) {
  try {
    const installation = findSubagentInstallation(options);
    const relative = 'app/daimon/dist/kimi-code-v2/kernel-bundle.mjs';
    let source;
    if (installation.bundleDir) {
      const file = path.join(installation.bundleDir, relative);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw Error();
      source = fs.readFileSync(file, 'utf8');
    } else if (installation.tarball) {
      const entries = execFileSync('tar', ['-tzf', installation.tarball], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }).split(/\r?\n/);
      const candidates = entries.filter(entry => [relative, './' + relative, 'daimon-bundle/' + relative].includes(entry));
      if (candidates.length !== 1) throw Error();
      source = execFileSync('tar', ['-xOzf', installation.tarball, candidates[0]], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
    } else return { state: 'unverified', reason: 'subagent_native_bundle_unavailable' };
    const checks = {
      section: /registerConfigSection\(SECONDARY_MODEL_SECTION,\s*SecondaryModelConfigSchema\)/.test(source),
      pool: /models:\s*record\(string\(\),\s*string\(\)\)/.test(source) && source.includes('"secondaryModel"'),
      reload: /watchCandidates\(homeDir,\s*\[configFile\]\)/.test(source) && /this\.watchDebounce\.cancelAndSet\(\(\)\s*=>\s*\{\s*this\.reload\(\)/.test(source),
      selection: source.includes('Pool entries don\'t inherit your thinking level.') && source.includes('primary_override') && source.includes('secondary_pool'),
    };
    return { state: Object.values(checks).every(Boolean) ? 'source-compatible' : 'unverified',
      version: installation.version, checks,
      ...(!Object.values(checks).every(Boolean) ? { reason: 'subagent_native_contract_unverified' } : {}) };
  } catch { return { state: 'unverified', reason: 'subagent_native_contract_unavailable' }; }
}

export class NativeSubagentBridge {
  constructor({ stateDir, kimiDir, config, inspectContract = inspectNativeSubagentContract } = {}) {
    this.config = config || new NativeSubagentConfig({ stateDir, kimiDir });
    this.inspectContract = inspectContract;
    this.status = { state: 'inherit', transport: 'native-config' };
  }

  update(policy) {
    this.policy = policy;
    const signature = JSON.stringify(policy);
    this.inspect();
    if (signature !== this.signature) { this.clearObservation(); this.signature = signature; }
    if (policy.mode === 'inherit' || policy.mode === 'blocked') {
      this.status = { ...this.config.update(policy), mode: policy.mode };
      return this.status;
    }
    if (!this.compatibility || Date.now() >= this.probeAfter) {
      this.compatibility = this.inspectContract();
      this.probeAfter = Date.now() + 30000;
    }
    if (this.compatibility.state !== 'source-compatible') {
      this.clearObservation();
      this.status = { state: 'unverified', transport: 'native-config', mode: policy.mode,
        reason: this.compatibility.reason, compatibility: this.compatibility };
      return this.status;
    }
    const applied = this.config.update(policy);
    if (applied.state !== 'file-applied' || this.appliedGeneration !== this.config.generation) this.clearObservation();
    this.appliedGeneration = this.config.generation;
    this.status = { ...applied, mode: policy.mode, version: this.compatibility.version, compatibility: this.compatibility,
      ...(this.observed ? { observed: this.observed } : {}) };
    return this.status;
  }

  beforeRequest(_protocol, payload) {
    if (!this.policy || this.policy.mode === 'inherit' && this.policy.transport !== 'native-config') return;
    const status = this.update(this.policy);
    if (this.policy.mode === 'inherit') return status.state === 'conflict'
      ? { status: 409, code: 'subagent_native_restore_conflict' } : undefined;
    if (this.policy.mode === 'blocked') return { status: 409, code: this.policy.reason || 'subagent_policy_blocked' };
    if (status.state !== 'file-applied') return { status: 503, code: status.reason || 'subagent_native_config_pending' };
    if (this.policy.mode !== 'pool') return;
    const tools = (payload.tools || []).map(tool => tool.function || tool).filter(tool => ['Agent', 'AgentSwarm', 'TowerSpawn'].includes(tool.name));
    if (!tools.length) return;
    const expected = this.policy.models.map(row => row.modelAlias);
    const visible = tools.every(tool => tool.parameters?.properties?.model
      && expected.every(alias => tool.description?.includes(alias))
      && tool.description?.includes(this.policy.modelAlias + ' [default]'));
    if (!visible) { this.clearObservation(); return { status: 503, code: 'subagent_native_reload_pending' }; }
    this.observed = { state: 'observed-schema', at: Date.now() };
    this.status.observed = this.observed;
  }

  clearObservation() { this.observed = undefined; delete this.status.observed; }
  inspect() {
    if (this.observed && (Date.now() - this.observed.at > 600000 || Date.now() < this.observed.at)) this.clearObservation();
    return this.status;
  }
  close() { this.policy = undefined; return this.status = this.config.close(); }
}

export function bindNativeSubagents({ policy, gateway, stateDir, kimiDir, bridge } = {}) {
  const native = bridge || new NativeSubagentBridge({ stateDir, kimiDir });
  let nativeSelected = false;
  const ownsPolicy = () => {
    try {
      const document = readSubagentJSON(policy.file);
      return document.ownerID === policy.ownerID && document.revision === policy.revision;
    } catch { return false; }
  };
  const sync = () => {
    const selected = policy.value || { mode: 'inherit' };
    if ((selected.transport === 'native-config' || nativeSelected) && !ownsPolicy()) {
      native.status = { state: 'conflict', transport: 'native-config', reason: 'subagent_policy_owner_conflict' };
      return false;
    }
    if (selected.transport === 'native-config' || selected.mode === 'blocked' && nativeSelected) {
      nativeSelected = true;
      native.update({ ...selected, transport: 'native-config' });
    } else if (nativeSelected) {
      const restored = native.update({ mode: 'inherit', transport: 'native-config' });
      nativeSelected = restored.state === 'conflict';
    } else native.update({ mode: 'inherit' });
    return true;
  };
  const guard = (protocol, payload) => sync() ? native.beforeRequest(protocol, payload)
    : { status: 409, code: 'subagent_policy_owner_conflict' };
  gateway.beforeRequest = guard;
  const timer = setInterval(() => { try { sync(); } catch { native.status = { state: 'conflict', transport: 'native-config', reason: 'subagent_native_config_failed' }; } }, 1000);
  timer.unref?.();
  const close = policy.close.bind(policy);
  policy.close = () => {
    clearInterval(timer);
    if (gateway.beforeRequest === guard) gateway.beforeRequest = undefined;
    try { if (!nativeSelected || ownsPolicy()) native.close(); } finally { close(); }
  };
  policy.nativeSync = sync;
  policy.nativeSubagents = native;
  sync();
  return native;
}
