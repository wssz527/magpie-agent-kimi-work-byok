import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_FILES, copyCore, digestText, INDEX_PROJECTION, projectIndex, verifyCore } from './scripts/vendor-core.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(root, 'vendor', 'kimi-work-gateway');

test('the vendored core matches the recorded file set and hashes', () => {
  const result = verifyCore();
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
  expect(fs.existsSync(path.join(target, 'translation-service.mjs'))).toBe(false);
  expect(fs.existsSync(path.join(target, 'translation-runtime.mjs'))).toBe(false);
  expect(fs.existsSync(path.join(target, 'translation-host.mjs'))).toBe(false);
});

test('the vendored index is an allowlist projection that keeps its source hash', () => {
  const { record } = verifyCore();
  expect(record.version).toBe('0.6.2');
  expect(record.commit).toMatch(/^[0-9a-f]{40}$/);
  const projection = record.projection['index.mjs'];
  expect(projection.mode).toBe(INDEX_PROJECTION);
  expect(projection.source).toBe('src/index.mjs');
  expect(projection.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(projection.dropped).toEqual(['translation-runtime.mjs', 'translation-service.mjs']);
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
    fs.mkdirSync(path.join(core, 'src'));
    for (const name of CORE_FILES) {
      const file = name === 'LICENSE' ? path.join(core, name) : path.join(core, 'src', name);
      const body = name === 'index.mjs'
        ? "export { KimiWorkGateway } from './gateway.mjs';\nexport { TranslationRuntime } from './translation-runtime.mjs';\n"
        : name + '\n';
      fs.writeFileSync(file, body.replace(/\n/g, '\r\n'));
    }
    fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: 'kimi-work-gateway', version: '9.9.9' }));
    const manifest = path.join(vendor, 'VENDOR.json');
    const record = copyCore(core, path.join(vendor, 'core'), manifest);
    expect(record.version).toBe('9.9.9');
    expect(record.commit).toBe(null);
    expect(verifyCore(path.join(vendor, 'core'), manifest).problems).toEqual([]);
    expect(fs.readFileSync(path.join(vendor, 'core', 'index.mjs'), 'utf8')).toBe("export { KimiWorkGateway } from './gateway.mjs';\n");
    fs.rmSync(core, { recursive: true, force: true });
    expect(verifyCore(path.join(vendor, 'core'), manifest).ok).toBe(true);
  } finally {
    fs.rmSync(core, { recursive: true, force: true });
    fs.rmSync(vendor, { recursive: true, force: true });
  }
});
