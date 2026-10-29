// Syntax-checks every shipped module without a shell loop, so the same
// command works on macOS, Windows and CI.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const patterns = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['*.mjs', '*.js', 'scripts/*.mjs', 'ui/*.js', 'vendor/kimi-work-gateway/*.mjs'];

function expand(pattern) {
  if (!pattern.includes('*')) return [pattern];
  const directory = path.dirname(pattern);
  const suffix = pattern.slice(pattern.indexOf('*') + 1);
  const root = path.join(here, directory);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(name => name.endsWith(suffix)).map(name => path.join(directory, name));
}

const targets = [...new Set(patterns.flatMap(expand))];
let failed = 0;
for (const relative of targets) {
  try {
    execFileSync(process.execPath, ['--check', path.join(here, relative)], { stdio: 'pipe' });
  } catch (failure) {
    failed++;
    process.stderr.write(relative + ': ' + String(failure.stderr || failure.message).trim() + '\n');
  }
}
process.stdout.write('checked ' + targets.length + ' files' + (failed ? ', ' + failed + ' failed' : '') + '\n');
process.exit(failed ? 1 : 0);
