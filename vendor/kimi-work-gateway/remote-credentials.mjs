// Provisions one fixed-identity credential helper bundle under the caller's
// state directory and hands back the path-only configuration the official main
// process needs. The bundle is built once; later gateway or Kimi releases reuse
// it, because its identity is the Keychain ACL that safeStorage keys are bound
// to. The bootstrap only imports this package's directory at runtime, so code
// updates never require re-signing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRemoteBundle, remoteDigest, verifyRemoteBundle } from './remote-bundle.mjs';
import { readAsarEntry } from './kimi-contract.mjs';
import { credentialSocketListening } from './remote-credentials-service.mjs';

const SERVICE_MODULE = fileURLToPath(new URL('./remote-credentials-service.mjs', import.meta.url));
const SERVICE_MODULE_URL = new URL('./remote-credentials-service.mjs', import.meta.url).href;
const CLIENT = fileURLToPath(new URL('./remote-credentials-client.mjs', import.meta.url));
const BUNDLE_ID = 'dev.kimi-work-gateway.credentials';
const EXECUTABLE = 'KimiWorkCredentials';
const BUNDLE_NAME = 'Kimi Work Credentials.app';
const SCHEMA = 1;

export const CREDENTIALS_SCHEMA_VERSION = SCHEMA;
export const MAX_PLAINTEXT = 1024 * 1024;
export const MAX_CIPHERTEXT = Math.ceil(MAX_PLAINTEXT * 4 / 3) + 64;
export const MAX_FRAME = 4 * 1024 * 1024;
export const SERVICE_IDLE_MS = 5 * 60 * 1000;
const CLIENT_TIMEOUT = 20000;
const START_TIMEOUT = 20000;
const STATUS_TIMEOUT = 8000;
const MAIN_CALL_TIMEOUT = 2000;
const RESTART_TIMEOUT = 2000;
const LOG_LIMIT = 1024 * 1024;

const codeFor = error => (/^remote_credentials_[a-z_]{1,80}$/.test(error?.message)
  ? error.message : 'remote_credentials_failed');
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);

export function credentialApplication(root) {
  return path.join(root, BUNDLE_NAME, 'Contents', 'MacOS', EXECUTABLE);
}

function realHome() {
  const home = process.env.HOME;
  return absolute(home) ? home : os.homedir();
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || fs.realpathSync(directory) !== directory) {
    throw Error('remote_credentials_scope_unverified');
  }
  return directory;
}

function privateJSON(file, limit = 65536) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > limit) {
    throw Error('remote_credentials_scope_unverified');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePrivateJSON(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function credentialsRoot(stateDir) {
  if (process.platform !== 'darwin' || !absolute(stateDir)) throw Error('remote_credentials_config_invalid');
  const resolved = path.resolve(stateDir);
  privateDirectory(resolved);
  privateDirectory(path.join(resolved, 'remote-credentials'));
  return privateDirectory(path.join(resolved, 'remote-credentials', 'v' + SCHEMA));
}

function bundlePaths(root) {
  const bundle = path.join(root, BUNDLE_NAME);
  return { bundle, application: credentialApplication(root),
    archive: path.join(bundle, 'Contents', 'Resources', 'app.asar'),
    manifest: path.join(root, 'bundle.json') };
}

function bootstrapSource() {
  return `import fs from 'node:fs';
import { app } from 'electron';
import { startRemoteCredentialsService } from ${JSON.stringify(SERVICE_MODULE_URL)};
const flag = process.argv.find(value => value.startsWith('--kwg-credentials-config='));
try {
  if (!flag) throw Error('remote_credentials_config_invalid');
  const file = flag.slice('--kwg-credentials-config='.length), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw Error('remote_credentials_scope_unverified');
  startRemoteCredentialsService(JSON.parse(fs.readFileSync(file, 'utf8'))).catch(() => app.exit(78));
} catch { app.exit(78); }
`;
}

// The manifest describes the sealed artifact, never the Kimi release it was
// cloned from: that is what keeps the identity stable across updates.
export function credentialManifestValid(manifest, paths, { archive, bootstrap }) {
  return !!manifest && typeof manifest === 'object'
    && manifest.schemaVersion === SCHEMA
    && manifest.bundle === paths.bundle
    && manifest.application === paths.application
    && manifest.bundleID === BUNDLE_ID
    && manifest.executableName === EXECUTABLE
    && /^[a-f0-9]{64}$/.test(manifest.archiveSHA256) && /^[a-f0-9]{64}$/.test(manifest.bootstrapSHA256)
    && remoteDigest(archive) === manifest.archiveSHA256
    && remoteDigest(bootstrap) === manifest.bootstrapSHA256;
}

function verifyArtifact(paths) {
  const manifest = privateJSON(paths.manifest);
  const archive = fs.readFileSync(paths.archive);
  let bootstrap;
  try { bootstrap = readAsarEntry(paths.archive, 'bootstrap.mjs'); }
  catch { throw Error('remote_credentials_artifact_unverified'); }
  if (!credentialManifestValid(manifest, paths, { archive, bootstrap })) {
    throw Error('remote_credentials_artifact_unverified');
  }
  if (!bootstrap.includes(JSON.stringify(SERVICE_MODULE_URL))) throw Error('remote_credentials_artifact_mismatch');
  if (!verifyRemoteBundle(paths.bundle)) throw Error('remote_credentials_artifact_unverified');
  const stat = fs.lstatSync(paths.application);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o100)) {
    throw Error('remote_credentials_artifact_unverified');
  }
  return { bundle: paths.bundle, application: paths.application };
}

function buildArtifact(paths, installation) {
  const bootstrap = bootstrapSource();
  let built;
  try {
    built = buildRemoteBundle({ destination: paths.bundle, application: installation.application,
      bootstrap, bundleID: BUNDLE_ID, displayName: 'Kimi Work Credentials', executableName: EXECUTABLE, lsuiElement: true });
  } catch (error) {
    throw Error(codeFor(error) === 'remote_credentials_failed' ? 'remote_credentials_build_failed' : codeFor(error));
  }
  writePrivateJSON(paths.manifest, { schemaVersion: SCHEMA, bundle: paths.bundle, application: built.application,
    bundleID: BUNDLE_ID, executableName: EXECUTABLE, archiveSHA256: built.archiveSHA256,
    bootstrapSHA256: remoteDigest(bootstrap), createdAt: Date.now() });
  return verifyArtifact(paths);
}

function ensureArtifact(paths, installation) {
  if (!absolute(installation?.application) || !fs.existsSync(installation.application)) {
    throw Error('remote_credentials_config_invalid');
  }
  if (fs.existsSync(paths.manifest)) return verifyArtifact(paths);
  if (fs.existsSync(paths.bundle)) throw Error('remote_credentials_artifact_unverified');
  return buildArtifact(paths, installation);
}

function serviceEnvironment(temp) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('KWG_') || name === 'CFFIXED_USER_HOME' || name === 'ELECTRON_RUN_AS_NODE'
      || name === 'NODE_OPTIONS' || name === 'NODE_EXTRA_CA_CERTS') delete env[name];
  }
  env.HOME = realHome();
  env.TMPDIR = temp;
  return env;
}

function clientEnvironment(temp) {
  return { ELECTRON_RUN_AS_NODE: '1', HOME: realHome(), TMPDIR: temp,
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: process.env.LANG || 'en_US.UTF-8' };
}

function invokeClient(config, payload, timeout = CLIENT_TIMEOUT) {
  const request = { ...payload, socket: config.socket, tokenFile: config.tokenFile };
  const result = spawnSync(config.application, [config.client], {
    input: JSON.stringify(request), encoding: 'utf8', timeout,
    maxBuffer: MAX_FRAME, env: clientEnvironment(config.temp), windowsHide: true,
  });
  if (result.error || result.status !== 0) return { ok: false, code: 'remote_credentials_client_failed' };
  let response;
  try { response = JSON.parse(String(result.stdout || '').trim()); }
  catch { return { ok: false, code: 'remote_credentials_client_failed' }; }
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
    return { ok: false, code: 'remote_credentials_client_failed' };
  }
  return response;
}

function serviceStatus(config) {
  if (!fs.existsSync(config.socket)) return null;
  const response = invokeClient(config, { operation: 'status', socket: config.socket,
    tokenFile: config.tokenFile }, STATUS_TIMEOUT);
  if (!response.ok) return null;
  if (response.application !== config.serviceApplication || response.root !== config.root
    || !Number.isInteger(response.pid) || response.pid <= 0) {
    throw Error('remote_credentials_service_conflict');
  }
  return response;
}

export function rotateRemoteCredentialsLog(file, { limit = LOG_LIMIT } = {}) {
  if (!absolute(file) || !Number.isSafeInteger(limit) || limit <= 0) throw Error('remote_credentials_config_invalid');
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
    throw Error('remote_credentials_scope_unverified');
  }
  if (stat.size < limit) return false;
  fs.rmSync(file + '.1', { force: true });
  fs.renameSync(file, file + '.1');
  return true;
}

function startService(config) {
  privateJSON(config.serviceConfig);
  fs.mkdirSync(config.temp, { recursive: true, mode: 0o700 });
  const logFile = path.join(config.root, 'service.log');
  rotateRemoteCredentialsLog(logFile);
  const log = fs.openSync(logFile, 'a', 0o600);
  fs.fchmodSync(log, 0o600);
  let child;
  try {
    child = spawn(config.serviceApplication, ['--kwg-credentials-config=' + config.serviceConfig],
      { detached: true, stdio: ['ignore', log, log], env: serviceEnvironment(config.temp) });
  } finally { fs.closeSync(log); }
  if (!Number.isInteger(child.pid)) throw Error('remote_credentials_service_failed');
  child.unref();
  return child.pid;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function awaitService(config, deadline) {
  while (Date.now() < deadline) {
    const status = serviceStatus(config);
    if (status) return status;
    await sleep(150);
  }
  throw Error('remote_credentials_service_unavailable');
}

async function ensureService(config) {
  const existing = serviceStatus(config);
  if (existing) return existing;
  if (fs.existsSync(config.socket)) {
    try {
      const stat = fs.lstatSync(config.socket);
      if (!stat.isSocket() || stat.uid !== process.getuid()) throw Error('remote_credentials_service_conflict');
      if (await credentialSocketListening(config.socket)) return awaitService(config, Date.now() + START_TIMEOUT);
      fs.rmSync(config.socket, { force: true });
    } catch (error) { throw Error(codeFor(error)); }
  }
  startService(config);
  return awaitService(config, Date.now() + START_TIMEOUT);
}

function normalizeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('remote_credentials_config_invalid');
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'application,client,root,socket,tokenFile') throw Error('remote_credentials_config_invalid');
  for (const key of ['root', 'application', 'client', 'socket', 'tokenFile']) {
    if (!absolute(value[key])) throw Error('remote_credentials_config_invalid');
  }
  const root = path.resolve(value.root);
  if (path.resolve(value.application) !== credentialApplication(root)
    || path.resolve(value.client) !== CLIENT
    || path.resolve(value.socket) !== path.join(root, 'service.sock')
    || path.resolve(value.tokenFile) !== path.join(root, 'service.token')
    || !fs.existsSync(CLIENT)) throw Error('remote_credentials_config_invalid');
  try { privateDirectory(root); }
  catch { throw Error('remote_credentials_config_invalid'); }
  return { root, application: credentialApplication(root), client: CLIENT,
    socket: path.join(root, 'service.sock'), tokenFile: path.join(root, 'service.token'), home: realHome() };
}

export async function ensureRemoteCredentials({ stateDir, installation } = {}) {
  try {
    const root = credentialsRoot(stateDir);
    const paths = bundlePaths(root);
    const artifact = ensureArtifact(paths, installation);
    const config = { root, application: artifact.application, client: CLIENT,
      socket: path.join(root, 'service.sock'), tokenFile: path.join(root, 'service.token') };
    const serviceConfig = path.join(root, 'service.json');
    const temp = privateDirectory(path.join(root, 'temp'));
    writePrivateJSON(serviceConfig, { schemaVersion: SCHEMA, root, application: artifact.application,
      socket: config.socket, tokenFile: config.tokenFile, home: realHome(), temp, idleMS: SERVICE_IDLE_MS });
    const settings = { ...normalizeConfig(config), temp, serviceApplication: artifact.application,
      serviceConfig, bundle: artifact.bundle };
    await ensureService(settings);
    const available = invokeClient(settings, { operation: 'available' });
    if (!available.ok || available.value !== true) throw Error('remote_credentials_unavailable');
    const synthetic = 'kwg-' + crypto.randomBytes(24).toString('base64url');
    const encrypted = invokeClient(settings, { operation: 'encrypt', value: synthetic });
    if (!encrypted.ok || typeof encrypted.value !== 'string') throw Error('remote_credentials_unavailable');
    const decrypted = invokeClient(settings, { operation: 'decrypt', value: encrypted.value });
    if (!decrypted.ok || decrypted.value !== synthetic) throw Error('remote_credentials_unavailable');
    return { root: config.root, application: config.application, client: config.client,
      socket: config.socket, tokenFile: config.tokenFile };
  } catch (error) { throw Error(codeFor(error)); }
}

export function installRemoteCredentials(safeStorage, config, { invoke = invokeClient, start = startService,
  wait = ms => spawnSync('/bin/sleep', [(ms / 1000).toFixed(3)]), now = Date.now } = {}) {
  if (!safeStorage || typeof safeStorage !== 'object') throw Error('remote_credentials_config_invalid');
  const settings = normalizeConfig(config);
  const call = (operation, value, timeout = MAIN_CALL_TIMEOUT) => invoke(settings,
    { operation, ...(value === undefined ? {} : { value }), socket: settings.socket, tokenFile: settings.tokenFile }, timeout);
  const unavailable = () => { throw Error('remote_credentials_unavailable'); };
  // Restarting a dead helper is only allowed for the artifact this root owns.
  // Any other executable would be an unverified identity, so fail closed.
  const resolvable = () => {
    try {
      return settings.application === credentialApplication(settings.root) && fs.existsSync(settings.application)
        && privateJSON(path.join(settings.root, 'service.json')).schemaVersion === SCHEMA;
    } catch { return false; }
  };
  const ensure = (operation, value) => {
    let response = call(operation, value);
    if (response.ok || response.code !== 'remote_credentials_client_failed' || !resolvable()) return response;
    const deadline = now() + RESTART_TIMEOUT;
    let started = false;
    while (now() < deadline) {
      const status = call('status', undefined, Math.max(1, deadline - now()));
      if (status.ok) {
        if (status.application !== settings.application || status.root !== settings.root
          || !Number.isInteger(status.pid) || status.pid <= 0) return response;
        if (now() >= deadline) break;
        response = call(operation, value, Math.max(1, deadline - now()));
        if (response.ok || response.code !== 'remote_credentials_client_failed') return response;
      } else if (!fs.existsSync(settings.socket) && !started) {
        try {
          start({ ...settings, temp: path.join(settings.root, 'temp'),
            serviceApplication: credentialApplication(settings.root),
            serviceConfig: path.join(settings.root, 'service.json') });
          started = true;
        } catch { return response; }
      }
      if (now() < deadline) wait(Math.min(150, deadline - now()));
    }
    return response;
  };
  const delegated = {
    isEncryptionAvailable: () => {
      const response = ensure('available');
      return response.ok === true && response.value === true;
    },
    encryptString: text => {
      if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_PLAINTEXT) unavailable();
      const response = ensure('encrypt', text);
      if (!response.ok || typeof response.value !== 'string') unavailable();
      return Buffer.from(response.value, 'base64');
    },
    decryptString: buffer => {
      const bytes = typeof buffer === 'string' ? Buffer.from(buffer) : buffer;
      if (!Buffer.isBuffer(bytes)) unavailable();
      const text = bytes.toString('base64');
      if (text.length > MAX_CIPHERTEXT) unavailable();
      const response = ensure('decrypt', text);
      if (!response.ok || typeof response.value !== 'string') unavailable();
      return response.value;
    },
  };
  const original = {
    isEncryptionAvailable: safeStorage.isEncryptionAvailable,
    encryptString: safeStorage.encryptString,
    decryptString: safeStorage.decryptString,
  };
  if (Object.values(original).some(method => typeof method !== 'function')) {
    throw Error('remote_credentials_config_invalid');
  }
  delegated.uninstall = () => {
    for (const name of Object.keys(original)) {
      if (safeStorage[name] === delegated[name]) safeStorage[name] = original[name];
    }
    return true;
  };
  for (const name of Object.keys(original)) safeStorage[name] = delegated[name];
  return delegated;
}

export const remoteCredentialsPaths = { client: CLIENT, serviceModule: SERVICE_MODULE, bundleID: BUNDLE_ID };
