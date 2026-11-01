// Keeps a private-pipe translation session attached across Kimi restarts.
//
// TranslationRuntime.launch() starts one detached host that owns exactly one
// Kimi child spawned with -remote-debugging-pipe. When that child exits — a
// plain restart from the Kimi updater, an installed-package update, or a
// manual quit — nothing re-attaches, so the next Kimi instance runs without the
// pipe and translation silently disappears. This supervisor watches the
// application lifecycle and installation identity and re-establishes the
// private pipe, without ever force-killing anything.
//
// Rules the state machine is built around:
//  * A healthy managed session stays attached; an older entry point migrates
//    once when the durable takeover grant permits it and live idleness is proven.
//  * Without the durable `allowTakeover` grant the running application is only
//    replaced when the installation changed or a managed session ended just
//    before a replacement appeared. With the grant — the user enabling the
//    integration — any ordinary Kimi may be closed normally and re-attached.
//  * Kimi is never started from nothing by a periodic tick. Starting happens on
//    an explicit start, or right after a quit this supervisor itself requested
//    completed. A user closing Kimi never reopens it.
//  * Before a quit is requested the live probe must prove the current generation
//    idle: the runner snapshot's four activity collections present and zero, a
//    matching pid / process-start identity / layout path, zero active daemon
//    operations, and every conversation not busy. The snapshot's age is not
//    evidence — it is not a heartbeat — but a missing or unreadable field is.
//    Any error, omission or unknown value means wait, never "probably idle".
//  * The quit is bound to one process whose executable path was verified. If two
//    builds share the name the state waits instead of choosing one.
//  * A quit is a normal application close request. It is issued at most once per
//    retry window and never escalated to a kill; when it does not produce a real
//    process exit the state is waiting-kimi-exit with the reason, not a pretend
//    success. Renderer/DOM contract failures back off instead of restarting.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';
import { installationChanged, installationIdentity, remoteRuntimeRevision } from './translation-runtime.mjs';
import { probeLiveIdle } from './native-idle.mjs';
import { publicRemoteRuntime } from './remote-runtime-state.mjs';
import { verifiedRemoteApplication } from './remote-companion.mjs';

const SCHEMA = 1;
const DEFAULT_INTERVAL = 2000;
const DEFAULT_QUIT_TIMEOUT = 25000;
const DEFAULT_TAKEOVER_WINDOW = 15 * 60 * 1000;
const DEFAULT_RETRY_QUIT_AFTER = 30 * 60 * 1000;
// A session that keeps failing on the DOM contract will keep failing after a
// restart, so its retries back off instead of looping.
const DEFAULT_CONTRACT_COOLDOWN = 10 * 60 * 1000;
const REPORTED = new Set(['disabled', 'not-started', 'starting', 'attaching', 'active', 'inactive',
  'legacy-running', 'waiting-kimi-exit', 'waiting-quit', 'failed']);
const TERMINAL_CONTRACT = new Set(['translation_renderer_failed', 'translation_renderer_unconfirmed']);

const safeReason = error => (/^translation_[a-z0-9_-]{1,80}$/.test(error?.message)
  ? error.message : 'translation_supervisor_failed');
const trustedCode = error => (typeof error?.code === 'string' && /^native_[a-z0-9_]+$/.test(error.code) ? error.code : null);

// Four required activity collections, each present and zero. A missing field is
// unknown, never zero: "the file does not say" must never read as "nothing is
// running". The snapshot is not a heartbeat, so age is deliberately not used —
// an idle file may be hours old and still be exactly true.
export function runnerEvidence(value) {
  if (!value || typeof value !== 'object') return { state: 'unavailable' };
  const counts = {};
  for (const key of ['activeKernelTurns', 'activeKernelToolCalls', 'activeOperations', 'activePendingInteractions']) {
    const field = value[key];
    const count = Array.isArray(field) ? field.length : Number.isInteger(field) && field >= 0 ? field : null;
    if (count === null) return { state: 'unavailable', missing: key };
    counts[key] = count;
  }
  const active = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (value.lifecycleStatus !== 'running') return { state: 'busy', active, reason: 'native_idle_runner_not_running' };
  return active > 0 ? { state: 'busy', active } : { state: 'idle' };
}

export function runnerStateFile(kimiDir) {
  return path.join(path.resolve(kimiDir), 'agents', 'main', 'runner.state.json');
}

export function inspectRunner(kimiDir) {
  let value;
  try { value = readSubagentJSON(runnerStateFile(kimiDir)); }
  catch (error) { return { state: error?.code === 'ENOENT' ? 'absent' : 'unavailable' }; }
  return runnerEvidence(value);
}

// A normal application close request for one exact pid.
//
// macOS asks AppKit to terminate the running application: the same request the
// Dock "Quit" menu makes. It neither force-kills nor raises the app, and needs
// no Accessibility permission. Windows asks the main window to close; the
// caller must still observe a real process exit, because a close request is not
// an exit. Anything else reports unsupported instead of guessing.
export function requestQuit(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'translation_application_pid_invalid' };
  if (platform === 'darwin') {
    const script = 'ObjC.import("AppKit");'
      + ' const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(' + pid + ');'
      + ' if (!app || app.isNil()) { "missing" } else { String(app.terminate) }';
    const result = spawnSync('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 10000, windowsHide: true });
    if (result.error || result.status !== 0) return { ok: false, reason: 'translation_quit_unavailable' };
    const answer = String(result.stdout || '').trim();
    if (answer === 'missing') return { ok: true, missing: true };
    return answer === 'true' ? { ok: true } : { ok: false, reason: 'translation_quit_refused' };
  }
  if (platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$p = Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue;'
      + ' if ($p) { [void]$p.CloseMainWindow() }'], { windowsHide: true, timeout: 10000 });
    if (result.error || result.status !== 0) return { ok: false, reason: 'translation_quit_unavailable' };
    return { ok: true };
  }
  return { ok: false, reason: 'translation_quit_unavailable' };
}

export class TranslationSupervisor {
  constructor({ stateDir, kimiDir, env = process.env, runtime, protectedEnvNames = [],
    interval = DEFAULT_INTERVAL, quitTimeout = DEFAULT_QUIT_TIMEOUT, takeoverWindow = DEFAULT_TAKEOVER_WINDOW,
    retryQuitAfter = DEFAULT_RETRY_QUIT_AFTER, contractCooldown = DEFAULT_CONTRACT_COOLDOWN,
    platform = process.platform, inspector, quit, relaunch, gatewayBusy, probe, now = () => Date.now(),
    launchOptions = {} } = {}) {
    this.stateDir = path.resolve(stateDir);
    this.homeDir = path.resolve(kimiDir);
    this.env = env;
    this.runtime = runtime;
    this.protectedEnvNames = protectedEnvNames;
    this.interval = interval;
    this.quitTimeout = quitTimeout;
    this.takeoverWindow = takeoverWindow;
    this.retryQuitAfter = retryQuitAfter;
    this.contractCooldown = contractCooldown;
    this.platform = platform;
    this.inspector = inspector || { inspectApplication: application => this.runtime.inspectApplication(application, platform),
      runningPids: application => this.runtime.runningPids(application, platform) };
    this.quit = quit || (pid => requestQuit(pid, platform));
    this.relaunch = relaunch || (options => this.runtime.launch(options));
    this.gatewayBusy = gatewayBusy || (() => 0);
    // The live read-only idleness proof. Injected in tests; the real one opens
    // the daemon control socket and never mutates anything.
    this.probe = probe || (options => probeLiveIdle({ kimiDir: this.homeDir, platform, ...options }));
    this.now = now;
    this.launchOptions = launchOptions;
    this.file = path.join(this.stateDir, 'translation-supervisor.json');
    this.timer = null;
    this.task = null;
    this.last = null;
    this.closed = false;
  }

  // --- persisted intent ---------------------------------------------------
  // Enabling supervision is an explicit, separate decision: editing translation
  // settings never turns it on by itself.
  read() {
    let value;
    try { value = readSubagentJSON(this.file); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Error('translation_supervisor_conflict');
    }
    if (value?.schemaVersion !== SCHEMA || value.homeDir !== this.homeDir) throw Error('translation_supervisor_conflict');
    return value;
  }

  write(patch = {}) {
    const previous = this.read() || {};
    const merged = { schemaVersion: SCHEMA, homeDir: this.homeDir, enabled: false, state: 'disabled',
      at: this.now(), ...previous, ...patch };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    writeSubagentJSON(this.file, merged);
    return merged;
  }

  inspect() {
    let record;
    try { record = this.read(); }
    catch (error) { return { state: 'failed', reason: error.message }; }
    if (!record) return { state: 'disabled', enabled: false };
    if (record.enabled !== true) {
      return { state: 'disabled', enabled: false, ...(record.state === 'disabled' ? {} : {}) };
    }
    const remote = ['starting', 'attaching', 'active', 'inactive', 'legacy-running'].includes(record.state)
      ? publicRemoteRuntime(record.remote) : undefined;
    return { state: REPORTED.has(record.state) ? record.state : 'failed', enabled: true,
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
      ...(Number.isInteger(record.applicationPid) ? { applicationPid: record.applicationPid } : {}),
      ...(typeof record.application === 'string' ? { application: record.application } : {}),
      ...(typeof record.version === 'string' ? { version: record.version } : {}),
      ...(remote ? { remote } : {}) };
  }

  settings() {
    try { return this.runtime.desiredSettings().settings; }
    catch (error) { return { error: safeReason(error) }; }
  }

  installation() {
    try { return this.runtime.locate({ ...(this.runtime.installationOptions || {}), env: this.runtime.env }); }
    catch { return null; }
  }

  // --- lifecycle ----------------------------------------------------------
  // `takeover: true` is the durable grant the user gives when they enable the
  // integration: from then on, an ordinary Kimi started by the user (or by an
  // update) may be closed normally and re-attached, instead of waiting for a
  // manual quit. It is never inferred from settings.
  async start(options = {}) {
    this.reopen();
    const takeover = options.takeover === true || this.read()?.allowTakeover === true;
    this.write({ enabled: true, state: 'starting', reason: undefined, allowTakeover: takeover, remote: undefined,
      ...(options.controlOnly === true ? { controlOnly: true } : {}) });
    this.arm();
    return this.tick({ ...options, allowStart: true, takeover });
  }

  // Reconciles supervision. Restores the timer when a previous process left the
  // intent enabled, and never starts Kimi from nothing unless a quit this
  // supervisor requested is what removed it.
  async ensure(options = {}) {
    const record = this.read();
    if (record?.enabled === true) this.arm();
    return this.tick(options);
  }

  arm() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.interval);
    this.timer.unref?.();
  }

  async tick(options = {}) {
    if (this.task) return this.task;
    if (this.closed) return { state: 'disabled' };
    this.task = this.pass(options).catch(error => ({ state: 'failed', reason: safeReason(error) }))
      .finally(() => { this.task = null; });
    this.last = await this.task;
    return this.last;
  }

  async stop() {
    this.close();
    let session;
    let launch;
    try { session = this.runtime.sessionReceipt(); } catch {}
    try { launch = this.runtime.activeLaunch(); } catch {}
    const remoteApplication = verifiedRemoteApplication({ stateDir: this.stateDir, receipt: session, launch });
    let remotePid;
    if (remoteApplication && session.state !== 'exited'
      && Number.isInteger(session.applicationPid) && session.applicationPid > 0) {
      try {
        if (this.applicationProcesses(remoteApplication).pids.includes(session.applicationPid)) remotePid = session.applicationPid;
      } catch {}
    }
    this.write({ enabled: false, state: 'disabled', reason: undefined, quit: undefined, quitFailure: undefined,
      allowTakeover: undefined });
    if (remotePid) {
      const result = this.quit(remotePid);
      return { ...this.inspect(), remoteQuit: result?.ok ? 'requested' : result?.reason || 'translation_quit_failed' };
    }
    return this.inspect();
  }

  close() {
    this.closed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    return this.inspect();
  }

  // Re-arms a closed supervisor (a later enable in the same process).
  reopen() {
    this.closed = false;
    return this;
  }

  save(patch) {
    const remote = publicRemoteRuntime(patch.remote);
    const value = this.write({ ...patch, remote });
    return { state: value.state, ...(value.reason ? { reason: value.reason } : {}),
      ...(value.version ? { version: value.version } : {}), ...(remote ? { remote } : {}) };
  }

  // The receipt of a session this scope still owns, judged by the host process
  // itself. A `failed` receipt may only mean the renderer could not be injected:
  // the host is still alive and still owns the private pipe, so starting a second
  // host would fight over the same Kimi. Only a recorded exit ends ownership.
  managedSession() {
    let receipt;
    try { receipt = this.runtime.sessionReceipt(); } catch { return null; }
    if (!receipt || receipt.state === 'exited') return null;
    if (!this.runtime.isAlive(receipt.pid)) return null;
    return receipt;
  }

  async pass(options) {
    let record;
    try { record = this.read(); }
    catch (error) { return { state: 'failed', reason: error.message }; }
    if (record?.enabled !== true) return { state: 'disabled' };
    const controlOnly = record.controlOnly === true || this.launchOptions.controlOnly === true;
    const settings = this.settings();
    if (settings.error) return this.save({ state: 'failed', reason: settings.error });
    // A control-only supervisor exists for the native bridge; translation is
    // optional there and its absence is not a reason to stop maintaining the pipe.
    if (!settings.enabled && !controlOnly) return this.save({ state: 'disabled', reason: 'translation_disabled' });
    const installation = this.installation();
    if (!installation) return this.save({ state: 'failed', reason: 'translation_kimi_unavailable' });

    const session = this.managedSession();
    let launch;
    try { launch = this.runtime.activeLaunch(); } catch {}
    const remoteApplication = verifiedRemoteApplication({ stateDir: this.stateDir, receipt: session, launch });
    let inspection;
    try {
      inspection = this.applicationProcesses(installation.application);
      if (remoteApplication) {
        const remote = this.applicationProcesses(remoteApplication);
        inspection = { pids: [...new Set([...inspection.pids, ...remote.pids])],
          nameMatches: Math.max(inspection.nameMatches, remote.nameMatches) };
      }
    } catch { return this.save({ state: 'failed', reason: 'translation_process_check_failed' }); }
    const pids = inspection.pids;

    const ours = session !== null && Number.isInteger(session.applicationPid) && pids.includes(session.applicationPid);
    if (!ours && (inspection.nameMatches > pids.length || pids.length > 1)) {
      return this.save({ state: 'waiting-kimi-exit', reason: 'translation_application_ambiguous',
        application: installation.application, version: installation.version });
    }

    if (ours && session.state === 'failed' && /^translation_pipe_/.test(session.reason || '')) {
      return this.takeover(record, installation, [session.applicationPid], options);
    }
    if (ours) {
      const remoteRequested = this.launchOptions.remoteModels === true;
      const revision = remoteRequested ? remoteRuntimeRevision() : undefined;
      const incompatibleLaunch = launch && (remoteRequested
        ? launch.remoteModels !== true || revision && launch.remoteRevision !== revision
        : launch.remoteModels === true);
      if (incompatibleLaunch && (record.allowTakeover === true || options.takeover === true)) {
        return this.takeover(record, installation, [session.applicationPid], options);
      }
      return this.save({ state: REPORTED.has(session.state) ? session.state : 'active', reason: undefined,
        application: installation.application, version: installation.version,
        applicationPid: session.applicationPid, identity: this.identityFor(record, installation), remote: session.remote,
        quit: undefined, quitFailure: undefined });
    }
    if (session) {
      // Our host is still attached but its Kimi process is gone: the host is
      // about to record the exit. Starting anything now would duplicate it. A
      // quit we requested ourselves keeps its own state so an in-flight close
      // is not reported as a surprise exit.
      if (!Number.isInteger(session.applicationPid)) {
        // The host exists but has not spawned its application yet; this is a
        // start in progress, not an exit.
        return this.save({ state: 'starting', application: installation.application, version: installation.version });
      }
      if (record.quit && pids.length === 0 && this.now() < record.quit.deadline) {
        return this.save({ state: 'waiting-quit', reason: 'translation_waiting_quit',
          application: installation.application, version: installation.version });
      }
      return this.save({ state: 'waiting-kimi-exit', reason: 'translation_application_exited',
        application: installation.application, version: installation.version, quit: undefined });
    }
    // A managed session that failed because its pipe closed has nothing to
    // recover: the host is gone with it. That is the one failure a restart fixes.
    if (this.contractCoolingDown(record)) {
      return this.save({ state: 'failed', reason: record.contractFailure.reason,
        application: installation.application, version: installation.version });
    }
    let current;
    try { current = this.runtime.inspect(); }
    catch { return this.save({ state: 'failed', reason: 'translation_session_failed' }); }
    if (current.state === 'stale') return this.save({ state: 'failed', reason: 'translation_host_stale' });
    if (current.state === 'starting' || current.state === 'attaching') {
      // A host was just started and has not spawned its application yet.
      return this.save({ state: current.state, application: installation.application, version: installation.version });
    }
    if (pids.length === 0) {
      // Nothing is running. Kimi is only started here when the caller explicitly
      // asked for it (start / an explicit enable), or right after a quit this
      // supervisor requested itself completed — that is the update re-attach
      // path, not a Kimi the user closed on their own. A periodic tick never
      // starts Kimi from nothing, so a user quit cannot become an endless
      // relaunch.
      const justQuit = record.quit !== undefined;
      if (options.allowStart === true || justQuit) return this.launch(installation, options);
      return this.save({ state: 'waiting-kimi-exit', reason: 'translation_kimi_not_running',
        application: installation.application, version: installation.version, quit: undefined });
    }

    // A Kimi instance that is not our managed child is running.
    const evidence = this.takeoverEvidence(record, installation, options);
    if (evidence.reason) return this.save({ state: 'waiting-kimi-exit', reason: evidence.reason,
      application: installation.application, version: installation.version });
    return this.takeover(record, installation, pids, options);
  }

  // An injected inspector may only know pids; the real one also reports how many
  // processes share the executable name so ambiguity can be refused.
  applicationProcesses(application) {
    if (typeof this.inspector.inspectApplication === 'function') return this.inspector.inspectApplication(application);
    const pids = this.runningPids(application);
    return { pids, nameMatches: pids.length };
  }

  runningPids(application) {
    const pids = this.inspector.runningPids(application);
    return Array.isArray(pids) ? pids.filter(pid => Number.isInteger(pid) && pid > 0) : [];
  }

  identityFor(record, installation) {
    const current = installationIdentity({ ...installation, application: installation.application });
    return record.identity && !installationChanged(record.identity, installation) ? record.identity : current;
  }

  // A session that keeps failing on the renderer/DOM contract will fail the same
  // way after a restart, so it backs off instead of looping.
  contractCoolingDown(record) {
    const failure = record.contractFailure;
    return Boolean(failure) && typeof failure.reason === 'string'
      && Number.isFinite(failure.at) && this.now() - failure.at < this.contractCooldown;
  }

  // Runs the live probe and requires the same generation to have been idle on the
  // previous pass. `confirm` is the pre-quit recheck: it only needs one fresh
  // idle reading of the generation already agreed on.
  async idleEvidence(record, { confirm = false } = {}) {
    let result;
    try { result = await this.probe({ kimiDir: this.homeDir }); }
    catch (error) { return { reason: 'unknown', detail: trustedCode(error) || 'native_idle_probe_failed' }; }
    if (!result || result.state !== 'idle') {
      this.write({ idleEvidence: undefined });
      return { reason: result?.state === 'busy' ? 'busy' : 'unknown', detail: result?.reason };
    }
    if (!confirm) {
      const previous = record.idleEvidence;
      if (!previous || previous.generationId !== result.generationId) {
        this.write({ idleEvidence: { generationId: result.generationId, at: this.now() } });
        return { reason: 'unknown', detail: 'native_idle_not_confirmed' };
      }
    }
    return { generationId: result.generationId };
  }

  // Decides whether the running instance may be replaced. A durable takeover
  // grant allows replacing any ordinary Kimi; without it, only a changed
  // installation or a just-ended managed session qualifies.
  takeoverEvidence(record, installation, options) {
    const granted = record.allowTakeover === true || options.takeover === true;
    if (granted) return { granted: true };
    if (record.identity && installationChanged(record.identity, installation)) return { changed: true };
    let receipt;
    try { receipt = this.runtime.sessionReceipt(); } catch { receipt = null; }
    // Still attached, or never had a managed session here: nothing proves this
    // instance is a replacement for ours.
    if (!receipt) return { reason: 'translation_kimi_running' };
    if (receipt.state !== 'exited' && receipt.state !== 'failed') return { reason: 'translation_kimi_running' };
    // A session that failed on its own ended nothing — Kimi was never ours.
    if (receipt.state === 'failed' && receipt.exit?.kind !== 'application-exit') {
      return { reason: 'translation_kimi_running' };
    }
    const ended = Number.isFinite(receipt.at) ? receipt.at : null;
    if (ended === null || this.now() - ended > this.takeoverWindow) return { reason: 'translation_kimi_running' };
    return { replacement: true };
  }

  async takeover(record, installation, pids, options) {
    const now = this.now();
    // A quit request survives across ticks and across a gateway restart, so a
    // close that is still being processed is neither repeated nor forgotten.
    const quit = record.quit && pids.includes(record.quit.pid) ? record.quit : null;
    if (quit) {
      if (now < quit.deadline) {
        return this.save({ state: 'waiting-quit', reason: 'translation_waiting_quit',
          application: installation.application, version: installation.version });
      }
      // The application ignored the close request. Report it, and do not ask
      // again for the same process until the retry window has passed.
      this.write({ quit: undefined, quitFailure: { pid: quit.pid, at: now, reason: 'translation_quit_timeout' } });
      return this.save({ state: 'waiting-kimi-exit', reason: 'translation_quit_timeout',
        application: installation.application, version: installation.version });
    }

    const failure = record.quitFailure;
    if (failure && pids.includes(failure.pid) && now - failure.at < this.retryQuitAfter) {
      return this.save({ state: 'waiting-kimi-exit',
        reason: typeof failure.reason === 'string' ? failure.reason : 'translation_quit_failed',
        application: installation.application, version: installation.version });
    }

    // Live, read-only idleness proof. A single good reading is not enough: the
    // grant says "restart me when I am really idle", and a turn can start
    // between two ticks, so the evidence has to agree across consecutive passes.
    const evidence = await this.idleEvidence(record);
    if (evidence.reason) {
      return this.save({ state: 'waiting-kimi-exit',
        reason: evidence.reason === 'busy' ? 'translation_kimi_busy' : 'translation_runner_evidence_unavailable',
        ...(evidence.detail ? { detail: evidence.detail } : {}),
        application: installation.application, version: installation.version });
    }
    let busy;
    try { busy = this.gatewayBusy(); }
    catch { busy = NaN; }
    if (!Number.isFinite(busy) || busy !== 0) {
      return this.save({ state: 'waiting-kimi-exit',
        reason: Number.isFinite(busy) ? 'translation_gateway_busy' : 'translation_gateway_evidence_unavailable',
        application: installation.application, version: installation.version });
    }

    // Re-confirm immediately before the close request: the window between a
    // check and the quit is the one interval a read-only probe cannot close.
    const recheck = await this.idleEvidence(record, { confirm: true });
    if (recheck.reason || recheck.generationId !== evidence.generationId) {
      this.write({ idleEvidence: undefined });
      return this.save({ state: 'waiting-kimi-exit',
        reason: recheck.reason === 'busy' ? 'translation_kimi_busy' : 'translation_runner_evidence_unavailable',
        application: installation.application, version: installation.version });
    }

    const pid = pids[0];
    const result = this.quit(pid);
    if (!result?.ok) {
      this.write({ quit: undefined, quitFailure: { pid, at: now, reason: result?.reason || 'translation_quit_failed' } });
      return this.save({ state: 'waiting-kimi-exit', reason: result?.reason || 'translation_quit_failed',
        application: installation.application, version: installation.version });
    }
    if (result.missing) return this.launch(installation, options);
    // The evidence that authorised this close is spent; a later takeover of a
    // new generation must collect its own.
    this.write({ idleEvidence: undefined });
    return this.save({ state: 'waiting-quit', reason: 'translation_waiting_quit',
      quit: { pid, at: now, deadline: now + this.quitTimeout },
      application: installation.application, version: installation.version });
  }

  async launch(installation, options = {}) {
    const controlOnly = this.launchOptions.controlOnly === true || options.controlOnly === true;
    let result;
    try {
      result = await this.relaunch({ ...this.launchOptions, ...options,
        subagentRuntime: options.subagentRuntime ?? this.launchOptions.subagentRuntime,
        controlOnly, nativeBridge: controlOnly ? true : options.nativeBridge === true,
        isRunning: () => false, protectedEnvNames: this.protectedEnvNames });
    } catch (error) {
      return this.save({ state: 'failed', reason: safeReason(error) });
    }
    // A completed launch clears the finished quit bookkeeping so a later
    // takeover is not blocked by a stale failure from an older process.
    this.write({ quit: undefined, quitFailure: undefined });
    const state = ['starting', 'active', 'attaching', 'inactive'].includes(result?.state) ? result.state : 'starting';
    // The renderer/DOM contract is a property of the Kimi build, not of the
    // process: remembering the failure makes the next takeover wait instead of
    // restarting into the identical failure.
    const contractFailure = result?.state === 'failed' && TERMINAL_CONTRACT.has(result.reason)
      ? { reason: result.reason, at: this.now() } : undefined;
    return this.save({ state, reason: result?.reason, application: installation.application, version: installation.version,
      identity: installationIdentity({ ...installation, application: installation.application }),
      ...(contractFailure ? { contractFailure } : { contractFailure: undefined }),
      ...(result?.warning ? { warning: result.warning } : {}) });
  }
}

export const TRANSLATION_SUPERVISOR_SCHEMA = SCHEMA;

// The supervisor state lives beside the translation receipts so a gateway
// restart resumes the same intent instead of forgetting it.
export function translationSupervisorFile(stateDir) {
  return path.join(path.resolve(stateDir), 'translation-supervisor.json');
}

export function readTranslationSupervisor(stateDir) {
  try { return readSubagentJSON(translationSupervisorFile(stateDir)); }
  catch { return null; }
}

export function supervisorEnabled(stateDir) {
  const record = readTranslationSupervisor(stateDir);
  return record?.schemaVersion === SCHEMA && record.enabled === true;
}
