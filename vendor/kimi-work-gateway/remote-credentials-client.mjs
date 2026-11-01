// Narrow client: reads one request frame from stdin, sends it to the private
// credential socket, prints one response frame to stdout. Values only ever
// travel through the two streams; nothing is read from argv, env or files
// beyond the 0600 token file the request names.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_INPUT = 3 * 1024 * 1024;
const OPERATIONS = new Set(['status', 'available', 'encrypt', 'decrypt', 'shutdown']);

const emit = payload => { process.stdout.write(JSON.stringify(payload) + '\n'); };
const fail = code => { emit({ ok: false, code }); process.exitCode = 1; };

const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);

function privateToken(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || stat.size !== 64) throw Error('remote_credentials_scope_unverified');
  const value = fs.readFileSync(file, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(value)) throw Error('remote_credentials_scope_unverified');
  return value;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > MAX_INPUT) { fail('remote_credentials_request_too_large'); process.stdin.destroy(); }
});
process.stdin.on('end', () => {
  let request;
  try { request = JSON.parse(input.trim()); }
  catch { return fail('remote_credentials_request_invalid'); }
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || !absolute(request.socket) || !absolute(request.tokenFile)
    || !OPERATIONS.has(request.operation)) return fail('remote_credentials_request_invalid');
  if (request.operation === 'encrypt' || request.operation === 'decrypt') {
    if (typeof request.value !== 'string' || request.value.length > MAX_INPUT) {
      return fail('remote_credentials_request_too_large');
    }
  } else if (request.value !== undefined) return fail('remote_credentials_request_invalid');

  let token;
  try { token = privateToken(request.tokenFile); }
  catch { return fail('remote_credentials_scope_unverified'); }

  let buffer = '';
  let settled = false;
  const socket = net.createConnection(request.socket);
  const finish = payload => {
    if (settled) return;
    settled = true;
    try { socket.destroy(); } catch {}
    emit(payload);
  };
  socket.setEncoding('utf8');
  socket.setTimeout(30000, () => finish({ ok: false, code: 'remote_credentials_timeout' }));
  socket.on('connect', () => {
    const frame = JSON.stringify({ operation: request.operation,
      ...(request.value === undefined ? {} : { value: request.value }), token }) + '\n';
    if (frame.length > MAX_FRAME) return finish({ ok: false, code: 'remote_credentials_request_too_large' });
    socket.write(frame);
  });
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_FRAME) return finish({ ok: false, code: 'remote_credentials_response_too_large' });
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    let response;
    try { response = JSON.parse(buffer.slice(0, newline)); }
    catch { return finish({ ok: false, code: 'remote_credentials_response_invalid' }); }
    finish(response);
  });
  socket.on('error', () => finish({ ok: false, code: 'remote_credentials_unavailable' }));
});
process.stdin.on('error', () => fail('remote_credentials_request_invalid'));
