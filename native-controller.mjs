import fs from 'node:fs';
import path from 'node:path';
import { KimiAdapter } from './adapter.mjs';
import { NativeByokGateway } from './native-byok.mjs';
import { NativeSetupProbe } from './native-status.mjs';
import { copySetupToken } from './native-clipboard.mjs';
import { NativeSetup, DEFAULT_HOSTS, hostsEntry } from './native-setup.mjs';
import { NativeByokDNS, BYOK_DNS_PORT, resolverConfiguration } from './native-dns.mjs';
import { inspect as inspectKimiContract } from './vendor/kimi-work-gateway/kimi-contract.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const activeCount = value => Array.isArray(value) ? value.length : Number(value) || 0;
const busy = runner => activeCount(runner?.activeKernelTurns) + activeCount(runner?.activeKernelToolCalls) > 0;

export class LocalKimiAdapter extends KimiAdapter {
  constructor(options = {}) {
    super(options);
    this.options = options;
    this.nativeGateway = new NativeByokGateway({ fetchImpl: this.fetchImpl, instructionsFile: this.instructionsFile });
    this.nativeDNS = new NativeByokDNS();
    this.nativeProbe = new NativeSetupProbe({
      flagFile: options.flagFile || path.join(path.dirname(path.dirname(this.kimiDir)), 'kimi-agent', 'byok-availability.json'),
      ...(options.lookupFn ? { lookupFn: options.lookupFn } : {}),
    });
  }

  runner() {
    try { return read(this.runnerFile); } catch { return null; }
  }

  async closeNative() {
    await this.nativeGateway.stop();
    await this.nativeDNS.stop();
    this.nativeCatalogAfter = 0;
  }

  async tick() {
    if (this.running || this.stopping) return;
    let desired;
    try { desired = read(this.connectionFile); } catch { return super.tick(); }
    if (desired.mode !== 'native-byok') {
      if (this.nativeGateway.server || this.nativeDNS.socket) {
        if (busy(this.runner()) || this.nativeGateway.inflight.size) { this.report('waiting_kimi_idle'); return; }
        this.running = true;
        try { await this.closeNative(); } finally { this.running = false; }
      }
      return super.tick();
    }
    this.running = true;
    try {
      if (!this.bootstrap() || !this.ownLock()) return;
      this.nativeSetup ||= new NativeSetup({ stateDir: this.stateDir, flagFile: this.nativeProbe.flagFile });
      const request = this.options.setupRequest;
      if (request && request.id !== this.preparationID && !this.preparationTask) {
        this.preparationID = request.id;
        this.preparationTask = this.nativeSetup.run(request, desired.nativeByok?.dns?.port ?? BYOK_DNS_PORT)
          .catch(() => { this.nativeSetup.result = { state: 'failed' }; })
          .finally(() => { this.nativeProbe.cached = null; this.preparationTask = null; });
      }
      const runner = this.runner();
      if (!desired.enabled) {
        if (busy(runner) || this.nativeGateway.inflight.size) { this.report('waiting_kimi_idle'); return; }
        await this.closeNative();
        await this.restore();
        this.report('disconnected');
        return;
      }
      if (this.state?.active) {
        if (busy(runner)) { this.report('waiting_kimi_idle'); return; }
        await this.restore();
        if (this.server) {
          this.server.closeAllConnections?.();
          await new Promise(resolve => this.server.close(resolve));
          this.server = null;
        }
      }
      const settings = desired.nativeByok || {};
      const url = await this.nativeGateway.configure({ url: desired.gateway?.url, key: desired.gateway?.key, port: settings.port ?? 3426 });
      let resolver;
      if (settings.dns?.enabled === true) {
        if (process.platform === 'win32') {
          // Windows has no per-domain resolver files and needs none: Kimi
          // resolves the name through the hosts file, which `prepare` wrote.
          // There is deliberately no UDP listener here.
          resolver = { path: DEFAULT_HOSTS, content: hostsEntry() };
          await this.nativeDNS.stop();
        } else if (process.platform === 'darwin') {
          const port = settings.dns.port ?? BYOK_DNS_PORT;
          resolver = resolverConfiguration(port);
          await this.nativeDNS.start(port);
        } else {
          throw Error('native_byok_dns_platform_unsupported');
        }
      } else {
        await this.nativeDNS.stop();
      }
      if (Date.now() >= (this.nativeCatalogAfter || 0)) {
        await this.nativeGateway.catalog();
        this.nativeCatalogAfter = Date.now() + 10000;
      }
      const setup = await this.nativeProbe.check();
      let imported = false;
      try {
        const providers = read(this.configFile).model?.providers || {};
        imported = ['byok-kth-kimi', 'byok-kth-resp'].some(id => providers[id]?.baseUrl?.replace(/\/$/, '') === url);
      } catch {}
      const code = !setup.intranet.passed ? 'native_byok_waiting_intranet'
        : !setup.revealed ? 'native_byok_waiting_setup'
          : !imported ? 'native_byok_waiting_import'
            : runner?.lifecycleStatus !== 'running' ? 'waiting_kimi' : 'native_byok_ready';
      // Cached for a minute: the probe parses the installed bundle, which is
      // too expensive to repeat on every tick.
      if (!this.compat || Date.now() - this.compat.at > 60000) {
        try { this.compat = { at: Date.now(), value: inspectKimiContract() }; }
        catch { this.compat = { at: Date.now(), value: { state: 'unverified', reason: 'probe_failed' } }; }
      }
      this.report(code, {
        mode: 'native-byok', gatewayReady: true, url, models: this.nativeGateway.models.length,
        setup: { ...setup, imported }, dnsListening: Boolean(this.nativeDNS.socket),
        compat: { state: this.compat.value.state, version: this.compat.value.version ?? null,
          ...(this.compat.value.reason ? { reason: this.compat.value.reason } : {}) },
        preparation: this.nativeSetup?.result,
        lastCatalogRequest: this.nativeGateway.lastCatalogRequest,
        clipboard: copySetupToken({ request: this.options.copyTokenRequest, stateDir: this.stateDir,
          key: this.nativeGateway.connection.key, platform: process.platform }),
        ...(resolver ? { resolver } : {}),
      });
    } catch (failure) {
      if (failure.message !== 'waiting_kimi_idle') await this.closeNative();
      const codes = new Set(['invalid_gateway', 'invalid_connection', 'native_byok_port_unavailable',
        'native_byok_dns_unavailable', 'native_byok_dns_platform_unsupported', 'invalid_dns_port',
        'waiting_kimi_idle', 'library_path_conflict', 'catalog_unavailable']);
      this.report(codes.has(failure.message) ? failure.message : 'native_byok_failed', {
        mode: 'native-byok', gatewayReady: Boolean(this.nativeGateway.server),
      });
    } finally { this.running = false; }
  }

  async stop() {
    clearInterval(this.timer);
    this.stopping = true;
    while (this.running) await new Promise(resolve => setTimeout(resolve, 20));
    await this.closeNative();
    await super.stop();
  }

  restoreFileOnExit() {
    this.nativeGateway.connection = null;
    super.restoreFileOnExit();
  }
}
