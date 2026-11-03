import { normalizeTranslationConfig, TRANSLATION_DEFAULTS } from './vendor/kimi-work-gateway/translation-config.mjs';
import { publicSurfaces } from './vendor/kimi-work-gateway/translation-runtime.mjs';
import { currentDocumentRevision } from './vendor/kimi-work-gateway/subagent-policy.mjs';

// States the embedded runtime and supervisor report. Anything else is shown
// as unavailable rather than guessed at.
const STATES = new Set(['disabled', 'not-started', 'starting', 'attaching', 'active', 'inactive',
  'legacy-running', 'waiting-kimi-exit', 'waiting-quit', 'failed', 'unverified', 'incompatible',
  'stale', 'pending-settings']);
const CODE = /^[a-z][a-z0-9_-]{0,100}$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,127}$/;
const refusal = (status, code) => Object.assign(Error(code), { status, code });
const settingsError = error => refusal(400, typeof error?.message === 'string'
  && /^(invalid_translation_[a-z_]+|translation_endpoint_required)$/.test(error.message)
  ? error.message : 'invalid_translation_config');

// The reasoning translation settings this plugin edits are the same file the
// embedded host and supervisor already read, so a save here needs no second
// store and no restart: the pinned host applies the new revision itself.
export class NativeTranslation {
  constructor({ desktop, env = process.env } = {}) {
    this.desktop = desktop;
    this.env = env;
  }

  // Desired settings as the host reads them. `revision` is the opaque
  // whole-document token currentDocumentRevision() derives from the settings file
  // as it exists right now, not the payload revision stored inside the
  // document — the compare-and-swap token a save must present names the
  // whole file. A missing file is the documented default (translation off,
  // revision null) and is never written by an inspection: an installation
  // that never configured translation keeps no file at all.
  read() {
    let stored;
    try { stored = this.desktop.runtime.desiredSettings(); }
    catch (error) {
      if (error?.code === 'ENOENT') return { revision: null, settings: { ...TRANSLATION_DEFAULTS } };
      throw refusal(409, error?.message === 'translation_scope_conflict'
        ? 'translation_scope_conflict' : 'translation_settings_conflict');
    }
    return { revision: currentDocumentRevision(this.desktop.runtime.settingsFile), settings: stored.settings };
  }

  save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || !input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) {
      throw refusal(400, 'invalid_translation_config');
    }
    if (input.revision !== null && typeof input.revision !== 'string') {
      throw refusal(409, 'translation_settings_conflict');
    }
    const current = this.read();
    if (input.revision !== current.revision) throw refusal(409, 'translation_settings_conflict');
    let settings;
    try { settings = normalizeTranslationConfig(input.settings); } catch (error) { throw settingsError(error); }
    // The whole-document token is handed to the embedded runtime, which
    // re-derives the file's current token right before the rename: a save
    // racing another writer (a standalone gateway, a second panel) fails with
    // translation_settings_conflict there instead of silently overwriting
    // that writer's change. `null` addresses the missing file, so a first
    // save is refused once another process created the file in the meantime.
    try { this.desktop.configure(settings, { expectedRevision: current.revision }); }
    catch (error) {
      if (error?.message === 'translation_scope_conflict' || error?.message === 'translation_settings_conflict') {
        throw refusal(409, error.message);
      }
      throw refusal(503, 'translation_settings_unavailable');
    }
    return this.read();
  }

  // The session's own state, allowlisted field by field. It is deliberately
  // separate from the BYOK connection: a connected gateway says nothing about
  // whether translation is attached. Application paths, pids and any
  // environment value stay out of the answer.
  status() {
    let value;
    try { value = this.desktop.inspect(); }
    catch { return { state: 'failed', reason: 'translation_status_unavailable' }; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { state: 'failed', reason: 'translation_status_unavailable' };
    }
    const status = { state: STATES.has(value.state) ? value.state : 'unavailable' };
    if (typeof value.reason === 'string' && CODE.test(value.reason)) status.reason = value.reason;
    if (typeof value.version === 'string' && VERSION.test(value.version)) status.version = value.version;
    if (value.verification === 'unverified-version') status.verification = 'unverified-version';
    if (typeof value.warning === 'string' && CODE.test(value.warning)) status.warning = value.warning;
    if (value.shared === true) status.shared = true;
    // Per-surface state stays beside the aggregate state: the aggregate says
    // the engine is running, only the surfaces say whether Chat or Work
    // actually shows a reasoning block. The core's own allowlist is reused
    // rather than restated, so this layer cannot drift from the host's shape.
    const surfaces = publicSurfaces(value.surfaces);
    if (surfaces) status.surfaces = surfaces;
    let settings;
    try { settings = this.read().settings; } catch { settings = undefined; }
    // Only the presence of the configured variable is reported, never its
    // value: the host reads it, this settings page only names it.
    if (settings?.provider === 'custom') status.keySet = this.keySet(settings.apiKeyEnv);
    return status;
  }

  keySet(name) {
    try {
      return typeof name === 'string' && Object.hasOwn(this.env || {}, name) && Boolean(this.env[name]);
    } catch { return false; }
  }
}
