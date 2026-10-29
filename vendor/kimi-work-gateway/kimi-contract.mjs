// Reads the installed Kimi desktop bundle to answer one question: does the
// catalog this package generates still import cleanly?
//
// The bundle is obfuscated and every release renames its symbols, so nothing
// here may depend on a name. The table function, the string decoder and the
// catalog parser are located by shape instead:
//
//   table    the symbol used by the bootstrap IIFE `})(NAME, <number>)` whose
//            function body returns a large string array
//   decoder  `function f(a, b) { a = a - <number>; ... }`
//   parser   the function whose decoded body mentions `skippedModels` and
//            `family`
//
// Everything here is best effort. A bundle this cannot read is reported as
// `unverified`, which is not a failure: the gateway only emits the documented
// `api.json` shape and never patches Kimi, so a probe that cannot run says
// nothing about whether the integration still works.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { nativeCatalog, validateModels } from './gateway.mjs';

export const KIMI_ENTRY = 'out/main/index.js';
export const DEFAULT_ARCHIVE = '/Applications/Kimi.app/Contents/Resources/app.asar';
export const ARCHIVE_BY_PLATFORM = {
  darwin: DEFAULT_ARCHIVE,
  win32: 'C:\\Program Files\\Kimi\\resources\\app.asar',
};

// Source-text observations only: obfuscated builds can hide these strings.
const RUNTIME_MARKERS = {
  'byok-availability.json': 'native_byok_flag',
  'byok-providers.json': 'native_profile_store',
  'models/api.json': 'native_catalog_route',
  'skippedModels': 'catalog_parser',
};

const SAMPLE_MODELS = [
  { id: 'kimi-probe-model', name: 'Kimi Probe', protocol: 'chat', contextWindow: 131072,
    maxOutputTokens: 8192, tools: true, reasoning: true, inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'high'], defaultEffort: 'high' },
  { id: 'group/kimi-probe-nested', protocol: 'chat', contextWindow: 65536, tools: true },
  { id: 'gpt-probe-model', protocol: 'responses', contextWindow: 262144, maxOutputTokens: 16384,
    tools: true, reasoning: true, inputModalities: ['text', 'image'] },
  { id: 'group/generic-probe-model', protocol: 'responses', contextWindow: 32768, tools: true },
  { id: 'plain-probe-id', protocol: 'responses', contextWindow: 8192 },
];

export function probeModels() {
  return validateModels(SAMPLE_MODELS);
}

// --- asar ------------------------------------------------------------------

export function readAsarEntry(file, entryPath = KIMI_ENTRY) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const head = Buffer.alloc(16);
    if (fs.readSync(handle, head, 0, 16, 0) !== 16) throw Error('asar_truncated');
    const jsonSize = head.readUInt32LE(12);
    if (jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) throw Error('asar_header_invalid');
    const json = Buffer.alloc(jsonSize);
    if (fs.readSync(handle, json, 0, jsonSize, 16) !== jsonSize) throw Error('asar_truncated');
    const base = 8 + head.readUInt32LE(4);
    let node = JSON.parse(json.toString('utf8'));
    for (const part of entryPath.split('/')) node = node?.files?.[part];
    if (!node || node.size === undefined) throw Error('asar_entry_missing');
    const size = Number(node.size), offset = Number(node.offset);
    if (!Number.isSafeInteger(size) || size <= 0) throw Error('asar_entry_invalid');
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const got = fs.readSync(handle, buffer, read, size - read, base + offset + read);
      if (!got) throw Error('asar_truncated');
      read += got;
    }
    return buffer.toString('utf8');
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

export function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function installedVersion(archiveFile) {
  try {
    const version = JSON.parse(readAsarEntry(archiveFile, 'package.json')).version;
    if (typeof version === 'string' && version.length <= 128) return version;
  } catch {}
  try {
    const plist = fs.readFileSync(path.join(path.dirname(path.dirname(archiveFile)), 'Info.plist'));
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist.toString('utf8'))?.[1] ?? null;
  } catch { return null; }
}

// --- shape discovery -------------------------------------------------------

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Skips a quoted literal in place. Regex literals are deliberately not
// modelled: the bundle's ordinary functions are short and delimited by
// `\n}`, so this scan is only used where a literal could hide a brace.
function skipString(text, at) {
  const quote = text[at];
  for (at++; at < text.length; at++) {
    if (text[at] === '\\') { at++; continue; }
    if (text[at] === quote) return at;
  }
  return text.length;
}

function functionBody(text, name) {
  const at = text.search(new RegExp('function ' + escape(name) + '\\([^)]*\\) \\{'));
  if (at < 0) return null;
  const end = text.indexOf('\n}', at);
  return end < 0 ? null : text.slice(at, end + 2);
}

// The string table holds megabytes of quoted text, so a `\n}` search finds a
// closing brace inside a literal long before the function ends. Walking the
// array with string awareness keeps the scan inside the declaration.
function arrayEnd(text, open) {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    const character = text[at];
    if (character === '"' || character === "'" || character === '`') { at = skipString(text, at); continue; }
    if (character === '[') depth++;
    else if (character === ']') { depth--; if (depth === 0) return at; }
  }
  return -1;
}

// Closes the function body that contains an already-open brace, starting just
// past the string array. Only literals are skipped: the tail of a table
// function is a couple of assignments, and anything this cannot read reports
// `unverified` instead of silently widening the slice.
function tailEnd(text, from) {
  let depth = 1;
  for (let at = from; at < text.length; at++) {
    const character = text[at];
    if (character === '"' || character === "'" || character === '`') { at = skipString(text, at); continue; }
    if (character === '{') depth++;
    else if (character === '}') { depth--; if (depth === 0) return at; }
  }
  return -1;
}

// A table function declares one large array and returns it. Its body is found
// by jumping over that array rather than by the first `\n}`.
//
// This deliberately reads one shape: a `const NAME = [` array within the first
// few kilobytes of the function. A future obfuscator that declares the table
// differently makes this return null, and `compat` then reports `unverified`
// rather than guessing — the safe direction for a probe that must never
// certify a build it could not read.
function tableBodyOf(text, name) {
  const at = text.search(new RegExp('function ' + escape(name) + '\\([^)]*\\) \\{'));
  if (at < 0) return null;
  // The declaration is the first statement of the function, so the window is
  // cut at the next `\n}` or `\nfunction` as well as at a fixed length: reading
  // past those would let a neighbour's array be mistaken for this one.
  let head = text.slice(at, at + 4096);
  for (const boundary of ['\n}', '\nfunction ']) {
    const cut = head.indexOf(boundary);
    if (cut >= 0) head = head.slice(0, cut);
  }
  const declaration = /const _0x[0-9a-f]+ = \[/.exec(head);
  if (!declaration) return null;
  const close = arrayEnd(text, at + declaration.index + declaration[0].length - 1);
  if (close < 0) return null;
  const end = tailEnd(text, close + 1);
  return end < 0 ? null : text.slice(at, end + 1);
}

// The bootstrap IIFE is the only `})(NAME, <number>)` in the bundle.
export function findTableFunction(text) {
  for (const match of text.matchAll(/\}\)\((_0x[0-9a-f]+),\s*(\d+)\)/g)) {
    const body = tableBodyOf(text, match[1]);
    if (body && /return _0x[0-9a-f]+;/.test(body) && /const _0x[0-9a-f]+ = \[/.test(body)) {
      return { name: match[1], seed: Number(match[2]), at: match.index, footer: match[0] };
    }
  }
  return null;
}

export function findDecoder(text) {
  const match = /function (_0x[0-9a-f]+)\((_0x[0-9a-f]+), (_0x[0-9a-f]+)\) \{\n {2}\2 = \2 - (\d+);/.exec(text);
  return match ? { name: match[1], offset: Number(match[4]) } : null;
}

function functionIndex(text) {
  const index = new Map();
  for (const match of text.matchAll(/\nfunction (_0x[0-9a-f]+)\(/g)) index.set(match[1], match.index + 1);
  return index;
}

function sourceAt(index, text, name) {
  const at = index.get(name);
  if (at === undefined) return null;
  const end = text.indexOf('\n}', at);
  return end < 0 ? null : text.slice(at, end + 2);
}

// The catalog parser mentions `skippedModels`, which is plain text even before
// decoding, so only a handful of candidates are examined.
export function findParser(text, decode, index = functionIndex(text)) {
  const seen = new Set();
  for (const match of text.matchAll(/skippedModels/g)) {
    const before = text.lastIndexOf('\nfunction ', match.index);
    if (before < 0) continue;
    const name = /^function (_0x[0-9a-f]+)\(/.exec(text.slice(before + 1, before + 60))?.[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const source = sourceAt(index, text, name);
    if (!source || source.length > 6000) continue;
    let decoded;
    try { decoded = decode(source); } catch { continue; }
    if (decoded.includes('family') && decoded.includes('skippedModels') && !decoded.includes('await ')) {
      return { name, source: decoded };
    }
  }
  return null;
}

export function decoderAliases(text, decoderName) {
  const aliases = new Set([decoderName, '_0x59c770']);
  const pattern = /\b(_0x[0-9a-f]+)\s*=\s*(_0x[0-9a-f]+)\s*[,;]/g;
  for (let round = 0; round < 8; round++) {
    let grew = false;
    for (const match of text.matchAll(pattern)) {
      if (aliases.has(match[2]) && !aliases.has(match[1])) { aliases.add(match[1]); grew = true; }
    }
    if (!grew) break;
  }
  return aliases;
}

export function decodeFactory(text, decoder, stringTable) {
  const names = [...decoderAliases(text, decoder.name)].map(escape).join('|');
  const calls = new RegExp('\\b(' + names + ')\\((\\d+)\\)', 'g');
  return source => source.replace(calls, (all, name, value) => {
    try { return JSON.stringify(stringTable(Number(value))); } catch { return all; }
  });
}

const LITERAL = /^(?:\{|\[|"|'|-?\d|!0|!1|void 0|null|true|false)/;

// Module-level `const` declarations the closure needs, in source order. The
// bundle packs many declarations into one comma-separated statement and they
// reference each other, so a statement is emitted whole as soon as any of its
// names is wanted. Only literal shapes are taken; anything computed is left
// out so the probe cannot silently invent behaviour.
//
// Statements are emitted at most once: the fixed point above routinely pulls
// the same neighbour in from two different callers, and a repeated `const`
// would fail the whole script instead of the symbol that was missing.
export function collectConstants(text, names, decode = value => value) {
  const wanted = new Set(names);
  const statements = [];
  for (const match of text.matchAll(/\nconst ([^;]{1,200000});/g)) {
    const declarations = splitDeclarations(match[1]).map(declaration => ({
      name: declaration.name,
      expression: declaration.expression.length <= 8000 ? decode(declaration.expression) : null,
    }));
    statements.push({ declarations });
  }

  const needed = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const statement of statements) {
      if (!statement.declarations.some(declaration => wanted.has(declaration.name))) continue;
      for (const declaration of statement.declarations) {
        if (!needed.has(declaration.name)) { needed.add(declaration.name); changed = true; }
        if (!declaration.expression) continue;
        for (const match of declaration.expression.matchAll(/\b(_0x[0-9a-f]+)\b(?!\s*\()/g)) {
          if (!needed.has(match[1])) { needed.add(match[1]); changed = true; }
        }
      }
    }
  }

  // The literal test runs after decoding: most values are `_0x5362(<number>)`
  // in the bundle and only become literals once the string table is applied.
  const collection = { statements: [], names: new Set() };
  for (const statement of statements) {
    const keep = statement.declarations.filter(declaration => needed.has(declaration.name)
      && declaration.expression
      && !collection.names.has(declaration.name)
      && LITERAL.test(declaration.expression));
    if (!keep.length) continue;
    for (const declaration of keep) collection.names.add(declaration.name);
    collection.statements.push(keep);
  }
  return collection;
}

// Splits a `const a = 1, b = {…}, c = [ … ];` body at top-level commas.
function splitDeclarations(body) {
  let depth = 0, start = 0, quote = null;
  const parts = [];
  for (let at = 0; at < body.length; at++) {
    const character = body[at];
    if (quote) {
      if (character === '\\') at++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if ('{[('.includes(character)) depth++;
    else if ('}])'.includes(character)) depth--;
    else if (character === ',' && depth === 0) { parts.push(body.slice(start, at)); start = at + 1; }
  }
  parts.push(body.slice(start));
  return parts.flatMap(part => {
    const assignment = /^(_0x[0-9a-f]+) = ([\s\S]+)$/.exec(part.trim());
    return assignment ? [{ name: assignment[1], expression: assignment[2].trim() }] : [];
  });
}

// Renders collected statements as source. The expressions were already
// decoded during collection, so nothing is transformed here.
export function renderConstants(collection) {
  return (collection?.statements || []).map(statements => 'const '
    + statements.map(declaration => declaration.name + ' = ' + declaration.expression).join(', ')
    + ';').join('\n');
}

// --- probe -----------------------------------------------------------------

function sandbox() {
  const noop = () => {};
  const logger = { log: noop, debug: noop, info: noop, warn: noop, error: noop, trace: noop };
  return vm.createContext({
    console: logger,
    _0xa44319: logger,
    _0x1d175e: 'compat-probe',
    Object, Array, Map, Set, JSON, Number, String, Boolean, Math, Date, RegExp, Error,
    Symbol, Promise, Buffer, URL, TextDecoder, TextEncoder,
    setTimeout, clearTimeout, queueMicrotask, structuredClone,
  });
}

function calledNames(source, index, skip) {
  const names = new Set();
  for (const match of source.matchAll(/\b(_0x[0-9a-f]+)\(/g)) {
    if (!skip.has(match[1]) && index.has(match[1])) names.add(match[1]);
  }
  return names;
}

// Runs `sources` in a fresh context, adding whatever the bundle asks for that
// the closure did not bring. Missing module constants are taken from the
// bundle when they are literals; anything else becomes a throwing stub, which
// leaves the behaviour visible instead of guessing.
//
// Declaring a function does not resolve its free variables, so the closure is
// exercised once after assembly: the probe parse triggers the same lookups a
// real import would, and each ReferenceError it raises is supplied and the
// parse retried.
function buildContext(text, decode, sources, aliases, parserName, catalog) {
  const pending = new Set();
  const declaredConstants = new Set();
  let assembled = sources.join('\n');
  let parseable = false;
  let lastFailure = null;

  for (let attempt = 0; attempt < 60; attempt++) {
    // A failed vm run still leaves its lexical declarations behind, so every
    // retry starts from a clean context instead of re-running into a
    // duplicate `const`.
    const context = sandbox();
    const declared = [...aliases].map(name => 'const ' + name + ' = value => value;').join('\n');
    try {
      vm.runInContext(declared + '\n' + assembled, context, { timeout: 10000 });
      vm.runInContext('let __result; let __error;', context);
      try {
        context.__catalog = catalog;
        vm.runInContext('__result = ' + parserName + '(__catalog);', context, { timeout: 5000 });
        parseable = true;
        return { context, pending, ok: true, parseable };
      } catch (error) { lastFailure = error; }
    } catch (error) { lastFailure = error; }

    const missing = /(\w+) is not defined/.exec(lastFailure?.message || '')?.[1];
    if (!missing || pending.has(missing)) {
      return { context, pending, ok: false, parseable,
        reason: lastFailure?.message || 'closure_failed' };
    }
    pending.add(missing);
    const constants = collectConstants(text, [missing], decode);
    // A statement group is emitted at most once: two different missing names
    // routinely resolve to the same group, and repeating it would fail the
    // whole script rather than the one symbol that was actually missing.
    const fresh = constants.statements.filter(statements =>
      statements.some(declaration => !declaredConstants.has(declaration.name)));
    for (const statements of fresh) {
      for (const declaration of statements) declaredConstants.add(declaration.name);
    }
    const rendered = renderConstants({ statements: fresh });
    if (rendered) {
      assembled += '\n' + rendered + '\n';
    } else {
      // Unresolvable symbols keep the failure visible: the probe must never
      // invent behaviour for something it could not read.
      assembled += '\nconst ' + missing + ' = (() => { throw Error("compat_unknown_symbol:' + missing + '"); })();\n';
      declaredConstants.add(missing);
    }
  }
  return { context: null, pending, ok: false, parseable, reason: 'closure_unstable' };
}

export function locateContract(text) {
  const table = findTableFunction(text);
  if (!table) return { ok: false, reason: 'table_not_found' };
  const decoder = findDecoder(text);
  if (!decoder) return { ok: false, reason: 'decoder_not_found', table: table.name };

  const tableBody = tableBodyOf(text, table.name);
  const decoderBody = functionBody(text, decoder.name);
  if (!tableBody || !decoderBody) return { ok: false, reason: 'bootstrap_unreadable' };

  const bootstrap = sandbox();
  try {
    vm.runInContext(tableBody + '\n' + decoderBody, bootstrap, { timeout: 10000 });
    const start = text.lastIndexOf('(function(', table.at);
    if (start < 0) return { ok: false, reason: 'bootstrap_not_found' };
    vm.runInContext(text.slice(start, table.at + table.footer.length) + ';', bootstrap, { timeout: 20000 });
  } catch (failure) {
    return { ok: false, reason: 'bootstrap_failed:' + failure.message };
  }

  const decode = decodeFactory(text, decoder, value => bootstrap[decoder.name](value));
  const index = functionIndex(text);
  const parser = findParser(text, decode, index);
  if (!parser) return { ok: false, reason: 'parser_not_found', table: table.name, decoder: decoder.name };

  const aliases = decoderAliases(text, decoder.name);
  const closure = new Set([parser.name]);
  const queue = [parser.name];
  while (queue.length) {
    const name = queue.shift();
    const source = sourceAt(index, text, name);
    if (!source) continue;
    for (const called of calledNames(decode(source), index, aliases)) {
      if (!closure.has(called)) { closure.add(called); queue.push(called); }
    }
  }

  const sources = [...closure].map(name => sourceAt(index, text, name)).filter(Boolean).map(decode);
  const built = buildContext(text, decode, sources, aliases, parser.name, nativeCatalog(probeModels()));
  if (!built.ok) {
    return { ok: false, reason: 'closure_failed:' + built.reason, parser: parser.name, pending: [...built.pending] };
  }

  const context = built.context;
  return {
    ok: true,
    table: table.name,
    decoder: decoder.name,
    parser: parser.name,
    functions: [...closure].length,
    pending: [...built.pending],
    parse(catalog) {
      context.__catalog = catalog;
      return vm.runInContext(parser.name + '(__catalog)', context, { timeout: 5000 });
    },
  };
}

export function runtimeContracts(text) {
  const markers = {};
  for (const [marker, id] of Object.entries(RUNTIME_MARKERS)) markers[id] = text.includes(marker);
  return markers;
}

// Inspects one archive. Never throws for an unexpected bundle: the caller
// decides what an `unverified` result means.
export function inspectArchive(file, { models = probeModels() } = {}) {
  let text;
  try { text = readAsarEntry(file); }
  catch (failure) {
    const missing = failure.code === 'ENOENT'
      || (typeof failure.message === 'string' && failure.message.startsWith('asar_'));
    return { state: 'unavailable', reason: 'archive_unreadable:' + failure.message };
  }

  const base = { version: installedVersion(file), sha256: (() => {
    try { return hashFile(file); } catch { return null; }
  })(), contracts: runtimeContracts(text) };

  const located = locateContract(text);
  if (!located.ok) return { ...base, state: 'unverified', reason: located.reason };

  let parsed;
  try { parsed = located.parse(nativeCatalog(models)); }
  catch (failure) {
    return { ...base, state: 'unverified', reason: 'parser_failed:' + failure.message, parser: located.parser };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.models) || !Array.isArray(parsed.skippedModels)
    || parsed.models.some(row => !row || typeof row !== 'object' || typeof row.model !== 'string' || typeof row.family !== 'string')
    || parsed.skippedModels.some(id => typeof id !== 'string')) {
    return { ...base, state: 'unverified', reason: 'parser_result_unrecognized', parser: located.parser };
  }
  const accepted = parsed.models;
  const skipped = parsed.skippedModels;
  const expected = models.map(row => row.id).sort();
  const got = accepted.map(row => row.model).sort();
  const detail = {
    ...base, parser: located.parser, functions: located.functions, pending: located.pending,
    accepted: got, skipped,
    families: Object.fromEntries(accepted.map(row => [row.model, row.family])),
  };

  if (skipped.length) return { ...detail, state: 'incompatible', reason: 'models_skipped' };
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    return { ...detail, state: 'incompatible', reason: 'model_list_mismatch' };
  }
  if (base.contracts.catalog_parser === false) {
    return { ...detail, state: 'unverified', reason: 'parser_marker_missing' };
  }
  return { ...detail, state: 'verified', reason: 'models_accepted' };
}

export function archiveCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') return [DEFAULT_ARCHIVE,
    path.posix.join(env.HOME || os.homedir(), 'Applications', 'Kimi.app', 'Contents', 'Resources', 'app.asar')];
  if (platform !== 'win32') return [];
  const local = env.LOCALAPPDATA || (env.USERPROFILE ? path.win32.join(env.USERPROFILE, 'AppData', 'Local') : null);
  const roots = [local && path.win32.join(local, 'Programs'), local,
    env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean);
  return [...new Set(roots.flatMap(root => ['Kimi', 'kimi-desktop'].map(name =>
    path.win32.join(root, name, 'resources', 'app.asar'))))];
}

function findArchive(options) {
  const candidates = options.archive ? [options.archive] : archiveCandidates(options);
  return candidates.find(file => fs.existsSync(file)) || candidates[0] || null;
}

export function contractFingerprint(options = {}) {
  const file = findArchive(options);
  try {
    const stat = fs.statSync(file);
    return JSON.stringify([file, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch { return JSON.stringify([file, 'unavailable']); }
}

export function inspect(options = {}) {
  const file = findArchive(options);
  const scope = options.models === undefined ? 'sample-models' : 'configured-models';
  const models = options.models === undefined ? probeModels() : validateModels(options.models);
  const base = { archive: file, scope, modelCount: models.length };
  if (!file || !fs.existsSync(file)) return { ...base, state: 'unavailable', reason: file ? 'archive_missing' : 'unsupported_platform' };
  return { ...base, ...inspectArchive(file, { models }) };
}

export function summarize(result) {
  const lines = [];
  lines.push('kimi: ' + (result.version || 'unknown')
    + (result.sha256 ? ' (app.asar ' + result.sha256.slice(0, 12) + '…)' : ''));
  if (result.scope) lines.push('catalog: ' + result.scope + (result.modelCount === undefined ? '' : ' (' + result.modelCount + ' models)'));
  if (result.contracts) {
    lines.push('runtime source markers: ' + Object.entries(result.contracts)
      .map(([name, present]) => name + (present ? ' observed' : ' not-observed')).join(', '));
    if (Object.values(result.contracts).some(present => !present)) {
      lines.push('unobserved source markers may be hidden by obfuscation; they do not prove a runtime feature is absent');
    }
  }
  if (result.state === 'verified') {
    lines.push('parser: verified — ' + result.accepted.length + ' models accepted, 0 skipped');
  } else if (result.state === 'incompatible') {
    lines.push('parser: INCOMPATIBLE — ' + result.reason
      + (result.skipped?.length ? ', skipped: ' + result.skipped.join(', ') : ''));
  } else if (result.state === 'unverified') {
    lines.push('parser: unverified — ' + result.reason + ' (compatibility could not be determined)');
  } else {
    lines.push('parser: unavailable — ' + result.reason);
  }
  return lines.join('\n');
}
