import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.versions.bun) throw Error('Run with Bun: bun scripts/verify-package.mjs [destination]');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = !process.argv[2];
const destination = temporary ? fs.mkdtempSync(path.join(os.tmpdir(), 'verified-package-')) : path.resolve(process.argv[2]);
fs.mkdirSync(destination, { recursive: true });
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const filename = manifest.name.replaceAll('/', '-') + '-' + manifest.version + '.tgz';
  execFileSync(process.execPath, ['pm', 'pack', '--filename', path.join(destination, filename), '--ignore-scripts', '--quiet'],
    { cwd: root, stdio: 'inherit' });
  const unpacked = fs.mkdtempSync(path.join(destination, 'unpacked-'));
  execFileSync('tar', ['-xzf', path.join(destination, filename), '-C', unpacked], { stdio: 'inherit' });
  const cwd = path.join(unpacked, 'package');
  for (const args of [['test'], ['run', 'check'], ...(manifest.scripts['vendor:verify'] ? [['run', 'vendor:verify']] : [])]) {
    execFileSync(process.execPath, args, { cwd, stdio: 'inherit' });
  }
  console.log('verified package: ' + path.join(destination, filename));
  console.log('verified contents: ' + cwd);
} finally {
  if (temporary) fs.rmSync(destination, { recursive: true, force: true });
}
