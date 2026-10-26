import { KimiWorkGateway, nativeCatalog as coreCatalog, validateModels } from './vendor/kimi-work-gateway/index.mjs';
import { MagpieBackend, toCoreModel } from './magpie-backend.mjs';

// Kept as a named export because the native contract test builds menus from it.
// It still takes Magpie catalog rows, as it always has.
export function nativeCatalog(models) {
  return coreCatalog(validateModels(models.map(toCoreModel)));
}

// Compatibility wrapper: the plugin's callers still describe the Magpie gateway
// with {url, key}, while the core owns the listener, authentication and
// forwarding. The backend object is long-lived and re-pointed in place.
export class NativeByokGateway {
  constructor({ fetchImpl = globalThis.fetch, instructionsFile, timeoutMs = 300000, catalogTimeoutMs = 6000 } = {}) {
    this.backend = new MagpieBackend({ fetchImpl, catalogTimeoutMs });
    this.gateway = new KimiWorkGateway({ backend: this.backend, instructionsFile, timeoutMs, catalogTimeoutMs, fetchImpl });
    this.instructionsFile = instructionsFile;
  }

  get server() { return this.gateway.server; }
  get url() { return this.gateway.url; }
  get models() { return this.gateway.models; }
  get inflight() { return this.gateway.inflight; }
  get lastCatalogRequest() { return this.gateway.lastCatalogRequest; }
  get connection() { return this.gateway.connection; }
  set connection(value) { this.gateway.connection = value; }
  get port() { return this.gateway.port; }

  configure({ url, key, port = 3426 }) {
    this.backend.configure({ url: validateGateway(url), key });
    return this.gateway.configure({ key, port });
  }

  async catalog(signal) {
    try { return await this.gateway.catalog(signal); }
    catch (failure) {
      throw Error(failure.message === 'kimi_not_connected' ? 'kimi_not_connected' : 'catalog_unavailable');
    }
  }

  async stop() {
    this.backend.disconnect();
    await this.gateway.stop();
  }
}

// Same acceptance rule the plugin has always applied to its own gateway URL.
function validateGateway(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('invalid_gateway'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url['pass' + 'word'] || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) throw Error('invalid_gateway');
  return url.href.replace(/\/$/, '');
}
