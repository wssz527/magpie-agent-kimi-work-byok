import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as moduleAPI from 'node:module';
import { pathToFileURL } from 'node:url';
import { decodeSourceStrings } from './kimi-contract.mjs';
import { sameInstallation } from './translation-runtime.mjs';
import { installRemoteWorkCatalog, transformRemoteMain } from './remote-work-hook.mjs';
import { installRemoteUpdateProxy } from './remote-update-proxy.mjs';
import { OfficialUpdateClient } from './remote-update-client.mjs';

const digest = source => crypto.createHash('sha256').update(source).digest('hex');
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);
const safeReason = error => /^remote_[a-z_]{1,80}$/.test(error?.message) ? error.message : 'remote_runtime_unverified';

export async function startRemoteCompanion(config, { electron, registerHooks = moduleAPI.registerHooks,
  createUpdateClient = options => new OfficialUpdateClient(options), importMain = url => import(url),
  installCredentials, runtimeProcess = process, decodeSource = decodeSourceStrings } = {}) {
  if (process.platform !== 'darwin' || typeof registerHooks !== 'function'
    || config?.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(config.sessionID)
    || !['stateDir', 'kimiDir', 'archive', 'application', 'userDataDir', 'helper', 'addon'].every(key => absolute(config[key]))
    || typeof config.version !== 'string' || !config.version || config.version.length > 128
    || /[\u0000-\u001f\u007f]/.test(config.version) || !/^[a-f0-9]{64}$/.test(config.mainSHA256)
    || !sameInstallation({ application: config.application, archive: config.archive, discoveredApplication: config.application }, 'darwin')) {
    throw Error('remote_runtime_config_invalid');
  }
  const stateDir = path.resolve(config.stateDir);
  if (!fs.lstatSync(stateDir).isDirectory() || fs.realpathSync(stateDir) !== stateDir) throw Error('remote_runtime_scope_unverified');
  const runtimeDir = path.join(stateDir, 'remote-runtime');
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(runtimeDir).isSymbolicLink()) throw Error('remote_runtime_scope_unverified');
  const statusFile = path.join(runtimeDir, 'status-' + config.sessionID + '.json');
  const status = { schemaVersion: 1, sessionID: config.sessionID, applicationPid: process.pid,
    state: 'starting', version: config.version, catalog: 'not-requested', added: 0 };
  const record = patch => {
    Object.assign(status, patch, { at: Date.now() });
    const temporary = statusFile + '.' + crypto.randomUUID();
    fs.writeFileSync(temporary, JSON.stringify(status), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, statusFile);
  };
  record({});
  let loadedElectron = electron, client, proxy, nativeProfile, credentials, installed = false, hook;
  const suffix = crypto.randomBytes(16).toString('hex');
  const installKey = '__kwgRemoteInstall_' + suffix, profileKey = '__kwgRemoteProfile_' + suffix;
  const ready = () => {
    if (installed && nativeProfile && proxy) record({ state: 'ready' });
  };
  try {
    loadedElectron ||= await import('electron');
    const { app, autoUpdater, safeStorage } = loadedElectron;
    if (!config.credentials) throw Error('remote_credentials_unavailable');
    if (!installCredentials) ({ installRemoteCredentials: installCredentials } = await import('./remote-credentials.mjs'));
    credentials = installCredentials(safeStorage, config.credentials);
    app.setPath('userData', config.userDataDir);
    app.setAppPath(config.archive);
    app.setName('Kimi');
    Object.defineProperty(runtimeProcess, 'resourcesPath', { value: path.dirname(config.archive) });
    runtimeProcess.execPath = config.application;
    app.getVersion = () => config.version;
    app.setAsDefaultProtocolClient = () => false;
    const cacheHome = path.join(runtimeDir, 'update-home');
    fs.mkdirSync(path.join(cacheHome, 'tmp'), { recursive: true, mode: 0o700 });
    if (fs.realpathSync(cacheHome) !== cacheHome || fs.lstatSync(path.join(cacheHome, 'tmp')).isSymbolicLink()) {
      throw Error('remote_runtime_scope_unverified');
    }
    client = createUpdateClient({ application: config.application, helper: config.helper, addon: config.addon, cacheHome,
      parentPid: process.pid, onEvent: event => proxy?.receive(event) });
    const inspection = await client.request('inspect');
    if (inspection?.ok !== true || inspection.supportsOfficialUpdates !== true) throw Error('remote_update_helper_unverified');
    proxy = installRemoteUpdateProxy({ updater: autoUpdater, app, request: (operation, value) => client.request(operation, value),
      onState: value => record({ updater: value.state }) });
    globalThis[installKey] = Type => {
      installRemoteWorkCatalog(Type, { getProfile: async () => {
        if (!nativeProfile) throw Error('remote_profile_unavailable');
        return (await nativeProfile())?.profile;
      }, onStatus: value => {
        if (value.state.startsWith('catalog-')) record({ catalog: value.state, added: value.added });
      } });
      installed = true;
      ready();
    };
    const profile = handler => {
      nativeProfile = handler;
      if (globalThis[profileKey] === profile) delete globalThis[profileKey];
      ready();
      return handler;
    };
    globalThis[profileKey] = profile;
    const target = pathToFileURL(path.join(config.archive, 'out/main/index.js')).href;
    let transformed = false;
    hook = registerHooks({ load(url, context, next) {
      const loaded = next(url, context);
      if (url !== target) return loaded;
      const source = String(loaded.source);
      if (digest(source) !== config.mainSHA256) throw Error('remote_installation_changed');
      const output = transformRemoteMain(source, 'globalThis.' + installKey,
        { profileExpression: 'globalThis.' + profileKey, decode: decodeSource(source) });
      transformed = true;
      return { ...loaded, source: output };
    } });
    app.on('will-quit', () => {
      delete globalThis[profileKey];
      credentials?.uninstall();
      record({ state: 'exited' });
    });
    await importMain(target);
    if (!transformed || !installed) throw Error('remote_main_hook_unverified');
    hook.deregister();
    hook = null;
    delete globalThis[installKey];
    ready();
    return { statusFile, inspect: () => ({ ...status }) };
  } catch (error) {
    hook?.deregister();
    proxy?.uninstall();
    credentials?.uninstall();
    delete globalThis[installKey];
    delete globalThis[profileKey];
    const reason = safeReason(error);
    record({ state: 'unverified', reason });
    throw Error(reason);
  }
}
