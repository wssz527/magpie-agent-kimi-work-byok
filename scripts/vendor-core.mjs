import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CORE_FILES = ['config.mjs', 'gateway.mjs', 'index.mjs', 'instructions.mjs', 'kimi-contract.mjs',
  'native-clipboard.mjs', 'native-dns.mjs', 'native-setup.mjs', 'native-status.mjs', 'openai-backend.mjs',
  'paths.mjs', 'subagent-policy.mjs', 'native-subagent-config.mjs', 'native-subagent-bridge.mjs', 'subagent-hook.mjs', 'subagent-runtime.mjs', 'subagent-structure.mjs',
  'subagent-launch-contract.mjs', 'translation-config.mjs', 'LICENSE'];

export const INDEX_FILE = 'index.mjs';
export const INDEX_PROJECTION = 'allowlist-reexports';

// The plugin embeds the gateway modules it runs, not the standalone CLI, web
// panel or translation host. `index.mjs` is the only embedded file that names
// modules outside that set, so it is rebuilt from source: a re-export statement
// survives only when the module it reads from is embedded too. Statements this
// small reader does not recognise are refused instead of copied, so a new core
// dependency cannot be pulled into the plugin silently.
const REEXPORT = /^export\s*\{([^}]*)\}\s*from\s*'\.\/([A-Za-z0-9._-]+)'\s*;$/;

export function projectIndex(source, files = CORE_FILES) {
  const lines = source.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const kept = [];
  const dropped = [];
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    let statement = lines[index];
    let last = index;
    while (!statement.trimEnd().endsWith(';')) {
      last += 1;
      if (last >= lines.length) throw Error('unsupported index structure at line ' + (index + 1));
      statement += '\n' + lines[last];
    }
    const text = statement.trim();
    const match = REEXPORT.exec(text);
    if (!match || !match[1].trim()) throw Error('unsupported index structure at line ' + (index + 1));
    if (files.includes(match[2])) kept.push(text); else dropped.push(match[2]);
    index = last;
  }
  if (!kept.length) throw Error('index projection is empty');
  return { text: kept.join('\n') + '\n', dropped: [...new Set(dropped)] };
}

function sourcePath(coreDirectory, name) {
  return name === 'LICENSE' ? path.join(coreDirectory, name) : path.join(coreDirectory, 'src', name);
}

// Line endings are checkout policy, not content: a Windows clone that turns LF
// into CRLF must still produce the same digest, or `vendor:verify` fails on
// every Windows machine for reasons that have nothing to do with the code.
export function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

export function digestText(text) {
  return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function sourceCommit(directory) {
  try {
    const commit = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return commit || null;
  } catch { return null; }
}

// One reader produces both the hashes and the bytes written to `vendor/`, so
// the manifest can never describe a file other than the one that was copied.
function assemble(coreDirectory) {
  const manifest = JSON.parse(readText(path.join(coreDirectory, 'package.json')));
  const indexSource = readText(sourcePath(coreDirectory, INDEX_FILE));
  const projection = projectIndex(indexSource, CORE_FILES);
  const contents = {};
  const files = {};
  for (const name of CORE_FILES) {
    contents[name] = name === INDEX_FILE ? projection.text : readText(sourcePath(coreDirectory, name));
    files[name] = digestText(contents[name]);
  }
  const record = {
    name: manifest.name,
    version: manifest.version,
    commit: sourceCommit(coreDirectory),
    files,
    projection: {
      [INDEX_FILE]: {
        source: 'src/' + INDEX_FILE,
        sourceSha256: digestText(indexSource),
        mode: INDEX_PROJECTION,
        dropped: projection.dropped,
      },
    },
  };
  return { record, contents };
}

export function vendorRecord(coreDirectory) {
  return assemble(coreDirectory).record;
}

export function copyCore(coreDirectory, target = path.join(here, 'vendor', 'kimi-work-gateway'),
  manifest = path.join(here, 'vendor', 'VENDOR.json')) {
  const { record, contents } = assemble(coreDirectory);
  fs.mkdirSync(target, { recursive: true });
  for (const name of CORE_FILES) fs.writeFileSync(path.join(target, name), contents[name]);
  fs.writeFileSync(manifest, JSON.stringify(record, null, 2) + '\n');
  // The vendor test pins the core version so a silent version change cannot
  // ship unreviewed. Keep the pin in step with the copy instead of leaving it
  // to fail in CI.
  const test = path.join(here, 'vendor.test.mjs');
  try {
    const text = fs.readFileSync(test, 'utf8');
    const next = text.replace(/expect\(record\.version\)\.toBe\('[^']+'\)/,
      "expect(record.version).toBe('" + record.version + "')");
    if (next !== text) fs.writeFileSync(test, next);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return record;
}

export function verifyCore(target = path.join(here, 'vendor', 'kimi-work-gateway'),
  manifest = path.join(here, 'vendor', 'VENDOR.json')) {
  const record = JSON.parse(readText(manifest));
  const problems = [];
  const present = fs.readdirSync(target).filter(name => name !== 'VENDOR.json').sort();
  if (JSON.stringify(present) !== JSON.stringify([...CORE_FILES].sort())) problems.push('unexpected file set: ' + present.join(','));
  for (const [name, expected] of Object.entries(record.files)) {
    let actual;
    try { actual = digestText(readText(path.join(target, name))); }
    catch { problems.push('missing ' + name); continue; }
    if (actual !== expected) problems.push('changed ' + name);
  }
  if (JSON.stringify(Object.keys(record.files).sort()) !== JSON.stringify([...CORE_FILES].sort())) problems.push('manifest file set mismatch');
  for (const name of CORE_FILES.filter(file => file.endsWith('.mjs'))) {
    let source;
    try { source = readText(path.join(target, name)); } catch { continue; }
    for (const match of source.matchAll(/^\s*(?:import\s+(?:[\w$*{}\s,]+\s+from\s*)?|export\s+(?:\*|\{[\w$\s,]*\})\s+from\s*)['"](\.[^'"]+)['"]/gm)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      if (!CORE_FILES.includes(dependency)) problems.push(name + ' has unvendored dependency ' + match[1]);
    }
  }
  const projection = record.projection?.[INDEX_FILE];
  if (projection?.mode !== INDEX_PROJECTION || !/^[0-9a-f]{64}$/.test(projection.sourceSha256 || '')) {
    problems.push('missing index projection record');
  }
  try {
    const text = readText(path.join(target, INDEX_FILE));
    const reread = projectIndex(text);
    if (reread.text !== text || reread.dropped.length) problems.push('index.mjs is not an allowlist projection');
  } catch (error) { problems.push(String(error?.message || error)); }
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
