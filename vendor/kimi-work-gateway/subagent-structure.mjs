export const SUBAGENT_ADAPTER_VERSION = 2;

const ID = '[A-Za-z_$][A-Za-z0-9_$]*';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function quotedEnd(source, start, quote) {
  for (let at = start + 1; at < source.length; at++) {
    if (source[at] === '\\') at++;
    else if (source[at] === quote) return at + 1;
  }
  return source.length;
}

function regexEnd(source, start) {
  let bracket = false;
  for (let at = start + 1; at < source.length; at++) {
    const char = source[at];
    if (char === '\n' || char === '\r') return start + 1;
    if (char === '\\') at++;
    else if (char === '[') bracket = true;
    else if (char === ']') bracket = false;
    else if (char === '/' && !bracket) {
      at++;
      while (at < source.length && /[a-z]/i.test(source[at])) at++;
      return at;
    }
  }
  return start + 1;
}

function templateEnd(source, start) {
  let at = start + 1;
  while (at < source.length) {
    const char = source[at];
    if (char === '\\') { at += 2; continue; }
    if (char === '`') return at + 1;
    if (char !== '$' || source[at + 1] !== '{') { at++; continue; }
    at += 2;
    let depth = 1;
    while (at < source.length && depth) {
      const next = source[at];
      if (next === '"' || next === "'") { at = quotedEnd(source, at, next); continue; }
      if (next === '`') { at = templateEnd(source, at); continue; }
      if (next === '/' && source[at + 1] === '/') {
        const end = source.indexOf('\n', at + 2); at = end < 0 ? source.length : end; continue;
      }
      if (next === '/' && source[at + 1] === '*') {
        const end = source.indexOf('*/', at + 2); at = end < 0 ? source.length : end + 2; continue;
      }
      if (next === '{') depth++;
      else if (next === '}') depth--;
      at++;
    }
  }
  return source.length;
}

function codeMask(source) {
  const pieces = [];
  let copied = 0, at = 0, canRegex = true;
  const hide = end => {
    pieces.push(source.slice(copied, at), ' '.repeat(end - at));
    at = copied = end;
  };
  while (at < source.length) {
    const char = source[at];
    if (/\s/.test(char)) { at++; continue; }
    if (char === '"' || char === "'") { hide(quotedEnd(source, at, char)); canRegex = false; continue; }
    if (char === '`') { hide(templateEnd(source, at)); canRegex = false; continue; }
    if (char === '/' && source[at + 1] === '/') {
      const end = source.indexOf('\n', at + 2); hide(end < 0 ? source.length : end); continue;
    }
    if (char === '/' && source[at + 1] === '*') {
      const end = source.indexOf('*/', at + 2); hide(end < 0 ? source.length : end + 2); continue;
    }
    if (char === '/' && canRegex) {
      const end = regexEnd(source, at);
      if (end > at + 1) { hide(end); canRegex = false; continue; }
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = at++;
      while (at < source.length && /[A-Za-z0-9_$]/.test(source[at])) at++;
      canRegex = /^(return|throw|case|delete|typeof|void|new|in|of|yield|await|else|do|instanceof)$/.test(source.slice(start, at));
      continue;
    }
    if (/[0-9]/.test(char)) {
      at++;
      while (at < source.length && /[A-Za-z0-9_.]/.test(source[at])) at++;
      canRegex = false;
      continue;
    }
    canRegex = /[({[,:;=!?&|+*%~^<>\-]/.test(char);
    at++;
  }
  pieces.push(source.slice(copied));
  return pieces.join('');
}

function unique(matches, name) {
  if (matches.length !== 1) {
    const error = Error('subagent_runtime_incompatible');
    error.reason = 'subagent_structure_' + name + (matches.length ? '_ambiguous' : '_missing');
    throw error;
  }
  return matches[0];
}

function classBodyAt(code, offset) {
  const header = new RegExp(String.raw`\bclass(?:\s+${ID})?(?:\s+extends\s+[^{};]{1,400})?\s*$`);
  let depth = 0;
  for (let at = offset - 1; at >= 0; at--) {
    if (code[at] === '}') depth++;
    else if (code[at] === '{') {
      if (depth) { depth--; continue; }
      if (!header.test(code.slice(Math.max(0, at - 512), at))) continue;
      let end = at + 1, level = 1;
      while (end < code.length && level) {
        if (code[end] === '{') level++;
        else if (code[end] === '}') level--;
        end++;
      }
      if (level) break;
      return code.slice(at + 1, end - 1);
    }
  }
  throw Error('subagent_runtime_incompatible');
}

export function probeSubagentKernel(source) {
  if (typeof source !== 'string' || !source.trim()) throw Error('subagent_runtime_incompatible');
  const code = codeMask(source);
  if (/\bkwgSubagentHook\b/.test(code)) throw Error('subagent_runtime_already_adapted');
  const profilePattern = new RegExp(String.raw`\b(?:const|let|var)\s+(${ID})\s*=\s*${ID}\s*\(\s*(["'])agentProfileService\2\s*\)`, 'g');
  const profile = unique([...source.matchAll(profilePattern)].filter(match => code.slice(match.index, match.index + 3).trim()), 'profile');
  const configuration = unique([...code.matchAll(new RegExp(String.raw`\bget\s*\(\s*(${ID})\s*\)\s*\{\s*if\s*\(\s*Object\s*\.\s*prototype\s*\.\s*hasOwnProperty\s*\.\s*call\s*\(\s*this\s*\.\s*memory\s*,\s*\1\s*\)\s*\)`, 'g'))], 'configuration');
  const spawn = unique([...code.matchAll(new RegExp(String.raw`\basync\s+planSpawn\s*\(\s*(${ID})\s*\)\s*\{\s*const\s+${ID}\s*=\s*this\s*\.\s*requireCaller\s*\(\s*\1\s*\.\s*callerAgentId\s*\)`, 'g'))], 'spawn');
  // The injected configuration read uses this.bootstrap, and the spawn guard
  // uses this.configService; both are only valid inside the class that owns
  // them, so an anchor found elsewhere is not a usable hook.
  for (const [match, field] of [[configuration, 'bootstrap'], [spawn, 'configService']]) {
    if (!new RegExp(String.raw`\b${field}\b`).test(classBodyAt(code, match.index))) {
      const error = Error('subagent_runtime_incompatible');
      error.reason = 'subagent_structure_' + field + '_missing';
      throw error;
    }
  }
  const runs = [...code.matchAll(new RegExp(String.raw`\bif\s*\(\s*(${ID})\s*===\s*(?:void\s+0|undefined)\s*\)\s*throw\s+new\s+${ID}\s*\(\s*${ID}\s*\.\s*AGENT_NOT_FOUND\s*,[\s\S]{0,2000}?\)\s*;\s*return\s+${ID}\s*\(\s*\1\s*,\s*${ID}\s*,\s*\{`, 'g'))]
    .filter(match => new RegExp(String.raw`\b(?:const|let)\s+${escape(match[1])}\s*=\s*this\s*\.\s*agentLifecycle\s*\.\s*handleOf\s*\(\s*${ID}\s*\.\s*agentId\s*\)\s*;\s*$`).test(code.slice(Math.max(0, match.index - 500), match.index)));
  const run = unique(runs, 'run');
  return {
    strategy: 'structural', adapterVersion: SUBAGENT_ADAPTER_VERSION,
    checks: ['configuration', 'spawn', 'run', 'profile'],
    insertions: [
      { at: configuration.index + configuration[0].indexOf('{') + 1,
        text: '\nif (' + configuration[1] + ' === "secondaryModel") { const __kwgPolicy = kwgSubagentHook.configuration(this.bootstrap.homeDir); if (__kwgPolicy !== undefined) return __kwgPolicy; }\n' },
      { at: spawn.index + spawn[0].indexOf('{') + 1,
        text: '\nkwgSubagentHook.assertSpawn(this.configService, ' + spawn[1] + ');\n' },
      { at: run.index + run[0].lastIndexOf('return'),
        text: 'kwgSubagentHook.assertModel(this.configService, ' + run[1] + '.accessor.get(' + profile[1] + ').data().modelAlias);\n' },
    ],
  };
}

export function applySubagentStructure(source, options, hook = 'kwg-subagent-hook.mjs') {
  const probe = probeSubagentKernel(source);
  let transformed = source;
  for (const item of probe.insertions.sort((a, b) => b.at - a.at)) {
    transformed = transformed.slice(0, item.at) + item.text + transformed.slice(item.at);
  }
  return transformed + '\nimport { createSubagentRuntimeHook as kwgCreateSubagentHook } from "./' + hook + '";\n'
    + 'const kwgSubagentHook = kwgCreateSubagentHook(' + JSON.stringify(options) + ');\n';
}
