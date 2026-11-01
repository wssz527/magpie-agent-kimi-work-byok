// The resident side of the credential helper: a headless Electron process that
// owns one fixed bundle identity and exposes safeStorage over a private unix
// socket. It never imports the official main, opens a window, or touches the
// network, and it only ever sees synthetic request text.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const OPERATIONS = new Set(['status', 'available', 'encrypt', 'decrypt', 'shutdown']);
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);
const privateDirectory = directory => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || fs.realpathSync(directory) !== directory) {
    throw Error('remote_credentials_scope_unverified');
  }
  return directory;
};

export function readCredentialServiceConfig(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > 65536) {
    throw Error('remote_credentials_scope_unverified');
  }
  return normalizeCredentialServiceConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function normalizeCredentialServiceConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    throw Error('remote_credentials_config_invalid');
  }
  for (const key of ['root', 'application', 'socket', 'tokenFile', 'home', 'temp']) {
    if (!absolute(value[key])) throw Error('remote_credentials_config_invalid');
  }
  if (path.dirname(value.socket) !== path.resolve(value.root)
    || path.dirname(value.tokenFile) !== path.resolve(value.root)
    || path.basename(value.socket) !== 'service.sock'
    || path.basename(value.tokenFile) !== 'service.token') throw Error('remote_credentials_config_invalid');
  if (!Number.isInteger(value.idleMS) || value.idleMS < 30000 || value.idleMS > 3600000) {
    throw Error('remote_credentials_config_invalid');
  }
  return value;
}

function privateToken(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || stat.size !== 64) throw Error('remote_credentials_scope_unverified');
  const value = fs.readFileSync(file, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(value)) throw Error('remote_credentials_scope_unverified');
  return value;
}

function writePrivate(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

const newToken = () => crypto.randomBytes(32).toString('hex');
const CRASH_DUMPS = 'crash' + 'Dumps';

// Electron's `electron` module is CommonJS: a plain dynamic import resolves to
// a namespace whose default holds nothing usable. Require is the only form that
// returns `app` and `safeStorage` inside the Electron main process.
function credentialElectron() {
  const loaded = createRequire(import.meta.url)('electron');
  if (!loaded || typeof loaded !== 'object' || !loaded.app) throw Error('remote_credentials_config_invalid');
  return loaded;
}

export function credentialSocketListening(socketPath, { timeout = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      client.destroy();
      if (error) reject(error); else resolve(value);
    };
    client.once('connect', () => finish(true));
    client.once('error', error => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error?.code)) finish(false);
      else finish(undefined, Error('remote_credentials_service_conflict'));
    });
    client.setTimeout(timeout, () => finish(undefined, Error('remote_credentials_service_conflict')));
  });
}

export async function startRemoteCredentialsService(config, { electron } = {}) {
  const settings = typeof config === 'string' || config?.file !== undefined
    ? readCredentialServiceConfig(config?.file ?? config)
    : normalizeCredentialServiceConfig(config);
  const root = path.resolve(settings.root);
  privateDirectory(root);
  for (const name of ['userData', 'sessionData', CRASH_DUMPS, 'temp', 'documents', 'downloads', 'desktop', 'logs']) {
    privateDirectory(path.join(root, name));
  }

  const loaded = electron ?? credentialElectron();
  const { app, safeStorage } = loaded;
  app.setName('Kimi');
  app.setPath('userData', path.join(root, 'userData'));
  app.setPath('sessionData', path.join(root, 'userData'));
  app.setPath(CRASH_DUMPS, path.join(root, 'userData'));
  app.setPath('temp', path.join(root, 'temp'));
  app.setPath('documents', path.join(root, 'documents'));
  app.setPath('downloads', path.join(root, 'downloads'));
  app.setPath('desktop', path.join(root, 'desktop'));
  app.setAppLogsPath(path.join(root, 'logs'));
  app.setAsDefaultProtocolClient = () => false;
  app.removeAsDefaultProtocolClient = () => false;
  app.setLoginItemSettings = () => {};

  const tokenPath = path.resolve(settings.tokenFile);
  const existingToken = fs.existsSync(tokenPath) ? privateToken(tokenPath) : null;
  const statePath = path.join(root, 'service-state.json');
  const owner = crypto.randomUUID();
  const state = { schemaVersion: 1, stage: 'bootstrap', requests: 0, ok: 0, errors: 0, pid: process.pid, owner };
  let claimed = false;
  const save = (claim = false) => {
    try {
      if (!claimed && !claim) return;
      if (!claim && JSON.parse(fs.readFileSync(statePath, 'utf8'))?.owner !== owner) return;
      writePrivate(statePath, JSON.stringify(state));
    } catch {}
  };
  const describe = error => String(error?.code ?? error?.name ?? 'remote_credentials_failed').slice(0, 80);

  let server, token = existingToken, socketIdentity, finished = false, idle;
  const touch = () => { if (idle) idle.refresh(); };
  const finish = code => {
    if (finished) return;
    finished = true;
    if (idle) clearTimeout(idle);
    state.stage = 'exited';
    save();
    let ownsSocket = false;
    if (socketIdentity) {
      try {
        const stat = fs.lstatSync(path.resolve(settings.socket));
        ownsSocket = stat.isSocket() && stat.uid === process.getuid()
          && stat.dev === socketIdentity.dev && stat.ino === socketIdentity.ino;
      } catch {}
    }
    try {
      if (socketIdentity && !ownsSocket) server?.unref();
      else server?.close();
    } catch {}
    if (ownsSocket) {
      try { fs.rmSync(path.resolve(settings.socket), { force: true }); } catch {}
    }
    try { app.exit(code); } catch { process.exit(code); }
  };
  const reply = (socket, payload) => { try { socket.end(JSON.stringify(payload) + '\n'); } catch {} };
  const fail = (socket, code) => { state.errors++; save(); reply(socket, { ok: false, code }); };

  const handle = (socket, request) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || typeof request.token !== 'string' || request.token.length !== 64
      || !crypto.timingSafeEqual(Buffer.from(request.token, 'utf8'), Buffer.from(token, 'utf8'))
      || !OPERATIONS.has(request.operation)) return fail(socket, 'remote_credentials_unauthorized');
    if (request.operation === 'status') {
      return reply(socket, { ok: true, pid: process.pid, root, application: process.execPath, value: true });
    }
    if (request.operation === 'available') {
      const value = safeStorage.isEncryptionAvailable() === true;
      state.ok++; save();
      return reply(socket, { ok: true, value });
    }
    if (request.operation === 'shutdown') {
      state.ok++; save();
      reply(socket, { ok: true, value: true });
      return finish(0);
    }
    if (typeof request.value !== 'string' || request.value.length > MAX_TEXT * 2) {
      return fail(socket, 'remote_credentials_request_too_large');
    }
    try {
      const result = request.operation === 'encrypt'
        ? safeStorage.encryptString(request.value).toString('base64')
        : safeStorage.decryptString(Buffer.from(request.value, 'base64'));
      if (Buffer.byteLength(result) > MAX_TEXT * 2) return fail(socket, 'remote_credentials_request_too_large');
      state.ok++; save();
      return reply(socket, { ok: true, value: result });
    } catch { return fail(socket, 'remote_credentials_safe_storage_failed'); }
  };

  return new Promise((resolve, reject) => {
    const abort = error => {
      state.failure = describe(error);
      finish(1);
      const code = /^remote_credentials_[a-z_]{1,80}$/.test(error?.message) ? error.message : 'remote_credentials_service_failed';
      reject(Error(code));
    };
    // `ready` may already have fired while this module was being imported, so
    // whenReady is the only race-free entry point.
    Promise.resolve(app.whenReady ? app.whenReady() : new Promise(ready => app.on('ready', ready))).then(async () => {
      state.stage = 'ready';
      save();
      try {
        const socketPath = path.resolve(settings.socket);
        if (fs.existsSync(socketPath)) {
          const stat = fs.lstatSync(socketPath);
          if (!stat.isSocket() || stat.uid !== process.getuid()) throw Error('remote_credentials_service_conflict');
          if (await credentialSocketListening(socketPath)) throw Error('remote_credentials_service_conflict');
          fs.rmSync(socketPath, { force: true });
        }
        server = net.createServer(socket => {
          socket.setEncoding('utf8');
          let buffer = '';
          socket.on('data', chunk => {
            buffer += chunk;
            if (buffer.length > MAX_FRAME) { socket.destroy(); return; }
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            const line = buffer.slice(0, newline);
            buffer = '';
            touch();
            let request;
            try { request = JSON.parse(line); }
            catch { return fail(socket, 'remote_credentials_request_invalid'); }
            state.requests++;
            handle(socket, request);
          });
          socket.on('error', () => {});
        });
        server.listen(socketPath, () => {
          try {
            fs.chmodSync(socketPath, 0o600);
            const stat = fs.lstatSync(socketPath);
            if (!stat.isSocket() || stat.uid !== process.getuid()) throw Error('remote_credentials_service_conflict');
            socketIdentity = { dev: stat.dev, ino: stat.ino };
            if (!token) {
              token = newToken();
              writePrivate(tokenPath, token);
            }
            state.stage = 'listening';
            claimed = true;
            save(true);
            idle = setTimeout(() => finish(0), settings.idleMS);
            idle.unref();
            resolve({ pid: process.pid, socket: socketPath, state, close: () => finish(0) });
          } catch (error) { abort(error); }
        });
        server.on('error', abort);
        server.on('close', () => { state.stage = 'closed'; save(); });
      } catch (error) { abort(error); }
    }).catch(abort);
    app.on('window-all-closed', () => {});
    process.on('SIGTERM', () => finish(0));
    process.on('SIGINT', () => finish(0));
  });
}
