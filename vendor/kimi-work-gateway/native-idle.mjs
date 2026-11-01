// Live "is the kernel idle right now" probe.
//
// The runner snapshot is *not* a heartbeat: it is written on lifecycle events, so
// an idle file can be hours old and still be exactly true. Age is therefore not
// evidence, and a 30-second freshness gate would make automatic re-attach wait
// forever. What the file does not prove is that no turn started since it was
// written, so this probe combines it with the daemon's own live, read-only
// control RPCs and requires every piece to agree.
//
// For a running daemon, all of this evidence is required twice before a quit:
//  * the runner file exists at the layout path the daemon reports, has the
//    expected lifecycle and all four activity collections present and zero;
//  * generation pid == control endpoint pid, and the OS process-start identity
//    matches the one recorded;
//  * runtime.status reports operations.activeCount === 0;
//  * every conversation of every agent (full pagination, temporary included)
//    reports busy === false;
//  * re-reading the snapshot afterwards still shows the same generation,
//    endpoint, token identity and zero counters.
//
// A stopped daemon has no control endpoint. It is idle only when all counters
// are zero, its recorded daemon pid is confirmed gone, and a second read proves
// the same stopped generation. Any error, omission, unknown value or page that
// never ends is "not idle". The probe never starts, stops, messages or mutates
// anything: its RPC allowlist is fixed in native-control.mjs.
import { controlEndpoint, processStartIdentity, NativeControlClient } from './native-control.mjs';
import { readSubagentJSON } from './subagent-policy.mjs';
import path from 'node:path';

const MAX_PAGES = 40;
const MAX_CONVERSATIONS = 5000;

const latest = () => {
  const value = new Date();
  return value.toISOString();
};

const integer = value => (Number.isInteger(value) && value >= 0 ? value : null);

// Every activity collection has to be present and zero. A missing field is
// unknown, never zero.
export function runnerSnapshot(state) {
  if (!state || typeof state !== 'object') return { state: 'unknown', reason: 'native_idle_runner_absent' };
  if (state.lifecycleStatus !== 'running') return { state: 'busy', reason: 'native_idle_runner_not_running' };
  const collections = {};
  for (const key of ['activeKernelTurns', 'activeKernelToolCalls', 'activeOperations', 'activePendingInteractions']) {
    const value = state[key];
    if (Array.isArray(value)) collections[key] = value.length;
    else if (Number.isInteger(value) && value >= 0) collections[key] = value;
    else return { state: 'unknown', reason: 'native_idle_runner_incomplete', missing: key };
  }
  const active = Object.values(collections).reduce((sum, value) => sum + value, 0);
  if (active > 0) return { state: 'busy', reason: 'native_idle_runner_active', active };
  return { state: 'idle', counts: collections };
}

export function identityOf(state) {
  const generation = state?.daemonGeneration;
  const endpoint = state?.control?.endpoint;
  const stopped = state?.lifecycleStatus === 'stopped';
  if (!generation || typeof generation !== 'object') return null;
  if (typeof generation.generationId !== 'string' || !generation.generationId) return null;
  const pid = integer(generation.pid);
  if (!pid || !stopped && !endpoint || endpoint && endpoint.pid !== pid) return null;
  const control = stopped ? null : controlEndpoint(state);
  if (!stopped && (typeof endpoint.url !== 'string' || !control)) return null;
  return {
    generationId: generation.generationId,
    pid,
    ...(control ? { endpoint: { host: control.host, port: control.port, url: endpoint.url } } : {}),
    startIdentity: generation.processStartIdentity && typeof generation.processStartIdentity === 'object'
      ? { kind: String(generation.processStartIdentity.kind || 'unknown'),
        value: typeof generation.processStartIdentity.value === 'string' ? generation.processStartIdentity.value : null }
      : { kind: 'unknown', value: null },
    ...(control ? { token: control.token } : {}),
  };
}

export function sameIdentity(left, right) {
  if (!left || !right) return false;
  return left.generationId === right.generationId && left.pid === right.pid
    && left.endpoint?.url === right.endpoint?.url
    && left.startIdentity.kind === right.startIdentity.kind
    && left.startIdentity.value === right.startIdentity.value
    && left.token === right.token;
}

const idle = extra => ({ state: 'idle', checkedAt: latest(), ...extra });
const wait = (reason, extra) => ({ state: 'unknown', reason, checkedAt: latest(), ...extra });
const busy = (reason, extra) => ({ state: 'busy', reason, checkedAt: latest(), ...extra });

// Full pagination. A page without `hasMore` or with `hasMore` but no cursor is a
// stalled enumeration, not an empty tail: it waits rather than assuming.
async function conversations(client, agentId) {
  const keys = [];
  let cursor;
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = { agentId, includeTemporary: true, limit: 100, ...(cursor === undefined ? {} : { cursor }) };
    const result = await client.send('conversations.list', params);
    const rows = Array.isArray(result?.conversations) ? result.conversations : null;
    if (!rows) return { reason: 'native_idle_conversations_invalid' };
    // Only the key is kept: titles and previews are dropped here, before this
    // function returns, so they never reach a caller or a log.
    for (const row of rows) {
      if (typeof row?.conversationKey !== 'string' || !row.conversationKey) {
        return { reason: 'native_idle_conversations_invalid' };
      }
      keys.push(row.conversationKey);
      if (keys.length > MAX_CONVERSATIONS) return { reason: 'native_idle_conversations_too_many' };
    }
    const more = result.page?.hasMore;
    if (more === false) return { keys };
    if (more !== true) return { reason: 'native_idle_conversations_incomplete' };
    const next = result.page?.nextCursor;
    if (typeof next !== 'string' || !next) return { reason: 'native_idle_conversations_incomplete' };
    if (seen.has(next)) return { reason: 'native_idle_conversations_incomplete' };
    seen.add(next);
    cursor = next;
  }
  return { reason: 'native_idle_conversations_incomplete' };
}

async function agents(client, kimiDir) {
  const status = await client.send('runtime.status', {});
  if (!status || typeof status !== 'object') return { reason: 'native_idle_status_invalid' };
  if (status.operations?.activeCount !== 0) {
    return { reason: Number.isInteger(status.operations?.activeCount)
      ? 'native_idle_operations_active' : 'native_idle_operations_unknown' };
  }
  const entries = status.layout?.agents?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return { reason: 'native_idle_layout_invalid' };
  const expected = path.join(path.resolve(kimiDir), 'agents', 'main', 'runner.state.json');
  const found = entries.find(entry => entry?.agentId === 'main');
  if (!found || typeof found.runnerStatePath !== 'string') return { reason: 'native_idle_layout_invalid' };
  if (path.resolve(found.runnerStatePath) !== expected) return { reason: 'native_idle_layout_mismatch' };
  if (entries.some(entry => typeof entry?.agentId !== 'string' || !entry.agentId)) {
    return { reason: 'native_idle_layout_invalid' };
  }
  return { agents: entries.map(entry => ({ agentId: entry.agentId })), status };
}

// One live read-only pass. `deps` exists so tests can drive the state machine
// without opening a socket.
export async function probeLiveIdle({ kimiDir, clientFactory, identity = processStartIdentity,
  platform = process.platform } = {}) {
  const file = path.join(path.resolve(kimiDir), 'agents', 'main', 'runner.state.json');
  let before;
  try { before = readSubagentJSON(file); }
  catch (error) {
    return wait(error?.code === 'ENOENT' ? 'native_idle_runner_absent' : 'native_idle_runner_unreadable');
  }
  const stopped = before?.lifecycleStatus === 'stopped';
  const snapshot = runnerSnapshot(stopped ? { ...before, lifecycleStatus: 'running' } : before);
  if (snapshot.state !== 'idle') {
    return snapshot.state === 'busy' ? busy(snapshot.reason, { active: snapshot.active })
      : wait(snapshot.reason, snapshot.missing ? { missing: snapshot.missing } : {});
  }
  const identityBefore = identityOf(before);
  if (!identityBefore) return wait('native_idle_identity_invalid');
  // A running daemon must retain its exact process-start identity. For a
  // stopped daemon, a confirmed dead pid is the evidence that no work remains.
  const observed = identity(identityBefore.pid, { platform });
  if (observed.kind === 'not_found') {
    if (!stopped) return wait('native_idle_process_not_found');
    let after;
    try { after = readSubagentJSON(file); }
    catch { return wait('native_idle_runner_unreadable'); }
    const afterSnapshot = after?.lifecycleStatus === 'stopped'
      ? runnerSnapshot({ ...after, lifecycleStatus: 'running' }) : null;
    if (afterSnapshot?.state !== 'idle' || !sameIdentity(identityBefore, identityOf(after))) {
      return wait('native_idle_identity_changed');
    }
    return idle({ generationId: identityBefore.generationId, pid: identityBefore.pid, evidence: 'daemon-stopped' });
  }
  if (observed.kind === 'unknown' || typeof observed.value !== 'string' || !observed.value) {
    return wait('native_idle_process_identity_unknown');
  }
  if (stopped) return wait('native_idle_process_still_running');
  if (identityBefore.startIdentity.kind !== observed.kind || identityBefore.startIdentity.value !== observed.value) {
    return wait('native_idle_process_identity_mismatch');
  }

  const endpoint = controlEndpoint(before);
  if (!endpoint) return wait('native_idle_endpoint_invalid');
  const client = (clientFactory || (value => new NativeControlClient({ endpoint: value })))(endpoint);
  try {
    await client.connect();
    const layout = await agents(client, kimiDir);
    if (layout.reason) return wait(layout.reason);
    for (const agent of layout.agents) {
      const listed = await conversations(client, agent.agentId);
      if (listed.reason) return wait(listed.reason, { agentId: agent.agentId });
      for (const conversationKey of listed.keys) {
        const result = await client.send('conversations.getBusy', { conversationKey });
        if (!result || typeof result !== 'object') return wait('native_idle_busy_invalid');
        if (result.busy === true) return busy('native_idle_conversation_busy');
        if (result.busy !== false || result.conversationKey !== conversationKey) return wait('native_idle_busy_invalid');
      }
    }
  } catch (error) {
    // A closed socket, timeout, refused method or RPC error is never idle.
    return wait(trusted(error) || 'native_idle_control_failed');
  } finally {
    client.close?.();
  }

  // Re-read after the RPCs: the generation, endpoint and token must be the same
  // ones that were just queried, and the counters must still be zero.
  let after;
  try { after = readSubagentJSON(file); }
  catch { return wait('native_idle_runner_unreadable'); }
  const snapshotAfter = runnerSnapshot(after);
  if (snapshotAfter.state !== 'idle') return wait('native_idle_evidence_changed');
  if (!sameIdentity(identityBefore, identityOf(after))) return wait('native_idle_identity_changed');
  return idle({ generationId: identityBefore.generationId, pid: identityBefore.pid });
}

function trusted(error) {
  return typeof error?.code === 'string' && /^native_(control|idle)_[a-z0-9_]+$/.test(error.code) ? error.code : null;
}

// Reusable entry point for the service runner's drain check: two consecutive
// agreeing probes are required, so a single lucky reading cannot authorize a
// quit. `probe` may be replaced to reuse the check with another evidence source.
export async function confirmLiveIdle(options, { attempts = 2, delayMs = 0, probe = probeLiveIdle } = {}) {
  let previous;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const result = await probe(options);
    if (result.state !== 'idle') return result;
    if (previous && previous.state === 'idle' && previous.generationId === result.generationId) {
      return { ...result, consecutive: 2 };
    }
    previous = result;
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return { ...previous, state: 'unknown', reason: 'native_idle_not_confirmed' };
}
