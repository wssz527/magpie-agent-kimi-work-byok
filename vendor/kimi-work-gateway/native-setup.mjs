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

export function hostsEntry() {
  return BYOK_ADDRESS + ' ' + BYOK_DOMAIN;
}

// Windows has no per-domain resolver files, and it does not need one: Kimi
// resolves the name through `dns.promises.lookup`, which reads this hosts file
// on win32, and it only checks that the answer is a private address. So the
// whole integration is two lines here — no UDP listener, no service.
//
// Only the lines this tool owns are touched. Everything else is preserved byte
// for byte (including a BOM and the original line endings), because the hosts
// file usually belongs to other software too.
export function updateHosts(content, action) {
  if (!['prepare', 'remove-dns'].includes(action)) throw Error('invalid_setup_action');
  const bom = content.startsWith('\uFEFF');
  const body = bom ? content.slice(1) : content;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const entry = hostsEntry();
  const lines = body.length ? body.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const kept = [];
  let sawEntry = false, sawMarker = false, foreign = false;
  for (let at = 0; at < lines.length; at++) {
    const trimmed = lines[at].trim();
    if (trimmed === HOSTS_MARKER) {
      sawMarker = true;
      // Our own pair is kept for `prepare` (so repeating it is a no-op) and
      // dropped for `remove-dns`, together with the entry that follows it.
      if (action === 'prepare') kept.push(lines[at]);
      if (lines[at + 1]?.trim() === entry) { sawEntry = true; if (action === 'prepare') kept.push(lines[at + 1]); at++; }
      continue;
    }
    if (trimmed === entry) {
      sawEntry = true;
      // A hand-written entry is adopted as-is by `prepare`, and is still the
      // entry this tool manages when it is removed.
      if (action === 'prepare') kept.push(lines[at]);
      continue;
    }
    // Another program already claims this name: refuse instead of shadowing it.
    if (trimmed && !trimmed.startsWith('#') && trimmed.split(/\s+/).includes(BYOK_DOMAIN)) foreign = true;
    kept.push(lines[at]);
  }

  if (foreign) throw Error('resolver_conflict');
  // Only `prepare` writes, and only when no entry exists yet.
  if (action === 'prepare' && !sawEntry) {
    if (kept.length && kept[kept.length - 1] === '') kept.pop();
    kept.push(HOSTS_MARKER, entry);
  }

  const text = kept.join(eol);
  return {
    content: (bom ? '\uFEFF' : '') + (text.length ? text + eol : ''),
    changed: action === 'prepare' ? !sawEntry : sawEntry || sawMarker,
  };
}

// Runs the edit inside an elevated PowerShell that reads the file back after
// writing it. The script mirrors `updateHosts` statement for statement, so the
// two cannot disagree about what counts as ours.
export function hostsScript(action, target = DEFAULT_HOSTS, flush = true, resultPath = null) {
  if (!['prepare', 'remove-dns'].includes(action)) throw Error('invalid_setup_action');
  const keep = action === 'prepare';
  // `Start-Process -Verb RunAs` returns neither the exit code nor stderr of the
  // elevated child, so the child writes its own verdict to a file the caller
  // reads afterwards. Without this an elevated `resolver_conflict` would be
  // indistinguishable from a crash.
  const report = resultPath ? JSON.stringify(resultPath) : null;
  const lines = [
    '$ErrorActionPreference = "Stop"',
    '$path = ' + JSON.stringify(target),
    '$marker = ' + JSON.stringify(HOSTS_MARKER),
    '$entry = ' + JSON.stringify(hostsEntry()),
    '$raw = [System.IO.File]::ReadAllText($path)',
    '$bom = $raw.StartsWith([char]0xFEFF)',
    'if ($bom) { $raw = $raw.Substring(1) }',
    '$crlf = [string][char]13 + [char]10',
    '$eol = if ($raw.Contains($crlf)) { $crlf } else { [string][char]10 }',
    // Splitting on a literal CRLF-or-LF regex; PowerShell does not expand
    // backslash escapes inside a double-quoted string, so the pattern is built
    // from character codes instead of "\\r?\\n".
    '$split = [regex]::Escape($crlf) + "|" + [string][char]10',
    '$lines = if ($raw.Length -gt 0) { [regex]::Split($raw, $split) } else { @() }',
    'if ($lines.Count -gt 0 -and $lines[$lines.Count-1] -eq "") { $lines = @($lines[0..($lines.Count-2)]) }',
    '$kept = New-Object System.Collections.ArrayList',
    '$sawEntry = $false; $foreign = $false',
    'for ($i = 0; $i -lt $lines.Count; $i++) {',
    '  $line = $lines[$i]; $trim = $line.Trim()',
    '  if ($trim -eq $marker) {',
    '    if ($i + 1 -lt $lines.Count -and $lines[$i+1].Trim() -eq $entry) {',
    '      $sawEntry = $true',
    ...(keep ? ['      [void]$kept.Add($line); [void]$kept.Add($lines[$i+1])'] : []),
    '      $i++',
    '    }',
    ...(keep ? ['    else { [void]$kept.Add($line) }'] : []),
    '    continue }',
    '  if ($trim -eq $entry) { $sawEntry = $true; ' + (keep ? '[void]$kept.Add($line)' : '') + '; continue }',
    '  if ($trim.Length -gt 0 -and -not $trim.StartsWith("#") -and ($trim -split "\\s+") -contains "' + BYOK_DOMAIN + '") { $foreign = $true }',
    '  [void]$kept.Add($line)',
    '}',
    'if ($foreign) { [Console]::Error.Write("resolver_conflict"); ' + (report
      ? 'Set-Content -LiteralPath ' + report + ' -Value "resolver_conflict" -NoNewline -Encoding utf8; ' : '')
      + 'exit 73 }',
    ...(keep
      ? ['if (-not $sawEntry) { if ($kept.Count -gt 0 -and $kept[$kept.Count-1] -eq "") { $kept.RemoveAt($kept.Count-1) }; [void]$kept.Add($marker); [void]$kept.Add($entry) }']
      : []),
    '$text = ($kept -join $eol)',
    'if ($text.Length -gt 0) { $text = $text + $eol }',
    'if ($bom) { $text = [char]0xFEFF + $text }',
    'Set-Content -LiteralPath $path -Value $text -NoNewline -Encoding utf8',
    ...(flush ? ['ipconfig /flushdns | Out-Null'] : []),
    ...(report ? ['Set-Content -LiteralPath ' + report + ' -Value "done" -NoNewline -Encoding utf8'] : []),
    'Write-Output "done"',
  ];
  return lines.filter(line => line !== '').join('\n');
}

// Interprets the elevated child's report. A missing report is not a failure:
// the child may have been cancelled at the prompt, which the caller reports as
// such. Only an explicit verdict is turned into an error.
export function verdictFailure(verdict) {
  if (!verdict || verdict === 'done') return null;
  const failure = new Error(verdict);
  failure.stderr = verdict;
  return failure;
}

async function windowsAdministrator(script, reportPath = null) {
  // A UAC prompt cannot be scripted away, so the elevated child runs a script
  // file and -Wait keeps this call blocking. The child reports its verdict
  // through a file instead of its exit code, because `Start-Process` returns
  // neither the code nor the stderr of the process it started.
  const stem = path.join(os.tmpdir(), 'kimi-work-gateway-' + process.pid + '-' + Date.now());
  const file = stem + '.ps1';
  fs.writeFileSync(file, script, { mode: 0o600 });
  try {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('
      + ["'-NoProfile'", "'-ExecutionPolicy'", "'Bypass'", "'-File'", "'" + file.replaceAll("'", "''") + "'"]
        .join(',') + ')'],
    { timeout: 180000, maxBuffer: 65536, windowsHide: true });
  } finally {
    fs.rmSync(file, { force: true });
  }
  const failure = verdictFailure(reportPath ? readReport(reportPath) : '');
  if (failure) throw failure;
  return 'done';
}

// The elevated child's report file. A missing file is not a failure: the child
// may have been cancelled at the prompt, which the caller reports as such.
function readReport(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch { return ''; }
}

// --- setup -----------------------------------------------------------------

export class NativeSetup {
  constructor({ stateDir, flagFile, platform = process.platform, admin = null,
    resolverPath = null, hostsPath = DEFAULT_HOSTS } = {}) {
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
        // The elevated child cannot return an exit code, so it writes its
        // verdict to `report` and this process reads it back.
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
        : /User cancel|user cancel|\(-128\)|operation was canceled|cancelled by the user/i.test(text) ? 'cancelled'
          : 'failed', stage);
    } finally {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    }
    atomic(receiptFile, { id: request.id, action: request.action, result: this.result, at: new Date().toISOString() });
    return this.result;
  }
}
