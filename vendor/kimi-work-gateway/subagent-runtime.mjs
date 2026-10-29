import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { archiveCandidates, installedVersion } from './kimi-contract.mjs';
import { SUBAGENT_POLICY_FILE, readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';
import { SUBAGENT_HOOK_VERSION } from './subagent-hook.mjs';
import { applySubagentStructure, probeSubagentKernel, SUBAGENT_ADAPTER_VERSION } from './subagent-structure.mjs';
import { inspectSubagentLaunchContract } from './subagent-launch-contract.mjs';
import { reservedEnvName } from './translation-config.mjs';

const KERNEL = 'app/daimon/dist/kimi-code-v2/kernel-bundle.mjs';
const HOOK = 'kwg-subagent-hook.mjs';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceText = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const hookFile = fileURLToPath(new URL('./subagent-hook.mjs', import.meta.url));

function runtimeIdentity(value, policyPath, hookHash) {
  const values = [value.sourceHash, policyPath, SUBAGENT_HOOK_VERSION, hookHash];
  if (value.adapterVersion !== undefined) values.push(value.adapterVersion, value.version, value.archiveHash ?? null);
  return hash(JSON.stringify(values)).slice(0, 24);
}

export function transformSubagentKernel(source, options) {
  return applySubagentStructure(source, options, HOOK);
}

function validateSyntax(source) {
  if (globalThis.Bun?.Transpiler) {
    try { new globalThis.Bun.Transpiler({ loader: 'js' }).scan(source); return; }
    catch { throw Error('subagent_runtime_incompatible'); }
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-syntax-'));
  try {
    const file = path.join(directory, 'kernel.mjs');
    fs.writeFileSync(file, source, { mode: 0o600 });
    const result = spawnSync(process.execPath, ['--check', file], { timeout: 10000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw Error('subagent_runtime_incompatible');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

export function findSubagentInstallation({ archive, bundleDir, application, platform = process.platform, env = process.env,
  requireBundle = true } = {}) {
  const archivePath = archive || archiveCandidates({ platform, env }).find(file => fs.existsSync(file));
  if (!archivePath || !fs.existsSync(archivePath)) throw Error('subagent_kimi_unavailable');
  const resources = path.dirname(archivePath);
  const candidates = [bundleDir, path.join(resources, 'resources', 'daimon-bundle'), path.join(resources, 'daimon-bundle')].filter(Boolean);
  const bundle = candidates.find(directory => fs.existsSync(path.join(directory, KERNEL)));
  const tarball = [path.join(resources, 'resources', 'daimon-bundle.tar.gz'), path.join(resources, 'daimon-bundle.tar.gz')]
    .find(file => fs.existsSync(file));
  if (requireBundle && !bundle && !tarball) throw Error('subagent_bundle_unavailable');
  const executables = platform === 'darwin' ? [path.join(path.dirname(resources), 'MacOS', 'Kimi')]
    : [path.join(path.dirname(resources), 'Kimi.exe'), path.join(path.dirname(resources), 'kimi-desktop.exe')];
  const app = application || executables.find(file => fs.existsSync(file));
  return { archive: path.resolve(archivePath), version: installedVersion(archivePath),
    ...(bundle ? { bundleDir: path.resolve(bundle) } : tarball ? { tarball: path.resolve(tarball) } : {}),
    application: app ? path.resolve(app) : null, platform };
}

function assertTree(directory) {
  const root = fs.realpathSync(directory);
  const visit = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        const relative = path.relative(root, fs.realpathSync(file));
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('subagent_bundle_link_conflict');
      } else if (entry.isDirectory()) visit(file);
      else if (!entry.isFile()) throw Error('subagent_bundle_file_conflict');
    }
  };
  visit(directory);
}

function extractBundle(tarball, staging) {
  const names = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split(/\r?\n/);
  if (!names.length || names.some(name => name.includes('\\') || path.posix.isAbsolute(name)
    || name.split('/').includes('..') || /^[A-Za-z]:/.test(name))) throw Error('subagent_bundle_archive_invalid');
  const entries = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split(/\r?\n/);
  if (entries.length !== names.length || entries.some(entry => !/^[-d]/.test(entry))) {
    throw Error('subagent_bundle_archive_links_unsupported');
  }
  fs.mkdirSync(staging, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', staging], { stdio: 'ignore' });
  const candidates = [staging, path.join(staging, 'daimon-bundle')];
  const source = candidates.find(directory => fs.existsSync(path.join(directory, KERNEL)));
  if (!source) throw Error('subagent_bundle_unavailable');
  assertTree(source);
  return source;
}

const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

export class SubagentRuntime {
  constructor({ stateDir, launchProbe = inspectSubagentLaunchContract, ...installation } = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw Error('invalid_subagent_state_dir');
    this.stateDir = stateDir;
    this.installationOptions = installation;
    this.launchProbe = launchProbe;
    this.manifestFile = path.join(stateDir, 'subagent-runtime.json');
    this.policyPath = path.join(stateDir, SUBAGENT_POLICY_FILE);
    this.receiptPath = path.join(stateDir, 'subagent-runtime-status.json');
  }

  installation(options) { return findSubagentInstallation({ ...this.installationOptions, ...options }); }

  launchCapability(installation) {
    try { return this.launchProbe(installation.archive); }
    catch { return { state: 'unverified', reason: 'bundle_override_probe_failed' }; }
  }

  prepare() {
    const installation = this.installation();
    const launch = this.launchCapability(installation);
    if (launch.state !== 'supported') throw Error('subagent_launch_unsupported');
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.stateDir).isSymbolicLink()) throw Error('subagent_file_conflict');
    const runtimeRoot = path.join(this.stateDir, 'native-runtime');
    fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(runtimeRoot).isSymbolicLink()) throw Error('subagent_file_conflict');
    const staging = fs.mkdtempSync(path.join(runtimeRoot, 'preparing-'));
    try {
      const sourceDirectory = installation.bundleDir || extractBundle(installation.tarball, path.join(staging, 'extracted'));
      assertTree(sourceDirectory);
      const source = sourceText(path.join(sourceDirectory, KERNEL));
      const sourceHash = hash(source);
      const probe = probeSubagentKernel(source);
      const compatibility = { strategy: probe.strategy, checks: probe.checks };
      const sourceIdentity = { sourceHash, version: installation.version, adapterVersion: SUBAGENT_ADAPTER_VERSION,
        ...(installation.tarball ? { archiveHash: hash(fs.readFileSync(installation.tarball)) } : {}) };
      const hook = sourceText(hookFile);
      const runtimeId = runtimeIdentity(sourceIdentity, this.policyPath, hash(hook));
      const destination = path.join(runtimeRoot, runtimeId);
      const bundleDir = path.join(destination, 'bundle');
      const generated = transformSubagentKernel(source, { policyPath: this.policyPath, receiptPath: this.receiptPath, runtimeId, sourceHash });
      validateSyntax(generated);
      let exists = false;
      try { fs.lstatSync(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (exists) {
        if (fs.lstatSync(destination).isSymbolicLink() || fs.lstatSync(bundleDir).isSymbolicLink()) {
          throw Error('subagent_bundle_link_conflict');
        }
        assertTree(bundleDir);
        if (hash(sourceText(path.join(bundleDir, KERNEL))) !== hash(generated)
          || hash(sourceText(path.join(path.dirname(path.join(bundleDir, KERNEL)), HOOK))) !== hash(hook)) {
          throw Error('subagent_runtime_copy_changed');
        }
      } else {
        const copied = path.join(staging, 'bundle');
        fs.cpSync(sourceDirectory, copied, { recursive: true, dereference: false, verbatimSymlinks: true });
        assertTree(copied);
        const kernelFile = path.join(copied, KERNEL);
        if (fs.lstatSync(kernelFile).isSymbolicLink()) throw Error('subagent_bundle_link_conflict');
        fs.writeFileSync(kernelFile, generated);
        fs.writeFileSync(path.join(path.dirname(kernelFile), HOOK), hook, { flag: 'wx', mode: 0o600 });
        const committed = path.join(staging, 'ready');
        fs.mkdirSync(committed);
        fs.renameSync(copied, path.join(committed, 'bundle'));
        fs.renameSync(committed, destination);
      }
      const manifest = { schemaVersion: 1, ...sourceIdentity, compatibility, runtimeId,
        hookVersion: SUBAGENT_HOOK_VERSION, ...installation, bundleDir,
        patchedHash: hash(generated), hookHash: hash(hook), policyPath: this.policyPath, receiptPath: this.receiptPath };
      writeSubagentJSON(this.manifestFile, manifest);
      return { state: 'prepared', version: manifest.version, runtimeId, bundleDir, compatibility };
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }

  inspect({ runnerPid } = {}) {
    let manifest;
    try { manifest = readSubagentJSON(this.manifestFile); }
    catch (error) {
      if (error.code !== 'ENOENT') return { state: 'conflict' };
      try {
        const installation = this.installation();
        const capability = this.launchCapability(installation);
        if (capability.state !== 'supported') return { state: 'unsupported', reason: capability.reason, version: installation.version };
      } catch {}
      return { state: 'not-prepared' };
    }
    try {
      if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{24}$/.test(manifest.runtimeId)
        || !/^[a-f0-9]{64}$/.test(manifest.sourceHash) || !/^[a-f0-9]{64}$/.test(manifest.patchedHash)
        || manifest.bundleDir !== path.join(this.stateDir, 'native-runtime', manifest.runtimeId, 'bundle')
        || manifest.policyPath !== this.policyPath || manifest.receiptPath !== this.receiptPath
        || !Number.isInteger(manifest.hookVersion)
        || ![manifest.sourceHash, manifest.patchedHash, manifest.hookHash].every(value => /^[a-f0-9]{64}$/.test(value))) throw Error();
      if (manifest.adapterVersion !== undefined && manifest.adapterVersion !== SUBAGENT_ADAPTER_VERSION
        || manifest.hookVersion !== SUBAGENT_HOOK_VERSION) return { state: 'outdated' };
      for (const directory of [this.stateDir, path.join(this.stateDir, 'native-runtime'), path.dirname(manifest.bundleDir), manifest.bundleDir]) {
        if (fs.lstatSync(directory).isSymbolicLink()) throw Error();
      }
      let installation;
      try { installation = this.installation(); }
      catch (error) {
        if (error.message === 'subagent_kimi_unavailable' || error.message === 'subagent_bundle_unavailable') {
          return { state: 'unavailable', reason: error.message };
        }
        throw error;
      }
      const capability = this.launchCapability(installation);
      if (capability.state !== 'supported') return { state: 'unsupported', reason: capability.reason, version: installation.version };
      if (installation.archive !== manifest.archive || installation.version !== manifest.version
        || installation.application !== manifest.application) return { state: 'outdated' };
      if (installation.bundleDir && hash(sourceText(path.join(installation.bundleDir, KERNEL))) !== manifest.sourceHash) return { state: 'outdated' };
      if (installation.tarball && (manifest.tarball !== installation.tarball
        || hash(fs.readFileSync(installation.tarball)) !== manifest.archiveHash)) return { state: 'outdated' };
      assertTree(manifest.bundleDir);
      const hookHash = hash(sourceText(hookFile));
      if (manifest.hookHash !== hookHash || manifest.runtimeId !== runtimeIdentity(manifest, this.policyPath, hookHash)) return { state: 'outdated' };
      if (hash(sourceText(path.join(manifest.bundleDir, KERNEL))) !== manifest.patchedHash
        || hash(sourceText(path.join(path.dirname(path.join(manifest.bundleDir, KERNEL)), HOOK))) !== hookHash) throw Error();
      let receipt, policy;
      try { receipt = readSubagentJSON(this.receiptPath); policy = readSubagentJSON(this.policyPath); } catch {}
      const result = { version: manifest.version, runtimeId: manifest.runtimeId,
        compatibility: { strategy: manifest.adapterVersion === undefined ? 'existing' : 'structural',
          adapterVersion: manifest.adapterVersion ?? 1 } };
      const observed = receipt?.schemaVersion === 1 && receipt?.runtimeId === manifest.runtimeId
        && receipt?.sourceHash === manifest.sourceHash && alive(receipt?.pid)
        && (runnerPid === undefined || receipt.pid === runnerPid);
      if (!observed) return { state: 'waiting-launch', ...result };
      if (receipt.reason === 'subagent_scope_mismatch') return { state: 'scope-conflict', ...result, reason: receipt.reason };
      const age = Date.now() - receipt.at;
      if (!Number.isFinite(receipt.at) || age < 0 || age >= 15000) return { state: 'heartbeat-stale', ...result };
      if (!policy || policy.schemaVersion !== 1 || receipt.homeDir !== policy.homeDir) {
        return { state: 'policy-unavailable', ...result, mode: 'blocked' };
      }
      return { state: receipt.revision === policy.revision ? 'loaded' : 'pending-policy', ...result,
        mode: receipt.mode, ...(receipt.modelAlias ? { modelAlias: receipt.modelAlias } : {}),
        ...(receipt.reason ? { reason: receipt.reason } : {}), ...(receipt.lastSpawn ? { lastSpawn: receipt.lastSpawn } : {}) };
    } catch { return { state: 'conflict' }; }
  }

  launchContext() {
    let status = this.inspect();
    if (status.state === 'unsupported') throw Error('subagent_launch_unsupported');
    if (['not-prepared', 'outdated'].includes(status.state)) {
      this.prepare();
      status = this.inspect();
    }
    if (!['loaded', 'pending-policy', 'waiting-launch'].includes(status.state)) throw Error('subagent_runtime_not_ready');
    const manifest = readSubagentJSON(this.manifestFile);
    if (this.launchCapability(manifest).state !== 'supported') throw Error('subagent_launch_unsupported');
    if (!manifest.application || !fs.existsSync(manifest.application)) throw Error('subagent_kimi_unavailable');
    let policy;
    try { policy = readSubagentJSON(this.policyPath); } catch { throw Error('subagent_policy_unavailable'); }
    if (policy?.schemaVersion !== 1 || typeof policy.homeDir !== 'string' || !path.isAbsolute(policy.homeDir)
      || !['inherit', 'force'].includes(policy.mode)) throw Error('subagent_policy_unavailable');
    return manifest;
  }

  async launchOriginal(options = {}) {
    const installation = this.installation({ requireBundle: false });
    if (!installation.application || !fs.existsSync(installation.application)) throw Error('subagent_kimi_unavailable');
    return this.start(installation.application, undefined, options);
  }

  async launch(options = {}) {
    const manifest = this.launchContext();
    const result = await this.start(manifest.application, manifest.bundleDir, options);
    return result.state === 'starting' ? { ...result, runtimeId: manifest.runtimeId } : result;
  }

  async start(application, bundleDir, { isRunning, spawnApp = spawn, protectedEnvNames = [] } = {}) {
    let running = isRunning?.();
    if (running === undefined) {
      const executable = path.basename(application).replace(/\.exe$/i, '');
      const probe = process.platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if (Get-Process -Name '" + executable.replaceAll("'", "''") + "' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"], { windowsHide: true, timeout: 10000 })
        : spawnSync('pgrep', ['-x', executable], { timeout: 10000 });
      if (probe.error || ![0, 1].includes(probe.status)) throw Error('subagent_process_check_failed');
      running = probe.status === 0;
    }
    if (running) return { state: 'waiting-kimi-exit' };
    const env = { ...process.env };
    if (bundleDir) env.DAIMON_BUNDLE_DIR = bundleDir;
    else delete env.DAIMON_BUNDLE_DIR;
    for (const name of protectedEnvNames) if (typeof name === 'string' && !reservedEnvName(name)) delete env[name];
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnApp(application, [], { env, detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { state: 'starting', pid: child.pid };
  }
}
