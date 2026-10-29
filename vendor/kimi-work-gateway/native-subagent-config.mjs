import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The desktop app owns `config.toml` and rewrites it wholesale, dropping any
// field it does not know. This module therefore never edits a foreign section:
// it appends or replaces one marker-delimited block it can prove it wrote, and
// keeps an ownership receipt beside it so a later instance can take over and a
// generator rebuild can be repaired. It only ever touches native TOML — never
// `config.json`, the installation or a credential.
export const NATIVE_SUBAGENT_BEGIN = '# BEGIN KIMI WORK GATEWAY SUBAGENTS';
export const NATIVE_SUBAGENT_END = '# END KIMI WORK GATEWAY SUBAGENTS';
export const NATIVE_SUBAGENT_RECEIPT = 'native-subagent-config-receipt.json';
export const NATIVE_CONFIG_MAX_BYTES = 8 * 1024 * 1024;

const TRANSPORT = 'native-config';
const MARKER_WORD = 'KIMI WORK GATEWAY SUBAGENTS';
const RECEIPT_MAX_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER_LINE = /^# owner=([0-9a-f-]{36}) body-sha256=([0-9a-f]{64}) added-eol=([01])$/;
const MODES = new Set(['inherit', 'blocked', 'force', 'pool']);
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
// A policy string can reach a TOML key or value, so it must stay on one line
// with no control characters at all: only plain single-line text is emitted.
const CONTROL = /[\u0000-\u001f\u007f]/;

const status = (state, extra = {}) => ({ state, transport: TRANSPORT, ...extra });
const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

function splitLines(raw) {
  const lines = [];
  let at = 0;
  for (const match of raw.matchAll(/\r\n|\n/g)) {
    lines.push({ text: raw.slice(at, match.index), eol: match[0] });
    at = match.index + match[0].length;
  }
  if (at < raw.length) lines.push({ text: raw.slice(at), eol: '' });
  return lines;
}

function stringEnd(text, at) {
  const quote = text[at];
  for (let i = at + 1; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') { i++; continue; }
    if (text[i] === quote) return i + 1;
  }
  return -1;
}

function unescapeBasic(raw) {
  let out = '';
  for (let at = 0; at < raw.length; at++) {
    const char = raw[at];
    if (char !== '\\') { out += char; continue; }
    const next = raw[++at];
    if (next === undefined) return null;
    if (next === 'b') out += '\b';
    else if (next === 't') out += '\t';
    else if (next === 'n') out += '\n';
    else if (next === 'f') out += '\f';
    else if (next === 'r') out += '\r';
    else if (next === '"') out += '"';
    else if (next === '\\') out += '\\';
    else if (next === 'u' || next === 'U') {
      const length = next === 'u' ? 4 : 8;
      const hex = raw.slice(at + 1, at + 1 + length);
      if (hex.length !== length || !/^[0-9a-fA-F]+$/.test(hex)) return null;
      const code = parseInt(hex, 16);
      if (code > 0x10ffff) return null;
      out += String.fromCodePoint(code);
      at += length;
    } else return null;
  }
  return out;
}

// Masks strings and comments with spaces so structure can be read without a
// real TOML parser. Anything the generator cannot be trusted to reproduce (a
// multi-line string, an unterminated string) is refused instead of guessed at.
function tokenizeLine(text) {
  let code = '';
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === '#') break;
    if (char === '"' || char === "'") {
      if (text.startsWith(char.repeat(3), at)) return { error: 'multiline' };
      const end = stringEnd(text, at);
      if (end < 0) return { error: 'string' };
      code += ' '.repeat(end - at);
      at = end;
      continue;
    }
    code += char;
    at++;
  }
  return { code };
}

function parseKey(text, start, end) {
  const segments = [];
  let at = start;
  while (at < end) {
    while (at < end && /\s/.test(text[at])) at++;
    if (at >= end) break;
    const quote = text[at];
    let segment;
    if (quote === '"' || quote === "'") {
      const close = stringEnd(text, at);
      if (close < 0 || close > end) return null;
      segment = quote === '"' ? unescapeBasic(text.slice(at + 1, close - 1)) : text.slice(at + 1, close - 1);
      if (segment === null) return null;
      at = close;
    } else {
      const from = at;
      while (at < end && /[A-Za-z0-9_-]/.test(text[at])) at++;
      if (at === from) return null;
      segment = text.slice(from, at);
    }
    segments.push(segment);
    while (at < end && /\s/.test(text[at])) at++;
    if (at >= end) break;
    if (text[at] !== '.') return null;
    at++;
  }
  return segments.length ? segments : null;
}

function parseHeader(text, code) {
  const lead = code.search(/\S/);
  if (lead < 0 || code[lead] !== '[') return null;
  const array = code.startsWith('[[', lead);
  const rest = code.slice(lead);
  const close = rest.lastIndexOf(array ? ']]' : ']');
  if (close < 0) return null;
  if (rest.slice(close + (array ? 2 : 1)).trim()) return null;
  return parseKey(text, lead + (array ? 2 : 1), lead + close);
}

function bracketDelta(code) {
  let depth = 0;
  for (const char of code) {
    if (char === '[') depth++;
    else if (char === ']') depth--;
    if (depth < 0) return -1;
  }
  return depth;
}

function parseValueString(text, from) {
  let at = from;
  while (at < text.length && /\s/.test(text[at])) at++;
  if (text[at] !== '"') return null;
  const end = stringEnd(text, at);
  if (end < 0) return null;
  const value = unescapeBasic(text.slice(at + 1, end - 1));
  if (value === null) return null;
  const rest = text.slice(end).trim();
  return rest && !rest.startsWith('#') ? null : value;
}

// The managed block is ours only if it still has the exact shape this module
// writes: a `[secondary_model]` section, an optional `[secondary_model.models]`
// map of single-line strings, and nothing else.
function parseBlockBody(bodyLines) {
  const out = { force: false, defaultModel: null, effort: null, aliases: [] };
  let table = null;
  for (const line of bodyLines) {
    const token = tokenizeLine(line);
    if (token.error) return null;
    const lead = line.search(/\S/);
    if (lead < 0) continue;
    if (line[lead] === '[') {
      const key = parseHeader(line, token.code);
      if (!key) return null;
      if (key.length === 1 && key[0] === 'secondary_model') { table = 'section'; continue; }
      if (key.length === 2 && key[0] === 'secondary_model' && key[1] === 'models') { table = 'models'; continue; }
      return null;
    }
    const eq = token.code.indexOf('=');
    if (eq < 0) return null;
    const key = parseKey(line, lead, eq);
    if (!key || key.length !== 1) return null;
    if (table === 'section' && key[0] === 'force') {
      if (line.slice(eq + 1).trim() !== 'true') return null;
      out.force = true;
    } else if (table === 'section' && key[0] === 'default_model') {
      out.defaultModel = parseValueString(line, eq + 1);
      if (out.defaultModel === null) return null;
    } else if (table === 'section' && key[0] === 'default_effort') {
      out.effort = parseValueString(line, eq + 1);
      if (out.effort === null) return null;
    } else if (table === 'models') {
      const value = parseValueString(line, eq + 1);
      if (value === null) return null;
      out.aliases.push(key[0]);
    } else return null;
  }
  if (!out.defaultModel) return null;
  if (out.force) return out.aliases.length ? null : { ...out, mode: 'force' };
  if (!out.aliases.length || !out.aliases.includes(out.defaultModel)) return null;
  return { ...out, mode: 'pool' };
}

function scanConfig(raw) {
  const lines = splitLines(raw);
  const out = { lines, issue: null, declared: new Set(), foreign: false, block: null };
  const begins = [], ends = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].text.trim();
    if (trimmed === NATIVE_SUBAGENT_BEGIN) begins.push(i);
    else if (trimmed === NATIVE_SUBAGENT_END) ends.push(i);
  }
  if (begins.length > 1 || ends.length > 1) return { ...out, issue: 'duplicate_block' };
  if (begins.length !== ends.length) return { ...out, issue: 'unterminated_block' };
  if (begins.length && ends[0] < begins[0]) return { ...out, issue: 'unterminated_block' };
  const start = begins[0];
  const stop = ends[0];
  // A near-miss marker outside our block is ambiguous: refuse rather than
  // scan the wrong region. Inside it, only text this module wrote lives there.
  for (let i = 0; i < lines.length; i++) {
    if (start !== undefined && i >= start && i <= stop) continue;
    if (lines[i].text.includes(MARKER_WORD)) return { ...out, issue: 'suspicious_marker' };
  }
  if (start !== undefined) {
    const owner = OWNER_LINE.exec(lines[start + 1]?.text ?? '');
    if (!owner) return { ...out, issue: 'block_modified' };
    const body = lines.slice(start + 2, stop).map(line => line.text);
    const parsed = parseBlockBody(body);
    if (!parsed || sha256(body.join('\n')) !== owner[2]) return { ...out, issue: 'block_modified' };
    // A top-level `key = value` right after the block would extend our last
    // table; a new header is safe because it ends that table.
    let header = false;
    for (let i = stop + 1; i < lines.length; i++) {
      if (header || !lines[i].text.trim() || lines[i].text.trim().startsWith('#')) continue;
      if (lines[i].text.trim().startsWith('[')) { header = true; continue; }
      return { ...out, issue: 'block_not_terminal' };
    }
    out.block = { begin: start, end: stop, ownerID: owner[1], digest: owner[2], addedEol: owner[3] === '1',
      mode: parsed.mode, aliases: parsed.mode === 'force' ? [parsed.defaultModel] : parsed.aliases };
  }
  let depth = 0;
  let table = [];
  for (let i = 0; i < lines.length; i++) {
    if (out.block && i >= out.block.begin && i <= out.block.end) continue;
    const text = lines[i].text;
    if (!text.trim() || text.trim().startsWith('#')) continue;
    const token = tokenizeLine(text);
    if (token.error) return { ...out, issue: 'unsupported_toml' };
    if (depth > 0) {
      depth += bracketDelta(token.code);
      if (depth < 0) return { ...out, issue: 'unsupported_toml' };
      continue;
    }
    const lead = text.search(/\S/);
    if (lead < 0) continue;
    if (text[lead] === '[') {
      const key = parseHeader(text, token.code);
      if (!key) return { ...out, issue: 'unsupported_toml' };
      if (key[0] === 'secondary_model') out.foreign = true;
      else if (key[0] === 'models' && key.length >= 2) { out.declared.add(key[1]); table = key; }
      else table = key;
      depth = bracketDelta(token.code);
      if (depth < 0) return { ...out, issue: 'unsupported_toml' };
      continue;
    }
    const eq = token.code.indexOf('=');
    if (eq < 0) return { ...out, issue: 'unsupported_toml' };
    const key = parseKey(text, lead, eq);
    if (!key) return { ...out, issue: 'unsupported_toml' };
    if (key[0] === 'secondary_model') out.foreign = true;
    else if (key[0] === 'models') {
      // `[models]` and `[models."alias"]` are the shapes we can read. A
      // top-level `models = ...` assignment is not, and guessing would silently
      // miss a declared alias.
      if (key.length >= 2) out.declared.add(key[1]);
      else if (table.length !== 1 || table[0] !== 'models') return { ...out, issue: 'unsupported_toml' };
    } else if (table.length === 1 && table[0] === 'models' && key.length === 1) out.declared.add(key[0]);
    depth = bracketDelta(token.code);
    if (depth < 0) return { ...out, issue: 'unsupported_toml' };
  }
  if (depth !== 0) return { ...out, issue: 'unsupported_toml' };
  return out;
}

function tomlString(value) {
  const simple = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
  return '"' + value.replace(/[\u0000-\u001f\u007f"\\]/g,
    char => simple[char] ?? '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')) + '"';
}

function validText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !CONTROL.test(value);
}

function validatePolicy(policy) {
  if (policy.mode === 'force') {
    return validText(policy.modelAlias)
      && (policy.effort === undefined || (typeof policy.effort === 'string' && EFFORT.test(policy.effort)));
  }
  if (policy.mode !== 'pool' || !validText(policy.modelAlias)) return false;
  if (!Array.isArray(policy.models) || !policy.models.length || policy.models.length > 32) return false;
  const seen = new Set();
  for (const row of policy.models) {
    if (!row || typeof row !== 'object' || !validText(row.modelAlias) || seen.has(row.modelAlias)) return false;
    if (typeof row.description !== 'string' || row.description.length > 1000 || CONTROL.test(row.description)) {
      return false;
    }
    // The marker word may only ever appear in the lines this module writes.
    if (row.description.includes(MARKER_WORD) || row.modelAlias.includes(MARKER_WORD)) return false;
    seen.add(row.modelAlias);
  }
  return seen.has(policy.modelAlias);
}

function renderBlock(policy) {
  const body = policy.mode === 'force'
    ? ['[secondary_model]', 'force = true', 'default_model = ' + tomlString(policy.modelAlias),
      ...(policy.effort === undefined ? [] : ['default_effort = ' + tomlString(policy.effort)])]
    : ['[secondary_model]', 'default_model = ' + tomlString(policy.modelAlias), '[secondary_model.models]',
      ...policy.models.map(row => tomlString(row.modelAlias) + ' = ' + tomlString(row.description))];
  return { body, digest: sha256(body.join('\n')) };
}

function managedLines(body, ownerID, addedEol) {
  return [NATIVE_SUBAGENT_BEGIN,
    '# owner=' + ownerID + ' body-sha256=' + sha256(body.join('\n')) + ' added-eol=' + (addedEol ? '1' : '0'),
    ...body, NATIVE_SUBAGENT_END];
}

function withBlock(snapshot, body, ownerID, eol) {
  const lines = snapshot.scan.lines.map(line => ({ ...line }));
  const block = snapshot.scan.block;
  if (block) {
    const text = managedLines(body, ownerID, block.addedEol);
    const closing = lines[block.end].eol;
    const rendered = text.map((line, index) => ({ text: line, eol: index === text.length - 1 ? closing : eol }));
    return { text: [...lines.slice(0, block.begin), ...rendered, ...lines.slice(block.end + 1)]
      .map(line => line.text + line.eol).join(''), addedEol: block.addedEol };
  }
  // Appending needs one separator newline when the file does not end with one;
  // the block records that so removal can restore the original bytes.
  const addedEol = !snapshot.raw.endsWith('\n');
  const text = managedLines(body, ownerID, addedEol);
  if (addedEol && lines.length) lines[lines.length - 1].eol = eol;
  const trailing = addedEol ? '' : eol;
  const rendered = text.map((line, index) => ({ text: line, eol: index === text.length - 1 ? trailing : eol }));
  return { text: [...lines, ...rendered].map(line => line.text + line.eol).join(''), addedEol };
}

function blockRange(snapshot) {
  const { lines, block } = snapshot.scan;
  let start = 0, end = 0;
  for (let i = 0; i <= block.end; i++) {
    const size = lines[i].text.length + lines[i].eol.length;
    if (i < block.begin) start += size;
    end += size;
  }
  return { start, end };
}

// Removing the block restores the surrounding bytes exactly: the only newline
// this module ever adds to the original text is the separator before an
// appended block, and the block records whether it had to.
function withoutBlock(snapshot) {
  const { start, end } = blockRange(snapshot);
  let head = snapshot.raw.slice(0, start);
  const tail = snapshot.raw.slice(end);
  if (!tail && snapshot.scan.block.addedEol) head = head.replace(/\r\n$|\n$/, '');
  return head + tail;
}

export class NativeSubagentConfig {
  constructor({ stateDir, kimiDir } = {}) {
    this.stateDir = path.resolve(stateDir);
    this.kimiDir = path.resolve(kimiDir);
    this.homeDir = path.join(this.kimiDir, 'runtime', 'kimi-code', 'home');
    this.configPath = path.resolve(kimiDir, 'runtime', 'kimi-code', 'home', 'config.toml');
    this.receiptPath = path.join(this.stateDir, NATIVE_SUBAGENT_RECEIPT);
    // Only the directories this module composes are checked, so an unrelated
    // symlink far above the user's home cannot veto the whole feature.
    this.ancestors = [this.kimiDir, path.join(this.kimiDir, 'runtime'),
      path.join(this.kimiDir, 'runtime', 'kimi-code'), this.homeDir];
    this.ownerID = crypto.randomUUID();
  }

  // --- reads ---------------------------------------------------------------

  guardPaths() {
    for (const dir of this.ancestors) {
      let stat;
      try { stat = fs.lstatSync(dir); } catch (error) {
        return error.code === 'ENOENT' ? 'config_missing' : 'path_unavailable';
      }
      if (stat.isSymbolicLink()) return 'path_symlink';
      if (!stat.isDirectory()) return 'path_not_directory';
    }
    let stat;
    try { stat = fs.lstatSync(this.configPath); } catch (error) {
      return error.code === 'ENOENT' ? 'config_missing' : 'config_unavailable';
    }
    if (stat.isSymbolicLink()) return 'config_symlink';
    if (!stat.isFile()) return 'config_not_file';
    if (stat.size > NATIVE_CONFIG_MAX_BYTES) return 'config_too_large';
    return null;
  }

  readReceipt() {
    let stat;
    try { stat = fs.lstatSync(this.receiptPath); } catch { return { kind: 'absent' }; }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > RECEIPT_MAX_BYTES) return { kind: 'unsafe' };
    let raw;
    try { raw = fs.readFileSync(this.receiptPath, 'utf8'); } catch { return { kind: 'unsafe' }; }
    let value;
    try { value = JSON.parse(raw); } catch { return { kind: 'corrupt' }; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
      || typeof value.ownerID !== 'string' || !UUID.test(value.ownerID)
      || typeof value.homeDir !== 'string' || typeof value.managed !== 'string'
      || value.managed.length > RECEIPT_MAX_BYTES || !/^[a-f0-9]{64}$/.test(value.blockHash)) {
      return { kind: 'corrupt' };
    }
    return { kind: 'valid', raw, value };
  }

  snapshot() {
    const issue = this.guardPaths();
    if (issue) return { issue, receipt: this.readReceipt() };
    let raw;
    try { raw = fs.readFileSync(this.configPath, 'utf8'); } catch (error) {
      return { issue: error.code === 'ENOENT' ? 'config_missing' : 'config_unavailable', receipt: this.readReceipt() };
    }
    const scan = scanConfig(raw);
    if (scan.issue) return { issue: scan.issue };
    if (scan.foreign) return { issue: 'foreign_secondary_model' };
    return { raw, scan, eol: raw.includes('\r\n') ? '\r\n' : '\n', receipt: this.readReceipt() };
  }

  // Who owns the block on disk, and may this instance act on it?
  //
  // - `ours`: the block names this instance.
  // - `superseded`: a valid receipt says a newer instance wrote it, so this
  //   instance may replace it but must never delete it.
  // - `adoptable`: the block is structurally ours (markers, owner line and body
  //   hash all verify) but its receipt is gone or corrupt. It is taken over on
  //   the next write; a block that cannot be verified is never touched.
  // - `owner_conflict`: a receipt and the block disagree, or the receipt names
  //   another Kimi home. Nothing is written.
  ownership(snapshot) {
    const block = snapshot.scan.block;
    if (!block) return { kind: 'none' };
    const receipt = snapshot.receipt;
    if (receipt.kind !== 'valid') return { kind: 'adoptable' };
    if (receipt.value.homeDir !== this.homeDir) return { issue: 'owner_conflict' };
    if (receipt.value.ownerID !== block.ownerID || receipt.value.blockHash !== block.digest) {
      const previous = receipt.value.previous;
      if (previous?.ownerID === block.ownerID && previous.blockHash === block.digest) {
        return { kind: this.ownerID === previous.ownerID ? 'superseded' : 'recoverable' };
      }
      return { issue: 'owner_conflict' };
    }
    return { kind: block.ownerID === this.ownerID ? 'ours' : 'superseded' };
  }

  // --- writes --------------------------------------------------------------

  writeReceipt(value) {
    try { fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 }); } catch { return 'receipt_conflict'; }
    let stat;
    try { stat = fs.lstatSync(this.stateDir); } catch { return 'receipt_conflict'; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'receipt_conflict';
    try {
      const current = fs.lstatSync(this.receiptPath);
      if (current.isSymbolicLink() || !current.isFile()) return 'receipt_conflict';
    } catch (error) { if (error.code !== 'ENOENT') return 'receipt_conflict'; }
    const temporary = this.receiptPath + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.receiptPath);
      return null;
    } catch { return 'receipt_conflict'; } finally { fs.rmSync(temporary, { force: true }); }
  }

  removeReceipt() {
    try {
      const stat = fs.lstatSync(this.receiptPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return;
      fs.rmSync(this.receiptPath);
    } catch {}
  }

  // Rewrites the whole file atomically, but only after re-reading it: a write
  // that raced with the desktop generator or a text editor is refused.
  commit(snapshot, next) {
    let current;
    try { current = fs.readFileSync(this.configPath, 'utf8'); } catch (error) {
      return error.code === 'ENOENT' ? 'config_missing' : 'config_unavailable';
    }
    if (current !== snapshot.raw) return 'concurrent_modification';
    let mode = 0o600;
    try { mode = fs.statSync(this.configPath).mode & 0o777; } catch {}
    const temporary = this.configPath + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, next, { mode, flag: 'wx' });
      fs.renameSync(temporary, this.configPath);
      this.generation = (this.generation || 0) + 1;
      return null;
    } catch { return 'write_failed'; } finally { fs.rmSync(temporary, { force: true }); }
  }

  releaseOwnedReceipt(snapshot) {
    const receipt = snapshot.receipt;
    if (receipt.kind === 'valid' && receipt.value.ownerID === this.ownerID) this.removeReceipt();
  }

  // Undo the block. A block a newer instance holds is left in place so an old
  // process cannot erase the newer policy. A structurally valid block whose
  // receipt was lost or corrupt cannot be attributed either, so it is kept: a
  // rewrite may adopt it, but a disable may not delete it.
  revoke(snapshot, owned) {
    if (owned.kind === 'none') { this.releaseOwnedReceipt(snapshot); return {}; }
    if (owned.kind === 'superseded') return { superseded: true };
    if (owned.kind === 'adoptable') return { issue: 'receipt_unverified' };
    const failure = this.commit(snapshot, withoutBlock(snapshot));
    if (failure) return { issue: failure };
    this.releaseOwnedReceipt(snapshot);
    return {};
  }

  // --- public surface ------------------------------------------------------

  update(policy) {
    const mode = policy?.mode;
    if (!policy || typeof policy !== 'object' || !MODES.has(mode)) return status('conflict', { reason: 'invalid_policy' });
    if ((mode === 'force' || mode === 'pool') && !validatePolicy(policy)) {
      return status('conflict', { reason: 'invalid_policy', mode });
    }
    const snapshot = this.snapshot();
    if (snapshot.issue) {
      if (snapshot.issue === 'config_missing' && (mode === 'inherit' || mode === 'blocked')) {
        this.releaseOwnedReceipt(snapshot);
        return status(mode, { mode });
      }
      return status(snapshot.issue === 'config_missing' ? 'waiting-config' : 'conflict',
        { reason: snapshot.issue, mode });
    }
    const owned = this.ownership(snapshot);
    if (owned.issue) return status('conflict', { reason: owned.issue, mode });
    if (mode === 'inherit' || mode === 'blocked') {
      const result = this.revoke(snapshot, owned);
      if (result.issue) return status('conflict', { reason: result.issue, mode });
      // A block a newer instance still holds keeps its policy: this instance
      // must not report the requested mode as if it had taken effect.
      if (result.superseded) return status('conflict', { reason: 'ownership_superseded', mode });
      return status(mode, { mode });
    }
    const aliases = mode === 'force' ? [policy.modelAlias] : [...new Set(policy.models.map(row => row.modelAlias))];
    if (!aliases.every(alias => snapshot.scan.declared.has(alias))) {
      // A block naming an undeclared model would make the kernel's own section
      // invalid, so ours is dropped and the policy waits for the models.
      const result = this.revoke(snapshot, owned);
      if (result.issue) return status('conflict', { reason: result.issue, mode });
      if (result.superseded) return status('conflict', { reason: 'ownership_superseded', mode });
      return status('waiting-config', { reason: 'models_missing', mode });
    }
    const block = renderBlock(policy);
    const rendered = withBlock(snapshot, block.body, this.ownerID, snapshot.eol);
    const receipt = { schemaVersion: 1, ownerID: this.ownerID, homeDir: this.homeDir, blockHash: block.digest,
      managed: managedLines(block.body, this.ownerID, rendered.addedEol).join('\n'), mode,
      ...(snapshot.scan.block && rendered.text !== snapshot.raw ? { previous: {
        ownerID: snapshot.scan.block.ownerID, blockHash: snapshot.scan.block.digest } } : {}) };
    const previous = snapshot.receipt.kind === 'valid' ? snapshot.receipt.raw : undefined;
    const receiptFailure = this.writeReceipt(receipt);
    if (receiptFailure) return status('conflict', { reason: receiptFailure, mode });
    if (rendered.text !== snapshot.raw) {
      const failure = this.commit(snapshot, rendered.text);
      if (failure) {
        // Ownership must not outlive a failed apply, so the old receipt returns.
        if (previous === undefined) this.removeReceipt(); else this.writeReceipt(JSON.parse(previous));
        return status(failure === 'config_missing' ? 'waiting-config' : 'conflict', { reason: failure, mode });
      }
    }
    return status('file-applied', { mode });
  }

  inspect() {
    const snapshot = this.snapshot();
    if (snapshot.issue) {
      return status(snapshot.issue === 'config_missing' ? 'waiting-config' : 'conflict', { reason: snapshot.issue });
    }
    const owned = this.ownership(snapshot);
    if (owned.issue) return status('conflict', { reason: owned.issue });
    if (owned.kind === 'none') {
      return snapshot.receipt.kind === 'valid' && snapshot.receipt.value.ownerID === this.ownerID
        ? status('waiting-config', { reason: 'managed_block_missing' }) : status('inherit');
    }
    if (owned.kind === 'recoverable') return status('waiting-config', { reason: 'handoff_pending' });
    const block = snapshot.scan.block;
    if (!block.aliases.every(alias => snapshot.scan.declared.has(alias))) {
      return status('waiting-config', { reason: 'models_missing', mode: block.mode });
    }
    return status('file-applied', { mode: block.mode });
  }

  close() {
    const snapshot = this.snapshot();
    if (snapshot.issue) {
      if (snapshot.issue === 'config_missing') {
        this.releaseOwnedReceipt(snapshot);
        return status('restored');
      }
      return status('conflict', { reason: snapshot.issue });
    }
    const owned = this.ownership(snapshot);
    if (owned.issue) return status('conflict', { reason: owned.issue });
    if (owned.kind === 'none') {
      if (snapshot.receipt.kind === 'valid' && snapshot.receipt.value.ownerID === this.ownerID) {
        this.removeReceipt();
        return status('restored');
      }
      return status('inherit', { reason: 'no_managed_block' });
    }
    // Never erase a block another instance is holding.
    if (owned.kind === 'superseded') return status('inherit', { reason: 'ownership_superseded' });
    // Nor one whose receipt is gone or corrupt: it cannot be attributed.
    if (owned.kind === 'adoptable') return status('conflict', { reason: 'receipt_unverified' });
    const failure = this.commit(snapshot, withoutBlock(snapshot));
    if (failure) return status('conflict', { reason: failure });
    this.releaseOwnedReceipt(snapshot);
    // A closed instance no longer claims the owner id, so a later close of the
    // same object cannot delete a block a new instance wrote.
    this.ownerID = crypto.randomUUID();
    return status('restored');
  }
}
