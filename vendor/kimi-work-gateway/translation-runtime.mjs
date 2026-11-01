import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { archiveCandidates, installedVersion } from './kimi-contract.mjs';
import { normalizeTranslationConfig, reservedEnvName } from './translation-config.mjs';
import { readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';

const HOST = fileURLToPath(new URL('./translation-host.mjs', import.meta.url));
const STATES = new Set(['starting', 'attaching', 'active', 'inactive', 'legacy-running', 'failed', 'exited']);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const KNOWN_TRANSLATION_KIMI_VERSIONS = new Set(['3.2.21']);
export const TRANSLATION_KIMI_VERSIONS = KNOWN_TRANSLATION_KIMI_VERSIONS;
export const translationRevision = (settings, homeDir) => digest({ homeDir, settings });
export function remoteRuntimeRevision() {
  try {
    return digest(['translation-host.mjs', 'remote-companion-runtime.mjs', 'remote-companion.mjs',
      'remote-work-hook.mjs', 'remote-work-models.mjs', 'remote-credentials.mjs',
      'remote-credentials-service.mjs', 'remote-credentials-client.mjs', 'remote-update-proxy.mjs',
      'remote-update-client.mjs', 'remote-update-helper.mjs', 'native/remote-official-updater.node']
      .map(name => crypto.createHash('sha256').update(fs.readFileSync(new URL(name, import.meta.url))).digest('hex')));
  } catch { return undefined; }
}
export const translationAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

function applicationCandidates(archive, platform) {
  const p = platform === 'win32' ? path.win32 : path;
  const parent = p.dirname(p.dirname(p.resolve(archive)));
  return platform === 'darwin' ? [p.join(parent, 'MacOS', 'Kimi')]
    : ['Kimi.exe', 'kimi-desktop.exe', 'Kimi', 'kimi'].map(name => p.join(parent, name));
}

export function sameInstallation(launchRecord, platform = process.platform) {
  if (!launchRecord || typeof launchRecord.application !== 'string' || typeof launchRecord.archive !== 'string'
    || typeof launchRecord.discoveredApplication !== 'string') return false;
  const p = platform === 'win32' ? path.win32 : path;
  const application = p.resolve(launchRecord.application);
  return application === p.resolve(launchRecord.discoveredApplication)
    && (launchRecord.explicitApplication === true || applicationCandidates(launchRecord.archive, platform).includes(application));
}

export function readTranslationSettings(file, homeDir) {
  const value = readSubagentJSON(file);
  if (value.schemaVersion !== 1 || typeof value.homeDir !== 'string' || !path.isAbsolute(value.homeDir)
    || homeDir !== undefined && value.homeDir !== homeDir) throw Error('translation_scope_conflict');
  const settings = normalizeTranslationConfig(value.settings);
  if (value.revision !== translationRevision(settings, value.homeDir)) throw Error('translation_settings_conflict');
  return { ...value, settings };
}

const resolvePath = (value, platform) => (platform === 'win32' ? path.win32 : path).resolve(value);

// Installation identity is what decides whether a supervised restart is an
// update or a plain re-open. It deliberately keeps the version string as one
// component among path/mtime/size rather than as a gate: a rebuilt build at the
// same version still counts as a new installation.
export function installationIdentity(installation, platform = process.platform) {
  if (!installation || typeof installation.archive !== 'string' || typeof installation.application !== 'string') return null;
  let stamp = '';
  try {
    const stat = fs.statSync(installation.archive);
    stamp = stat.size + ':' + Math.round(stat.mtimeMs);
  } catch {}
  const archive = resolvePath(installation.archive, platform);
  const application = resolvePath(installation.application, platform);
  const version = typeof installation.version === 'string' ? installation.version : 'unknown';
  return { archive, application, version, signature: digest({ archive, application, version, stamp }) };
}

export function installationChanged(recorded, current, platform = process.platform) {
  if (!recorded || !current) return false;
  const before = typeof recorded.signature === 'string' ? recorded : installationIdentity(recorded, platform);
  const after = installationIdentity(current, platform);
  if (!before || !after) return false;
  if (before.archive !== after.archive || before.application !== after.application) return true;
  return before.signature !== after.signature;
}

export function translationInstallation({ archive, application, platform = process.platform, env = process.env } = {}) {
  const file = archive || archiveCandidates({ platform, env }).find(candidate => fs.existsSync(candidate));
  if (!file || !fs.existsSync(file)) throw Error('translation_kimi_unavailable');
  const executable = application || applicationCandidates(file, platform).find(candidate => fs.existsSync(candidate));
  if (!executable || !fs.existsSync(executable)
    || !sameInstallation({ application: executable, archive: file, discoveredApplication: executable,
      explicitApplication: Boolean(application) }, platform)) {
    throw Error('translation_kimi_unavailable');
  }
  const version = installedVersion(file) || 'unknown';
  const p = platform === 'win32' ? path.win32 : path;
  return { archive: p.resolve(file), application: p.resolve(executable), version, platform,
    explicitApplication: Boolean(application) };
}

export function kimiProcessRunning(application, platform = process.platform) {
  return kimiProcessIds(application, platform).length > 0;
}

// Pids of processes whose executable is this exact application path.
//
// Matching by process name alone is not proof: a second copy from another
// install, or a differently configured userData dir, shares the name. Committing
// a quit to the wrong pid is unacceptable, so the executable path is compared
// and callers get a count of name-only matches to detect ambiguity.
export function inspectApplicationProcesses(application, platform = process.platform, { run = spawnSync } = {}) {
  const paths = platform === 'win32' ? path.win32 : path;
  const executable = paths.resolve(application);
  const name = paths.basename(executable).replace(/\.exe$/i, '');
  const output = platform === 'win32'
    ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-Process -Name '" + name.replaceAll("'", "''") + "' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + ' ' + $_.Path })"],
      { windowsHide: true, timeout: 10000, encoding: 'utf8' })
    : run('ps', ['-axo', 'pid=,comm='], { timeout: 10000, encoding: 'utf8' });
  if (output.error || output.status !== 0) throw Error('translation_process_check_failed');
  const rows = String(output.stdout || '').split('\n').map(line => line.trim()).filter(Boolean)
    .map(line => {
      const at = line.search(/\s/);
      return at < 0 ? null : { pid: Number(line.slice(0, at)), command: line.slice(at + 1).trim() };
    }).filter(row => row && Number.isInteger(row.pid) && row.pid > 0);
  let sameName = rows.filter(row => paths.basename(row.command).replace(/\.exe$/i, '').toLowerCase() === name.toLowerCase());
  if (platform === 'darwin' && sameName.length > 1 && sameName.length <= 64) {
    const pids = sameName.map(row => row.pid);
    const script = 'ObjC.import("AppKit"); JSON.stringify(' + JSON.stringify(pids)
      + '.map(pid=>{const app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);'
      + 'return {pid,registered:!!app&&!app.isNil()};}));';
    try {
      const result = run('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 10000, encoding: 'utf8' });
      const values = result.status === 0 && !result.error ? JSON.parse(String(result.stdout || '')) : null;
      if (Array.isArray(values) && values.length === pids.length
        && values.every((row, index) => row?.pid === pids[index] && typeof row.registered === 'boolean')
        && values.some(row => row.registered)) {
        const registered = new Set(values.filter(row => row.registered).map(row => row.pid));
        sameName = sameName.filter(row => registered.has(row.pid));
      }
    } catch {}
  }
  const matches = sameName.filter(row => {
    const value = paths.resolve(row.command);
    return platform === 'win32' ? value.toLowerCase() === executable.toLowerCase() : value === executable;
  });
  return { pids: matches.map(row => row.pid), nameMatches: sameName.length, total: rows.length };
}

export function kimiProcessIds(application, platform = process.platform) {
  return inspectApplicationProcesses(application, platform).pids;
}

export class TranslationRuntime {
  constructor({ stateDir, kimiDir, env = process.env, installation, spawnHost = spawn,
    locate = translationInstallation, isAlive = translationAlive } = {}) {
    this.stateDir = path.resolve(stateDir);
    this.homeDir = path.resolve(kimiDir);
    this.settingsFile = path.join(this.stateDir, 'translation-settings.json');
    this.receiptFile = path.join(this.stateDir, 'translation-runtime.json');
    this.launchFile = path.join(this.stateDir, 'translation-launch.json');
    this.env = env;
    this.installationOptions = installation || {};
    this.locate = locate;
    this.spawnHost = spawnHost;
    this.isAlive = isAlive;
    this.settings = normalizeTranslationConfig();
  }

  configure(value) {
    const settings = normalizeTranslationConfig(value);
    const desired = { schemaVersion: 1, homeDir: this.homeDir, settings,
      revision: translationRevision(settings, this.homeDir) };
    let previous;
    try { previous = readTranslationSettings(this.settingsFile, this.homeDir); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous?.revision !== desired.revision) writeSubagentJSON(this.settingsFile, desired);
    this.settings = settings;
    return settings;
  }

  // The enabled intent lives in translation-settings.json. A supervisor reads it
  // without reconfiguring so that an inspection never rewrites user state.
  desiredSettings() {
    return readTranslationSettings(this.settingsFile, this.homeDir);
  }

  activeLaunch() {
    let launch;
    try { launch = readSubagentJSON(this.launchFile); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Error('translation_session_conflict');
    }
    if (!launch || launch.homeDir !== this.homeDir || launch.handedOff === true) return null;
    if (this.isAlive(launch.pid)) return launch;
    const receipt = this.sessionReceipt();
    return receipt?.id === launch.id && receipt.state !== 'exited' && this.isAlive(receipt.pid) ? launch : null;
  }

  // The last receipt this scope wrote, including the managed application pid.
  // A receipt left behind by a dead host is still evidence that a managed
  // session existed and when it ended; the supervisor needs that to decide
  // whether a newly appeared Kimi instance replaced ours or was user-started.
  sessionReceipt() {
    let receipt;
    try { receipt = readSubagentJSON(this.receiptFile); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Error('translation_session_conflict');
    }
    if (!receipt || receipt.schemaVersion !== 1 || receipt.homeDir !== this.homeDir) return null;
    return receipt;
  }

  runningPids(application = this.locate({ ...this.installationOptions, env: this.env }).application,
    platform = this.platform || process.platform) {
    return kimiProcessIds(application, platform);
  }

  // Application processes plus the name-only match count, so a caller can refuse
  // to act when more than one build shares the executable name.
  inspectApplication(application = this.locate({ ...this.installationOptions, env: this.env }).application,
    platform = this.platform || process.platform) {
    return inspectApplicationProcesses(application, platform);
  }

  inspect() {
    const status = this.inspectCurrent();
    if (status.state === 'failed' && typeof status.version !== 'string') return status;
    const now = Date.now();
    if (['disabled', 'not-started', 'starting'].includes(status.state)
      && (typeof this.versionCheckedAt !== 'number' || now < this.versionCheckedAt || now - this.versionCheckedAt >= 60000)) {
      this.versionCheckedAt = now;
      try { this.version = this.locate({ ...this.installationOptions, env: this.env }).version; }
      catch { this.version = undefined; }
    }
    const version = typeof status.version === 'string' ? status.version : this.version;
    if (typeof version !== 'string') return status;
    return { ...status, version,
      ...(KNOWN_TRANSLATION_KIMI_VERSIONS.has(version) ? {} : { verification: 'unverified-version' }) };
  }

  inspectCurrent() {
    let desired;
    try { desired = readTranslationSettings(this.settingsFile, this.homeDir); }
    catch (error) {
      if (error.code !== 'ENOENT') return { state: 'failed', reason: 'translation_settings_conflict' };
      return { state: this.settings.enabled ? 'not-started' : 'disabled' };
    }
    let receipt;
    try { receipt = readSubagentJSON(this.receiptFile); }
    catch (error) { if (error.code !== 'ENOENT') return { state: 'failed', reason: 'translation_session_conflict' }; }
    if (receipt) {
      if (receipt.schemaVersion !== 1 || receipt.homeDir !== this.homeDir || !STATES.has(receipt.state)
        || typeof receipt.id !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt.id)) {
        return { state: 'failed', reason: 'translation_session_conflict' };
      }
      const info = { ...(typeof receipt.version === 'string' ? { version: receipt.version } : {}),
        ...(Number.isInteger(receipt.pid) ? { pid: receipt.pid } : {}),
        ...(typeof receipt.reason === 'string' && /^[a-z][a-z0-9_-]{0,100}$/.test(receipt.reason) ? { reason: receipt.reason } : {}) };
      if (this.isAlive(receipt.pid) && receipt.state !== 'exited') {
        const age = Date.now() - receipt.at;
        if (!Number.isFinite(age) || age < 0 || age > 15000) return { ...info, state: 'stale' };
        if (receipt.revision !== desired.revision) return { ...info, state: 'pending-settings' };
        if (receipt.state === 'active' && !desired.settings.enabled) return { ...info, state: 'pending-settings' };
        return { ...info, state: receipt.state };
      }
      if (receipt.state === 'failed') return { ...info, state: 'failed' };
    }
    try {
      const launch = readSubagentJSON(this.launchFile);
      if (launch.homeDir !== this.homeDir) return { state: 'failed', reason: 'translation_scope_conflict' };
      if (this.isAlive(launch.pid) && Date.now() - launch.at < 15000) return { state: 'starting' };
    } catch (error) { if (error.code !== 'ENOENT') return { state: 'failed', reason: 'translation_session_conflict' }; }
    return { state: desired.settings.enabled ? 'not-started' : 'disabled' };
  }

  check() {
    const current = this.inspect();
    if (!['disabled', 'not-started'].includes(current.state)) return current;
    try {
      const installation = this.locate({ ...this.installationOptions, env: this.env });
      this.version = installation.version;
      this.versionCheckedAt = Date.now();
      // The version is informational; KNOWN_* only marks what this codebase was
      // hand-verified against. Unknown builds stay launchable and are labelled.
      const known = KNOWN_TRANSLATION_KIMI_VERSIONS.has(installation.version);
      return { ...current, version: installation.version,
        ...(known ? {} : { verification: 'unverified-version' }) };
    } catch (error) {
      const incompatible = error.message === 'translation_runtime_incompatible';
      return { state: incompatible ? 'incompatible' : 'failed',
        reason: incompatible ? error.message : 'translation_kimi_unavailable' };
    }
  }

  // Classifies the subagent runtime for a plain (non-force) translation launch.
  // Translation and model access are deliberately independent: a missing or
  // not-prepared runtime never blocks a pure translation launch, while a
  // runtime that exists but cannot be trusted right now must not be silently
  // dropped — the launch proceeds WITHOUT the bundle and reports exactly why.
  subagentContext(subagentRuntime) {
    if (!subagentRuntime) return { mode: 'absent' };
    let status;
    try { status = subagentRuntime.inspect(); } catch { return { mode: 'unusable', reason: 'subagent_state_conflict' }; }
    if (!status || typeof status.state !== 'string') return { mode: 'unusable', reason: 'subagent_state_conflict' };
    if (['loaded', 'pending-policy', 'waiting-launch'].includes(status.state)) {
      try {
        const context = subagentRuntime.launchContext();
        if (!context) return { mode: 'unusable', reason: 'subagent_runtime_not_ready', state: status.state };
        return { mode: 'adopted', context, state: status.state };
      } catch (error) {
        return { mode: 'unusable', reason: /^subagent_[a-z0-9_]+$/.test(error.message) ? error.message : 'subagent_state_conflict', state: status.state };
      }
    }
    if (status.state === 'not-prepared' || status.state === 'unavailable') return { mode: 'absent', state: status.state };
    // A prepared-but-currently-unusable runtime (outdated, conflict,
    // heartbeat-stale, policy-unavailable, …) launches translation alone and
    // says so; only force mode refuses outright.
    const reason = /^subagent_[a-z0-9_]+$/.test(status.reason || '') ? status.reason : 'subagent_runtime_' + status.state;
    return { mode: 'unusable', reason, state: status.state };
  }

  async launch({ subagentRuntime, force = false, isRunning, userDataDir, protectedEnvNames = [], controlOnly = false,
    nativeBridge = false, inheritLegacyTranslation = false, remoteModels = false } = {}) {
    const desired = readTranslationSettings(this.settingsFile, this.homeDir);
    if (!desired.settings.enabled && !controlOnly) throw Error('translation_not_enabled');
    const current = this.inspect();
    if (current.state === 'stale') throw Error('translation_host_stale');
    let context;
    let application;
    let subagent = { mode: 'absent' };
    if (force) {
      context = subagentRuntime?.launchContext();
      if (!context) throw Error('subagent_runtime_not_ready');
      subagent = { mode: 'adopted', context, state: 'force' };
    } else {
      subagent = this.subagentContext(subagentRuntime);
      context = subagent.context;
    }
    if (['active', 'attaching', 'starting', 'pending-settings', 'inactive', 'legacy-running'].includes(current.state)) {
      if (context) {
        let request;
        try { request = readSubagentJSON(this.launchFile); } catch { throw Error('translation_session_conflict'); }
        if (request.homeDir !== this.homeDir) throw Error('translation_scope_conflict');
        if (request.bundleDir !== context.bundleDir || request.application !== context.application) {
          return { state: 'waiting-kimi-exit', ...(current.version ? { version: current.version } : {}) };
        }
      }
      return current;
    }
    const installation = this.locate({ ...this.installationOptions, env: this.env });
    this.version = installation.version;
    this.versionCheckedAt = Date.now();
    if (context?.application && (!sameInstallation({ application: context.application, archive: installation.archive,
      discoveredApplication: installation.application }, installation.platform)
      || context.archive && path.resolve(context.archive) !== path.resolve(installation.archive))) {
      if (force) throw Error('subagent_bundle_application_mismatch');
      context = undefined;
      subagent = { mode: 'unusable', reason: 'subagent_bundle_application_mismatch', state: subagent.state };
    }
    application = context?.application || installation.application;
    const running = isRunning === undefined ? kimiProcessRunning(application, installation.platform) : isRunning();
    if (running) return { state: 'waiting-kimi-exit', version: installation.version,
      ...(subagent.mode === 'unusable' ? { warning: subagent.reason } : {}) };
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.stateDir).isSymbolicLink()) throw Error('translation_session_conflict');
    let previous;
    try { previous = readSubagentJSON(this.launchFile); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('translation_session_conflict'); }
    if (previous?.handedOff !== true && previous && this.isAlive(previous.pid) && Date.now() - previous.at < 15000) {
      return { state: 'starting' };
    }
    if (previous) fs.rmSync(this.launchFile);
    const id = crypto.randomUUID();
    const request = { schemaVersion: 1, id, pid: process.pid, at: Date.now(), homeDir: this.homeDir,
      ...installation, application, ...(context ? { bundleDir: context.bundleDir } : {}),
      discoveredApplication: installation.application,
      installationIdentity: installationIdentity({ ...installation, application }),
      controlOnly: controlOnly === true,
      nativeBridge: nativeBridge === true,
      remoteModels: remoteModels === true,
      ...(remoteModels === true ? { remoteRevision: remoteRuntimeRevision() } : {}),
      inheritLegacyTranslation: inheritLegacyTranslation === true,
      protectedEnvNames: protectedEnvNames.filter(name => typeof name === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/.test(name) && !reservedEnvName(name)),
      subagent: subagent.mode === 'unusable' ? { adopted: false, reason: subagent.reason }
        : { adopted: context !== undefined, ...(subagent.state ? { state: subagent.state } : {}) },
      ...(userDataDir ? { userDataDir: path.resolve(userDataDir) } : {}) };
    try {
      fs.writeFileSync(this.launchFile, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      // Another process (a supervisor tick or a second panel action) won the
      // race. Its record is authoritative; starting a second helper now is the
      // duplicate-host bug this record exists to prevent.
      if (error.code === 'EEXIST') return { state: 'starting', version: installation.version };
      throw Error('translation_session_conflict');
    }
    const env = { ...this.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let child;
    try {
      child = this.spawnHost(process.execPath, [HOST, this.stateDir, id], { env, detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } catch {
      if (readSubagentJSON(this.launchFile).id === id) fs.rmSync(this.launchFile);
      throw Error('translation_host_start_failed');
    }
    return { state: 'starting', pid: child.pid, version: installation.version,
      ...(subagent.mode === 'unusable' ? { warning: subagent.reason } : {}) };
  }
}
