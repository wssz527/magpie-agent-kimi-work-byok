import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeSetup } from './native-setup.mjs';
import { NativeSetupProbe } from './native-status.mjs';
import { nativeFlagFile } from './paths.mjs';
import { readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';

export class NativeOnboarding {
  constructor({ stateDir, kimiDir, setup, probe, dnsPort = 53535 } = {}) {
    this.file = path.join(stateDir, 'native-onboarding.json');
    this.flagFile = nativeFlagFile(kimiDir);
    this.kimiDir = path.resolve(kimiDir);
    this.setup = setup || new NativeSetup({ stateDir, flagFile: this.flagFile });
    this.probe = probe || new NativeSetupProbe({ flagFile: this.flagFile });
    this.dnsPort = dnsPort;
  }

  async ensure({ retry = false } = {}) {
    if (this.pending) return this.pending;
    this.pending = this.run(retry).finally(() => { this.pending = null; });
    return this.pending;
  }

  async run(retry) {
    const current = await this.probe.check();
    if (current.intranet?.passed) {
      if (!current.revealed) {
        try {
          writeSubagentJSON(this.flagFile, this.setup.flagValue());
          this.probe.cached = null;
        } catch { return { state: 'waiting-kimi', reason: 'native_setup_waiting_data' }; }
      }
      return { state: 'ready' };
    }
    if (!fs.existsSync(this.kimiDir)) return { state: 'waiting-kimi', reason: 'native_setup_waiting_data' };
    let previous;
    try { previous = readSubagentJSON(this.file); } catch (error) {
      if (error.code !== 'ENOENT') return { state: 'conflict', reason: 'native_setup_receipt_conflict' };
    }
    if (!retry && previous) return previous.result || { state: 'interrupted', reason: 'native_setup_interrupted' };
    const request = { id: crypto.randomUUID(), action: 'prepare', at: Date.now() };
    writeSubagentJSON(this.file, { schemaVersion: 1, id: request.id, at: request.at });
    const result = await this.setup.run(request, this.dnsPort);
    writeSubagentJSON(this.file, { schemaVersion: 1, id: request.id, at: request.at, result });
    this.probe.cached = null;
    return result;
  }
}
