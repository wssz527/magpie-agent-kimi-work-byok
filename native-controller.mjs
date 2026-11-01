import fs from 'node:fs';
import path from 'node:path';
import { KimiAdapter } from './adapter.mjs';
import { NativeByokGateway } from './native-byok.mjs';
import { NativeSetupProbe } from './native-status.mjs';
import { NativeSubagents } from './native-subagents.mjs';
import { WorkPanel } from './work-panel.mjs';
import { WorkSettings } from './work-settings.mjs';
import { NativeWorkIntegration, NativeModelImport, NativeOnboarding, NativeDesktopRuntime,
  normalizeSubagentPolicy } from './vendor/kimi-work-gateway/index.mjs';
import crypto from 'node:crypto';
import { readSubagentJSON, writeSubagentJSON } from './vendor/kimi-work-gateway/subagent-policy.mjs';
import { copySetupToken } from './native-clipboard.mjs';
import { NativeSetup, defaultHostsPath, hostsEntry } from './native-setup.mjs';
import { NativeByokDNS, BYOK_DNS_PORT, resolverConfiguration } from './native-dns.mjs';
import { inspect as inspectKimiContract, contractFingerprint } from './vendor/kimi-work-gateway/kimi-contract.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const activeCount = value => Array.isArray(value) ? value.length : Number(value) || 0;
const busy = runner => activeCount(runner?.activeKernelTurns) + activeCount(runner?.activeKernelToolCalls) > 0;

export class LocalKimiAdapter extends KimiAdapter {
  constructor(options = {}) {
    super(options);
    this.options = options;
    this.workSettingsStore = new WorkSettings({ stateDir: this.stateDir });
    this.desktop = options.desktopRuntime || new NativeDesktopRuntime({ stateDir: this.stateDir, kimiDir: this.kimiDir,
      gatewayBusy: () => this.nativeGateway?.inflight?.size ?? 0 });
    this.nativeImport = new NativeModelImport({ stateDir: this.stateDir, kimiDir: this.kimiDir,
      getContext: options.nativeContext, getToken: () => this.nativeGateway.connection?.key,
      ensureRuntime: () => this.ensureNativeDesktop() });
    this.integration = options.nativeIntegration || new NativeWorkIntegration({ stateDir: this.stateDir, kimiDir: this.kimiDir,
      sourceID: 'magpie', getContext: options.nativeContext,
      syncNative: options.syncNative || (request => this.nativeImport.sync(request)) });
    this.nativeGateway = new NativeByokGateway({ fetchImpl: this.fetchImpl, instructionsFile: this.instructionsFile });
    this.nativeDNS = new NativeByokDNS();
    this.subagents = new NativeSubagents({ stateDir: this.stateDir, kimiDir: this.kimiDir, runtime: options.subagentRuntime, native: options.nativeSubagents });
    this.nativeGateway.gateway.beforeRequest = (protocol, payload) => this.nativeSubagentInitializing
      ? { status: 503, code: 'subagent_policy_initializing' } : this.subagents.beforeRequest(protocol, payload);
    this.workPanel = new WorkPanel(this, options.panelFile ? { file: options.panelFile } : {});
    this.nativeProbe = new NativeSetupProbe({
      flagFile: options.flagFile || path.join(path.dirname(path.dirname(this.kimiDir)), 'kimi-agent', 'byok-availability.json'),
      ...(options.lookupFn ? { lookupFn: options.lookupFn } : {}),
    });
    this.onboarding = options.nativeOnboarding || (!options.flagFile && new NativeOnboarding({ stateDir: this.stateDir,
      kimiDir: this.kimiDir, probe: this.nativeProbe }));
  }

  async ensureNativeDesktop() {
    if (this.stopping || busy(this.runner()) || this.nativeGateway.inflight.size) return { state: 'waiting-idle' };
    return this.desktop.ensure();
  }

  requestNativeConnection() {
    if (this.stopping || !this.ownLock()) throw Error('work_not_connected');
    this.nativeImport.retry = true;
    this.nativeImport.after = 0;
    if (this.onboarding && !this.onboardingTask) {
      this.onboardingTask = this.onboarding.ensure({ retry: true }).then(value => { this.onboardingStatus = value; })
        .catch(() => { this.onboardingStatus = { state: 'failed' }; })
        .finally(() => { this.onboardingTask = null; this.nativeProbe.cached = null; });
    }
    return { state: 'running' };
  }

  report(code, details = {}) {
    super.report(code, details);
    this.workPanel?.publish(this.status, this.nativeGateway?.models || []);
  }

  workSettings() { return this.workSettingsStore.snapshot(); }

  async saveWorkSettings(input) {
    if (this.stopping) throw Object.assign(Error('work_settings_stopping'), { status: 503 });
    if (input?.mainModel !== undefined && !this.nativeGateway.models.some(row => row.id === input.mainModel)) {
      throw Object.assign(Error('model_not_enabled_for_kimi'), { status: 400 });
    }
    if (!this.ownLock() || input?.revision !== this.workSettingsStore.snapshot().revision) {
      throw Object.assign(Error('work_settings_conflict'), { status: 409 });
    }
    if (!input.subagents || typeof input.subagents !== 'object' || Array.isArray(input.subagents)) throw Error('invalid_subagent_policy');
    const policy = normalizeSubagentPolicy(input.subagents, this.nativeGateway.models);
    const selector = { mode: policy.mode === 'inherit' ? 'inherit' : 'force', transport: 'native-config',
      ...(policy.model ? { model: policy.model } : {}) };
    const previous = readSubagentJSON(this.connectionFile);
    if (previous.mode !== 'native-byok' || previous.enabled !== true) throw Object.assign(Error('work_not_connected'), { status: 409 });
    const next = { ...previous, subagents: selector };
    if (JSON.stringify(readSubagentJSON(this.connectionFile)) !== JSON.stringify(previous)) {
      throw Object.assign(Error('work_settings_conflict'), { status: 409 });
    }
    writeSubagentJSON(this.connectionFile, next);
    let saved;
    try { saved = this.workSettingsStore.save(input, this.nativeGateway.models, selector); }
    catch (error) {
      if (JSON.stringify(readSubagentJSON(this.connectionFile)) === JSON.stringify(next)) writeSubagentJSON(this.connectionFile, previous);
      throw error;
    }
    if (input.mainModel !== undefined) {
      const { randomUUID } = await import('node:crypto');
      this.mainModelRequest = { id: randomUUID(), at: Date.now(), model: input.mainModel };
    }
    this.nativeSubagentInitializing = true;
    await this.tick();
    return saved;
  }

  runner() {
    try { return read(this.runnerFile); } catch { return null; }
  }

  async closeNative() {
    await this.integration.close();
    await this.workPanel.stop?.();
    this.panelStartFailed = false;
    await this.nativeGateway.stop();
    await this.nativeDNS.stop();
    this.nativeCatalogAfter = 0;
    this.appliedSubagentSelection = undefined;
    this.nativeSubagentInitializing = false;
    this.subagentClose = { policy: { mode: 'inherit' } };
    try { this.subagents.close(); }
    catch { this.subagentClose = { policy: { mode: 'blocked', reason: 'subagent_policy_close_failed' } }; }
  }

  async tick() {
    if (this.running || this.stopping) return;
    let desired;
    try { desired = read(this.connectionFile); } catch { return super.tick(); }
    if (desired.mode !== 'native-byok') {
      if (this.nativeGateway.server || this.nativeDNS.socket || this.desktop.inspect().enabled) {
        if (busy(this.runner()) || this.nativeGateway.inflight.size) { this.report('waiting_kimi_idle'); return; }
        this.running = true;
        try {
          if (this.desktop.inspect().enabled) await this.desktop.stop();
          await this.closeNative();
        } finally { this.running = false; }
      }
      return super.tick();
    }
    this.running = true;
    try {
      if (!this.bootstrap() || !this.ownLock()) return;
      const subagentSelection = this.workSettingsStore.resolve(desired.subagents, this.options.workModels?.subagents);
      const selectionKey = JSON.stringify(subagentSelection);
      this.nativeSubagentInitializing = selectionKey !== this.appliedSubagentSelection;
      if (!this.workPanel.server && !this.panelStartFailed) {
        try { await this.workPanel.start({ port: this.options.panelPort ?? 3428 }); }
        catch { this.panelStartFailed = true; }
      }
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
        if (this.desktop.inspect().enabled) await this.desktop.stop();
        await this.closeNative();
        await this.restore();
        this.report('disconnected', { subagents: this.subagentClose });
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
          resolver = { path: defaultHostsPath(), content: hostsEntry() };
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
      if (this.onboarding && !this.onboardingTask && Date.now() >= (this.onboardingAfter || 0)) {
        this.onboarding.dnsPort = settings.dns?.port ?? BYOK_DNS_PORT;
        this.onboardingAfter = Date.now() + 10000;
        this.onboardingTask = this.onboarding.ensure().then(value => { this.onboardingStatus = value; })
          .catch(() => { this.onboardingStatus = { state: 'failed' }; })
          .finally(() => { this.onboardingTask = null; });
      }
      const models = this.nativeGateway.models;
      const integration = await this.integration.reconcile({ enabled: true, url, models,
        allowNativeImport: setup.revealed && setup.intranet.passed,
        connectionRevision: crypto.createHash('sha256').update(this.nativeGateway.connection.key).digest('hex') });
      this.nativeIntegrationStatus = integration;
      const imported = integration.imported === true;
      const missingProviders = integration.missingProviders || [];
      const code = !setup.intranet.passed ? 'native_byok_waiting_intranet'
        : !setup.revealed ? 'native_byok_waiting_setup'
          : integration.state === 'account-unverified' ? 'native_byok_account_unverified'
            : integration.state === 'conflict' ? 'native_byok_config_conflict'
              : integration.state === 'waiting-native-sync' ? 'native_byok_syncing'
                : !imported ? 'native_byok_waiting_import'
                  : runner?.lifecycleStatus !== 'running' ? 'waiting_kimi' : 'native_byok_ready';
      const compatKey = JSON.stringify([(this.options.contractFingerprint || contractFingerprint)(), models]);
      if (!this.compat || this.compat.key !== compatKey || Date.now() - this.compat.at > 60000) {
        let value;
        try { value = (this.options.inspectKimiContract || inspectKimiContract)({ models }); }
        catch { value = { state: 'unverified', reason: 'probe_failed' }; }
        this.compat = { at: Date.now(), key: compatKey, value };
      }
      if (imported) await this.workPanel.selectMain(this.mainModelRequest ?? this.options.workModels?.mainModelRequest, models, runner);
      const subagentStatus = await this.subagents.update(subagentSelection, models, this.options.subagentRequest,
        imported ? integration.aliases : {});
      if (this.nativeSubagentInitializing) {
        this.appliedSubagentSelection = selectionKey;
        this.nativeSubagentInitializing = false;
      }
      await this.ensureNativeDesktop();
      this.report(code, {
        mode: 'native-byok', gatewayReady: true, url, models: models.length,
        setup: { ...setup, imported, missingProviders }, integration, dnsListening: Boolean(this.nativeDNS.socket),
        subagents: subagentStatus,
        panel: this.workPanel.publication,
        compat: { state: this.compat.value.state, version: this.compat.value.version ?? null,
          scope: 'active-models', modelCount: models.length,
          ...(this.compat.value.accepted ? { accepted: this.compat.value.accepted.length } : {}),
          ...(this.compat.value.skipped ? { skipped: this.compat.value.skipped } : {}),
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

  retire() {
    if (this.retirement) return this.retirement;
    clearInterval(this.timer);
    this.retirement = (async () => {
      while (this.running || this.nativeGateway.inflight.size || busy(this.runner())) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await this.stop();
    })();
    return this.retirement;
  }

  async stop() {
    clearInterval(this.timer);
    this.stopping = true;
    this.desktop.close();
    while (this.running) await new Promise(resolve => setTimeout(resolve, 20));
    await this.closeNative();
    await super.stop();
  }

  restoreFileOnExit() {
    this.nativeGateway.connection = null;
    try { this.subagents.close(); } catch { this.log('subagent_policy_close_failed'); }
    super.restoreFileOnExit();
  }
}
