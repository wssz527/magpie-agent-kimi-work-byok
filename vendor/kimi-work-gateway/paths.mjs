import os from 'node:os';
import path from 'node:path';

export function defaultKimiDirectory(home = os.homedir(), platform = process.platform) {
  const support = platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
  return path.join(support, 'kimi-desktop', 'daimon-share', 'daimon');
}

// Kimi stores the hidden BYOK flag one level above the Work data directory.
export function nativeFlagFile(kimiDir) {
  return path.join(path.dirname(path.dirname(kimiDir)), 'kimi-agent', 'byok-availability.json');
}

export function defaultStateDirectory(home = os.homedir()) {
  return path.join(home, '.config', 'kimi-work-gateway');
}
