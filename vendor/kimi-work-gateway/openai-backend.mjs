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

// One upstream endpoint with one credential. `id` is null for the legacy
// `upstream` block so existing callers keep a single unnamed connection.
function readEndpoint({ baseURL, apiKey, id = null } = {}) {
  if (typeof apiKey !== 'string' || !apiKey) throw Error('invalid_api_key');
  return { id, baseURL: validateBaseURL(baseURL), apiKey };
}

// The backend holds every configured connection at once and dispatches each
// request by connection id. A model names its connection; a model without one
// goes to the legacy upstream exactly as it did before connections existed.
export class OpenAIBackend {
  constructor({ baseURL, apiKey, models, connections, fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
    this.models = validateModels(models);
    this.endpoints = new Map();
    const legacy = baseURL !== undefined || apiKey !== undefined;
    if (legacy) {
      const endpoint = readEndpoint({ baseURL, apiKey });
      this.baseURL = endpoint.baseURL;
      this.apiKey = endpoint.apiKey;
      this.endpoints.set(null, endpoint);
    } else {
      this.baseURL = undefined;
      this.apiKey = undefined;
    }
    for (const connection of connections || []) {
      if (!connection || typeof connection.id !== 'string' || !connection.id) throw Error('invalid_connection');
      const endpoint = readEndpoint(connection);
      this.endpoints.set(connection.id, { ...endpoint, id: connection.id,
        ...(Array.isArray(connection.protocols) ? { protocols: connection.protocols } : {}) });
    }
  }

  // Every connection the backend can dispatch to, without its credential.
  get connectionIds() {
    return [...this.endpoints.keys()].filter(id => id !== null);
  }

  connection(id) {
    const endpoint = this.endpoints.get(id ?? null);
    if (!endpoint) throw Error(id === null ? 'connection_unavailable' : 'invalid_connection_id');
    return endpoint;
  }

  has(id) { return this.endpoints.has(id ?? null); }

  async listModels({ signal } = {}) {
    if (signal?.aborted) throw Error('catalog_unavailable');
    return this.models;
  }

  async request(protocol, payload, { signal, headers = {}, connectionId = null } = {}) {
    if (protocol !== 'chat' && protocol !== 'responses') throw Error('invalid_protocol');
    const endpoint = this.connection(connectionId ?? null);
    if (endpoint.protocols && !endpoint.protocols.includes(protocol)) throw Error('invalid_protocol');
    const path = protocol === 'chat' ? '/chat/completions' : '/responses';
    return this.fetchImpl(endpoint.baseURL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + endpoint.apiKey, ...headers },
      body: JSON.stringify(payload),
      signal,
      redirect: 'error',
    });
  }
}
