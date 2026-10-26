import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copySetupToken } from './native-clipboard.mjs';

test('explicit fresh setup requests copy only once and never persist the credential', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-copy-'));
  const copied = [], key = 'synthetic-agent-key', request = { id: 'synthetic-request-1234', at: Date.now() };
  const options = { request, stateDir, key, copy: value => copied.push(value) };
  try {
    expect(copySetupToken({ ...options, request: undefined })).toBeUndefined();
    expect(copySetupToken({ ...options, request: { ...request, at: 0 } })).toBe('expired');
    expect(copied).toHaveLength(0);
    expect(copySetupToken(options)).toBe('copied');
    expect(copySetupToken(options)).toBe('copied');
    expect(copied).toEqual([key]);
    expect(fs.readFileSync(path.join(stateDir, 'native-copy-receipt.json'), 'utf8')).not.toContain(key);
    expect(copySetupToken({ ...options, request: { ...request, id: 'synthetic-request-5678' }, copy: () => { throw Error('failed'); } })).toBe('unavailable');
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});
