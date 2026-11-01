import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeAccountContext } from './native-account-context.mjs';

// Kimi's native BYOK import is the authority for what the model menu offers:
// it owns `byok-providers.json` (the profile), and its own generator rewrites
// `config.json` from that profile. This module never writes the profile and
// never decrypts a credential. It reconciles the generated file outwards from
// the profile, and only touches entries it can prove it wrote or that already
// agree with the profile.
//
// Three boundaries shape everything below:
//
// - The profile is per account. A profile that cannot be tied to the caller's
//   account is never substituted for another account's, so an account switch
//   ends in a report instead of a silent revive.
// - A missing or changed profile cannot be repaired from a local snapshot.
//   Only the native import (with the user's own token) can create one, so the
//   module reports `needs-native-import` and, when the caller explicitly
//   authorised that step, hands it to the injected `syncNative` callback.
// - `config.json` may be rewritten by Kimi at any moment. Every write is
//   preceded by a byte comparison against what was parsed, and a foreign entry
//   (or one another source owns) is a conflict rather than an overwrite.
//
// Nothing here depends on a Kimi version or build hash: profiles are read by
// shape (`kind`/`id`/`models`), providers by the model `family`, and the
// profile store's own `v` field is tolerated rather than asserted.
export const NATIVE_WORK_INTENT = 'native-work-intent.json';
export const NATIVE_WORK_LOCK = '.kimi-work-gateway-owner.json';
export const NATIVE_WORK_STORE = 'byok-providers.json';
export const NATIVE_WORK_CONFIG = 'config.json';
export const NATIVE_WORK_SCHEMA = 1;

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_INTENT_BYTES = 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
const HEX64 = /^[a-f0-9]{64}$/;
const STALE_LOCK_MS = 60000;
// Reasons a native import may be asked to recreate the profile. An account
// change, a foreign URL or an ambiguous owner is a user decision instead.
const IMPORTABLE = new Set(['profile_missing', 'profile_store_missing', 'models_missing',
  'base_url_changed', 'credential_missing', 'profile_delisted']);
const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const isPlain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 2048) => typeof value === 'string' && value.length > 0
  && value.length <= limit && !CONTROL.test(value);
const hex = value => typeof value === 'string' && HEX64.test(value);
const lastSegment = id => id.slice(id.lastIndexOf('/') + 1).toLowerCase();
const uniqueSorted = value => Array.isArray(value)
  ? [...new Set(value.filter(item => typeof item === 'string'))].sort() : undefined;

// Key order differs between Kimi's generator, a hand edit and this module, so
// equality and ownership digests use one canonical serialisation.
function stable(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}
const digestOf = value => sha256(stable(value));

export function normalizeNativeUrl(value) {
  if (!text(value)) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return parsed.href.replace(/\/+$/, '');
}

// Kimi routes a model by its own name, so the family a profile row declares is
// the only field that decides which provider type it belongs to.
function rowFamily(row) {
  if (row.family === 'kimi' || row.family === 'responses') return row.family;
  if (typeof row.alias === 'string' && row.alias.startsWith('byok-kth-kimi/')) return 'kimi';
  if (typeof row.alias === 'string' && row.alias.startsWith('byok-kth-resp/')) return 'responses';
  return typeof row.model === 'string' && lastSegment(row.model).startsWith('kimi-') ? 'kimi' : 'responses';
}

const providerType = row => rowFamily(row) === 'kimi' ? 'kimi' : 'openai_responses';

function readJsonFile(file, limit) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    return { kind: error.code === 'ENOENT' ? 'absent' : 'unavailable' };
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > limit) return { kind: 'unsafe' };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { kind: 'unavailable' }; }
  const bom = raw.startsWith('\uFEFF');
  let value;
  try { value = JSON.parse(bom ? raw.slice(1) : raw); } catch { return { kind: 'corrupt', raw }; }
  if (!isPlain(value)) return { kind: 'corrupt', raw };
  return { kind: 'valid', raw, bom, value };
}

// Profiles are found by shape, never by a slot name or a store version. The
// store may carry `v`, extra top-level fields and per-profile fields this
// module does not know about; all of them are left alone.
function kthProfiles(store) {
  if (!isPlain(store.profiles)) return [];
  const found = [];
  for (const [key, entry] of Object.entries(store.profiles)) {
    if (!isPlain(entry)) continue;
    for (const [slot, candidate] of Object.entries(entry)) {
      if (!isPlain(candidate)) continue;
      if (!(candidate.kind === 'kth' || candidate.id === 'byok-kth'
        || slot === 'byok-kth' && typeof candidate.baseUrl === 'string')) continue;
      found.push({ key, slot, profile: candidate });
      break;
    }
  }
  return found;
}

// Only a row with everything needed to generate a provider/model entry counts;
// a partially written profile is reported through `missingModels` instead of
// being guessed at.
function profileRows(profile) {
  if (!Array.isArray(profile.models)) return [];
  const rows = [];
  for (const row of profile.models) {
    if (!isPlain(row)) continue;
    if (!text(row.alias, 1024) || !text(row.providerId, 512) || !text(row.model, 1024)) continue;
    if (!Number.isSafeInteger(row.maxContextSize) || row.maxContextSize <= 0) continue;
    rows.push(row);
  }
  return rows;
}

function modelEntry(row) {
  const entry = { provider: row.providerId, model: row.model, maxContextSize: row.maxContextSize };
  if (Number.isSafeInteger(row.maxOutputSize) && row.maxOutputSize > 0) entry.maxOutputSize = row.maxOutputSize;
  if (Array.isArray(row.capabilities)) {
    const capabilities = uniqueSorted(row.capabilities);
    if (capabilities?.length) entry.capabilities = capabilities;
  }
  if (Array.isArray(row.supportEfforts)) {
    const efforts = uniqueSorted(row.supportEfforts);
    if (efforts?.length) {
      entry.supportEfforts = efforts;
      if (typeof row.defaultEffort === 'string' && efforts.includes(row.defaultEffort)) {
        entry.defaultEffort = row.defaultEffort;
      }
    }
  }
  return entry;
}

function providerMatches(current, desired) {
  if (!isPlain(current)) return false;
  return current.type === desired.type
    && normalizeNativeUrl(current.baseUrl) === desired.baseUrl
    && current.credential === desired.credential;
}

// Unknown fields a generator or the user added are preserved: a matching entry
// is adopted as-is instead of being rewritten into this module's shape.
function modelMatches(current, desired) {
  if (!isPlain(current)) return false;
  if (stable(current.provider) !== stable(desired.provider)) return false;
  if (stable(current.model) !== stable(desired.model)) return false;
  if (stable(current.maxContextSize) !== stable(desired.maxContextSize)) return false;
  if (stable(current.maxOutputSize) !== stable(desired.maxOutputSize)) return false;
  if (stable(uniqueSorted(current.capabilities)) !== stable(desired.capabilities)) return false;
  if (stable(uniqueSorted(current.supportEfforts)) !== stable(desired.supportEfforts)) return false;
  if (stable(current.defaultEffort) !== stable(desired.defaultEffort)) return false;
  return true;
}

// The caller may hand over ids alone; the protocol is then derived the same
// way Kimi derives it, so this module never depends on a caller-side list.
function normalizeCatalog(models) {
  if (!Array.isArray(models) || !models.length || models.length > 256) return null;
  const seen = new Set();
  const catalog = [];
  for (const entry of models) {
    const row = typeof entry === 'string' ? { id: entry } : entry;
    if (!isPlain(row) || !text(row.id, 1024) || seen.has(row.id)) return null;
    const protocol = row.protocol === undefined ? (lastSegment(row.id).startsWith('kimi-') ? 'chat' : 'responses')
      : row.protocol;
    if (protocol !== 'chat' && protocol !== 'responses') return null;
    seen.add(row.id);
    catalog.push({ id: row.id, protocol });
  }
  return catalog;
}

const resolveScope = (primary, secondary) => text(primary, 512) ? primary
  : text(secondary, 512) ? secondary : null;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

const publicOwner = owner => ({
  sourceID: text(owner?.sourceID, 128) ? owner.sourceID : 'unknown',
  ...(text(owner?.url, 2048) ? { url: owner.url } : {}),
});

function intentSignature(value) {
  if (!value) return null;
  return stable({ sourceID: value.sourceID, kimiHome: value.kimiHome, url: value.url,
    accountDigest: value.accountDigest, profileKeyDigest: value.profileKeyDigest,
    credentialRef: value.credentialRef, aliases: value.aliases, entries: value.entries,
    active: value.active, catalogRevision: value.catalogRevision ?? null });
}

// An owned entry records the digest that proves it, and whether this tool wrote
// it. A merely adopted entry (already generated by Kimi) is never deleted by an
// explicit disconnect, because deleting it would be a change Kimi did not ask
// for; a written one is removed, and only while its digest still matches.
function ownedEntries(intent) {
  const raw = isPlain(intent?.entries) ? intent.entries : {};
  const keep = value => isPlain(value) ? Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => isPlain(entry) && hex(entry.digest))
    .map(([key, entry]) => [key, { digest: entry.digest, written: entry.written === true }])) : {};
  return { providers: keep(raw.providers), models: keep(raw.models) };
}

export class NativeWorkIntegration {
  // No filesystem access happens here: an instance may be constructed before
  // the caller knows whether the integration is wanted at all.
  constructor({ stateDir, kimiDir, sourceID = 'gateway', getContext, syncNative } = {}) {
    if (!text(stateDir, 4096)) throw Error('invalid_integration_state_dir');
    if (!text(kimiDir, 4096)) throw Error('invalid_integration_kimi_dir');
    this.stateDir = path.resolve(stateDir);
    this.kimiDir = path.resolve(kimiDir);
    this.sourceID = text(sourceID, 128) ? sourceID : 'gateway';
    this.accountContext = new NativeAccountContext({ stateDir, kimiDir });
    this.getContext = typeof getContext === 'function' ? getContext : () => this.accountContext.read();
    this.syncNative = typeof syncNative === 'function' ? syncNative : undefined;
    this.configPath = path.join(this.kimiDir, NATIVE_WORK_CONFIG);
    this.storePath = path.join(this.kimiDir, NATIVE_WORK_STORE);
    this.intentPath = path.join(this.stateDir, NATIVE_WORK_INTENT);
    this.lockPath = path.join(this.kimiDir, NATIVE_WORK_LOCK);
    this.ownerID = crypto.randomUUID();
    this.locked = false;
  }

  // --- files ---------------------------------------------------------------

  readStore() { return readJsonFile(this.storePath, MAX_STORE_BYTES); }

  readConfig() { return readJsonFile(this.configPath, MAX_CONFIG_BYTES); }

  readIntent() {
    let stat;
    try { stat = fs.lstatSync(this.intentPath); } catch (error) {
      return { kind: error.code === 'ENOENT' ? 'absent' : 'unsafe' };
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_INTENT_BYTES) return { kind: 'unsafe' };
    let raw;
    try { raw = fs.readFileSync(this.intentPath, 'utf8'); } catch { return { kind: 'unsafe' }; }
    let value;
    try { value = JSON.parse(raw); } catch { return { kind: 'corrupt', raw }; }
    if (!isPlain(value) || value.schemaVersion !== NATIVE_WORK_SCHEMA || !isPlain(value.entries)) {
      return { kind: 'corrupt', raw };
    }
    return { kind: 'valid', raw, value };
  }

  writeIntent(value) {
    try { fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 }); } catch { return 'intent_unavailable'; }
    let stat;
    try { stat = fs.lstatSync(this.stateDir); } catch { return 'intent_unavailable'; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'intent_unavailable';
    try {
      const current = fs.lstatSync(this.intentPath);
      if (current.isSymbolicLink() || !current.isFile()) return 'intent_unavailable';
    } catch (error) { if (error.code !== 'ENOENT') return 'intent_unavailable'; }
    return this.replaceFile(this.intentPath, JSON.stringify(value, null, 2) + '\n', 0o600);
  }

  restoreIntent(raw) {
    if (raw === null) { try { fs.rmSync(this.intentPath, { force: true }); } catch {} return; }
    this.replaceFile(this.intentPath, raw, 0o600);
  }

  replaceFile(file, content, mode) {
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, content, { mode, flag: 'wx' });
      fs.renameSync(temporary, file);
      return null;
    } catch { return 'write_failed'; } finally { fs.rmSync(temporary, { force: true }); }
  }

  // The generated file is replaced atomically, and only while the bytes that
  // were parsed are still the bytes on disk: Kimi's generator or an editor
  // racing this call wins, and this call reports the conflict.
  commitConfig(raw, content) {
    let current;
    try { current = fs.readFileSync(this.configPath, 'utf8'); } catch (error) {
      return error.code === 'ENOENT' ? 'config_missing' : 'config_unavailable';
    }
    if (current !== raw) return 'concurrent_modification';
    let mode = 0o600;
    try { mode = fs.statSync(this.configPath).mode & 0o777; } catch {}
    return this.replaceFile(this.configPath, content, mode);
  }

  // --- shared owner lock ---------------------------------------------------

  // The lock lives beside `config.json`, so every installation sharing a Kimi
  // home shares it wherever its own state directory is. A plugin and the
  // standalone CLI therefore cannot edit the generated file at the same time,
  // and the receipt names which source holds it.
  acquireLock() {
    let stat;
    try { stat = fs.lstatSync(this.kimiDir); } catch (error) {
      return error.code === 'ENOENT' ? { ok: true, skipped: true } : { ok: false, reason: 'path_unavailable' };
    }
    if (!stat.isDirectory()) return { ok: false, reason: 'path_unavailable' };
    let raw = null;
    try { raw = fs.readFileSync(this.lockPath, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') return { ok: false, reason: 'lock_unavailable' };
    }
    if (raw !== null) {
      let owner = null;
      try { owner = JSON.parse(raw); } catch {}
      if (!isPlain(owner) || !text(owner.ownerID, 128)) {
        let age = 0;
        try { age = Date.now() - fs.statSync(this.lockPath).mtimeMs; } catch {}
        // An unreadable lock is ambiguous until it is old enough to be dead.
        if (age < STALE_LOCK_MS) return { ok: false, reason: 'lock_corrupt' };
      } else if (owner.ownerID === this.ownerID) {
        this.locked = true;
        return { ok: true };
      } else if (text(owner.kimiHome, 4096) && path.resolve(owner.kimiHome) !== this.kimiDir) {
        return { ok: false, reason: 'owner_conflict', owner: publicOwner(owner) };
      } else if (pidAlive(owner.pid)) {
        return { ok: false, reason: 'owner_conflict', owner: publicOwner(owner) };
      }
      try {
        if (fs.readFileSync(this.lockPath, 'utf8') !== raw) return { ok: false, reason: 'owner_conflict' };
        fs.rmSync(this.lockPath);
      } catch (error) { return { ok: false, reason: error.code === 'ENOENT' ? 'owner_conflict' : 'lock_unavailable' }; }
    }
    try {
      fs.writeFileSync(this.lockPath, JSON.stringify({ ownerID: this.ownerID, sourceID: this.sourceID,
        kimiHome: this.kimiDir, pid: process.pid, at: new Date().toISOString() }) + '\n',
      { mode: 0o600, flag: 'wx' });
      this.locked = true;
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error.code === 'EEXIST' ? 'owner_conflict' : 'lock_unavailable' };
    }
  }

  releaseLock() {
    if (!this.locked) return false;
    this.locked = false;
    try {
      const raw = fs.readFileSync(this.lockPath, 'utf8');
      if (JSON.parse(raw).ownerID !== this.ownerID) return false;
      fs.rmSync(this.lockPath);
      return true;
    } catch { return false; }
  }

  peekLock() {
    try {
      const owner = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (!isPlain(owner)) return { state: 'corrupt' };
      const alive = pidAlive(owner.pid);
      return { state: owner.ownerID === this.ownerID ? 'held-by-self' : alive ? 'held' : 'stale',
        ...publicOwner(owner) };
    } catch (error) { return { state: error.code === 'ENOENT' ? 'free' : 'corrupt' }; }
  }

  // --- public surface ------------------------------------------------------

  // The main loop may call this every tick: with nothing to change it reads the
  // same files, writes no receipt and returns the same result.
  async reconcile(options = {}) {
    const initial = this.baseResult(options?.enabled !== false, null);
    if (!isPlain(options)) return this.conflict(initial, 'invalid_request');
    const context = this.readContext();
    if (context === null) return this.conflict(initial, 'context_unavailable');
    const scope = resolveScope(options.accountScope, context.accountScope);
    const scopeDigest = scope === null ? null : sha256(scope);
    const enabled = options.enabled !== false;
    const base = this.baseResult(enabled, scopeDigest);
    const target = normalizeNativeUrl(options.url);
    const catalog = normalizeCatalog(options.models);
    if (target === null || catalog === null) return this.conflict(base, 'invalid_request');

    const lock = this.acquireLock();
    if (!lock.ok) {
      return { ...base, state: 'conflict', reason: lock.reason, ...(lock.owner ? { lock: lock.owner } : {}) };
    }
    try {
      const catalogRevision = options.allowNativeImport === true
        ? digestOf({ models: options.models, connectionRevision: options.connectionRevision ?? null }) : null;
      const receiptPath = path.join(this.stateDir, 'native-work-catalog.json');
      const receipt = readJsonFile(receiptPath, MAX_INTENT_BYTES);
      if (catalogRevision !== null && receipt.kind !== 'absent') {
        if (receipt.kind !== 'valid' || receipt.value.schemaVersion !== NATIVE_WORK_SCHEMA
          || !hex(receipt.value.catalogRevision)) return this.conflict(base, 'catalog_receipt_unavailable');
        if (receipt.value.sourceID !== this.sourceID || receipt.value.kimiHome !== this.kimiDir) {
          return this.conflict(base, 'catalog_receipt_foreign');
        }
      }
      const profileKeyDigest = text(context.profileKey, 512) ? sha256(context.profileKey) : null;
      const accepted = catalogRevision !== null && receipt.kind === 'valid'
        && receipt.value.url === target && receipt.value.accountDigest === scopeDigest
        && receipt.value.profileKeyDigest === profileKeyDigest
        && receipt.value.catalogRevision === catalogRevision;
      const request = { enabled, target, catalog, context, scopeDigest,
        options: accepted ? { ...options, confirmedCatalogRevision: catalogRevision } : options };
      let result;
      try { result = this.evaluate(request); } catch { result = this.conflict(base, 'integration_failed'); }
      const intent = this.readIntent();
      const refresh = catalogRevision !== null && result.imported === true
        && intent.value?.catalogRevision !== catalogRevision;
      const credentialRepair = result.state === 'waiting-config' && result.reason === 'credential_not_generated';
      if (options.allowNativeImport === true && typeof this.syncNative === 'function'
        && (result.state === 'needs-native-import' && IMPORTABLE.has(result.reason) || credentialRepair || refresh)) {
        const outcome = await this.callSyncNative({ target, catalog,
          result: refresh ? { ...result, reason: 'catalog_changed' } : result });
        if (outcome.ok === true) {
          try {
            fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
            const directory = fs.lstatSync(this.stateDir);
            if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error();
            const current = readJsonFile(receiptPath, MAX_INTENT_BYTES);
            if (current.kind !== receipt.kind || current.raw !== receipt.raw) throw Error();
            const failure = this.replaceFile(receiptPath, JSON.stringify({ schemaVersion: NATIVE_WORK_SCHEMA,
              sourceID: this.sourceID, kimiHome: this.kimiDir, url: target, accountDigest: scopeDigest,
              profileKeyDigest, catalogRevision }) + '\n', 0o600);
            if (failure) throw Error();
          } catch { return this.conflict(base, 'catalog_receipt_unavailable'); }
        }
        let retried;
        const confirmed = outcome.ok === true ? { ...request,
          options: { ...options, confirmedCatalogRevision: catalogRevision } } : request;
        try { retried = this.evaluate(confirmed); } catch { retried = this.conflict(base, 'integration_failed'); }
        retried.nativeImport = outcome.ok === true ? { attempted: true, ok: true }
          : { attempted: true, ok: false, reason: outcome.reason };
        if (refresh && !outcome.ok) retried = { ...retried, state: 'waiting-native-sync' };
        return retried;
      }
      if (result.state === 'needs-native-import') {
        result.nativeImport = { required: true, reason: result.reason };
      }
      return result;
    } finally {
      this.releaseLock();
    }
  }

  // A read-only summary for status surfaces: no lock, no writes, no secret.
  inspect() {
    const intentRead = this.readIntent();
    const intent = intentRead.kind === 'valid' ? intentRead.value : null;
    const store = this.readStore();
    const config = this.readConfig();
    const candidates = store.kind === 'valid' ? kthProfiles(store.value) : [];
    const selected = intent && hex(intent.profileKeyDigest)
      ? candidates.find(candidate => sha256(candidate.key) === intent.profileKeyDigest)
      : candidates.length === 1 ? candidates[0] : null;
    const profile = selected ? this.profileSummary(selected.profile) : { state: 'missing' };
    const doc = config.kind === 'valid' ? config.value : null;
    const providers = isPlain(doc?.model?.providers) ? Object.keys(doc.model.providers) : [];
    const models = isPlain(doc?.model?.models) ? Object.keys(doc.model.models) : [];
    const aliases = isPlain(intent?.aliases) ? Object.fromEntries(Object.entries(intent.aliases)
      .filter(([, alias]) => text(alias, 1024))) : {};
    return {
      sourceID: this.sourceID,
      intent: { present: Boolean(intent), active: intent?.active === true,
        ...(text(intent?.url, 2048) ? { url: intent.url } : {}),
        ...(hex(intent?.accountDigest) ? { accountDigest: intent.accountDigest.slice(0, 16) } : {}),
        aliases },
      profile,
      config: { state: config.kind, providers: providers.length, models: models.length,
        ...(text(doc?.model?.current, 1024) ? { current: doc.model.current } : {}),
        ...(doc?.byokSnapshotRev === undefined ? {} : { snapshotRev: doc.byokSnapshotRev }),
        matching: Object.values(aliases).filter(alias => models.includes(alias)).length },
      lock: this.peekLock(),
    };
  }

  close() { return { state: 'closed', released: this.releaseLock() }; }

  // --- evaluation ----------------------------------------------------------

  readContext() {
    if (typeof this.getContext !== 'function') return {};
    let value;
    try { value = this.getContext(); } catch { return null; }
    if (value === undefined || value === null) return {};
    if (!isPlain(value)) return null;
    return { accountScope: value.accountScope, profileKey: value.profileKey, profile: value.profile };
  }

  baseResult(enabled, scopeDigest) {
    return {
      sourceID: this.sourceID,
      enabled,
      state: 'idle',
      imported: false,
      changed: false,
      aliases: {},
      missingProviders: [],
      missingModels: [],
      account: { scope: scopeDigest === null ? 'unknown' : 'provided',
        ...(scopeDigest === null ? {} : { digest: scopeDigest.slice(0, 16) }) },
    };
  }

  conflict(base, reason, extra = {}) { return { ...base, state: 'conflict', reason, ...extra }; }

  importResult(base, reason, extra = {}) {
    return { ...base, state: 'needs-native-import', reason, imported: false, ...extra };
  }

  profileSummary(profile) {
    const total = Array.isArray(profile.models) ? profile.models.length : 0;
    const rows = profileRows(profile);
    const state = profile.pending !== undefined && profile.pending !== null ? 'pending'
      : profile.delisted === true ? 'delisted' : 'active';
    return {
      state,
      models: total,
      ...(typeof profile.revision === 'string' || Number.isFinite(profile.revision)
        ? { revision: profile.revision } : {}),
      ...(text(profile.importedAt, 64) ? { importedAt: profile.importedAt } : {}),
      ...(rows.length === total ? {} : { malformed: total - rows.length }),
    };
  }

  pendingSummary(pending) {
    if (!isPlain(pending)) return { present: true };
    return { present: true,
      ...(typeof pending.rev === 'string' || Number.isFinite(pending.rev) ? { rev: pending.rev } : {}),
      ...(Array.isArray(pending.models) ? { models: pending.models.length } : {}),
      ...(text(pending.importedAt, 64) ? { importedAt: pending.importedAt } : {}) };
  }

  selectProfile(candidates, context, scope, scopeDigest) {
    const wanted = text(context.profileKey, 512) ? context.profileKey : null;
    if (wanted) {
      const found = candidates.find(candidate => candidate.key === wanted || sha256(wanted) === candidate.key);
      return found ? { key: found.key, profile: found.profile } : { key: null, profile: null };
    }
    if (scopeDigest !== null) {
      const found = candidates.find(candidate => candidate.key === scopeDigest
        || candidate.key === scope || sha256(candidate.key) === scopeDigest);
      return found ? { key: found.key, profile: found.profile } : { key: null, profile: null };
    }
    return { ambiguous: true };
  }

  evaluate({ enabled, target, catalog, options, context, scopeDigest }) {
    const intentRead = this.readIntent();
    if (intentRead.kind === 'unsafe') return this.conflict(this.baseResult(enabled, scopeDigest), 'intent_unavailable');
    const intent = intentRead.kind === 'valid' ? intentRead.value : null;
    const base = this.baseResult(enabled, scopeDigest);
    if (!enabled) return this.disconnect({ base, intent, intentRead });

    if (options.nativeProfile !== undefined && options.nativeProfile !== null && !isPlain(options.nativeProfile)) {
      return this.conflict(base, 'invalid_request');
    }
    if (context.profile !== undefined && context.profile !== null && !isPlain(context.profile)) {
      return this.conflict(base, 'invalid_request');
    }
    // A confirmed account switch ends the old import; it is never repaired by
    // reaching for another account's profile.
    if (intent && hex(intent.accountDigest) && scopeDigest !== null && intent.accountDigest !== scopeDigest) {
      return this.importResult(base, 'account_changed');
    }

    let profile = isPlain(options.nativeProfile) ? options.nativeProfile
      : isPlain(context.profile) ? context.profile : null;
    let selectedKey = null;
    let storeKind = 'injected';
    if (!profile) {
      const store = this.readStore();
      storeKind = store.kind;
      if (store.kind === 'absent') return this.importResult(base, 'profile_store_missing');
      if (store.kind === 'unsafe') return this.conflict(base, 'profile_store_unavailable');
      if (store.kind === 'corrupt') return this.conflict(base, 'profile_store_corrupt');
      const chosen = this.selectProfile(kthProfiles(store.value), context, null, scopeDigest, intent);
      if (chosen.ambiguous) return { ...base, state: 'account-unverified', reason: 'account_ambiguous' };
      profile = chosen.profile ?? null;
      selectedKey = chosen.key ?? null;
    }
    if (!profile) {
      // Either the store holds no kth profile, or the one this tool imported is
      // gone. Neither can be rebuilt here: only the native import can create a
      // profile, and it needs the user's own token.
      return this.importResult(base, storeKind === 'absent' ? 'profile_store_missing' : 'profile_missing');
    }
    if (intent && hex(intent.profileKeyDigest) && selectedKey !== null
      && sha256(selectedKey) !== intent.profileKeyDigest) {
      return this.importResult(base, 'account_changed', { profile: this.profileSummary(profile) });
    }
    // Without an account or a profile key, the recorded intent must still name
    // the profile for its entries to be treated as this tool's.
    if (!intent || !hex(intent.profileKeyDigest)) {
      if (scopeDigest === null && selectedKey === null && isPlain(options.nativeProfile ?? context.profile)) {
        return { ...base, state: 'account-unverified', reason: 'account_unverified',
          profile: this.profileSummary(profile) };
      }
    }

    const profileInfo = this.profileSummary(profile);
    if (profile.pending !== undefined && profile.pending !== null) {
      // An unfinished native import is a transaction in flight: its models are
      // not active yet, so nothing is generated from them and nothing is
      // cleared. The native side completes or discards it.
      return { ...base, state: 'pending', reason: 'native_profile_pending',
        profile: profileInfo, pending: this.pendingSummary(profile.pending) };
    }
    if (profile.delisted === true) {
      return this.importResult(base, 'profile_delisted', { profile: profileInfo });
    }
    const profileUrl = normalizeNativeUrl(profile.baseUrl);
    if (profileUrl === null) return this.importResult(base, 'profile_invalid', { profile: profileInfo });
    if (profileUrl !== target) {
      // A profile this tool last imported, that now points somewhere else, is
      // drift this tool can repair through a native import. A profile it never
      // imported belongs to another source and is reported instead.
      const previous = intent && intent.active === true ? normalizeNativeUrl(intent.url) : null;
      return this.importResult(base, previous !== null ? 'base_url_changed' : 'foreign_url',
        { profile: profileInfo, url: target });
    }
    const credentialRef = text(profile.credentialRef, 512) ? profile.credentialRef : null;
    if (!credentialRef) {
      // The profile names no credential, so it cannot be completed locally; a
      // fresh native import is the only route.
      return this.importResult(base, 'credential_missing', { profile: profileInfo });
    }

    const config = this.readConfig();
    if (config.kind === 'absent') {
      // A file that is momentarily gone keeps the intent: it comes back with
      // the generator, and only an explicit disconnect clears what we know.
      return { ...base, state: 'waiting-config', reason: 'config_missing', profile: profileInfo };
    }
    if (config.kind === 'unsafe') return this.conflict(base, 'config_unavailable');
    if (config.kind === 'corrupt') return this.conflict(base, 'invalid_config');
    const doc = config.value;
    if (!isPlain(doc.model) || !isPlain(doc.credentials)) return this.conflict(base, 'invalid_config');
    if (doc.model.providers !== undefined && !isPlain(doc.model.providers)) return this.conflict(base, 'invalid_config');
    if (doc.model.models !== undefined && !isPlain(doc.model.models)) return this.conflict(base, 'invalid_config');
    const credential = doc.credentials[credentialRef];
    if (!isPlain(credential) || !text(credential.apiKey, 4096)) {
      // The profile is intact and its credential reference still exists; only
      // the generated copy of the key is missing. That is repaired by Kimi's
      // own generator (or a native re-import), never invented here, so the
      // report is a waiting state rather than a local write.
      return { ...base, state: 'waiting-config', reason: 'credential_not_generated',
        profile: profileInfo, credentialRef };
    }

    const rows = profileRows(profile);
    const matched = [];
    const missingModels = [];
    for (const model of catalog) {
      const wanted = model.protocol === 'chat' ? 'kimi' : 'responses';
      const found = rows.find(row => row.model === model.id && rowFamily(row) === wanted)
        ?? rows.find(row => row.model === model.id);
      if (found) matched.push({ model, row: found }); else missingModels.push(model.id);
    }
    const aliases = {};
    for (const { model, row } of matched) aliases[model.id] = row.alias;
    if (Object.values(aliases).some((alias, index, all) => all.indexOf(alias) !== index)) {
      return this.importResult(base, 'profile_invalid', { profile: profileInfo });
    }
    if (missingModels.length) {
      return this.importResult(base, 'models_missing', { aliases, missingModels, profile: profileInfo });
    }

    const providerTypes = new Map();
    for (const { row } of matched) {
      const type = providerType(row);
      if (providerTypes.has(row.providerId) && providerTypes.get(row.providerId) !== type) {
        return this.importResult(base, 'profile_invalid', { profile: profileInfo });
      }
      providerTypes.set(row.providerId, type);
    }
    const desiredProviders = new Map();
    for (const [providerId, type] of providerTypes) {
      desiredProviders.set(providerId, { type, baseUrl: target, credential: credentialRef });
    }

    const owned = ownedEntries(intent);
    const existingProviders = isPlain(doc.model.providers) ? doc.model.providers : {};
    const existingModels = isPlain(doc.model.models) ? doc.model.models : {};
    // An entry is repairable while it still equals the digest recorded for it:
    // nothing else has touched it since this tool last reconciled it, so
    // rewriting it restores what the profile says. Once the bytes differ from
    // that digest, the change belongs to the generator, another source or the
    // user, and it is reported instead of replaced.
    for (const [providerId, desired] of desiredProviders) {
      const current = existingProviders[providerId];
      if (current === undefined || providerMatches(current, desired)) continue;
      if (owned.providers[providerId]?.digest === digestOf(current)) continue;
      return this.conflict(base, 'foreign_provider', { provider: providerId, profile: profileInfo });
    }
    for (const { row } of matched) {
      const desired = modelEntry(row);
      const current = existingModels[row.alias];
      if (current === undefined || modelMatches(current, desired)) continue;
      if (owned.models[row.alias]?.digest === digestOf(current)) continue;
      return this.conflict(base, 'foreign_model', { alias: row.alias, profile: profileInfo });
    }

    const next = JSON.parse(JSON.stringify(doc));
    if (!isPlain(next.model.providers)) next.model.providers = {};
    if (!isPlain(next.model.models)) next.model.models = {};
    const entries = { providers: {}, models: {} };
    let changed = false;
    for (const [providerId, desired] of desiredProviders) {
      const current = existingProviders[providerId];
      if (current !== undefined && providerMatches(current, desired)) {
        entries.providers[providerId] = { digest: digestOf(current),
          written: owned.providers[providerId]?.written === true };
      } else {
        next.model.providers[providerId] = desired;
        entries.providers[providerId] = { digest: digestOf(desired), written: true };
        changed = true;
      }
    }
    for (const { row } of matched) {
      const desired = modelEntry(row);
      const current = existingModels[row.alias];
      if (current !== undefined && modelMatches(current, desired)) {
        entries.models[row.alias] = { digest: digestOf(current),
          written: owned.models[row.alias]?.written === true };
      } else {
        next.model.models[row.alias] = desired;
        entries.models[row.alias] = { digest: digestOf(desired), written: true };
        changed = true;
      }
    }

    // Identity is recorded as digests only. The store slot key is itself a
    // digest of the account, so its hash is what proves the same profile later;
    // an injected profile without a key cannot prove it and records none.
    const sameAccount = scopeDigest !== null && hex(intent?.accountDigest)
      && intent.accountDigest === scopeDigest;
    const nextIntent = {
      schemaVersion: NATIVE_WORK_SCHEMA,
      sourceID: this.sourceID,
      ownerID: this.ownerID,
      kimiHome: this.kimiDir,
      url: target,
      accountDigest: scopeDigest ?? (hex(intent?.accountDigest) ? intent.accountDigest : null),
      profileKeyDigest: selectedKey !== null ? sha256(selectedKey)
        : sameAccount && hex(intent?.profileKeyDigest) ? intent.profileKeyDigest : null,
      credentialRef,
      aliases,
      entries,
      catalogRevision: hex(options.confirmedCatalogRevision) ? options.confirmedCatalogRevision
        : hex(intent?.catalogRevision) ? intent.catalogRevision : null,
      active: true,
      generation: (Number.isSafeInteger(intent?.generation) ? intent.generation : 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    const previousIntent = intentRead.kind === 'valid' ? intentRead.raw : null;
    const intentChanged = intentSignature(intent) !== intentSignature(nextIntent);
    if (intentChanged) {
      const failure = this.writeIntent(nextIntent);
      if (failure) return this.conflict(base, failure, { profile: profileInfo });
    }
    if (changed) {
      const failure = this.commitConfig(config.raw, (config.bom ? '\uFEFF' : '') + JSON.stringify(next, null, 2) + '\n');
      if (failure) {
        if (intentChanged) this.restoreIntent(previousIntent);
        return this.conflict(base, failure, { profile: profileInfo });
      }
    }
    return {
      ...base,
      state: changed ? 'repaired' : 'ready',
      imported: true,
      changed,
      aliases,
      missingProviders: [],
      missingModels: [],
      profile: profileInfo,
      account: { ...base.account, ...(selectedKey === null ? {} : { profileKey: sha256(selectedKey).slice(0, 16) }) },
    };
  }

  // An explicit disconnect removes only entries this tool wrote and still owns
  // byte for byte, keeps a model that is still the current one, and keeps every
  // provider another model still references. The intent stays, marked inactive
  // and stripped of its ownership digests, so a later run cannot revive the old
  // import from a snapshot; the profile itself is left untouched.
  disconnect({ base, intent, intentRead }) {
    if (intentRead.kind === 'unsafe') return this.conflict(base, 'intent_unavailable');
    const result = { ...base, state: 'disabled', reason: 'disconnected' };
    const markInactive = reason => {
      if (!intent) return null;
      const next = { ...intent, active: false, disconnectedAt: new Date().toISOString(), lastReason: reason,
        entries: { providers: {}, models: {} },
        generation: (Number.isSafeInteger(intent.generation) ? intent.generation : 0) + 1 };
      return this.writeIntent(next);
    };
    const config = this.readConfig();
    if (config.kind === 'absent') {
      const failure = markInactive('config_missing');
      if (failure) return this.conflict(base, failure);
      return { ...result, reason: 'config_missing' };
    }
    if (config.kind === 'unsafe') return this.conflict(base, 'config_unavailable');
    if (config.kind === 'corrupt') return this.conflict(base, 'invalid_config');
    const doc = config.value;
    if (!isPlain(doc.model)) return this.conflict(base, 'invalid_config');
    if (!intent) {
      const failure = markInactive('disconnected');
      return failure ? this.conflict(base, failure) : result;
    }
    const owned = ownedEntries(intent);
    const next = JSON.parse(JSON.stringify(doc));
    const removed = { providers: [], models: [] };
    const retained = [];
    const currentModels = isPlain(next.model.models) ? next.model.models : {};
    for (const [alias, entry] of Object.entries(owned.models)) {
      if (!entry.written || !(alias in currentModels)) continue;
      if (next.model.current === alias) { retained.push(alias); continue; }
      if (digestOf(currentModels[alias]) !== entry.digest) { retained.push(alias); continue; }
      delete currentModels[alias];
      removed.models.push(alias);
    }
    const currentProviders = isPlain(next.model.providers) ? next.model.providers : {};
    for (const [providerId, entry] of Object.entries(owned.providers)) {
      if (!entry.written || !(providerId in currentProviders)) continue;
      const referenced = Object.values(currentModels)
        .some(model => isPlain(model) && model.provider === providerId);
      if (referenced) { retained.push(providerId); continue; }
      if (digestOf(currentProviders[providerId]) !== entry.digest) { retained.push(providerId); continue; }
      delete currentProviders[providerId];
      removed.providers.push(providerId);
    }
    const changed = removed.models.length > 0 || removed.providers.length > 0;
    if (changed) {
      const failure = this.commitConfig(config.raw, (config.bom ? '\uFEFF' : '') + JSON.stringify(next, null, 2) + '\n');
      if (failure) return this.conflict(base, failure);
    }
    const failure = markInactive('disconnected');
    if (failure) return this.conflict(base, failure);
    return { ...result, changed, removed, ...(retained.length ? { retained } : {}) };
  }

  // The one step this module cannot perform itself. The callback receives the
  // exact scope it is authorised for and a context that carries no credential:
  // the caller's own token never passes through here.
  async callSyncNative({ target, catalog, result }) {
    const intentRead = this.readIntent();
    const intent = intentRead.kind === 'valid' ? intentRead.value : null;
    const scope = {
      sourceID: this.sourceID,
      url: target,
      modelIds: catalog.map(row => row.id),
      accountDigest: hex(intent?.accountDigest) ? intent.accountDigest : null,
      profileKeyDigest: hex(intent?.profileKeyDigest) ? intent.profileKeyDigest : null,
      credentialRef: text(intent?.credentialRef, 512) ? intent.credentialRef : null,
      authorized: true,
    };
    const previousContext = {
      sourceID: this.sourceID,
      url: text(intent?.url, 2048) ? intent.url : null,
      aliases: isPlain(intent?.aliases) ? intent.aliases : {},
      accountDigest: scope.accountDigest,
      profileKeyDigest: scope.profileKeyDigest,
      credentialRef: scope.credentialRef,
      reason: result.reason,
    };
    try {
      const outcome = await this.syncNative({ url: target, models: catalog.map(row => row.id),
        previousContext, scope });
      if (isPlain(outcome) && outcome.ok === true) return { ok: true };
      return { ok: false, reason: text(outcome?.reason, 128) ? outcome.reason : 'native_import_failed' };
    } catch { return { ok: false, reason: 'native_import_failed' }; }
  }
}
