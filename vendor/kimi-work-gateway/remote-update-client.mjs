import { spawn } from 'node:child_process';
import path from 'node:path';

const OPERATIONS = new Set(['set-feed', 'check', 'relaunch-after-parent-exit', 'inspect']);
const MAX_FRAME = 256 * 1024;

export class OfficialUpdateClient {
  constructor({ application, helper, addon, cacheHome, parentPid = process.pid, env = process.env, spawnImpl = spawn,
    timeout = 10000, onEvent = () => {} } = {}) {
    if (![application, helper, addon, cacheHome].every(value => typeof value === 'string' && path.isAbsolute(value))
      || !Number.isInteger(parentPid) || parentPid <= 0 || !Number.isSafeInteger(timeout) || timeout <= 0) {
      throw Error('remote_update_client_invalid');
    }
    this.application = application;
    this.helper = helper;
    this.addon = addon;
    this.cacheHome = cacheHome;
    this.parentPid = parentPid;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.timeout = timeout;
    this.onEvent = onEvent;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    this.closed = false;
  }

  emit(event) { try { this.onEvent(event); } catch {} }

  fail() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error('remote_update_helper_unavailable'));
    }
    this.pending.clear();
    this.emit({ type: 'error' });
  }

  message(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return this.fail();
    if (Object.hasOwn(message, 'event')) {
      if (!message.event || typeof message.event.type !== 'string') return this.fail();
      this.emit(message.event);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return this.fail();
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok !== true) entry.reject(Error('remote_update_helper_unavailable'));
    else entry.resolve(message);
  }

  data(chunk) {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_FRAME) return this.fail();
    let at;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (!line) return this.fail();
      let message;
      try { message = JSON.parse(line); } catch { return this.fail(); }
      this.message(message);
      if (this.closed) return;
    }
  }

  async connect() {
    if (this.closed) throw Error('remote_update_helper_unavailable');
    if (this.connection) return this.connection;
    this.connection = (async () => {
      const env = { ELECTRON_RUN_AS_NODE: '1', HOME: this.cacheHome, TMPDIR: path.join(this.cacheHome, 'tmp') };
      for (const name of ['PATH', 'LANG']) {
        if (typeof this.env[name] === 'string') env[name] = this.env[name];
      }
      const child = this.spawnImpl(this.application, [this.helper, this.addon],
        { env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
      this.child = child;
      child.on('error', () => this.fail());
      child.on('exit', () => this.fail());
      this.write = child.stdio?.[3];
      const read = child.stdio?.[4];
      if (!this.write || !read) { this.fail(); throw Error('remote_update_helper_unavailable'); }
      this.write.on('error', () => this.fail());
      read.on('error', () => this.fail());
      read.on('end', () => this.fail());
      read.setEncoding('utf8');
      read.on('data', chunk => this.data(chunk));
      child.unref?.();
      const hello = await this.send('hello', { parentPid: this.parentPid, application: this.application, cacheHome: this.cacheHome });
      if (hello.identityVerified !== true || hello.application !== this.application) {
        this.fail();
        throw Error('remote_update_helper_identity_unverified');
      }
    })();
    return this.connection;
  }

  send(operation, value) {
    if (this.closed) return Promise.reject(Error('remote_update_helper_unavailable'));
    const id = ++this.sequence;
    const frame = JSON.stringify({ id, operation, value }) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME || this.pending.size >= 16) {
      return Promise.reject(Error('remote_update_request_invalid'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('remote_update_helper_timeout'));
        this.fail();
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write.write(frame); }
      catch { this.fail(); }
    });
  }

  async request(operation, value) {
    if (!OPERATIONS.has(operation)) throw Error('remote_update_request_invalid');
    await this.connect();
    return this.send(operation, value);
  }
}
