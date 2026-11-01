import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const MAX_FRAME = 256 * 1024;
const EVENT_TYPES = new Set(['checking-for-update', 'update-available', 'update-not-available', 'update-downloaded', 'error']);
const codeFor = error => /^remote_update_[a-z_]{1,80}$/.test(error?.code) ? error.code : 'remote_update_helper_failed';
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

export function normalizeRemoteFeed(value) {
  const feed = typeof value === 'string' ? { url: value } : value;
  if (!plain(feed) || typeof feed.url !== 'string' || feed.url.length > 32768
    || Object.keys(feed).some(key => !['url', 'headers'].includes(key))) throw Error('remote_update_feed_invalid');
  let url;
  try { url = new URL(feed.url); } catch { throw Error('remote_update_feed_invalid'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) throw Error('remote_update_feed_invalid');
  const headers = feed.headers ?? {};
  if (!plain(headers) || Object.keys(headers).length > 64) throw Error('remote_update_feed_invalid');
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~\w-]{1,256}$/.test(key) || typeof value !== 'string' || value.length > 16384 || /[\r\n\0]/.test(value)) {
      throw Error('remote_update_feed_invalid');
    }
  }
  return { url: feed.url, headers };
}

export function remoteUpdateEvent(value) {
  if (!plain(value) || !EVENT_TYPES.has(value.type)) return null;
  if (value.type === 'error') return { type: 'error', code: /^remote_update_[a-z_]{1,80}$/.test(value.code) ? value.code : 'remote_update_check_failed' };
  const event = { type: value.type };
  if (value.type === 'update-downloaded') {
    for (const [key, max] of [['releaseNotes', 16384], ['releaseName', 512], ['updateURL', 8192]]) {
      if (typeof value[key] === 'string') event[key] = value[key].slice(0, max);
    }
    if (typeof value.releaseDate === 'number' && Number.isFinite(value.releaseDate)) event.releaseDate = value.releaseDate;
  }
  return event;
}

export function createRemoteUpdateFrameDecoder({ onRequest, onError }) {
  let buffered = Buffer.alloc(0), closed = false;
  return chunk => {
    if (closed) return false;
    buffered = Buffer.concat([buffered, chunk]);
    let at;
    while ((at = buffered.indexOf(10)) !== -1) {
      const frame = buffered.subarray(0, at);
      buffered = buffered.subarray(at + 1);
      if (!frame.length || frame.length + 1 > MAX_FRAME) {
        onError('remote_update_frame_invalid'); closed = true; buffered = Buffer.alloc(0); return false;
      }
      let request;
      try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
      catch { onError('remote_update_frame_invalid'); continue; }
      onRequest(request);
    }
    if (buffered.length >= MAX_FRAME) {
      onError('remote_update_frame_invalid'); closed = true; buffered = Buffer.alloc(0); return false;
    }
    return true;
  };
}

export function startRemoteUpdateHelper({ addonPath = process.argv[2], inputFD = 3, outputFD = 4,
  loadAddon = value => createRequire(import.meta.url)(value) } = {}) {
  let native, startupError;
  const cacheHome = process.env.HOME;
  const application = process.execPath;
  const parentPid = process.ppid;
  process.env.CFFIXED_USER_HOME = cacheHome;
  try {
    if (process.platform !== 'darwin' || process.env.ELECTRON_RUN_AS_NODE !== '1'
      || !Number.isInteger(parentPid) || parentPid <= 1
      || typeof addonPath !== 'string' || !path.isAbsolute(addonPath)
      || typeof cacheHome !== 'string' || !path.isAbsolute(cacheHome)) throw Error('remote_update_startup_invalid');
    native = loadAddon(addonPath);
    const state = native.initialize({ parentPid, application, cacheHome });
    if (state.identityVerified !== true || state.supportsOfficialUpdates !== true) throw Error('remote_update_identity_unverified');
  } catch (error) { startupError = codeFor(error); native = undefined; }
  const input = fs.createReadStream(null, { fd: inputFD, autoClose: true });
  const output = fs.createWriteStream(null, { fd: outputFD, autoClose: true });
  let hello = false, lastID = 0, outputOpen = true, inputOpen = true;
  const send = message => {
    if (!outputOpen) return;
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME) return;
    try { output.write(frame); } catch { outputOpen = false; }
  };
  output.on('error', () => { outputOpen = false; });
  input.on('error', () => { inputOpen = false; });
  input.on('end', () => { inputOpen = false; });
  if (startupError) {
    input.destroy();
    output.end(JSON.stringify({ event: { type: 'error', code: startupError } }) + '\n');
    process.exitCode = 1;
    return { inspect: () => undefined, input, output, timer: null, startupError };
  }
  const reject = (id, code) => send({ id, ok: false, code });
  const handle = request => {
    if (!plain(request) || !Number.isSafeInteger(request.id) || request.id <= lastID || typeof request.operation !== 'string'
      || Object.keys(request).some(key => !['id', 'operation', 'value'].includes(key))) {
      reject(Number.isSafeInteger(request?.id) ? request.id : null, 'remote_update_request_invalid');
      return;
    }
    lastID = request.id;
    try {
      let result;
      if (request.operation === 'hello') {
        const value = request.value;
        if (hello || !plain(value) || value.parentPid !== parentPid || value.parentPid !== process.ppid
          || value.application !== application || value.cacheHome !== cacheHome) return reject(request.id, 'remote_update_identity_unverified');
        const state = native.inspect();
        if (state.identityVerified !== true || state.supportsOfficialUpdates !== true || state.parentWatchRegistered !== true) return reject(request.id, 'remote_update_identity_unverified');
        hello = true;
        result = { identityVerified: true, application };
      } else {
        if (!hello) return reject(request.id, 'remote_update_hello_required');
        if (request.operation === 'inspect') result = native.inspect();
        else if (request.operation === 'set-feed') result = native.setFeed(normalizeRemoteFeed(request.value));
        else if (request.operation === 'check') result = native.check();
        else if (request.operation === 'relaunch-after-parent-exit') result = native.armRelaunch();
        else return reject(request.id, 'remote_update_operation_unknown');
      }
      send({ id: request.id, ok: true, ...result });
    } catch (error) { reject(request.id, codeFor(error)); }
  };
  const decode = createRemoteUpdateFrameDecoder({ onRequest: handle, onError: code => reject(null, code) });
  input.on('data', chunk => {
    if (inputOpen && !decode(chunk)) { inputOpen = false; input.pause(); }
  });
  const timer = setInterval(() => {
    try {
      for (const value of native.pump()) {
        const event = remoteUpdateEvent(value);
        if (event && hello) send({ event });
      }
    } catch (error) { send({ event: { type: 'error', code: codeFor(error) } }); }
  }, 5);
  return { inspect: () => native.inspect(), input, output, timer };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startRemoteUpdateHelper();
