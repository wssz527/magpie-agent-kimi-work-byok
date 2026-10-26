import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function copySetupToken({ request, stateDir, key, copy = value => {
  const result = spawnSync('/usr/bin/pbcopy', [], { input: value, timeout: 2000, stdio: ['pipe', 'ignore', 'ignore'] });
  if (result.error || result.status !== 0) throw Error('clipboard_unavailable');
} }) {
  if (!request) return undefined;
  if (typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(request.id)
    || !Number.isFinite(request.at) || Math.abs(Date.now() - request.at) > 300000) return 'expired';
  if (typeof key !== 'string' || !key) return 'unavailable';
  const receipt = path.join(stateDir, 'native-copy-receipt.json');
  try {
    if (JSON.parse(fs.readFileSync(receipt, 'utf8')).id === request.id) return 'copied';
  } catch {}
  try {
    copy(key);
    fs.writeFileSync(receipt, JSON.stringify({ id: request.id, at: Date.now() }), { mode: 0o600 });
    return 'copied';
  } catch { return 'unavailable'; }
}
