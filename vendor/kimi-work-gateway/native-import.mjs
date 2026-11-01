import crypto from 'node:crypto';
import path from 'node:path';
import { NativeAccountContext } from './native-account-context.mjs';
import { nativeDesktopRequest } from './native-desktop-bridge.mjs';
import { readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

export class NativeModelImport {
  constructor({ stateDir, kimiDir, getToken, ensureRuntime, request = nativeDesktopRequest, getContext } = {}) {
    this.stateDir = stateDir;
    this.kimiDir = kimiDir;
    this.file = path.join(stateDir, 'native-import-receipt.json');
    this.getToken = getToken;
    this.ensureRuntime = ensureRuntime;
    this.request = request;
    this.account = new NativeAccountContext({ kimiDir });
    this.getContext = getContext || (() => this.account.read());
    this.after = 0;
  }

  async sync(input) {
    if (this.pending) return this.pending;
    this.pending = this.run(input).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async run(input) {
    if (Date.now() < this.after) return { ok: false, reason: 'native_import_retry_pending' };
    this.after = Date.now() + 3000;
    const context = this.getContext();
    if (typeof context?.profileKey !== 'string' || !/^[a-f0-9]{64}$/.test(context.profileKey)) {
      return this.last = { ok: false, reason: 'native_import_waiting_login' };
    }
    if (input.previousContext?.accountDigest && input.previousContext.accountDigest !== hash(context.accountScope)) {
      return this.last = { ok: false, reason: 'native_import_account_changed' };
    }
    let token;
    try { token = await this.getToken(); } catch {}
    if (typeof token !== 'string' || !token) return this.last = { ok: false, reason: 'native_import_token_unavailable' };
    const preparation = await this.ensureRuntime?.();
    if (preparation?.ok === false) return this.last = { ok: false, reason: preparation.reason || 'native_setup_failed' };
    const status = await this.request(this.kimiDir, 'status');
    if (!status.ok || status.state !== 'ready') return this.last = { ok: false, reason: 'native_bridge_waiting_launch' };
    let previous;
    try { previous = readSubagentJSON(this.file); } catch (error) {
      if (error.code !== 'ENOENT') return this.last = { ok: false, reason: 'native_import_receipt_conflict' };
    }
    const signature = hash(JSON.stringify({ url: input.url, token, models: input.models }));
    if (!this.retry && previous?.account === context.profileKey && previous.applicationPid === status.applicationPid
      && previous.signature === signature && ['profile_missing', 'profile_store_missing'].includes(input.previousContext?.reason)) {
      return this.last = { ok: false, reason: 'native_import_disconnected' };
    }
    const result = await this.request(this.kimiDir, 'import-models', {
      url: input.url, token, expectedAccountKey: context.profileKey,
    });
    if (result.ok) {
      this.retry = false;
      writeSubagentJSON(this.file, { schemaVersion: 1, account: context.profileKey,
        applicationPid: status.applicationPid, signature, models: input.models.length, at: Date.now() });
      try { this.account.capture(context.profileKey); } catch {}
    }
    return this.last = result.ok ? { ok: true } : { ok: false, reason: result.reason || 'native_import_failed' };
  }
}
