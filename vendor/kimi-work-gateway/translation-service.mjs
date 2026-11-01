// Reasoning translation for the gateway host process. The renderer never talks
// to a translation provider: it forwards text over a CDP binding and this
// module performs every outbound request with the host's fetch implementation.
import { normalizeTranslationConfig } from './translation-config.mjs';

const MAX_TEXT_CHARS = 120000;
const MAX_UNITS = 3000;
const MAX_UNIT_CHARS = 1200;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PROTECTED_TEXTS = 512;
const DEFAULT_TIMEOUT_MS = 20000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;
const TIMEOUT_ENV = 'KIMI_WORK_TRANSLATION_TIMEOUT_MS';
const CUSTOM_TIMEOUT_FACTOR = 3;

const LIMITS = Object.freeze({
  bing: Object.freeze({ items: 8, chars: 2400, concurrency: 3 }),
  google: Object.freeze({ items: 1, chars: MAX_UNIT_CHARS, concurrency: 4 }),
  custom: Object.freeze({ items: 10, chars: 2800, concurrency: 2 }),
});

const LANGUAGES = Object.freeze({
  zh: Object.freeze({ bing: 'zh-Hans', google: 'zh-CN', label: 'Simplified Chinese' }),
  en: Object.freeze({ bing: 'en', google: 'en', label: 'English' }),
  ja: Object.freeze({ bing: 'ja', google: 'ja', label: 'Japanese' }),
  ko: Object.freeze({ bing: 'ko', google: 'ko', label: 'Korean' }),
  es: Object.freeze({ bing: 'es', google: 'es', label: 'Spanish' }),
  fr: Object.freeze({ bing: 'fr', google: 'fr', label: 'French' }),
  de: Object.freeze({ bing: 'de', google: 'de', label: 'German' }),
  ru: Object.freeze({ bing: 'ru', google: 'ru', label: 'Russian' }),
});

const WORD = /[\p{L}\p{N}]/u;
const FENCE = /```[\s\S]*?(?:```|$)/g;
const TILDE_FENCE = /~~~[\s\S]*?(?:~~~|$)/g;
const DOUBLE_TICK = /``[^\n]*?``/g;
const SINGLE_TICK = /`[^`\n]*`/g;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const URL_TRIM = new Set(['.', ',', ';', ':', '!', '?', '，', '。', '；', '：', '！', '？', '、', '”', '’', '"', "'", ']', '}']);
const SENTENCE_END = ['。', '.', '！', '!', '？', '?', '；', ';', '，', ',', '：', ':', '、', '）', ')', '】', ']'];

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readConfig(settings) {
  try {
    return normalizeTranslationConfig(settings);
  } catch (error) {
    if (error?.message === 'translation_endpoint_required') throw failure('translation_endpoint_required');
    throw failure('translation_invalid_config');
  }
}

function timeoutFor(env, provider) {
  const raw = Number(env?.[TIMEOUT_ENV]);
  const base = Number.isFinite(raw)
    ? Math.min(Math.max(Math.trunc(raw), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  return provider === 'custom' ? Math.min(base * CUSTOM_TIMEOUT_FACTOR, MAX_TIMEOUT_MS) : base;
}

function readKey(env, name) {
  if (!env || typeof env !== 'object') return '';
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function urlEnd(text, start, end) {
  let stop = end;
  while (stop > start) {
    const char = text[stop - 1];
    if (char === ')') {
      const slice = text.slice(start, stop);
      const open = (slice.match(/\(/g) || []).length;
      const close = (slice.match(/\)/g) || []).length;
      if (close <= open) break;
      stop -= 1;
      continue;
    }
    if (!URL_TRIM.has(char)) break;
    stop -= 1;
  }
  return stop;
}

function mergeRanges(ranges) {
  if (!ranges.length) return ranges;
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [ranges[0]];
  for (let index = 1; index < ranges.length; index += 1) {
    const last = merged[merged.length - 1];
    const [start, end] = ranges[index];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function collectRanges(text, protectedTexts) {
  const ranges = [];
  const add = (start, end) => { if (end > start) ranges.push([start, end]); };
  for (const pattern of [FENCE, TILDE_FENCE, DOUBLE_TICK, SINGLE_TICK, URL_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      let end = start + match[0].length;
      if (match[0].startsWith('http')) end = urlEnd(text, start, end);
      add(start, end);
      if (end === start) pattern.lastIndex = start + 1;
    }
  }
  const candidates = [];
  for (const value of Array.isArray(protectedTexts) ? protectedTexts : []) {
    // A single visible character is a real protected token: a DOM <code>x</code>
    // must come back as `x`, never as a translated word.
    if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TEXT_CHARS) continue;
    candidates.push(value);
    const trimmed = value.trim();
    if (trimmed.length >= 1 && trimmed !== value) candidates.push(trimmed);
    if (candidates.length >= MAX_PROTECTED_TEXTS) break;
  }
  for (const value of candidates) {
    let from = 0;
    while (from <= text.length - value.length) {
      const index = text.indexOf(value, from);
      if (index < 0) break;
      add(index, index + value.length);
      from = index + value.length;
    }
  }
  return mergeRanges(ranges);
}

function splitLong(word) {
  const chunks = [];
  let rest = word;
  while (rest.length > MAX_UNIT_CHARS) {
    const window = rest.slice(0, MAX_UNIT_CHARS);
    let cut = 0;
    for (const char of SENTENCE_END) {
      const index = window.lastIndexOf(char);
      if (index + 1 > cut) cut = index + 1;
    }
    if (cut < Math.floor(MAX_UNIT_CHARS / 2)) cut = MAX_UNIT_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Every character of the source ends up either in a protected range or in the
// whitespace stream around the units, so swapping units for their translations
// cannot move a line break, a blank line, a fence or a URL.
function buildPlan(text, protectedTexts) {
  const ranges = collectRanges(text, protectedTexts);
  const pieces = [];
  const units = [];
  let unit = null;
  let gap = '';
  let cursor = 0;

  const flush = () => {
    if (unit === null) return;
    pieces.push({ unit: units.length });
    units.push(unit);
    unit = null;
  };
  const keep = (value) => { if (value) pieces.push({ keep: value }); };
  const releaseGap = () => { if (gap) { keep(gap); gap = ''; } };
  const startUnit = (word) => {
    releaseGap();
    if (word.length <= MAX_UNIT_CHARS) { unit = word; return; }
    for (const chunk of splitLong(word)) { unit = chunk; flush(); }
  };
  const appendWord = (word) => {
    if (unit === null) { startUnit(word); return; }
    if (unit.length + gap.length + word.length <= MAX_UNIT_CHARS) { unit += gap + word; gap = ''; return; }
    flush();
    releaseGap();
    startUnit(word);
  };
  const appendSpace = (space) => {
    if (unit !== null && gap === '' && space === ' ') { gap = ' '; return; }
    flush();
    releaseGap();
    keep(space);
  };
  const appendBreak = (value) => { flush(); releaseGap(); keep(value); };
  const appendSpan = (span) => {
    if (!span) return;
    const pattern = /[ \t]+|\r\n|\r|\n|[^ \t\r\n]+/g;
    let match;
    while ((match = pattern.exec(span)) !== null) {
      const token = match[0];
      if (/^[ \t]+$/.test(token)) appendSpace(token);
      else if (/[\r\n]/.test(token)) appendBreak(token);
      else if (WORD.test(token)) appendWord(token);
      else { flush(); releaseGap(); keep(token); }
    }
  };

  for (const [start, end] of ranges) {
    appendSpan(text.slice(cursor, start));
    appendBreak(text.slice(start, end));
    cursor = end;
  }
  appendSpan(text.slice(cursor));
  flush();
  releaseGap();

  return {
    units,
    assemble(values) {
      return pieces.map(piece => (piece.keep !== undefined ? piece.keep : values[piece.unit])).join('');
    },
  };
}

function decodeChunks(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

async function readLimited(response, limit, controller) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    controller.abort();
    throw failure('translation_response_too_large');
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.length;
      if (size > limit) {
        try { await reader.cancel(); } catch { /* best effort */ }
        controller.abort();
        throw failure('translation_response_too_large');
      }
      chunks.push(value);
    }
    return decodeChunks(chunks);
  }
  const body = typeof response.text === 'function' ? await response.text() : String(response.body ?? '');
  if (body.length > limit) throw failure('translation_response_too_large');
  return body;
}

async function requestJSON(fetchImpl, url, init, { timeoutMs, signal, limit }) {
  // `init.signal` lets a caller scope several requests to one batch (a failure
  // cancels its siblings); the caller's top-level signal stays the outer bound.
  const parent = init?.signal || signal;
  if (parent?.aborted) throw failure('translation_aborted');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  parent?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response || typeof response !== 'object') throw failure('translation_network_error');
    if (!response.ok) {
      const error = failure('translation_http_error');
      error.status = Number(response.status) || 0;
      throw error;
    }
    const body = await readLimited(response, limit, controller);
    if (timedOut) throw failure('translation_timeout');
    try {
      return JSON.parse(body);
    } catch {
      throw failure('translation_invalid_response');
    }
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('translation_')) throw error;
    if (signal?.aborted) throw failure('translation_aborted');
    if (timedOut) throw failure('translation_timeout');
    throw failure('translation_network_error');
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener?.('abort', onAbort);
  }
}

async function mapLimit(items, limit, run) {
  if (!items.length) return [];
  let next = 0;
  const workers = Math.min(Math.max(1, limit), items.length);
  const work = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: workers }, work));
  return items;
}

async function bingBatch(request, texts, to) {
  const url = new URL('https://edge.microsoft.com/translate/translatetext');
  url.searchParams.set('to', to);
  url.searchParams.set('isEnterpriseClient', 'false');
  const payload = await request(url.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(texts),
    redirect: 'error',
    credentials: 'omit',
  });
  if (!Array.isArray(payload) || payload.length !== texts.length) throw failure('translation_invalid_response');
  return payload.map(item => item?.translations?.[0]?.text);
}

async function googleBatch(request, texts, tl) {
  const values = [];
  for (const text of texts) {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'auto');
    url.searchParams.set('tl', tl);
    url.searchParams.set('dt', 't');
    const payload = await request(url.href, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: text }).toString(),
      redirect: 'error',
      credentials: 'omit',
    });
    const rows = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : null;
    if (!rows || !rows.length) throw failure('translation_invalid_response');
    const joined = rows.map(row => (Array.isArray(row) && typeof row[0] === 'string' ? row[0] : '')).join('');
    if (!joined.trim()) throw failure('translation_invalid_response');
    values.push(joined);
  }
  return values;
}

function stripFence(value) {
  const text = value.trim();
  if (!text.startsWith('```')) return text;
  const lines = text.split(/\r?\n/);
  lines.shift();
  if (lines.length && lines[lines.length - 1].trim() === '```') lines.pop();
  return lines.join('\n').trim();
}

function alignCustomReply(content, count) {
  const body = stripFence(content);
  try {
    const value = JSON.parse(body);
    if (Array.isArray(value) && value.length === count && value.every(item => typeof item === 'string')) {
      return value.map(item => item.trim());
    }
  } catch { /* fall through to the line form */ }
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === count) return lines.map(line => line.replace(/^\d+[.)]\s*/, ''));
  return null;
}

async function customRequest(request, texts, language, config, key) {
  const single = texts.length === 1;
  const instruction = single
    ? `You are a translation engine. Translate the user text into ${language}. Preserve Markdown, code, URLs and line breaks exactly. Reply with only the translation.`
    : `You are a translation engine. The user message is a JSON array of ${texts.length} strings. Translate every string into ${language}. Reply with only a JSON array of exactly ${texts.length} translated strings in the same order; never merge, drop, split or reorder items. Preserve Markdown, code, URLs and line breaks exactly.`;
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const payload = await request(config.customEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...(config.customModel ? { model: config.customModel } : {}),
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: single ? texts[0] : JSON.stringify(texts) },
      ],
      temperature: 0,
      stream: false,
    }),
    redirect: 'error',
    credentials: 'omit',
  });
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw failure('translation_invalid_response');
  return content;
}

// A batch that does not come back item-aligned is retried one segment at a
// time instead of being assembled from misaligned lines, which is how the old
// numbered-list approach silently dropped text.
async function customBatch(request, texts, language, config, key) {
  const content = await customRequest(request, texts, language, config, key);
  if (texts.length === 1) return [content.trim()];
  const aligned = alignCustomReply(content, texts.length);
  if (aligned) return aligned;
  const values = [];
  for (const text of texts) {
    const single = await customRequest(request, [text], language, config, key);
    const value = single.trim();
    if (!value) throw failure('translation_invalid_response');
    values.push(value);
  }
  return values;
}

async function translateAll(config, units, language, request, env, signal) {
  const limits = LIMITS[config.provider];
  const batches = [];
  let current = [];
  let size = 0;
  for (let index = 0; index < units.length; index += 1) {
    const length = units[index].length;
    if (current.length && (current.length >= limits.items || size + length > limits.chars)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(index);
    size += length;
  }
  if (current.length) batches.push(current);

  const key = config.provider === 'custom' ? readKey(env, config.apiKeyEnv) : '';
  const results = new Array(units.length);
  // One failing batch aborts its siblings: there is nothing useful to finish
  // and the caller is about to fail the whole translation anyway.
  const abort = new AbortController();
  const forwardAbort = () => abort.abort();
  signal?.addEventListener?.('abort', forwardAbort, { once: true });
  const scopedRequest = (url, init) => request(url, { ...init, signal: abort.signal });
  try {
    await mapLimit(batches, limits.concurrency, async (batch) => {
      if (signal?.aborted) throw failure('translation_aborted');
      const texts = batch.map(index => units[index]);
      let values;
      try {
        if (config.provider === 'bing') values = await bingBatch(scopedRequest, texts, language.bing);
        else if (config.provider === 'google') values = await googleBatch(scopedRequest, texts, language.google);
        else values = await customBatch(scopedRequest, texts, language.label, config, key);
      } catch (error) {
        abort.abort();
        throw error;
      }
      if (!Array.isArray(values) || values.length !== batch.length) {
        abort.abort();
        throw failure('translation_invalid_response');
      }
      for (let offset = 0; offset < batch.length; offset += 1) {
        const value = values[offset];
        if (typeof value !== 'string' || !value.trim()) {
          abort.abort();
          throw failure('translation_invalid_response');
        }
        results[batch[offset]] = value.trim();
      }
    });
  } finally {
    signal?.removeEventListener?.('abort', forwardAbort);
  }
  if (results.some(value => typeof value !== 'string' || !value)) throw failure('translation_invalid_response');
  return results;
}

export async function translateReasoning(text, settings,
  { env = process.env, protectedTexts = [], signal, fetchImpl = fetch } = {}) {
  const config = readConfig(settings);
  if (typeof text !== 'string') throw failure('translation_invalid_text');
  if (text.length > MAX_TEXT_CHARS) throw failure('translation_text_too_large');
  if (signal?.aborted) throw failure('translation_aborted');
  if (!text.trim()) return text;
  if (typeof fetchImpl !== 'function') throw failure('translation_unavailable');

  const plan = buildPlan(text, protectedTexts);
  if (!plan.units.length) return text;
  if (plan.units.length > MAX_UNITS) throw failure('translation_text_too_large');

  const language = LANGUAGES[config.targetLanguage];
  const timeoutMs = timeoutFor(env, config.provider);
  const request = (url, init) => requestJSON(fetchImpl, url, init, {
    timeoutMs, signal, limit: MAX_RESPONSE_BYTES,
  });
  const values = await translateAll(config, plan.units, language, request, env, signal);
  return plan.assemble(values);
}
