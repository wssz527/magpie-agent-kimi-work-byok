import { TranslationRuntime } from './translation-runtime.mjs';
import { TranslationSupervisor } from './translation-supervisor.mjs';
import { nativeDesktopRequest } from './native-desktop-bridge.mjs';
import path from 'node:path';
import { defaultKimiDirectory } from './paths.mjs';

export class NativeDesktopRuntime {
  constructor({ stateDir, kimiDir, env = process.env, runtime, supervisor, gatewayBusy = () => 0,
    protectedEnvNames = [], request = nativeDesktopRequest } = {}) {
    this.kimiDir = kimiDir;
    this.request = request;
    this.scopeVerified = Boolean(runtime || supervisor)
      || typeof kimiDir === 'string' && path.resolve(kimiDir) === path.resolve(defaultKimiDirectory());
    this.runtime = runtime || new TranslationRuntime({ stateDir, kimiDir, env });
    this.supervisor = supervisor || new TranslationSupervisor({ stateDir, kimiDir, env,
      runtime: this.runtime, gatewayBusy, protectedEnvNames, launchOptions: { controlOnly: true } });
  }

  configure(settings) { return this.runtime.configure(settings); }

  async ensure() {
    if (!this.scopeVerified) return this.inspect();
    const status = await this.request(this.kimiDir, 'status');
    const state = this.supervisor.inspect();
    this.sharedState = undefined;
    if (state.enabled) return this.supervisor.ensure();
    let launch;
    try { launch = this.runtime.activeLaunch(); } catch {}
    if (status.ok && status.state === 'ready' && launch?.remoteModels !== true && !status.remote) {
      this.sharedState = { at: Date.now(), value: { state: 'active', shared: true } };
      return this.sharedState.value;
    }
    try { this.runtime.desiredSettings(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.runtime.configure({ enabled: false });
      this.supervisor.launchOptions = { ...this.supervisor.launchOptions, inheritLegacyTranslation: true };
    }
    return this.supervisor.start({ takeover: true, controlOnly: true });
  }

  async start(options = {}) {
    if (!this.scopeVerified) return this.inspect();
    this.sharedState = undefined;
    return this.supervisor.start({ takeover: true, controlOnly: true, ...options });
  }

  inspect() {
    if (!this.scopeVerified) return { state: 'unverified', ok: false, enabled: false, reason: 'native_scope_unverified' };
    if (this.sharedState && Date.now() - this.sharedState.at < 5000) return this.sharedState.value;
    return this.supervisor.inspect();
  }

  close() { return this.supervisor.close(); }

  stop() { return this.supervisor.stop(); }
}
