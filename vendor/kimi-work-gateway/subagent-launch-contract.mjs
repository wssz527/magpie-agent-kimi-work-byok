import vm from 'node:vm';
import { contractFingerprint, decoderAliases, findDecoder, findTableFunction, readAsarEntry } from './kimi-contract.mjs';

const cache = new Map();
const NAME = '[A-Za-z_$][\\w$]*';
const SENTINEL = '/synthetic-kimi-runtime-probe';

function blockEnd(text, start) {
  let depth = 0, quote = '', comment = '';
  for (let at = start; at < text.length; at++) {
    const character = text[at], next = text[at + 1];
    if (comment === 'line') { if (character === '\n') comment = ''; continue; }
    if (comment === 'block') { if (character === '*' && next === '/') { comment = ''; at++; } continue; }
    if (quote) { if (character === '\\') at++; else if (character === quote) quote = ''; continue; }
    if (character === '/' && next === '/') { comment = 'line'; at++; continue; }
    if (character === '/' && next === '*') { comment = 'block'; at++; continue; }
    if ('"\'`'.includes(character)) { quote = character; continue; }
    if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return at + 1;
  }
  throw Error('launch_source_unreadable');
}

function functions(text) {
  const result = new Map();
  for (const match of text.matchAll(new RegExp('\\bfunction\\s+(' + NAME + ')\\s*\\([^)]*\\)\\s*\\{', 'g'))) {
    result.set(match[1], { at: match.index, start: match.index + match[0].lastIndexOf('{') });
  }
  return {
    has: name => result.has(name),
    get(name) {
      const entry = result.get(name);
      if (!entry) throw Error('launch_source_unreadable');
      return text.slice(entry.at, blockEnd(text, entry.start));
    },
  };
}

export function probeSubagentLaunchSource(text) {
  try {
    let sources = functions(text);
    const table = findTableFunction(text), decoder = findDecoder(text);
    let decode = value => value;
    if (table && decoder) {
      const context = vm.createContext({});
      vm.runInContext(sources.get(table.name) + '\n' + sources.get(decoder.name), context, { timeout: 1000 });
      const start = text.lastIndexOf('(function(', table.at);
      if (start < 0) throw Error('launch_source_unreadable');
      vm.runInContext(text.slice(start, table.at + table.footer.length) + ';', context, { timeout: 2000 });
      const aliases = decoderAliases(text, decoder.name);
      const calls = /\b([A-Za-z_$][\w$]*)\(\s*(\d+)\s*\)/g;
      const numbers = [...new Set([...text.matchAll(calls)].filter(match => aliases.has(match[1])).map(match => Number(match[2])))];
      const values = JSON.parse(vm.runInContext('JSON.stringify(' + JSON.stringify(numbers)
        + '.map(value => ' + decoder.name + '(value)))', context, { timeout: 1000 }));
      if (!Array.isArray(values) || values.length !== numbers.length || values.some(value => typeof value !== 'string')) {
        throw Error('launch_source_unreadable');
      }
      const strings = new Map(numbers.map((value, index) => [value, values[index]]));
      decode = source => source.replace(calls, (all, name, value) => aliases.has(name) ? JSON.stringify(strings.get(Number(value))) : all);
    }
    const decoded = decode(text);
    sources = functions(decoded);
    const readers = new Set([...decoded.matchAll(new RegExp('\\b(' + NAME + ')\\(\\s*["\']DAIMON_BUNDLE_DIR["\']\\s*\\)', 'g'))]
      .map(match => match[1]).filter(name => sources.has(name)));
    if (readers.size !== 1) return { state: 'unverified', reason: 'bundle_override_reader_unconfirmed' };
    const reader = [...readers][0];
    const closure = new Set([reader]);
    const pending = [reader];
    while (pending.length) {
      for (const match of sources.get(pending.shift()).matchAll(new RegExp('\\b(' + NAME + ')\\s*\\(', 'g'))) {
        if (sources.has(match[1]) && !closure.has(match[1])) { closure.add(match[1]); pending.push(match[1]); }
      }
      if (closure.size > 16) throw Error('launch_source_unreadable');
    }
    const script = [...closure].map(name => sources.get(name)).join('\n') + '\n' + reader + '("DAIMON_BUNDLE_DIR")';
    const run = packaged => vm.runInNewContext(script, {
      process: Object.freeze({ env: Object.freeze({ DAIMON_BUNDLE_DIR: SENTINEL }) }),
      app: Object.freeze({ isPackaged: packaged }),
    }, { timeout: 100, contextCodeGeneration: { strings: false, wasm: false } });
    if (run(false) !== SENTINEL) return { state: 'unverified', reason: 'bundle_override_reader_unconfirmed' };
    return run(true) === SENTINEL
      ? { state: 'supported', reason: 'packaged_bundle_override_accepted' }
      : { state: 'unsupported', reason: 'packaged_bundle_override_disabled' };
  } catch {
    return { state: 'unverified', reason: 'bundle_override_probe_failed' };
  }
}

export function inspectSubagentLaunchContract(archive) {
  const fingerprint = contractFingerprint({ archive });
  if (cache.has(fingerprint)) return cache.get(fingerprint);
  let result;
  try { result = probeSubagentLaunchSource(readAsarEntry(archive)); }
  catch { result = { state: 'unavailable', reason: 'bundle_override_archive_unavailable' }; }
  if (cache.size >= 4) cache.delete(cache.keys().next().value);
  cache.set(fingerprint, Object.freeze(result));
  return cache.get(fingerprint);
}
