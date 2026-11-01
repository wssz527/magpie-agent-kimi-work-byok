import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findSubagentInstallation } from './subagent-runtime.mjs';
import { NativeSubagentConfig } from './native-subagent-config.mjs';
import { readSubagentJSON } from './subagent-policy.mjs';

// --- structural probe ------------------------------------------------------
//
// The desktop bundle is rebuilt on every release: symbols are renamed,
// formatting changes, and optional arguments are appended to calls. The probe
// therefore never looks for a name or a version. It locates the secondary
// model section by the values it is registered with — the `"secondaryModel"`
// domain string and a schema object literal that names `defaultModel` and
// `models` — then reads the behaviour it needs from that literal: whether a
// `force` key still exists, and whether a pool of one member exposes the model
// choice at all.

const DOMAIN_BINDING = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*"secondaryModel"\s*;/g;
const REGISTRATION = /registerConfigSection\s*\(/g;
// The gate that decides whether a pool of one still counts as a choice. It is
// read off the pool's own `models` map, never off a function name.
const POOL_GATE = /Object\s*\.\s*keys\s*\(\s*[^()]{0,80}\s*\.\s*models\s*\)\s*\.\s*length\s*(?:>\s*1\b|>=\s*2\b)/g;
const POOL_ENTRY = /^record\s*\(\s*string\s*\(\s*\)\s*,\s*string\s*\(\s*\)\s*\)/;
// The section module is one contiguous region of the bundle, so a gate further
// than this from the registration belongs to some other feature.
const GATE_WINDOW = 256 * 1024;

function skipLiteral(text, at) {
  const quote = text[at];
  for (let i = at + 1; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') { i++; continue; }
    if (char === quote) return i + 1;
    if (quote !== '`' && char === '\n') return -1;
  }
  return -1;
}

// Returns the index of the bracket closing the one at `at`, or -1. Strings are
// skipped; a template literal is refused because it could hide a bracket.
function balancedEnd(text, at) {
  const open = text[at];
  const close = { '(': ')', '[': ']', '{': '}' }[open];
  if (!close) return -1;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'") { const end = skipLiteral(text, i); if (end < 0) return -1; i = end - 1; continue; }
    if (char === '`') return -1;
    if (char === open) depth++;
    else if (char === close && --depth === 0) return i;
  }
  return -1;
}

// Splits `text[start..end)` on commas at depth zero.
function topLevelParts(text, start, end) {
  const parts = [];
  let depth = 0, from = start;
  for (let i = start; i < end; i++) {
    const char = text[i];
    if (char === '"' || char === "'") { const stop = skipLiteral(text, i); if (stop < 0 || stop > end) return null; i = stop - 1; continue; }
    if (char === '`') return null;
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') { if (depth === 0) return null; depth--; }
    else if (char === ',' && depth === 0) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  parts.push(text.slice(from, end));
  return parts;
}

// Reads the top-level `key: value` pairs of an object literal. Nested objects
// stay inside their own value text, so a `force` buried in a sub-schema is not
// mistaken for the section's own key.
function objectEntries(text, brace) {
  const end = balancedEnd(text, brace);
  if (end < 0) return null;
  const parts = topLevelParts(text, brace + 1, end);
  if (!parts) return null;
  const entries = new Map();
  for (const part of parts) {
    if (!part.trim()) continue;
    const match = /^\s*(?:([A-Za-z_$][\w$]*)|"([^"]*)"|'([^']*)')\s*:([\s\S]*)$/.exec(part);
    if (!match) return null;
    entries.set(match[1] ?? match[2] ?? match[3], match[4].trim());
  }
  return entries;
}

function callArguments(text, open) {
  const end = balancedEnd(text, open);
  if (end < 0) return null;
  const parts = topLevelParts(text, open + 1, end);
  if (!parts) return null;
  const args = parts.map(part => part.trim());
  return args.length === 1 && args[0] === '' ? [] : args;
}

// Parses the schema literal passed by name: `NAME = <call>({ ... })`.
function locateSchema(text, name) {
  const pattern = new RegExp('(?:const|let|var)\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '\\s*=\\s*[A-Za-z_$][\\w$]*\\s*\\(\\s*\\{');
  const match = pattern.exec(text);
  if (!match) return null;
  return objectEntries(text, match.index + match[0].length - 1);
}

function locateSecondaryModelSection(source) {
  const domains = new Set();
  for (const match of source.matchAll(DOMAIN_BINDING)) domains.add(match[1]);
  for (const match of source.matchAll(REGISTRATION)) {
    const open = match.index + match[0].length - 1;
    const args = callArguments(source, open);
    if (!args || args.length < 2) continue;
    const domain = args[0];
    if (domain !== '"secondaryModel"' && !domains.has(domain)) continue;
    const entries = args[1].startsWith('{') ? null : locateSchema(source, args[1]);
    if (!entries || !entries.has('defaultModel') || !entries.has('models')) continue;
    const from = Math.max(0, match.index - GATE_WINDOW);
    const window = source.slice(from, match.index + GATE_WINDOW);
    return {
      keys: entries,
      pool: POOL_ENTRY.test(entries.get('models')),
      countGate: new RegExp(POOL_GATE.source).test(window),
    };
  }
  return null;
}

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
    const section = locateSecondaryModelSection(source);
    const checks = {
      section: Boolean(section),
      pool: Boolean(section?.pool),
      reload: /watchCandidates\(homeDir,\s*\[configFile\]\)/.test(source) && /this\.watchDebounce\.cancelAndSet\(\(\)\s*=>\s*\{\s*this\.reload\(\)/.test(source),
      selection: source.includes('Pool entries don\'t inherit your thinking level.') && source.includes('primary_override') && source.includes('secondary_pool'),
    };
    const compatible = Object.values(checks).every(Boolean);
    // A schema that no longer carries `force` cannot be told to force: a lone
    // default_model already pins every subagent there, so the key is dropped.
    // A member-count gate means a one-entry pool offers no model choice at all;
    // without one, a pool of one still exposes the choice.
    const capabilities = section && {
      forceKeySupported: section.keys.has('force'),
      singlePoolModelChoice: !section.countGate,
    };
    return { state: compatible ? 'source-compatible' : 'unverified',
      version: installation.version, checks, ...(capabilities ? { capabilities } : {}),
      ...(!compatible ? { reason: 'subagent_native_contract_unverified' } : {}) };
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
    const applied = this.config.update(policy, this.compatibility.capabilities);
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
    // A one-entry pool is a choice only where the kernel's own member-count
    // gate counts it as one. Where it does not, a lone default pins the agent
    // tools: their model parameter and their whole model list disappear, which
    // is the configured outcome rather than a stale reload. TowerSpawn keeps
    // both because its gate only asks whether a pool exists. Demanding the
    // choice everywhere rejects a correctly loaded kernel; accepting either
    // shape everywhere would hide a reload that never happened.
    const pinned = this.policy.models.length === 1 && this.compatibility.capabilities?.singlePoolModelChoice === false;
    const offered = tool => tool.parameters?.properties?.model
      && this.policy.models.every(row => tool.description?.includes(row.modelAlias))
      && tool.description?.includes(this.policy.modelAlias + ' [default]');
    // A pinned agent tool advertises nothing, so the only thing to observe is
    // that the previous pool is gone; the default itself cannot be seen there.
    const stripped = tool => !tool.parameters?.properties?.model
      && !tool.description?.includes(this.policy.modelAlias + ' [default]');
    const visible = tools.every(tool => (pinned && tool.name !== 'TowerSpawn' ? stripped(tool) : offered(tool)));
    if (!visible) { this.clearObservation(); return { status: 503, code: 'subagent_native_reload_pending' }; }
    if (pinned) { this.clearObservation(); return; }
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
