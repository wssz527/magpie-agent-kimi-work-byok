// Minimal, read-only client for Kimi's native control WebSocket.
//
// The daemon exposes exactly one authenticated `ws://127.0.0.1:<port>/control`
// endpoint. It speaks JSON-RPC 2.0 with a bearer token and has no health HTTP
// route, so proving "the kernel is idle right now" requires a real WebSocket
// exchange. This module implements only what that needs — a bounded RFC 6455
// client handshake and text frames — with no dependencies, so it runs on Node 20
// as-is (Bun's WebSocket `headers` option is not available on Node and is not
// used).
//
// Safety properties this file is responsible for:
//  * loopback only; a descriptor pointing anywhere else is refused.
//  * strict method allowlist; nothing outside it can be sent.
//  * bounded handshake, frame, message and total byte budgets.
//  * the token lives in memory only and never appears in a returned error.
//  * conversation titles/previews are dropped immediately, before returning.
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSubagentJSON } from './subagent-policy.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1024 * 1024;
const MAX_MESSAGE = 4 * 1024 * 1024;
const CONNECT_TIMEOUT = 5000;
const CALL_TIMEOUT = 8000;
// Read-only, fixed. `daimon.` is the prefix Work uses for the same routes; the
// raw socket takes the unprefixed names.
const METHODS = Object.freeze({
  capabilities: 'capabilities.get',
  status: 'runtime.status',
  conversations: 'conversations.list',
  busy: 'conversations.getBusy',
});

export const NATIVE_CONTROL_METHODS = METHODS;

const fail = code => {
  const error = Error(code);
  error.code = code;
  return error;
};

// Reads the control endpoint out of a runner snapshot. Only a loopback ws URL
// with a bearer token is accepted; everything else is "unknown", never guessed.
export function controlEndpoint(state) {
  const endpoint = state?.control?.endpoint;
  if (!endpoint || typeof endpoint !== 'object') return null;
  if (!Number.isInteger(endpoint.pid) || endpoint.pid <= 0) return null;
  let url;
  try { url = new URL(endpoint.url); } catch { return null; }
  if (url.protocol !== 'ws:' || url.pathname !== '/control' || url.username || url.password
    || url.search || url.hash || !isLoopback(url.hostname) || !url.port) return null;
  const token = endpoint.auth?.token;
  if (typeof token !== 'string' || !token || token.length > 4096) return null;
  return { url, host: url.hostname, port: Number(url.port), pid: endpoint.pid, token };
}

export function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost';
}

// Windows FILETIME epoch (1601-01-01) in 100 ns ticks, and the tick rate. This
// matches the daemon's own conversion exactly.
const WINDOWS_FILETIME_UNIX_EPOCH_OFFSET = 116444736000000000n;
const WINDOWS_FILETIME_TICKS_PER_MILLISECOND = 10000n;
const WINDOWS_PROCESS_NOT_FOUND_MARKER = '__DAIMON_PROCESS_NOT_FOUND__';
const WINDOWS_PROCESS_PERMISSION_DENIED_MARKER = '__DAIMON_PROCESS_PERMISSION_DENIED__';
export const WINDOWS_PROCESS_CREATION_FILETIME_KIND = 'windows_process_creation_filetime';

// The exact script the daemon runs. It only reads; it writes the creation time
// as FILETIME ticks so the value is comparable without locale or timezone luck.
export function windowsIdentityScript(pid) {
  return '$ErrorActionPreference = \'Stop\'; try { $process = Get-Process -Id ' + pid
    + ' -ErrorAction Stop; [Console]::Out.Write($process.StartTime.ToUniversalTime().ToFileTimeUtc()'
    + '.ToString([Globalization.CultureInfo]::InvariantCulture)) } catch { if ($_.FullyQualifiedErrorId -like '
    + '\'NoProcessFoundForGivenId*\') { [Console]::Error.Write(\'' + WINDOWS_PROCESS_NOT_FOUND_MARKER
    + '\'); exit 3 }; if (($_.Exception.NativeErrorCode -eq 5) -or ($_.Exception -is '
    + '[System.UnauthorizedAccessException])) { [Console]::Error.Write(\'' + WINDOWS_PROCESS_PERMISSION_DENIED_MARKER
    + '\'); exit 4 }; exit 5 }';
}

export function windowsFiletimeToUnixMilliseconds(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
  const milliseconds = (BigInt(value) - WINDOWS_FILETIME_UNIX_EPOCH_OFFSET) / WINDOWS_FILETIME_TICKS_PER_MILLISECOND;
  const ms = Number(milliseconds);
  return Number.isSafeInteger(ms) ? ms : null;
}

// OS-level process identity, so a pid reused after a restart cannot be mistaken
// for the process the descriptor described. Each platform uses the same source
// the daemon itself uses; anything that cannot be read is `unknown`, never
// assumed equal to the recorded value.
export function processStartIdentity(pid, { platform = process.platform, run = spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: 'unknown' };
  if (platform === 'darwin') {
    const result = run('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5000, encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' } });
    if (result.error) return { kind: 'unknown' };
    const value = String(result.stdout || '').trim();
    if (result.status === 1 && !value && !String(result.stderr || '').trim()) return { kind: 'not_found' };
    if (result.status !== 0) return { kind: 'unknown' };
    return value ? { kind: 'darwin_ps_lstart', value } : { kind: 'not_found' };
  }
  if (platform === 'win32') {
    const result = run('powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsIdentityScript(pid)],
      { encoding: 'utf8', shell: false, timeout: 5000, windowsHide: true });
    if (result.error) {
      const code = result.error.code;
      if (code === 3 || String(result.stderr || '').includes(WINDOWS_PROCESS_NOT_FOUND_MARKER)) return { kind: 'not_found' };
      return { kind: 'unknown' };
    }
    if (result.status === 3 || String(result.stderr || '').includes(WINDOWS_PROCESS_NOT_FOUND_MARKER)) return { kind: 'not_found' };
    if (result.status === 4 || String(result.stderr || '').includes(WINDOWS_PROCESS_PERMISSION_DENIED_MARKER)) {
      return { kind: 'unknown', reason: 'permission_denied' };
    }
    if (result.status !== 0) return { kind: 'unknown', reason: 'query_failed' };
    const value = String(result.stdout || '').trim();
    // The value must also be readable as a real timestamp; a syntactically valid
    // but impossible tick count is not identity evidence.
    if (windowsFiletimeToUnixMilliseconds(value) === null) return { kind: 'unknown', reason: 'invalid_output' };
    return { kind: WINDOWS_PROCESS_CREATION_FILETIME_KIND, value };
  }
  return { kind: 'unknown' };
}

// One connection, one exchange. `call(method, params)` is available until close.
export class NativeControlClient {
  constructor({ endpoint, connectTimeout = CONNECT_TIMEOUT, callTimeout = CALL_TIMEOUT } = {}) {
    this.endpoint = endpoint;
    this.connectTimeout = connectTimeout;
    this.callTimeout = callTimeout;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.closed = false;
    this.socket = null;
  }

  async connect() {
    if (!this.endpoint) throw fail('native_control_unavailable');
    const { url } = this.endpoint;
    const key = crypto.randomBytes(16).toString('base64');
    const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, '');
    const socket = net.connect({ host, port: Number(url.port) });
    this.socket = socket;
    const request = [
      'GET ' + url.pathname + ' HTTP/1.1',
      'Host: ' + url.host,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + key,
      'Sec-WebSocket-Version: 13',
      'Authorization: Bearer ' + this.endpoint.token,
      '', '',
    ].join('\r\n');
    // One reader owns the socket from the first byte: the 101 response and any
    // frame bytes that arrive in the same packet are parsed by the same loop, so
    // nothing is lost between the handshake and the RPC phase.
    let parsed = false;
    let raw = Buffer.alloc(0);
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { settle(fail('native_control_unavailable')); }, this.connectTimeout);
      const settle = error => {
        if (parsed || this.closed) return;
        parsed = true;
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
        if (error) {
          socket.destroy();
          reject(error);
        } else resolve();
      };
      const onError = () => settle(fail('native_control_unavailable'));
      const onClose = () => settle(fail('native_control_unavailable'));
      const onData = chunk => {
        raw = Buffer.concat([raw, chunk]);
        const at = raw.indexOf('\r\n\r\n');
        if (at < 0) {
          if (raw.length > 16384) settle(fail('native_control_unavailable'));
          return;
        }
        const head = raw.subarray(0, at).toString('latin1');
        const rest = raw.subarray(at + 4);
        const lines = head.split('\r\n');
        if (!/^HTTP\/1\.1 101\b/.test(lines[0] || '')) { settle(fail('native_control_refused')); return; }
        const headers = new Map();
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':');
          if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
        const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        if (headers.get('sec-websocket-accept') !== expected
          || (headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
          settle(fail('native_control_refused'));
          return;
        }
        this.upgraded = true;
        settle(null);
        if (rest.length) this.receive(rest);
      };
      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.write(request, 'latin1');
    });
    await ready;
    socket.on('data', chunk => this.receive(chunk));
    socket.on('error', () => this.dispose('native_control_unavailable'));
    socket.on('close', () => this.dispose('native_control_closed'));
    return this;
  }

  // Client frames must be masked (RFC 6455 §5.3); the server rejects them
  // otherwise and an unmasked frame is a protocol violation in its own right.
  frame(opcode, payload) {
    const length = payload.length;
    const header = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length])
      : length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff])
        : (() => { const value = Buffer.alloc(10); value[0] = 0x80 | opcode; value[1] = 0x80 | 127;
          value.writeBigUInt64BE(BigInt(length), 2); return value; })();
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index & 3];
    return Buffer.concat([header, mask, masked]);
  }

  send(method, params = {}) {
    if (this.closed || !this.upgraded) return Promise.reject(fail('native_control_closed'));
    if (!Object.values(METHODS).includes(method)) return Promise.reject(fail('native_control_method_refused'));
    if (this.pending.size >= 8) return Promise.reject(fail('native_control_busy'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail('native_control_timeout'));
      }, this.callTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(this.frame(0x1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8')));
      } catch { this.dispose('native_control_closed'); }
    });
  }

  receive(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      // The extended length follows the two fixed bytes; the mask key follows
      // that length. Adding the mask offset before reading the extended length
      // shifts the payload by four bytes, which corrupts every large reply.
      let offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) {
        if (this.buffer.length < 10) return;
        const value = this.buffer.readBigUInt64BE(2);
        if (value > BigInt(MAX_FRAME)) { this.dispose('native_control_frame_too_large'); return; }
        length = Number(value);
        offset = 10;
      }
      if (masked) offset += 4;
      if (length > MAX_FRAME) { this.dispose('native_control_frame_too_large'); return; }
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      this.handleFrame(fin, opcode, payload, masked);
      if (this.closed) return;
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) { this.dispose('native_control_closed'); return; }
    if (opcode === 0x9) { this.writeControl(0xa, payload); return; }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
      if (fin) this.flushMessage();
      return;
    }
    if (opcode === 0x0) {
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_MESSAGE) { this.dispose('native_control_message_too_large'); return; }
      this.fragments.push(payload);
      if (fin) this.flushMessage();
    }
  }

  writeControl(opcode, payload) {
    if (this.closed) return;
    try { this.socket.write(this.frame(opcode, payload.subarray(0, 125))); } catch { this.dispose('native_control_closed'); }
  }

  flushMessage() {
    const text = Buffer.concat(this.fragments).toString('utf8');
    this.fragments = [];
    this.fragmentBytes = 0;
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (!message || message.id === undefined) return; // server notifications are ignored
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(message.id);
    if (message.error) waiting.reject(fail('native_control_error'));
    else waiting.resolve(message.result && typeof message.result === 'object' ? message.result : {});
  }

  dispose(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(fail(reason));
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    try { this.socket?.destroy(); } catch {}
  }

  close() {
    if (this.closed) return;
    this.writeControl(0x8, Buffer.from([0x03, 0xe8]));
    this.dispose('native_control_closed');
  }
}

// Reads the runner snapshot's control endpoint without echoing anything secret.
export function readControlEndpoint(kimiDir) {
  let state;
  try { state = readSubagentJSON(path.join(path.resolve(kimiDir), 'agents', 'main', 'runner.state.json')); }
  catch { return null; }
  return controlEndpoint(state);
}
