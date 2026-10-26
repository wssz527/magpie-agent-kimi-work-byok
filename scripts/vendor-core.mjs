import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CORE_FILES = ['config.mjs', 'gateway.mjs', 'index.mjs', 'instructions.mjs', 'native-clipboard.mjs',
  'native-dns.mjs', 'native-setup.mjs', 'native-status.mjs', 'openai-backend.mjs', 'paths.mjs', 'LICENSE'];

export function vendorRecord(coreDirectory) {
  const source = path.join(coreDirectory, 'src');
  const files = {};
  for (const name of CORE_FILES) {
    const file = name === 'LICENSE' ? path.join(coreDirectory, name) : path.join(source, name);
    files[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(coreDirectory, 'package.json'), 'utf8'));
  return { name: manifest.name, version: manifest.version, files };
}

export function copyCore(coreDirectory, target = path.join(here, 'vendor', 'kimi-work-gateway'), record = vendorRecord(coreDirectory)) {
  fs.mkdirSync(target, { recursive: true });
  for (const name of CORE_FILES) {
    const file = name === 'LICENSE' ? path.join(coreDirectory, name) : path.join(coreDirectory, 'src', name);
    fs.copyFileSync(file, path.join(target, name));
  }
  fs.writeFileSync(path.join(here, 'vendor', 'VENDOR.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}

export function verifyCore(target = path.join(here, 'vendor', 'kimi-work-gateway'),
  manifest = path.join(here, 'vendor', 'VENDOR.json')) {
  const record = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const problems = [];
  const present = fs.readdirSync(target).filter(name => name !== 'VENDOR.json').sort();
  if (JSON.stringify(present) !== JSON.stringify([...CORE_FILES].sort())) problems.push('unexpected file set: ' + present.join(','));
  for (const [name, expected] of Object.entries(record.files)) {
    let actual;
    try { actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(target, name))).digest('hex'); }
    catch { problems.push('missing ' + name); continue; }
    if (actual !== expected) problems.push('changed ' + name);
  }
  return { ok: problems.length === 0, record, problems };
}

const [, , command, coreDirectory] = process.argv;
if (command === 'sync' || command === 'verify') {
  if (command === 'sync') {
    if (!coreDirectory) { console.error('usage: node scripts/vendor-core.mjs sync <core checkout>'); process.exit(2); }
    console.log(JSON.stringify(copyCore(coreDirectory)));
  } else {
    const result = verifyCore();
    console.log(JSON.stringify(result));
    if (!result.ok) process.exit(1);
  }
} else if (command) {
  console.error('usage: node scripts/vendor-core.mjs <sync <core checkout>|verify>');
  process.exit(2);
}
