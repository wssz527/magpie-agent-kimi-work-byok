import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_FILES, verifyCore } from './scripts/vendor-core.mjs';

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'kimi-work-gateway');

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
