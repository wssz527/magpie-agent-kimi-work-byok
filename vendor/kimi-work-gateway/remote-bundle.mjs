import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const remoteDigest = value => crypto.createHash('sha256').update(value).digest('hex');
const ENTITLEMENTS = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>';
const HELPERS = ['', ' (Renderer)', ' (GPU)', ' (Plugin)'].map(suffix => 'Kimi Helper' + suffix + '.app');

export function remoteAsar(files) {
  const entries = {};
  const payloads = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw Error('remote_bundle_entry_invalid');
    const data = Buffer.from(content), blocks = [];
    for (let at = 0; at < data.length; at += 4194304) blocks.push(remoteDigest(data.subarray(at, at + 4194304)));
    entries[name] = { size: data.length, offset: String(offset),
      integrity: { algorithm: 'SHA256', hash: remoteDigest(data), blockSize: 4194304, blocks } };
    offset += data.length;
    payloads.push(data);
  }
  const json = Buffer.from(JSON.stringify({ files: entries }));
  const header = Buffer.alloc(8 + json.length + (4 - json.length % 4) % 4);
  header.writeUInt32LE(header.length - 4, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const outer = Buffer.alloc(8);
  outer.writeUInt32LE(4, 0);
  outer.writeUInt32LE(header.length, 4);
  return { data: Buffer.concat([outer, header, ...payloads]), headerHash: remoteDigest(json) };
}

export function verifyRemoteBundle(bundle) {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', bundle], { stdio: 'pipe', timeout: 30000 });
    return true;
  } catch { return false; }
}

export function remoteBundleMetadata(source, { bundleID, displayName, executableName, lsuiElement }) {
  if (typeof lsuiElement !== 'boolean') throw Error('remote_bundle_config_invalid');
  const metadata = { ...source, CFBundleIdentifier: bundleID, CFBundleExecutable: executableName,
    CFBundleName: 'Kimi', CFBundleDisplayName: displayName, LSUIElement: lsuiElement };
  delete metadata.CFBundleURLTypes;
  delete metadata.CFBundleDocumentTypes;
  return metadata;
}

export function buildRemoteBundle({ destination, application, bootstrap, bundleID, displayName, executableName = 'Kimi', lsuiElement }) {
  if (process.platform !== 'darwin' || !path.isAbsolute(destination) || !path.isAbsolute(application)
    || !/^dev\.kimi-work-gateway\.[a-z-]+$/.test(bundleID) || typeof lsuiElement !== 'boolean'
    || !['Kimi', 'KimiWorkCredentials'].includes(executableName)) throw Error('remote_bundle_config_invalid');
  const original = path.dirname(path.dirname(application));
  const contents = path.join(destination, 'Contents');
  if (fs.existsSync(destination)) throw Error('remote_bundle_destination_exists');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true, mode: 0o700 });
  const executable = path.join(contents, 'MacOS', executableName);
  const run = (command, args, timeout = 120000) => execFileSync(command, args, { stdio: 'pipe', timeout });
  try {
    for (const folder of ['Frameworks', 'Resources']) {
      run('/bin/cp', ['-Rc', path.join(original, folder), path.join(contents, folder)]);
    }
    fs.copyFileSync(application, executable);
    fs.chmodSync(executable, 0o755);
    for (const helper of HELPERS) {
      if (!verifyRemoteBundle(path.join(contents, 'Frameworks', helper))) throw Error('remote_vendor_signature_invalid');
    }
    const archive = remoteAsar({
      'package.json': JSON.stringify({ name: 'kimi-work-remote-runtime', version: '1.0.0', type: 'module', main: 'bootstrap.mjs' }),
      'bootstrap.mjs': bootstrap,
    });
    fs.writeFileSync(path.join(contents, 'Resources', 'app.asar'), archive.data);
    const sourceMetadata = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(original, 'Info.plist')]).toString('utf8'));
    const metadata = remoteBundleMetadata(sourceMetadata, { bundleID, displayName, executableName, lsuiElement });
    metadata.ElectronAsarIntegrity = { 'Resources/app.asar': { algorithm: 'SHA256', hash: archive.headerHash } };
    const plist = path.join(contents, 'Info.plist');
    fs.writeFileSync(plist, JSON.stringify(metadata));
    run('/usr/bin/plutil', ['-convert', 'xml1', plist]);
    const entitlements = path.join(path.dirname(destination), '.' + crypto.randomUUID() + '.plist');
    try {
      fs.writeFileSync(entitlements, ENTITLEMENTS, { mode: 0o600, flag: 'wx' });
      run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--options', 'runtime',
        '--entitlements', entitlements, destination]);
    } finally { fs.rmSync(entitlements, { force: true }); }
    if (!verifyRemoteBundle(destination)) throw Error('remote_bundle_signature_invalid');
    return { application: executable, archiveSHA256: remoteDigest(archive.data) };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw Error(/^remote_[a-z_]+$/.test(error.message) ? error.message : 'remote_bundle_build_failed');
  }
}
