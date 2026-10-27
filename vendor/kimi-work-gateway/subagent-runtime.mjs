import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { archiveCandidates, installedVersion } from './kimi-contract.mjs';
import { SUBAGENT_POLICY_FILE, readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';
import { SUBAGENT_HOOK_VERSION } from './subagent-hook.mjs';

const KERNEL = 'app/daimon/dist/kimi-code-v2/kernel-bundle.mjs';
const HOOK = 'kwg-subagent-hook.mjs';
const SUPPORTED = new Set(['3.2.21:ea0a2ec58a26bd0365401e14251b33b7a547dd31bfd423f61699ac362026d1af']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceText = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const hookFile = fileURLToPath(new URL('./subagent-hook.mjs', import.meta.url));

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw Error('subagent_runtime_incompatible');
  return source.replace(anchor, replacement);
}

export function transformSubagentKernel(source, options) {
  if (source.includes('kwgSubagentHook')) throw Error('subagent_runtime_already_adapted');
  let result = replaceOnce(source,
    '\tget(domain) {\n\t\tif (Object.prototype.hasOwnProperty.call(this.memory, domain))',
    '\tget(domain) {\n\t\tif (domain === "secondaryModel") {\n\t\t\tconst policy = kwgSubagentHook.configuration(this.bootstrap.homeDir);\n\t\t\tif (policy !== undefined) return policy;\n\t\t}\n\t\tif (Object.prototype.hasOwnProperty.call(this.memory, domain))');
  result = replaceOnce(result,
    '\tasync planSpawn(input) {\n\t\tconst caller = this.requireCaller(input.callerAgentId);',
    '\tasync planSpawn(input) {\n\t\tkwgSubagentHook.assertSpawn(this.configService, input);\n\t\tconst caller = this.requireCaller(input.callerAgentId);');
  result = replaceOnce(result,
    '\t\tif (handle === void 0) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agent.agentId}" does not exist`, { details: { agentId: agent.agentId } });\n\t\treturn runAgentTurn(handle, request, {',
    '\t\tif (handle === void 0) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agent.agentId}" does not exist`, { details: { agentId: agent.agentId } });\n\t\tkwgSubagentHook.assertModel(this.configService, handle.accessor.get(IAgentProfileService).data().modelAlias);\n\t\treturn runAgentTurn(handle, request, {');
  return result + '\nimport { createSubagentRuntimeHook as kwgCreateSubagentHook } from "./' + HOOK + '";\n'
    + 'const kwgSubagentHook = kwgCreateSubagentHook(' + JSON.stringify(options) + ');\n';
}

export function findSubagentInstallation({ archive, bundleDir, application, platform = process.platform, env = process.env } = {}) {
  const archivePath = archive || archiveCandidates({ platform, env }).find(file => fs.existsSync(file));
  if (!archivePath || !fs.existsSync(archivePath)) throw Error('subagent_kimi_unavailable');
  const resources = path.dirname(archivePath);
  const candidates = [bundleDir, path.join(resources, 'resources', 'daimon-bundle'), path.join(resources, 'daimon-bundle')].filter(Boolean);
  const bundle = candidates.find(directory => fs.existsSync(path.join(directory, KERNEL)));
  const tarball = [path.join(resources, 'resources', 'daimon-bundle.tar.gz'), path.join(resources, 'daimon-bundle.tar.gz')]
    .find(file => fs.existsSync(file));
  if (!bundle && !tarball) throw Error('subagent_bundle_unavailable');
  const executables = platform === 'darwin' ? [path.join(path.dirname(resources), 'MacOS', 'Kimi')]
    : [path.join(path.dirname(resources), 'Kimi.exe'), path.join(path.dirname(resources), 'kimi-desktop.exe')];
  const app = application || executables.find(file => fs.existsSync(file));
  return { archive: path.resolve(archivePath), version: installedVersion(archivePath),
    ...(bundle ? { bundleDir: path.resolve(bundle) } : { tarball: path.resolve(tarball) }),
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
  constructor({ stateDir, ...installation } = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw Error('invalid_subagent_state_dir');
    this.stateDir = stateDir;
    this.installationOptions = installation;
    this.manifestFile = path.join(stateDir, 'subagent-runtime.json');
    this.policyPath = path.join(stateDir, SUBAGENT_POLICY_FILE);
    this.receiptPath = path.join(stateDir, 'subagent-runtime-status.json');
  }

  installation() { return findSubagentInstallation(this.installationOptions); }

  prepare() {
    const installation = this.installation();
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
      if (!SUPPORTED.has(installation.version + ':' + sourceHash)) throw Error('subagent_runtime_incompatible');
      const hook = sourceText(hookFile);
      const runtimeId = hash(JSON.stringify([sourceHash, this.policyPath, SUBAGENT_HOOK_VERSION, hash(hook)])).slice(0, 24);
      const destination = path.join(runtimeRoot, runtimeId);
      const bundleDir = path.join(destination, 'bundle');
      const generated = transformSubagentKernel(source, { policyPath: this.policyPath, receiptPath: this.receiptPath, runtimeId, sourceHash });
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
      const manifest = { schemaVersion: 1, runtimeId, hookVersion: SUBAGENT_HOOK_VERSION, ...installation,
        ...(installation.tarball ? { archiveHash: hash(fs.readFileSync(installation.tarball)) } : {}),
        bundleDir, sourceHash, patchedHash: hash(generated), hookHash: hash(hook),
        policyPath: this.policyPath, receiptPath: this.receiptPath };
      writeSubagentJSON(this.manifestFile, manifest);
      return { state: 'prepared', version: manifest.version, runtimeId, bundleDir };
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }

  inspect({ runnerPid } = {}) {
    let manifest;
    try { manifest = readSubagentJSON(this.manifestFile); }
    catch (error) { return { state: error.code === 'ENOENT' ? 'not-prepared' : 'conflict' }; }
    try {
      if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{24}$/.test(manifest.runtimeId)
        || manifest.bundleDir !== path.join(this.stateDir, 'native-runtime', manifest.runtimeId, 'bundle')
        || manifest.policyPath !== this.policyPath || manifest.receiptPath !== this.receiptPath
        || manifest.hookVersion !== SUBAGENT_HOOK_VERSION
        || !SUPPORTED.has(manifest.version + ':' + manifest.sourceHash)) throw Error();
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
      if (installation.archive !== manifest.archive || installation.version !== manifest.version
        || installation.application !== manifest.application) return { state: 'outdated' };
      if (installation.bundleDir && hash(sourceText(path.join(installation.bundleDir, KERNEL))) !== manifest.sourceHash) return { state: 'outdated' };
      if (installation.tarball && (manifest.tarball !== installation.tarball
        || hash(fs.readFileSync(installation.tarball)) !== manifest.archiveHash)) return { state: 'outdated' };
      assertTree(manifest.bundleDir);
      const hookHash = hash(sourceText(hookFile));
      if (manifest.hookHash !== hookHash || manifest.runtimeId !== hash(JSON.stringify([
        manifest.sourceHash, this.policyPath, SUBAGENT_HOOK_VERSION, hookHash])).slice(0, 24)) return { state: 'outdated' };
      if (hash(sourceText(path.join(manifest.bundleDir, KERNEL))) !== manifest.patchedHash
        || hash(sourceText(path.join(path.dirname(path.join(manifest.bundleDir, KERNEL)), HOOK))) !== hookHash) throw Error();
      let receipt, policy;
      try { receipt = readSubagentJSON(this.receiptPath); policy = readSubagentJSON(this.policyPath); } catch {}
      const result = { version: manifest.version, runtimeId: manifest.runtimeId };
      const observed = receipt?.schemaVersion === 1 && receipt?.runtimeId === manifest.runtimeId
        && receipt?.sourceHash === manifest.sourceHash && alive(receipt?.pid)
        && (runnerPid === undefined || receipt.pid === runnerPid);
      if (!observed) return { state: 'waiting-launch', ...result };
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

  async launch({ isRunning, spawnApp = spawn } = {}) {
    const status = this.inspect();
    if (!['loaded', 'pending-policy', 'waiting-launch'].includes(status.state)) throw Error('subagent_runtime_not_ready');
    const manifest = readSubagentJSON(this.manifestFile);
    if (!manifest.application || !fs.existsSync(manifest.application)) throw Error('subagent_kimi_unavailable');
    const policy = readSubagentJSON(this.policyPath);
    if (policy?.schemaVersion !== 1 || !['inherit', 'force'].includes(policy.mode)) throw Error('subagent_policy_unavailable');
    let running = isRunning?.();
    if (running === undefined) {
      const executable = path.basename(manifest.application).replace(/\.exe$/i, '');
      const probe = process.platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if (Get-Process -Name '" + executable.replaceAll("'", "''") + "' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"], { windowsHide: true, timeout: 10000 })
        : spawnSync('pgrep', ['-x', executable], { timeout: 10000 });
      if (probe.error || ![0, 1].includes(probe.status)) throw Error('subagent_process_check_failed');
      running = probe.status === 0;
    }
    if (running) return { state: 'waiting-kimi-exit' };
    const env = { ...process.env, DAIMON_BUNDLE_DIR: manifest.bundleDir };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnApp(manifest.application, [], { env, detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { state: 'starting', pid: child.pid, runtimeId: manifest.runtimeId };
  }
}
