import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Names are posix paths relative to the vendored root, so a module that lives in
// a subdirectory of the core keeps that subdirectory here too. The last entry is
// the compiled updater addon; it is universal (x86_64 + arm64) so users never
// need a compiler.
export const CORE_FILES = ['config.mjs', 'gateway.mjs', 'index.mjs', 'instructions.mjs', 'kimi-contract.mjs',
  'native-clipboard.mjs', 'native-dns.mjs', 'native-setup.mjs', 'native-status.mjs', 'native-account-context.mjs', 'native-work-integration.mjs', 'openai-backend.mjs',
  'paths.mjs', 'subagent-policy.mjs', 'native-subagent-config.mjs', 'native-subagent-bridge.mjs', 'subagent-hook.mjs', 'subagent-runtime.mjs', 'subagent-structure.mjs',
  'subagent-launch-contract.mjs', 'translation-config.mjs', 'native-import.mjs', 'native-onboarding.mjs',
  'native-desktop-bridge.mjs', 'native-desktop-runtime.mjs', 'native-control.mjs', 'native-idle.mjs',
  'translation-runtime.mjs', 'translation-host.mjs',
  'translation-supervisor.mjs', 'translation-pipe.mjs', 'translation-service.mjs', 'translation-renderer.js',
  'remote-bundle.mjs', 'remote-companion.mjs', 'remote-companion-runtime.mjs', 'remote-runtime-state.mjs',
  'remote-work-models.mjs', 'remote-work-hook.mjs', 'remote-update-client.mjs', 'remote-update-proxy.mjs',
  'remote-update-helper.mjs', 'remote-credentials.mjs', 'remote-credentials-service.mjs',
  'remote-credentials-client.mjs', 'native/remote-official-updater.node', 'LICENSE'];

export const INDEX_FILE = 'index.mjs';
export const INDEX_PROJECTION = 'allowlist-reexports';

// The plugin embeds its native bridge host but excludes the standalone CLI and
// web panel. `index.mjs` is the only embedded file that names modules outside
// that set, so it is rebuilt from source: a re-export statement
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

// `native/remote-official-updater.node` resolves under `src/` like every other
// embedded module, and keeps that directory in the target when copied.
function sourcePath(coreDirectory, name) {
  return name === 'LICENSE' ? path.join(coreDirectory, name)
    : path.join(coreDirectory, name === 'translation-renderer.js' ? 'ui' : 'src', name);
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

export function readBytes(file) {
  return fs.readFileSync(file);
}

// A compiled addon has no line endings to normalise and must reach the plugin
// byte for byte: it is loaded with `dlopen`, so a single rewritten CRLF turns
// into a load failure on the user's machine.
export function isBinary(name) {
  return path.posix.extname(name) === '.node';
}

export function digestBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const STATIC_FROM = /\bfrom\s*['"](\.{1,2}\/[^'"\n]+)['"]/g;
const SIDE_EFFECT = /\bimport\s*['"](\.{1,2}\/[^'"\n]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"](\.{1,2}\/[^'"\n]+)['"]\s*\)/g;
const MODULE_URL = /\bnew\s+URL\s*\(\s*['"](\.{1,2}\/[^'"\n]+)['"]\s*,\s*import\.meta\.url\s*\)/g;

// Every way an embedded module can name a sibling file: a static import or
// re-export, a side-effect import, a literal dynamic import, and a
// `new URL(..., import.meta.url)` path that is loaded at runtime. A dynamic
// import built from a variable (`import(url)`) names an external path by
// design and is left alone. Whole-line comments are dropped first so prose
// cannot look like a dependency.
export function relativeReferences(source) {
  const text = source.split('\n').map(line => (/^\s*\/\//.test(line) ? '' : line)).join('\n');
  const references = [];
  for (const pattern of [STATIC_FROM, SIDE_EFFECT, DYNAMIC_IMPORT, MODULE_URL]) {
    for (const match of text.matchAll(pattern)) references.push(match[1]);
  }
  return [...new Set(references)];
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
    const file = sourcePath(coreDirectory, name);
    contents[name] = name === INDEX_FILE ? projection.text
      : isBinary(name) ? readBytes(file) : readText(file);
    files[name] = isBinary(name) ? digestBytes(contents[name]) : digestText(contents[name]);
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
  for (const name of CORE_FILES) {
    const file = path.join(target, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents[name]);
  }
  fs.writeFileSync(manifest, JSON.stringify(record, null, 2) + '\n');
  return record;
}

// `readdirSync` reports a symlink as its own entry, so this walk never leaves
// the tree it verifies: a linked-in module is reported instead of hashed.
function listFiles(directory, prefix, problems) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (!prefix && name === 'VENDOR.json') continue;
    if (entry.isSymbolicLink()) problems.push('symlinked ' + name);
    else if (entry.isDirectory()) found.push(...listFiles(directory, name, problems));
    else found.push(name);
  }
  return found;
}

// A manifest is data on disk, so a name in it must not be able to point `verify`
// at a file outside the vendored tree. Only plain relative posix paths pass.
function relativeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || path.posix.isAbsolute(name)) return null;
  const normalized = path.posix.normalize(name);
  if (normalized !== name || normalized === '.' || normalized.startsWith('../')) return null;
  return normalized;
}

// A reference is resolved against the core's source layout (`src/`, `ui/`) and
// then mapped onto the vendored one, where source modules sit at the root and
// the `ui/` renderer sits beside them. Null means the reference points outside
// the embedded tree, which no manifest can satisfy.
function vendoredName(name, reference) {
  const resolved = path.posix.normalize(
    path.posix.join('src', path.posix.dirname(name), reference));
  if (resolved.startsWith('src/')) return resolved.slice(4);
  if (resolved.startsWith('ui/')) return resolved.slice(3);
  return null;
}

function readVendored(target, name) {
  const file = path.join(target, name);
  if (!fs.lstatSync(file).isFile()) throw Error('not a regular file');
  return isBinary(name) ? readBytes(file) : readText(file);
}

export function verifyCore(target = path.join(here, 'vendor', 'kimi-work-gateway'),
  manifest = path.join(here, 'vendor', 'VENDOR.json')) {
  const record = JSON.parse(readText(manifest));
  const problems = [];
  const present = listFiles(target, '', problems).sort();
  if (JSON.stringify(present) !== JSON.stringify([...CORE_FILES].sort())) problems.push('unexpected file set: ' + present.join(','));
  for (const [key, expected] of Object.entries(record.files || {})) {
    const name = relativeName(key);
    if (!name) { problems.push('manifest path escapes target: ' + key); continue; }
    let actual;
    try {
      const contents = readVendored(target, name);
      actual = isBinary(name) ? digestBytes(contents) : digestText(contents);
    } catch { problems.push('missing ' + name); continue; }
    if (actual !== expected) problems.push('changed ' + name);
  }
  if (JSON.stringify(Object.keys(record.files || {}).sort()) !== JSON.stringify([...CORE_FILES].sort())) problems.push('manifest file set mismatch');
  for (const name of CORE_FILES.filter(file => file.endsWith('.mjs'))) {
    let source;
    try { source = readText(path.join(target, name)); } catch { continue; }
    for (const reference of relativeReferences(source)) {
      const dependency = vendoredName(name, reference);
      if (dependency === null || !CORE_FILES.includes(dependency)) problems.push(name + ' has unvendored dependency ' + reference);
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
