import { normalizeModels } from './catalog.mjs';

const UA = 'Desktop Kimi Work';
const CATALOG_LIMIT = 8 * 1024 * 1024;

const lastSegment = id => id.slice(id.lastIndexOf('/') + 1).toLowerCase();

// The Magpie gateway describes the same upstream model in its own shape. The
// translation is mechanical, and the protocol keeps the rule this plugin has
// always used so an imported Kimi menu does not change on upgrade.
function protocolFor(alias) {
  return lastSegment(alias).startsWith('kimi-') ? 'chat' : 'responses';
}

export function toCoreModel(row) {
  const effort = row.runtime.supportEfforts;
  return {
    id: row.id,
    name: row.menu.displayName,
    protocol: protocolFor(row.id),
    contextWindow: row.runtime.maxContextSize,
    ...(row.runtime.maxOutputSize ? { maxOutputTokens: row.runtime.maxOutputSize } : {}),
    tools: row.runtime.capabilities.includes('dynamically_loaded_tools'),
    reasoning: row.runtime.capabilities.includes('thinking'),
    inputModalities: row.runtime.capabilities.includes('image_in') ? ['text', 'image'] : ['text'],
    ...(effort?.length ? { reasoningEfforts: effort, ...(row.runtime.defaultEffort ? { defaultEffort: row.runtime.defaultEffort } : {}) } : {}),
  };
}

// The gateway connection is replaced in place: the core keeps one backend
// reference for its whole lifetime, so reconnecting must not swap the object.
export class MagpieBackend {
  constructor({ fetchImpl = globalThis.fetch, catalogTimeoutMs = 6000 } = {}) {
    Object.assign(this, { fetchImpl, catalogTimeoutMs });
    this.connection = null;
    this.models = [];
  }

  configure({ url, key }) {
    this.connection = { target: url, key };
  }

  disconnect() {
    this.connection = null;
    this.models = [];
  }

  async listModels({ signal } = {}) {
    const active = this.connection;
    if (!active) throw Error('kimi_not_connected');
    const timeout = AbortSignal.timeout(this.catalogTimeoutMs);
    const response = await this.fetchImpl(active.target + '/models', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + active.key, 'User-Agent': UA },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error', proxy: '',
    });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > CATALOG_LIMIT) {
      await response.body?.cancel();
      throw Error('catalog_unavailable');
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > CATALOG_LIMIT) throw Error('catalog_unavailable');
    let rows;
    try { rows = normalizeModels(JSON.parse(text), { allowEmpty: true }); }
    catch { throw Error('catalog_unavailable'); }
    const models = rows.map(toCoreModel);
    this.models = models;
    return models;
  }

  async request(protocol, payload, { signal, headers = {} } = {}) {
    const active = this.connection;
    if (!active) throw Error('kimi_not_connected');
    const path = protocol === 'chat' ? '/chat/completions' : '/responses';
    return this.fetchImpl(active.target + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + active.key, 'User-Agent': UA, ...headers },
      body: JSON.stringify(payload), signal, redirect: 'error', proxy: '',
    });
  }
}
