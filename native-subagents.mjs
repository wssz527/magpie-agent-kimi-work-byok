import path from 'node:path';
import { SubagentPolicy, SubagentRuntime, NativeSubagentBridge } from './vendor/kimi-work-gateway/index.mjs';
import { readSubagentJSON, writeSubagentJSON } from './vendor/kimi-work-gateway/subagent-policy.mjs';

const reason = error => /^subagent_[a-z_]+$|^invalid_subagent_[a-z_]+$/.test(error?.message) ? error.message : 'subagent_operation_failed';

export class NativeSubagents {
  constructor({ stateDir, kimiDir, runtime, native } = {}) {
    this.policy = new SubagentPolicy({ stateDir, kimiDir });
    this.native = native || new NativeSubagentBridge({ stateDir, kimiDir });
    this.runtime = runtime || new SubagentRuntime({ stateDir: path.resolve(stateDir) });
    this.receiptFile = path.join(stateDir, 'subagent-operation-receipt.json');
  }

  async operate(request, policy) {
    if (!request) return;
    if (this.requestID === request.id) return this.operation;
    this.requestID = request.id;
    if (typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(request.id)
      || !['prepare', 'launch'].includes(request.action) || !Number.isFinite(request.at)
      || Math.abs(Date.now() - request.at) > 300000) {
      return this.operation = { state: 'invalid-request' };
    }
    let history = [];
    try { history = readSubagentJSON(this.receiptFile).history; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Array.isArray(history)) throw Error('subagent_file_conflict');
    const previous = history.find(row => row.id === request.id);
    if (previous) return this.operation = previous.result || { state: 'interrupted' };
    history = history.filter(row => Date.now() - row.at < 300000);
    if (history.length >= 128) return this.operation = { state: 'too-many-requests' };
    const record = { id: request.id, action: request.action, at: request.at };
    history.push(record);
    writeSubagentJSON(this.receiptFile, { schemaVersion: 1, history });
    this.operation = { state: 'running', action: request.action };
    try {
      if (request.action === 'launch' && policy?.mode === 'blocked') throw Error('subagent_policy_blocked');
      this.operation = request.action === 'prepare' ? this.runtime.prepare() : await this.runtime.launch();
    } catch (error) { this.operation = { state: 'failed', reason: reason(error) }; }
    record.result = this.operation;
    writeSubagentJSON(this.receiptFile, { schemaVersion: 1, history });
    this.runtimeAfter = 0;
    return this.operation;
  }

  async update(desired, models, request) {
    let policy;
    try { policy = this.policy.configure(desired, models); }
    catch (error) { policy = { mode: 'blocked', reason: reason(error) }; }
    const native = desired?.transport === 'native-config' || desired?.mode === 'pool';
    if (native || this.nativeActive || this.nativeRestoring) {
      this.nativeActive = native;
      this.runtimeStatus = this.native.update(native ? { ...policy, transport: 'native-config' } : { mode: 'inherit', transport: 'native-config' });
      this.nativeRestoring = !native && this.runtimeStatus.state === 'conflict';
      if (native || this.nativeRestoring) return { policy, runtime: this.runtimeStatus };
    }
    try { await this.operate(request, policy); }
    catch (error) { this.operation = { state: 'failed', reason: reason(error) }; }
    const key = JSON.stringify(policy);
    if (key !== this.policyKey || Date.now() >= (this.runtimeAfter || 0)) {
      this.runtimeStatus = this.runtime.inspect();
      this.runtimeAfter = Date.now() + 3000;
      this.policyKey = key;
    }
    return { policy, runtime: this.runtimeStatus, ...(this.operation ? { operation: this.operation } : {}) };
  }

  beforeRequest(protocol, payload) { if (this.nativeActive || this.nativeRestoring) return this.native.beforeRequest(protocol, payload); }
  close() {
    let restored;
    try { if (this.nativeActive || this.nativeRestoring) restored = this.native.close(); } finally { this.policy.close(); }
    if (restored?.state === 'conflict') throw Error('subagent_native_restore_conflict');
    return restored;
  }
}
