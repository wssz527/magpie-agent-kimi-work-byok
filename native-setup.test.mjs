import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NativeSetup, resolverScript } from './native-setup.mjs';
import { resolverConfiguration } from './native-dns.mjs';

function fixture(admin = async () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-setup-'));
  const stateDir = path.join(directory, 'state'), support = path.join(directory, 'kimi-desktop');
  fs.mkdirSync(stateDir); fs.mkdirSync(support);
  const flagFile = path.join(support, 'kimi-agent', 'byok-availability.json');
  return { directory, stateDir, flagFile, admin,
    setup: new NativeSetup({ stateDir, flagFile, platform: 'darwin', admin }),
    request(action = 'prepare') { return { action, id: crypto.randomUUID(), at: Date.now() }; },
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('setup requires a fresh explicit request and supported platform', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; });
  try {
    expect(await f.setup.run()).toBeUndefined();
    expect((await f.setup.run({ ...f.request(), at: 0 })).state).toBe('invalid-request');
    expect((await f.setup.run({ ...f.request(), action: 'anything' })).state).toBe('invalid-request');
    const unsupported = new NativeSetup({ ...f, platform: 'linux' });
    expect((await unsupported.run(f.request())).state).toBe('unsupported-platform');
    expect(calls).toBe(0); expect(fs.existsSync(f.flagFile)).toBe(false);
  } finally { f.cleanup(); }
});

test('prepare reveals only the native user-data flag and consumes its request across reloads', async () => {
  let calls = 0;
  const f = fixture(async script => {
    calls++;
    expect(script).toContain('/etc/resolver/dev.msh.team');
    expect(script).not.toContain('/Applications/');
  });
  try {
    fs.mkdirSync(path.dirname(f.flagFile));
    fs.writeFileSync(f.flagFile, JSON.stringify({ revealed: false, retained: 'user-value' }));
    const request = f.request();
    expect((await f.setup.run(request)).state).toBe('done');
    expect(JSON.parse(fs.readFileSync(f.flagFile))).toEqual({ revealed: true, retained: 'user-value' });
    const reloaded = new NativeSetup({ ...f, platform: 'darwin' });
    expect((await reloaded.run(request)).state).toBe('done');
    expect(calls).toBe(1);
    const receipt = fs.readFileSync(path.join(f.stateDir, 'native-setup-receipt.json'), 'utf8');
    expect(receipt).not.toContain('token'); expect(receipt).not.toContain('user-value');
  } finally { f.cleanup(); }
});

test('administrator cancellation and resolver conflict do not reveal the flag or retry automatically', async () => {
  for (const [message, state] of [['User canceled. (-128)', 'cancelled'], ['resolver_conflict', 'resolver-conflict']]) {
    let calls = 0;
    const f = fixture(async () => { calls++; throw Error(message); });
    try {
      const request = f.request();
      expect((await f.setup.run(request)).state).toBe(state);
      expect((await f.setup.run(request)).state).toBe(state);
      expect(calls).toBe(1); expect(fs.existsSync(f.flagFile)).toBe(false);
    } finally { f.cleanup(); }
  }
});

test('invalid native flag is rejected before administrator authorization', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; });
  try {
    fs.mkdirSync(path.dirname(f.flagFile)); fs.writeFileSync(f.flagFile, '[]');
    expect((await f.setup.run(f.request())).state).toBe('failed');
    expect(calls).toBe(0); expect(fs.readFileSync(f.flagFile, 'utf8')).toBe('[]');
  } finally { f.cleanup(); }
});

test.skipIf(process.platform === 'win32')('resolver script installs and removes matching contents but preserves unrelated files and symlinks', () => {
  const f = fixture();
  try {
    const source = path.join(f.directory, "candidate's resolver"), target = path.join(f.directory, 'resolver', 'dev.msh.team');
    fs.writeFileSync(source, resolverConfiguration().content);
    const run = action => execFileSync('/bin/sh', ['-c', resolverScript(action, source, target, false)], { stdio: 'pipe' });
    run('prepare'); expect(fs.readFileSync(target, 'utf8')).toBe(resolverConfiguration().content);
    run('prepare'); run('remove-dns'); expect(fs.existsSync(target)).toBe(false);
    fs.writeFileSync(target, 'nameserver 192.0.2.1\n');
    expect(() => run('prepare')).toThrow(); expect(() => run('remove-dns')).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('nameserver 192.0.2.1\n');
    fs.unlinkSync(target); fs.symlinkSync(source, target);
    expect(() => run('prepare')).toThrow(); expect(() => run('remove-dns')).toThrow();
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  } finally { f.cleanup(); }
});

test('remove-dns does not hide the entry or edit a native gateway profile', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.dirname(f.flagFile)); fs.writeFileSync(f.flagFile, '{"revealed":true}');
    expect((await f.setup.run(f.request('remove-dns'))).state).toBe('done');
    expect(fs.readFileSync(f.flagFile, 'utf8')).toBe('{"revealed":true}');
  } finally { f.cleanup(); }
});
