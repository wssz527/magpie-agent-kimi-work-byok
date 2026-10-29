import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSubagentJSON, writeSubagentJSON } from './vendor/kimi-work-gateway/subagent-policy.mjs';

const panelFile = fileURLToPath(new URL('./ui/.runtime-state.js', import.meta.url));
const plainReason = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,100}$/.test(value) ? value : undefined;

export class WorkPanel {
  constructor(adapter, { file = panelFile } = {}) {
    this.adapter = adapter;
    this.file = file;
    this.receipt = path.join(adapter.stateDir, 'panel-model-receipt.json');
  }

  async selectMain(request, models, runner) {
    if (!request) return;
    if (typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(request.id)
      || !Number.isFinite(request.at) || typeof request.model !== 'string') return this.mainStatus = { state: 'invalid-request' };
    let history = [];
    try {
      const receipt = readSubagentJSON(this.receipt);
      if (receipt.schemaVersion !== 1 || !Array.isArray(receipt.history) || receipt.history.length > 128
        || receipt.history.some(row => !row || typeof row.id !== 'string' || typeof row.model !== 'string' || !Number.isFinite(row.at))) throw Error();
      history = receipt.history;
    } catch (error) { if (error.code !== 'ENOENT') return this.mainStatus = { state: 'conflict' }; }
    const previous = history.find(row => row.id === request.id);
    if (previous) return this.mainStatus = previous.model !== request.model || previous.at !== request.at
      ? { state: 'conflict' } : previous.result || { state: 'interrupted' };
    if (Math.abs(Date.now() - request.at) > 300000) return this.mainStatus = { state: 'expired-request' };
    const model = models.find(row => row.id === request.model);
    if (!model) return this.mainStatus = { state: 'blocked', reason: 'model_not_enabled_for_kimi' };
    if (runner?.lifecycleStatus !== 'running') return this.mainStatus = { state: 'waiting-kimi' };
    if ((runner.activeKernelTurns?.length || Number(runner.activeKernelTurns) || 0)
      || (runner.activeKernelToolCalls?.length || Number(runner.activeKernelToolCalls) || 0)) return this.mainStatus = { state: 'waiting-idle' };
    history = history.filter(row => Date.now() - row.at < 300000);
    if (history.length >= 128) return this.mainStatus = { state: 'too-many-requests' };
    const record = { id: request.id, at: request.at, model: model.id };
    history.push(record);
    writeSubagentJSON(this.receipt, { schemaVersion: 1, history });
    try {
      const alias = (model.protocol === 'chat' ? 'byok-kth-kimi/' : 'byok-kth-resp/') + model.id;
      await this.adapter.rpcCall(runner, 'conversations.setModel', { modelAlias: alias });
      this.mainStatus = { state: 'requested', model: model.id };
    } catch { this.mainStatus = { state: 'failed', reason: 'kimi_control_rejected' }; }
    record.result = this.mainStatus;
    writeSubagentJSON(this.receipt, { schemaVersion: 1, history });
    return this.mainStatus;
  }

  publish(status, models) {
    try {
      let currentModel;
      try {
        const doc = JSON.parse(fs.readFileSync(this.adapter.configFile, 'utf8'));
        if (typeof doc.model?.current === 'string' && doc.model.current.length <= 2048) currentModel = doc.model.current;
      } catch {}
      const runtime = status.subagents?.runtime || {};
      const data = { schemaVersion: 1, at: Date.now(), code: plainReason(status.code),
        models: models.map(row => ({ id: row.id, name: row.name || row.id, tools: row.tools === true,
          reasoningEfforts: row.reasoningEfforts || [], defaultEffort: row.defaultEffort })),
        currentModel, main: this.mainStatus ? { state: plainReason(this.mainStatus.state),
          ...(models.some(row => row.id === this.mainStatus.model) ? { model: this.mainStatus.model } : {}),
          reason: plainReason(this.mainStatus.reason) } : undefined,
        subagents: { mode: status.subagents?.policy?.mode, state: plainReason(runtime.state),
          reason: plainReason(runtime.reason), observed: runtime.observed?.state === 'observed-schema',
          transport: runtime.transport === 'native-config' ? 'native-config' : 'runtime-copy' },
      };
      const directory = path.dirname(this.file);
      if (fs.lstatSync(directory).isSymbolicLink()) throw Error();
      try { const stat = fs.lstatSync(this.file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const contents = 'globalThis.KIMI_WORK_STATE = ' + JSON.stringify(data).replace(/</g, '\\u003c')
        + '; globalThis.dispatchEvent(new Event("kimi-work-state"));\n';
      const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
      try { fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.file); }
      finally { fs.rmSync(temporary, { force: true }); }
      this.publication = { state: 'ready' };
    } catch { this.publication = { state: 'unavailable', reason: 'panel_assets_not_writable' }; }
  }
}
