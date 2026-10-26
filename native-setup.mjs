import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolverConfiguration } from './native-dns.mjs';

const execute = promisify(execFile);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const atomic = (file, value) => {
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
};

export function resolverScript(action, source, target = '/etc/resolver/dev.msh.team', flush = true) {
  if (!['prepare', 'remove-dns'].includes(action)) throw Error('invalid_setup_action');
  const destination = quote(target), input = quote(source), directory = quote(path.dirname(target));
  const checks = 'set -eu\n' + 'test ! -L ' + directory + '\n' + 'test ! -L ' + destination + '\n';
  const operation = action === 'prepare'
    ? 'if test -e ' + destination + '; then /usr/bin/cmp -s ' + input + ' ' + destination
      + ' || { /usr/bin/printf %s resolver_conflict >&2; exit 73; }; else /bin/mkdir -p ' + directory
      + '; /usr/bin/install -m 644 ' + input + ' ' + destination + '; fi\n'
    : 'if test -e ' + destination + '; then /usr/bin/cmp -s ' + input + ' ' + destination
      + ' || { /usr/bin/printf %s resolver_conflict >&2; exit 73; }; /bin/rm ' + destination + '; fi\n';
  return checks + operation + (flush ? '/usr/bin/dscacheutil -flushcache\n/usr/bin/killall -HUP mDNSResponder\n' : '');
}

async function administrator(command) {
  await execute('/usr/bin/osascript', ['-e', 'do shell script ' + JSON.stringify(command) + ' with administrator privileges'],
    { timeout: 180000, maxBuffer: 16384 });
}

export class NativeSetup {
  constructor({ stateDir, flagFile, platform = process.platform, admin = administrator } = {}) {
    Object.assign(this, { stateDir, flagFile, platform, admin });
  }

  flagValue() {
    let value = {};
    try {
      const stat = fs.lstatSync(this.flagFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('invalid_setup_flag');
      value = JSON.parse(fs.readFileSync(this.flagFile, 'utf8'));
      if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('invalid_setup_flag');
    } catch (failure) { if (failure.code !== 'ENOENT') throw Error('invalid_setup_flag'); }
    return { ...value, revealed: true };
  }

  async run(request, port = 53535) {
    if (!request) return undefined;
    if (this.requestID === request.id && this.result) return this.result;
    this.requestID = request.id;
    const finish = (state, stage) => (this.result = { action: request.action, state, ...(stage ? { stage } : {}) });
    if (typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(request.id)
      || !['prepare', 'remove-dns'].includes(request.action) || !Number.isFinite(request.at)
      || Math.abs(Date.now() - request.at) > 300000) return finish('invalid-request');
    if (this.platform !== 'darwin') return finish('unsupported-platform');
    const receiptFile = path.join(this.stateDir, 'native-setup-receipt.json');
    try {
      const previous = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      if (previous.id === request.id) return this.result = previous.result || finish('interrupted');
    } catch {}
    let temporary;
    let stage = 'validate';
    try {
      const configuration = resolverConfiguration(port);
      if (request.action === 'prepare') {
        if (!fs.statSync(path.dirname(path.dirname(this.flagFile))).isDirectory()) throw Error('kimi_data_missing');
        this.flagValue();
      }
      atomic(receiptFile, { id: request.id, action: request.action, state: 'running' });
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-kimi-byok-'));
      const source = path.join(temporary, 'resolver');
      fs.writeFileSync(source, configuration.content, { mode: 0o600 });
      stage = 'dns';
      finish('running', stage);
      await this.admin(resolverScript(request.action, source, configuration.path));
      if (request.action === 'prepare') {
        stage = 'reveal';
        const value = this.flagValue();
        fs.mkdirSync(path.dirname(this.flagFile), { recursive: true });
        atomic(this.flagFile, value);
      }
      finish('done');
    } catch (failure) {
      const text = String(failure.stderr || failure.message || '');
      finish(text.includes('resolver_conflict') ? 'resolver-conflict'
        : /User cancel|user cancel|\(-128\)/.test(text) ? 'cancelled' : 'failed', stage);
    } finally {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    }
    atomic(receiptFile, { id: request.id, action: request.action, result: this.result, at: new Date().toISOString() });
    return this.result;
  }
}
