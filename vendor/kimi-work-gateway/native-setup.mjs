import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolverConfiguration, BYOK_DOMAIN, BYOK_ADDRESS } from './native-dns.mjs';

const execute = promisify(execFile);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const atomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
};

export const HOSTS_MARKER = '# kimi-work-gateway native BYOK';
export const DEFAULT_HOSTS = 'C:\\Windows\\System32\\drivers\\etc\\hosts';

// --- macOS -----------------------------------------------------------------

// Kept byte for byte as it has always been: an installed resolver is compared
// against this text before it is replaced or removed, so changing even a space
// would strand every earlier installation behind a conflict.
export function resolverScript(action, source, target = '/etc/resolver/' + BYOK_DOMAIN, flush = true) {
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

// --- Windows ---------------------------------------------------------------

export function defaultHostsPath(env = process.env) {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
}

export function hostsEntry() {
  return BYOK_ADDRESS + ' ' + BYOK_DOMAIN;
}

export function updateHosts(content, action) {
  if (!['prepare', 'remove-dns'].includes(action)) throw Error('invalid_setup_action');
  const binary = Buffer.isBuffer(content);
  const original = binary ? content.toString('latin1') : content;
  if (typeof original !== 'string' || original.includes('\0')) throw Error('unsupported_hosts_encoding');
  const marker = binary ? '\xEF\xBB\xBF' : '\uFEFF';
  const prefix = original.startsWith(marker) ? marker : '';
  const body = original.slice(prefix.length);
  const eol = /\r\n|\r|\n/.exec(body)?.[0] || '\r\n';
  const lines = (body.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || []).filter(Boolean);
  const kept = [];
  let sawEntry = false;
  for (let at = 0; at < lines.length; at++) {
    const trimmed = lines[at].trim();
    if (trimmed === HOSTS_MARKER) {
      if (lines[at + 1]?.trim() !== hostsEntry()) throw Error('resolver_conflict');
      sawEntry = true;
      if (action === 'prepare') kept.push(lines[at], lines[at + 1]);
      at++;
      continue;
    }
    const [address, ...names] = lines[at].split('#')[0].trim().split(/\s+/);
    if (names.some(name => name.toLowerCase() === BYOK_DOMAIN)) {
      if (address !== BYOK_ADDRESS || names.length !== 1) throw Error('resolver_conflict');
      sawEntry = true;
    }
    kept.push(lines[at]);
  }
  // Prefixing the owned pair keeps the original EOF and makes removal reversible.
  const result = action === 'prepare' && !sawEntry
    ? prefix + HOSTS_MARKER + eol + hostsEntry() + eol + body
    : prefix + kept.join('');
  return { content: binary ? Buffer.from(result, 'latin1') : result, changed: result !== original };
}

const powershellLiteral = value => "'" + String(value).replaceAll("'", "''") + "'";

export function hostsScript(action, target = defaultHostsPath(), flush = true, resultPath = null) {
  if (!['prepare', 'remove-dns'].includes(action)) throw Error('invalid_setup_action');
  const keep = action === 'prepare';
  return [
    '$ErrorActionPreference = "Stop"',
    '$path = ' + powershellLiteral(target),
    '$report = ' + (resultPath ? powershellLiteral(resultPath) : '$null'),
    '$marker = ' + powershellLiteral(HOSTS_MARKER),
    '$entry = ' + powershellLiteral(hostsEntry()),
    'function Write-Verdict([string]$value) {',
    '  if ($report) { [System.IO.File]::WriteAllText($report, $value, (New-Object System.Text.UTF8Encoding($false))) }',
    '}',
    'try {',
    '  if (([System.IO.File]::GetAttributes($path) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "resolver_conflict" }',
    '  $bytes = [System.IO.File]::ReadAllBytes($path)',
    '  if ($bytes -contains [byte]0) { throw "unsupported_hosts_encoding" }',
    '  $encoding = [System.Text.Encoding]::GetEncoding(28591)',
    '  $raw = $encoding.GetString($bytes)',
    '  $bom = $encoding.GetString([byte[]]@(239,187,191))',
    '  $prefix = if ($raw.StartsWith($bom)) { $bom } else { "" }',
    '  $body = $raw.Substring($prefix.Length)',
    String.raw`  $eol = [regex]::Match($body, '\r\n|\r|\n').Value`,
    '  if (-not $eol) { $eol = [string][char]13 + [char]10 }',
    String.raw`  $lines = @([regex]::Matches($body, '[^\r\n]*(?:\r\n|\r|\n|$)') | Where-Object { $_.Length -gt 0 } | ForEach-Object { $_.Value })`,
    '  $kept = New-Object System.Collections.ArrayList',
    '  $sawEntry = $false',
    '  for ($i = 0; $i -lt $lines.Count; $i++) {',
    '    $line = $lines[$i]',
    '    if ($line.Trim() -ceq $marker) {',
    '      if ($i + 1 -ge $lines.Count -or $lines[$i+1].Trim() -cne $entry) { throw "resolver_conflict" }',
    '      $sawEntry = $true',
    ...(keep ? ['      [void]$kept.Add($line); [void]$kept.Add($lines[$i+1])'] : []),
    '      $i++; continue',
    '    }',
    String.raw`    $tokens = @($line.Split('#')[0].Trim() -split '\s+')`,
    '    if ($tokens.Count -gt 1) {',
    '      $names = @($tokens[1..($tokens.Count-1)])',
    '      if ($names -contains ' + powershellLiteral(BYOK_DOMAIN) + ') {',
    '        if ($tokens[0] -ne ' + powershellLiteral(BYOK_ADDRESS) + ' -or $names.Count -ne 1) { throw "resolver_conflict" }',
    '        $sawEntry = $true',
    '      }',
    '    }',
    '    [void]$kept.Add($line)',
    '  }',
    '  $text = $prefix + ($kept -join "")',
    ...(keep ? ['  if (-not $sawEntry) { $text = $prefix + $marker + $eol + $entry + $eol + $body }'] : []),
    '  $next = $encoding.GetBytes($text)',
    '  $before = [Convert]::ToBase64String($bytes)',
    '  $expected = [Convert]::ToBase64String($next)',
    '  if ($expected -cne $before) {',
    '    if ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($path)) -cne $before) { throw "resolver_conflict" }',
    '    [System.IO.File]::WriteAllBytes($path, $next)',
    '  }',
    '  if ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($path)) -cne $expected) { throw "hosts_verify_failed" }',
    ...(flush ? ['  ipconfig /flushdns | Out-Null', '  if ($LASTEXITCODE -ne 0) { throw "dns_flush_failed" }'] : []),
    '  Write-Verdict "done"',
    '  Write-Output "done"',
    '  exit 0',
    '} catch {',
    '  $verdict = if ($_.Exception.Message -in @("resolver_conflict", "unsupported_hosts_encoding", "hosts_verify_failed", "dns_flush_failed")) { $_.Exception.Message } else { "hosts_edit_failed" }',
    '  [Console]::Error.Write($verdict)',
    '  try { Write-Verdict $verdict } catch {}',
    '  if ($verdict -eq "resolver_conflict") { exit 73 }',
    '  exit 1',
    '}',
  ].join('\n');
}

export function verdictFailure(verdict) {
  if (verdict === 'done') return null;
  const failure = new Error(verdict || 'setup_report_missing');
  failure.stderr = failure.message;
  return failure;
}

export function elevationCommand(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    '  $child = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @(',
    "    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '" + encoded + "')",
    '  exit $child.ExitCode',
    '} catch {',
    '  $failure = $_.Exception',
    '  while ($failure -and $failure.NativeErrorCode -ne 1223) { $failure = $failure.InnerException }',
    '  if ($failure) { [Console]::Error.Write("setup_cancelled"); exit 1 }',
    '  [Console]::Error.Write("elevation_failed"); exit 1',
    '}',
  ].join('\n');
}

export async function windowsAdministrator(script, reportPath = null, executeImpl = execute) {
  let childFailure;
  try {
    await executeImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(elevationCommand(script), 'utf16le').toString('base64')],
    { timeout: 180000, maxBuffer: 65536, windowsHide: true });
  } catch (failure) { childFailure = failure; }
  const verdict = reportPath ? readReport(reportPath) : '';
  if (childFailure) {
    if (String(childFailure.stderr).includes('setup_cancelled')) throw Error('setup_cancelled');
    if (verdict && verdict !== 'done') throw verdictFailure(verdict);
    throw childFailure;
  }
  const failure = verdictFailure(verdict);
  if (failure) throw failure;
  return 'done';
}

function readReport(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch { return ''; }
}

// --- setup -----------------------------------------------------------------

export class NativeSetup {
  constructor({ stateDir, flagFile, platform = process.platform, admin = null,
    resolverPath = null, hostsPath = defaultHostsPath() } = {}) {
    Object.assign(this, {
      stateDir, flagFile, platform, hostsPath,
      resolverPath: resolverPath || '/etc/resolver/' + BYOK_DOMAIN,
      admin: admin || (platform === 'win32' ? windowsAdministrator : administrator),
    });
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
    if (!['darwin', 'win32'].includes(this.platform)) return finish('unsupported-platform');
    const receiptFile = path.join(this.stateDir, 'native-setup-receipt.json');
    try {
      const previous = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      if (previous.id === request.id) return this.result = previous.result || finish('interrupted');
    } catch {}
    let temporary;
    let stage = 'validate';
    try {
      const configuration = this.platform === 'darwin'
        ? resolverConfiguration(port, this.resolverPath)
        : { path: this.hostsPath, content: '' };
      if (request.action === 'prepare') {
        if (!fs.statSync(path.dirname(path.dirname(this.flagFile))).isDirectory()) throw Error('kimi_data_missing');
        this.flagValue();
      }
      atomic(receiptFile, { id: request.id, action: request.action, state: 'running' });
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-work-gateway-'));
      const source = path.join(temporary, 'resolver');
      fs.writeFileSync(source, configuration.content, { mode: 0o600 });
      stage = 'dns';
      finish('running', stage);
      if (this.platform === 'win32') {
        const report = path.join(temporary, 'report');
        await this.admin(hostsScript(request.action, configuration.path, true, report), report);
      } else {
        await this.admin(resolverScript(request.action, source, configuration.path));
      }
      if (request.action === 'prepare') {
        stage = 'reveal';
        const value = this.flagValue();
        atomic(this.flagFile, value);
      }
      finish('done');
    } catch (failure) {
      const text = String(failure.stderr || failure.message || '');
      finish(text.includes('resolver_conflict') ? 'resolver-conflict'
        : /setup_cancelled|User cancel|user cancel|\(-128\)|operation was canceled|cancelled by the user/i.test(text) ? 'cancelled'
          : 'failed', stage);
    } finally {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    }
    atomic(receiptFile, { id: request.id, action: request.action, result: this.result, at: new Date().toISOString() });
    return this.result;
  }
}
