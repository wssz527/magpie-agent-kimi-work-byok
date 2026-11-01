import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readAsarEntry, decodeSourceStrings } from './kimi-contract.mjs';
import { sameInstallation } from './translation-runtime.mjs';
import { transformRemoteMain } from './remote-work-hook.mjs';
import { buildRemoteBundle, remoteAsar, remoteDigest, verifyRemoteBundle } from './remote-bundle.mjs';
import { writeSubagentJSON } from './subagent-policy.mjs';

const SOURCE = fileURLToPath(new URL('./remote-companion-runtime.mjs', import.meta.url));
const MODULES = ['remote-companion-runtime.mjs', 'remote-work-hook.mjs', 'remote-work-models.mjs',
  'remote-update-proxy.mjs', 'remote-update-client.mjs', 'remote-bundle.mjs', 'remote-companion.mjs'];
const validSession = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
    || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw Error('remote_runtime_scope_unverified');
}

function privateJSON(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
    || stat.size > 65536) throw Error('remote_runtime_scope_unverified');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function cleanupRemoteRevisions(apps, current, { now = Date.now(), graceMS = 24 * 60 * 60 * 1000 } = {}) {
  const removed = [];
  for (const entry of fs.readdirSync(apps, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{32}$/.test(entry.name) || entry.name === current) continue;
    const artifact = path.join(apps, entry.name);
    const stat = fs.lstatSync(artifact);
    if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs <= graceMS) continue;
    fs.rmSync(artifact, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

export function prepareRemoteCompanion({ stateDir, kimiDir, sessionID, installation, userDataDir, credentials }) {
  if (process.platform !== 'darwin' || !validSession(sessionID) || !path.isAbsolute(stateDir)
    || !path.isAbsolute(kimiDir) || !sameInstallation({ ...installation, discoveredApplication: installation?.application }, 'darwin')) {
    throw Error('remote_runtime_config_invalid');
  }
  stateDir = path.resolve(stateDir);
  privateDirectory(stateDir);
  const root = path.join(stateDir, 'remote-runtime');
  privateDirectory(root);
  const source = readAsarEntry(installation.archive);
  const mainSHA256 = remoteDigest(source);
  transformRemoteMain(source, 'globalThis.__kwgRemoteInstall_' + '0'.repeat(32),
    { profileExpression: 'globalThis.__kwgRemoteProfile_' + '0'.repeat(32), decode: decodeSourceStrings(source) });
  const revision = remoteDigest(JSON.stringify({ schemaVersion: 1, application: installation.application,
    archive: installation.archive, mainSHA256,
    executable: remoteDigest(fs.readFileSync(installation.application)),
    metadata: remoteDigest(fs.readFileSync(path.join(path.dirname(path.dirname(installation.application)), 'Info.plist'))),
    framework: remoteDigest(fs.readFileSync(path.join(path.dirname(path.dirname(installation.application)),
      'Frameworks/Electron Framework.framework/Versions/A/Electron Framework'))),
    modules: MODULES.map(name => remoteDigest(fs.readFileSync(new URL(name, import.meta.url)))) })).slice(0, 32);
  const apps = path.join(root, 'apps');
  privateDirectory(apps);
  const artifact = path.join(apps, revision);
  privateDirectory(artifact);
  const bundle = path.join(artifact, 'Kimi Work Remote.app');
  const application = path.join(bundle, 'Contents', 'MacOS', 'Kimi');
  const manifestFile = path.join(artifact, 'manifest.json');
  const bootstrap = `import fs from 'node:fs';
import { app } from 'electron';
import { startRemoteCompanion } from ${JSON.stringify(pathToFileURL(SOURCE).href)};
const flag = process.argv.find(value => value.startsWith('--kwg-remote-config='));
try {
  if (!flag) throw Error('remote_runtime_config_invalid');
  const file = flag.slice('--kwg-remote-config='.length), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 63) !== 0 || stat.size > 65536) throw Error('remote_runtime_scope_unverified');
  await startRemoteCompanion(JSON.parse(fs.readFileSync(file, 'utf8')));
} catch { app.exit(78); }
`;
  const expectedArchive = remoteDigest(remoteAsar({
    'package.json': JSON.stringify({ name: 'kimi-work-remote-runtime', version: '1.0.0', type: 'module', main: 'bootstrap.mjs' }),
    'bootstrap.mjs': bootstrap,
  }).data);
  let manifest;
  try { manifest = privateJSON(manifestFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!fs.existsSync(bundle)) {
    const staging = fs.mkdtempSync(path.join(artifact, '.build-'));
    try {
      const temporaryBundle = path.join(staging, 'Kimi Work Remote.app');
      buildRemoteBundle({ destination: temporaryBundle, application: installation.application, bootstrap,
        bundleID: 'dev.kimi-work-gateway.remote', displayName: 'Kimi Work', lsuiElement: false });
      fs.renameSync(temporaryBundle, bundle);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  if (!manifest) {
    if (!verifyRemoteBundle(bundle)
      || remoteDigest(fs.readFileSync(path.join(bundle, 'Contents/Resources/app.asar'))) !== expectedArchive) {
      throw Error('remote_runtime_artifact_unverified');
    }
    manifest = { schemaVersion: 1, revision, application, originalApplication: installation.application,
      archive: installation.archive, mainSHA256, archiveSHA256: expectedArchive };
    writeSubagentJSON(manifestFile, manifest);
  }
  if (manifest.schemaVersion !== 1 || manifest.revision !== revision || manifest.application !== application
    || manifest.originalApplication !== installation.application || manifest.archive !== installation.archive
    || manifest.mainSHA256 !== mainSHA256 || manifest.archiveSHA256 !== expectedArchive || !verifyRemoteBundle(bundle)
    || manifest.archiveSHA256 !== remoteDigest(fs.readFileSync(path.join(bundle, 'Contents/Resources/app.asar')))) {
    throw Error('remote_runtime_artifact_unverified');
  }
  cleanupRemoteRevisions(apps, revision);
  const helper = fileURLToPath(new URL('./remote-update-helper.mjs', import.meta.url));
  const addon = fileURLToPath(new URL('./native/remote-official-updater.node', import.meta.url));
  if (!fs.existsSync(helper) || !fs.existsSync(addon)) throw Error('remote_update_helper_unavailable');
  const configFile = path.join(root, 'config-' + sessionID + '.json');
  writeSubagentJSON(configFile, { schemaVersion: 1, sessionID, stateDir, kimiDir: path.resolve(kimiDir),
    archive: installation.archive, application: installation.application,
    userDataDir: path.resolve(userDataDir || path.dirname(path.dirname(kimiDir))),
    version: installation.version, mainSHA256, helper, addon, ...(credentials ? { credentials } : {}) });
  return { application, args: ['--kwg-remote-config=' + configFile], revision };
}

export function verifiedRemoteApplication({ stateDir, receipt, launch }) {
  try {
    if (process.platform !== 'darwin' || !validSession(receipt?.id) || receipt.id !== launch?.id
      || receipt.homeDir !== launch.homeDir || !path.isAbsolute(receipt.runtimeApplication || '')
      || launch.remoteModels !== true || !sameInstallation(launch, 'darwin')) return null;
    const root = path.join(path.resolve(stateDir), 'remote-runtime', 'apps');
    const relative = path.relative(root, receipt.runtimeApplication);
    const match = /^([a-f0-9]{32})\/Kimi Work Remote\.app\/Contents\/MacOS\/Kimi$/.exec(relative);
    if (!match || fs.realpathSync(root) !== root) return null;
    const artifact = path.join(root, match[1]);
    if (fs.realpathSync(artifact) !== artifact) return null;
    const manifest = privateJSON(path.join(artifact, 'manifest.json'));
    if (manifest.schemaVersion !== 1 || manifest.revision !== match[1]
      || manifest.application !== receipt.runtimeApplication || manifest.originalApplication !== launch.application
      || manifest.archive !== launch.archive || !/^[a-f0-9]{64}$/.test(manifest.archiveSHA256)) return null;
    const config = privateJSON(path.join(path.resolve(stateDir), 'remote-runtime', 'config-' + receipt.id + '.json'));
    if (config.sessionID !== receipt.id || config.application !== launch.application || config.archive !== launch.archive
      || config.mainSHA256 !== manifest.mainSHA256) return null;
    const archive = path.join(artifact, 'Kimi Work Remote.app/Contents/Resources/app.asar');
    if (remoteDigest(fs.readFileSync(archive)) !== manifest.archiveSHA256) return null;
    return receipt.runtimeApplication;
  } catch { return null; }
}
