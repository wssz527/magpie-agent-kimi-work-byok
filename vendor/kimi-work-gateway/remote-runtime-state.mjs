import fs from 'node:fs';
import path from 'node:path';

const STATES = new Set(['starting', 'ready', 'unverified', 'exited']);
const CATALOG = new Set(['not-requested', 'catalog-extended', 'catalog-unchanged', 'catalog-unavailable']);
const UPDATER = new Set(['delegated', 'helper-unavailable', 'waiting-parent-exit', 'staged-by-official-helper', 'removed']);

export function publicRemoteRuntime(value) {
  if (!value || typeof value !== 'object' || !STATES.has(value.state)) return undefined;
  return { state: value.state,
    ...(typeof value.reason === 'string' && /^remote_[a-z_]{1,80}$/.test(value.reason) ? { reason: value.reason } : {}),
    ...(CATALOG.has(value.catalog) ? { catalog: value.catalog } : {}),
    ...(Number.isSafeInteger(value.added) && value.added >= 0 && value.added <= 256 ? { added: value.added } : {}),
    ...(UPDATER.has(value.updater) ? { updater: value.updater } : {}) };
}

export function readRemoteRuntime(stateDir, sessionID, applicationPid) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)
    || typeof sessionID !== 'string' || !/^[a-f0-9-]{36}$/.test(sessionID)
    || !Number.isInteger(applicationPid) || applicationPid <= 0) return undefined;
  try {
    const file = path.join(stateDir, 'remote-runtime', 'status-' + sessionID + '.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384
      || process.platform !== 'win32' && (stat.mode & 0o077)) return undefined;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.schemaVersion !== 1 || value.sessionID !== sessionID || value.applicationPid !== applicationPid) return undefined;
    return publicRemoteRuntime(value);
  } catch { return undefined; }
}
