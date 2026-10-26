import fs from 'node:fs';
import path from 'node:path';

// The tag goes upstream with the prompt, so it names neither the app nor
// the vendor (magpie-community/plugins#356). Turns written before 0.1.3 hold
// the old tag; both are taken out, so a history never carries two copies.
const BEGIN = '<shared-instructions>';
const END = '</shared-instructions>';
const TAGS = [[BEGIN, END], ['<magpie-kimi-shared-instructions>', '</magpie-kimi-shared-instructions>']];
const LIMIT = 1024 * 1024;

function linkDirectory(link, target) {
  fs.mkdirSync(target, {recursive: true, mode: 0o700});
  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A directory junction needs no Windows developer-mode file-symlink privilege.
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  try {
    if (!stat.isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(target)) throw Error();
  } catch {throw Error('library_path_conflict');}
}

export function prepareLibrary(stateDir, kimiDir) {
  linkDirectory(path.join(stateDir, 'library-native'), path.join(kimiDir, 'runtime', 'kimi-code', 'home'));
  linkDirectory(path.join(stateDir, 'library-skills'), path.join(kimiDir, 'skills'));
}

function instructionText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > LIMIT) throw Error('instructions_unavailable');
    const bytes = fs.readFileSync(file);
    if (bytes.length > LIMIT) throw Error('instructions_unavailable');
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/^\uFEFF/, '').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw Error('instructions_unavailable');
  }
}

function managed(message) {
  if (message?.role !== 'system') return false;
  const content = typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) && message.content.length === 1 && message.content[0]?.type === 'input_text'
      ? message.content[0].text : undefined;
  return typeof content === 'string' && TAGS.some(([begin, end]) =>
    content.startsWith(begin + '\n') && content.endsWith('\n' + end));
}

export function applyInstructions(payload, file) {
  if (!Array.isArray(payload.messages)) throw Error('invalid_messages');
  const text = instructionText(file);
  const messages = payload.messages.filter(message => !managed(message));
  if (text) {
    let at = 0;
    while (['system', 'developer'].includes(messages[at]?.role)) at++;
    messages.splice(at, 0, {role: 'system', content: BEGIN + '\n' + text + '\n' + END});
  }
  return {...payload, messages};
}

export function applyResponsesInstructions(payload, file) {
  if (typeof payload.input !== 'string' && !Array.isArray(payload.input)) throw Error('invalid_input');
  const text = instructionText(file);
  if (!text && typeof payload.input === 'string') return payload;
  const input = typeof payload.input === 'string' ? [{role: 'user', content: payload.input}]
    : payload.input.filter(message => !managed(message));
  if (text) {
    let at = 0;
    while (['system', 'developer'].includes(input[at]?.role)) at++;
    input.splice(at, 0, {role: 'system', content: [{type: 'input_text', text: BEGIN + '\n' + text + '\n' + END}]});
  }
  return {...payload, input};
}
