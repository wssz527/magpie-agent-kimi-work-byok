import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_FILES, copyCore, digestBytes, digestText, INDEX_PROJECTION, isBinary, projectIndex,
  readText, relativeReferences, verifyCore } from './scripts/vendor-core.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(root, 'vendor', 'kimi-work-gateway');

// The compiled addon is part of the embedded set but its bytes are opaque, so
// fixtures give it a binary body instead of a module body.
const ADDON = 'native/remote-official-updater.node';
const addonBytes = () => Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0x0a, 0x0d]);

function sourceFile(core, name) {
  return path.join(core, name === 'translation-renderer.js' ? 'ui' : 'src', name);
}

function fixtureCore(core) {
  fs.mkdirSync(path.join(core, 'src'), { recursive: true });
  for (const name of CORE_FILES) {
    const file = name === 'LICENSE' ? path.join(core, name) : sourceFile(core, name);
    const body = name === 'index.mjs'
      ? "export { KimiWorkGateway } from './gateway.mjs';\nexport { createNativeConnection } from './native-connection.mjs';\n"
      : name === ADDON ? addonBytes() : Buffer.from((name + '\n').replace(/\n/g, '\r\n'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: 'kimi-work-gateway', version: '9.9.9' }));
}

// The vendored copy is only as good as the file list it was built from: every
// module the embedded code imports must be embedded too, including the ones it
// reaches through a literal dynamic import.
test('the embedded file list covers the remote host and its updater addon', () => {
  expect(CORE_FILES).toContain('remote-companion.mjs');
  expect(CORE_FILES).toContain('remote-companion-runtime.mjs');
  expect(CORE_FILES).toContain('remote-runtime-state.mjs');
  expect(CORE_FILES).toContain('remote-update-helper.mjs');
  expect(CORE_FILES).toContain('remote-credentials.mjs');
  expect(CORE_FILES).toContain(ADDON);
  expect(isBinary(ADDON)).toBe(true);
  expect(isBinary('subagent-runtime.mjs')).toBe(false);
  expect(new Set(CORE_FILES).size).toBe(CORE_FILES.length);
});

test('dependency scanning sees static, dynamic and import.meta.url references only', () => {
  const source = [
    "import { a } from './a.mjs';",
    "import './side-effect.mjs';",
    "export { b } from './b.mjs';",
    "const c = await import('./dynamic.mjs');",
    "const d = await import(url);",
    "const e = new URL('./helper.mjs', import.meta.url);",
    "// import { f } from './commented.mjs';",
    "const g = './string-only.mjs';",
  ].join('\n');
  expect(relativeReferences(source)).toEqual(['./a.mjs', './b.mjs', './side-effect.mjs',
    './dynamic.mjs', './helper.mjs']);
});

// The vendored tree only becomes current when `vendor:sync` runs against a core
// checkout that carries the remote host. Until then the strict check would just
// restate that the sync is pending, so a stale tree is held to the one property
// that still matters: it is untouched, not half-copied.
const recorded = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'VENDOR.json'), 'utf8')).files).sort();
const synced = JSON.stringify(recorded) === JSON.stringify([...CORE_FILES].sort());

test('the vendored core matches the recorded file set and hashes', () => {
  const result = verifyCore();
  if (!synced) {
    expect(result.problems.filter(problem => !problem.startsWith('unexpected file set'))).toEqual(['manifest file set mismatch']);
    expect(result.record.files['remote-companion.mjs']).toBeUndefined();
    expect(fs.existsSync(path.join(target, 'native'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'remote-credentials.mjs'))).toBe(false);
    return;
  }
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.record.name).toBe('kimi-work-gateway');
  expect(Object.keys(result.record.files).sort()).toEqual([...CORE_FILES].sort());
});

test('the vendored core keeps its licence and does not ship the CLI', () => {
  expect(fs.existsSync(path.join(target, 'LICENSE'))).toBe(true);
  expect(fs.existsSync(path.join(target, 'cli.mjs'))).toBe(false);
  expect(fs.existsSync(path.join(target, 'bin'))).toBe(false);
  const licence = fs.readFileSync(path.join(target, 'LICENSE'), 'utf8');
  expect(licence).toContain('magpie-community contributors');
});

test('the embedded core records the translation config its config.mjs imports', () => {
  expect(CORE_FILES).toContain('translation-config.mjs');
  const config = fs.readFileSync(path.join(target, 'config.mjs'), 'utf8');
  for (const match of config.matchAll(/from '\.\/([^']+)'/g)) expect(CORE_FILES).toContain(match[1]);
  for (const name of ['translation-service.mjs', 'translation-runtime.mjs', 'translation-host.mjs',
    'translation-supervisor.mjs', 'native-desktop-bridge.mjs', 'translation-renderer.js']) {
    expect(CORE_FILES).toContain(name);
    expect(fs.existsSync(path.join(target, name))).toBe(true);
  }
});

test('the vendored index is an allowlist projection that keeps its source hash', () => {
  const { record } = verifyCore();
  // Pinned on purpose: a vendor copy that silently changes core version is a
  // release that was not reviewed. Update this line when syncing a new core.
  expect(record.version).toBe('0.9.0');
  expect(record.commit).toMatch(/^[0-9a-f]{40}$/);
  const projection = record.projection['index.mjs'];
  expect(projection.mode).toBe(INDEX_PROJECTION);
  expect(projection.source).toBe('src/index.mjs');
  expect(projection.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(projection.dropped).toEqual(['native-connection.mjs']);
  const text = fs.readFileSync(path.join(target, 'index.mjs'), 'utf8');
  expect(projection.sourceSha256).not.toBe(digestText(text));
  for (const name of projection.dropped) expect(text).not.toContain(name);
  for (const match of text.matchAll(/from '\.\/([^']+)'/g)) expect(CORE_FILES).toContain(match[1]);
});

test('projection keeps multi-line re-exports and refuses unrecognised index structures', () => {
  const source = [
    "export { a, b } from './gateway.mjs';",
    "export { c,",
    "  d } from './native-dns.mjs';",
    "export { translation } from './translation-service.mjs';",
    '',
  ].join('\n');
  const projected = projectIndex(source, ['gateway.mjs', 'native-dns.mjs']);
  expect(projected.text).toBe("export { a, b } from './gateway.mjs';\nexport { c,\n  d } from './native-dns.mjs';\n");
  expect(projected.dropped).toEqual(['translation-service.mjs']);
  expect(() => projectIndex("import './gateway.mjs';\n", ['gateway.mjs'])).toThrow('unsupported index structure');
  expect(() => projectIndex("export * from './gateway.mjs';\n", ['gateway.mjs'])).toThrow('unsupported index structure');
  expect(() => projectIndex("export { a } from './other.mjs';\n", ['gateway.mjs'])).toThrow('index projection is empty');
});

test('copying a core writes the same bytes it records and verifies without the source checkout', () => {
  const core = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-core-'));
  const vendor = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-vendor-'));
  try {
    fixtureCore(core);
    const manifest = path.join(vendor, 'VENDOR.json');
    const record = copyCore(core, path.join(vendor, 'core'), manifest);
    expect(record.version).toBe('9.9.9');
    expect(record.commit).toBe(null);
    expect(verifyCore(path.join(vendor, 'core'), manifest).problems).toEqual([]);
    expect(fs.readFileSync(path.join(vendor, 'core', 'index.mjs'), 'utf8')).toBe("export { KimiWorkGateway } from './gateway.mjs';\n");
    // CRLF in a text source is normalised, so a Windows checkout digests alike.
    expect(record.files['gateway.mjs']).toBe(digestText('gateway.mjs\n'));
    expect(fs.readFileSync(path.join(vendor, 'core', 'gateway.mjs'), 'utf8')).toBe('gateway.mjs\n');
    fs.rmSync(core, { recursive: true, force: true });
    expect(verifyCore(path.join(vendor, 'core'), manifest).ok).toBe(true);
    const file = path.join(vendor, 'core', 'subagent-runtime.mjs');
    fs.appendFileSync(file, '\nimport "./forgotten-dependency.mjs";\n');
    const updated = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    updated.files['subagent-runtime.mjs'] = digestText(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(manifest, JSON.stringify(updated));
    expect(verifyCore(path.join(vendor, 'core'), manifest).problems).toContain('subagent-runtime.mjs has unvendored dependency ./forgotten-dependency.mjs');
  } finally {
    fs.rmSync(core, { recursive: true, force: true });
    fs.rmSync(vendor, { recursive: true, force: true });
  }
});

test('the updater addon is copied byte for byte into a nested directory', () => {
  const core = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-core-'));
  const vendor = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-vendor-'));
  try {
    fixtureCore(core);
    const manifest = path.join(vendor, 'VENDOR.json');
    const copy = path.join(vendor, 'core');
    const record = copyCore(core, copy, manifest);
    const addon = path.join(copy, ADDON);
    expect(fs.statSync(addon).isFile()).toBe(true);
    expect(fs.readFileSync(addon).equals(addonBytes())).toBe(true);
    expect(record.files[ADDON]).toBe(digestBytes(addonBytes()));
    expect(record.files[ADDON]).not.toBe(digestText(addonBytes().toString('utf8')));
    expect(verifyCore(copy, manifest).problems).toEqual([]);
    fs.writeFileSync(addon, Buffer.from([0x00, 0x01]));
    expect(verifyCore(copy, manifest).problems).toContain('changed ' + ADDON);
  } finally {
    fs.rmSync(core, { recursive: true, force: true });
    fs.rmSync(vendor, { recursive: true, force: true });
  }
});

test('verification refuses a manifest path that leaves the vendored tree', () => {
  const core = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-core-'));
  const vendor = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-vendor-'));
  try {
    fixtureCore(core);
    const manifest = path.join(vendor, 'VENDOR.json');
    const copy = path.join(vendor, 'core');
    copyCore(core, copy, manifest);
    fs.writeFileSync(path.join(vendor, 'outside.mjs'), 'outside\n');
    const record = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    record.files['../outside.mjs'] = digestText('outside\n');
    fs.writeFileSync(manifest, JSON.stringify(record));
    const result = verifyCore(copy, manifest);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('manifest path escapes target: ../outside.mjs');
  } finally {
    fs.rmSync(core, { recursive: true, force: true });
    fs.rmSync(vendor, { recursive: true, force: true });
  }
});

test('verification reports a symlinked file instead of following it', () => {
  const core = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-core-'));
  const vendor = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-vendor-'));
  try {
    fixtureCore(core);
    const manifest = path.join(vendor, 'VENDOR.json');
    const copy = path.join(vendor, 'core');
    copyCore(core, copy, manifest);
    const linked = path.join(copy, 'gateway.mjs');
    fs.rmSync(linked);
    fs.symlinkSync(path.join(copy, 'openai-backend.mjs'), linked);
    const result = verifyCore(copy, manifest);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('symlinked gateway.mjs');
    expect(result.problems).toContain('missing gateway.mjs');
    expect(result.problems.some(problem => problem.startsWith('unexpected file set'))).toBe(true);
  } finally {
    fs.rmSync(core, { recursive: true, force: true });
    fs.rmSync(vendor, { recursive: true, force: true });
  }
});

test('verification treats a literal dynamic import as an embedded dependency', () => {
  const core = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-core-'));
  const vendor = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-vendor-'));
  try {
    fixtureCore(core);
    const manifest = path.join(vendor, 'VENDOR.json');
    const copy = path.join(vendor, 'core');
    copyCore(core, copy, manifest);
    const file = path.join(copy, 'translation-host.mjs');
    // `panel-controller.mjs` is real core code the plugin deliberately leaves out.
    fs.appendFileSync(file, "\nconst late = await import('./panel-controller.mjs');\n");
    const record = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    record.files['translation-host.mjs'] = digestText(readText(file));
    fs.writeFileSync(manifest, JSON.stringify(record));
    expect(verifyCore(copy, manifest).problems)
      .toContain('translation-host.mjs has unvendored dependency ./panel-controller.mjs');
  } finally {
    fs.rmSync(core, { recursive: true, force: true });
    fs.rmSync(vendor, { recursive: true, force: true });
  }
});
