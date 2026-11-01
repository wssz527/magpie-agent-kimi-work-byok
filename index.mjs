import { LocalKimiAdapter as KimiAdapter } from './native-controller.mjs';

const instance = Symbol.for('magpie.kimi-desktop.adapter.v1');

export default async function KimiDesktop(input, options = {}) {
  if (!globalThis[instance]) {
    const log = code => {
      try {
        void input?.client?.app?.log?.({ body: { service: 'kimi-desktop', level: 'warn', message: code } })?.catch?.(() => {});
      } catch { /* No configuration, credentials or raw RPC errors in logs. */ }
    };
    const adapter = await new KimiAdapter({ home: process.env.MAGPIE_KIMI_DATA_HOME || undefined,
      log, copyTokenRequest: options.copyTokenRequest, setupRequest: options.setupRequest,
      subagentRequest: options.subagentRequest, workModels: options.workModels, panelPort: options.workPanelPort }).start();
    globalThis[instance] = adapter;
    process.stdin.once('end', () => { void adapter.retire().catch(() => log('adapter_retire_failed')); });
    process.once('exit', () => adapter.restoreFileOnExit());
  }
  globalThis[instance].options = { ...globalThis[instance].options,
    setupRequest: options.setupRequest, copyTokenRequest: options.copyTokenRequest,
    subagentRequest: options.subagentRequest, workModels: options.workModels };
  return {};
}
