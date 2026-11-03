import { normalizeSubagentPolicy } from './subagent-policy.mjs';
import { normalizeTranslationConfig } from './translation-config.mjs';
import { validateBaseURL } from './openai-backend.mjs';

const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const PROTOCOLS = ['chat', 'responses'];
const clean = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\x00-\x1f]/.test(value);

// Each connection stores its key in its own named variable, so two upstreams
// can hold different credentials in one process. A connection that does not
// name one gets a stable, deterministic name derived from its id, which is
// `KIMI_WORK_CONN_A_KEY` for the id `conn-a`.
export function connectionKeyEnv(id) {
  return 'KIMI_WORK_' + id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '_KEY';
}

function readConnection(value, seenIds, seenEnvs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_config');
  const keys = Object.keys(value);
  if (keys.some(key => !['id', 'name', 'providerPresetId', 'baseURL', 'apiKeyEnv', 'protocols'].includes(key))) {
    throw Error('invalid_config');
  }
  if (typeof value.id !== 'string' || !CONNECTION_ID.test(value.id) || seenIds.has(value.id)) throw Error('invalid_config');
  if (!clean(value.name, 128) || !value.name.trim()) throw Error('invalid_config');
  if (value.providerPresetId !== undefined && (typeof value.providerPresetId !== 'string'
    || !CONNECTION_ID.test(value.providerPresetId))) throw Error('invalid_config');
  let baseURL;
  try { baseURL = validateBaseURL(value.baseURL); } catch { throw Error('invalid_config'); }
  const apiKeyEnv = value.apiKeyEnv === undefined ? connectionKeyEnv(value.id) : value.apiKeyEnv;
  if (typeof apiKeyEnv !== 'string' || !ENV_NAME.test(apiKeyEnv) || seenEnvs.has(apiKeyEnv)) throw Error('invalid_config');
  let protocols;
  if (value.protocols !== undefined) {
    if (!Array.isArray(value.protocols) || !value.protocols.length || value.protocols.length > PROTOCOLS.length
      || new Set(value.protocols).size !== value.protocols.length
      || value.protocols.some(protocol => !PROTOCOLS.includes(protocol))) throw Error('invalid_config');
    protocols = PROTOCOLS.filter(protocol => value.protocols.includes(protocol));
  }
  seenIds.add(value.id);
  seenEnvs.add(apiKeyEnv);
  return { id: value.id, name: value.name.trim(),
    ...(value.providerPresetId === undefined ? {} : { providerPresetId: value.providerPresetId }),
    baseURL, apiKeyEnv, ...(protocols ? { protocols } : {}) };
}

// Connection references are checked here, before anything reaches a backend:
// a model that points at a connection that no longer exists would otherwise
// fail one request at a time, long after the edit that broke it.
function readModels(models, connections, upstream) {
  const byId = new Map(connections.map(connection => [connection.id, connection]));
  return models.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    if (row.connectionId !== undefined) {
      if (typeof row.connectionId !== 'string' || !byId.has(row.connectionId)) throw Error('invalid_config');
      const connection = byId.get(row.connectionId);
      if (connection.protocols && PROTOCOLS.includes(row.protocol) && !connection.protocols.includes(row.protocol)) {
        throw Error('protocol_conflict');
      }
    } else if (row.upstreamModelId !== undefined && !upstream) {
      throw Error('invalid_config');
    }
    if (row.upstreamModelId !== undefined && !clean(row.upstreamModelId, 2048)) throw Error('invalid_config');
    // A saved budget above the vendor's own hard limit could never be served,
    // so it is refused when the file is read rather than one request at a time.
    if (row.contextLimit !== undefined) {
      if (!Number.isSafeInteger(row.contextLimit) || row.contextLimit <= 0) throw Error('invalid_config');
      if (Number.isSafeInteger(row.contextWindow) && row.contextWindow > row.contextLimit) {
        throw Error('context_window_exceeds_limit');
      }
    }
    return row;
  });
}

export function readConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_config');
  if (!Array.isArray(value.models)) throw Error('invalid_config');
  const rawConnections = value.connections === undefined ? [] : value.connections;
  if (!Array.isArray(rawConnections) || rawConnections.length > 32) throw Error('invalid_config');
  const seenIds = new Set(), seenEnvs = new Set();
  const connections = rawConnections.map(connection => readConnection(connection, seenIds, seenEnvs));
  const upstream = value.upstream;
  // A connections-only configuration has no legacy upstream and needs none:
  // requiring an unused placeholder would make the new mode impossible to save.
  if (upstream !== undefined && upstream !== null) {
    if (typeof upstream !== 'object' || typeof upstream.baseURL !== 'string'
      || typeof upstream.apiKeyEnv !== 'string' || !ENV_NAME.test(upstream.apiKeyEnv)
      || seenEnvs.has(upstream.apiKeyEnv)) {
      throw Error('invalid_config');
    }
  }
  if ((upstream === undefined || upstream === null) && !connections.length) throw Error('invalid_config');
  const models = readModels(value.models, connections, upstream);
  const tokenEnv = value.tokenEnv === undefined ? 'KIMI_WORK_GATEWAY_TOKEN' : value.tokenEnv;
  if (typeof tokenEnv !== 'string' || !ENV_NAME.test(tokenEnv)
    || upstream && tokenEnv === upstream.apiKeyEnv || seenEnvs.has(tokenEnv)) throw Error('invalid_config');
  const port = value.port === undefined ? 3426 : value.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('invalid_config');
  const dns = value.dns === undefined ? {} : value.dns;
  if (!dns || typeof dns !== 'object' || Array.isArray(dns)) throw Error('invalid_config');
  const dnsEnabled = dns.enabled === true;
  const dnsPort = dns.port === undefined ? 53535 : dns.port;
  if (!Number.isInteger(dnsPort) || dnsPort < 1024 || dnsPort > 65535) throw Error('invalid_config');
  return {
    upstream: upstream === undefined || upstream === null
      ? null : { baseURL: upstream.baseURL, apiKeyEnv: upstream.apiKeyEnv },
    connections, models, tokenEnv, port, dns: { enabled: dnsEnabled, port: dnsPort },
    ...(value.subagents === undefined ? {} : { subagents: normalizeSubagentPolicy(
      value.subagents?.mode === 'force' ? { ...value.subagents, transport: 'native-config' } : value.subagents, value.models) }),
    ...(value.translation === undefined ? {} : { translation: normalizeTranslationConfig(value.translation) }),
  };
}
