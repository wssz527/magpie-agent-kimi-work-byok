import { validateModels } from './gateway.mjs';

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

// Base URLs are configuration, not input: credentials in the URL, query
// strings and fragments are rejected rather than quietly stripped.
export function validateBaseURL(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('invalid_base_url'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('invalid_base_url');
  if (url.username || url.password || url.search || url.hash) throw Error('invalid_base_url');
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) throw Error('invalid_base_url');
  return url.href.replace(/\/$/, '');
}

export class OpenAIBackend {
  constructor({ baseURL, apiKey, models, fetchImpl = globalThis.fetch } = {}) {
    if (typeof apiKey !== 'string' || !apiKey) throw Error('invalid_api_key');
    this.baseURL = validateBaseURL(baseURL);
    this.apiKey = apiKey;
    this.models = validateModels(models);
    this.fetchImpl = fetchImpl;
  }

  async listModels({ signal } = {}) {
    if (signal?.aborted) throw Error('catalog_unavailable');
    return this.models;
  }

  async request(protocol, payload, { signal, headers = {} } = {}) {
    if (protocol !== 'chat' && protocol !== 'responses') throw Error('invalid_protocol');
    const path = protocol === 'chat' ? '/chat/completions' : '/responses';
    return this.fetchImpl(this.baseURL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.apiKey, ...headers },
      body: JSON.stringify(payload),
      signal,
      redirect: 'error',
    });
  }
}
