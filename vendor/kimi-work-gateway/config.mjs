import { normalizeSubagentPolicy } from './subagent-policy.mjs';

export function readConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_config');
  const upstream = value.upstream;
  if (!upstream || typeof upstream !== 'object' || typeof upstream.baseURL !== 'string'
    || typeof upstream.apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(upstream.apiKeyEnv)) {
    throw Error('invalid_config');
  }
  if (!Array.isArray(value.models)) throw Error('invalid_config');
  const tokenEnv = value.tokenEnv === undefined ? 'KIMI_WORK_GATEWAY_TOKEN' : value.tokenEnv;
  if (typeof tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) throw Error('invalid_config');
  const port = value.port === undefined ? 3426 : value.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('invalid_config');
  const dns = value.dns === undefined ? {} : value.dns;
  if (!dns || typeof dns !== 'object' || Array.isArray(dns)) throw Error('invalid_config');
  const dnsEnabled = dns.enabled === true;
  const dnsPort = dns.port === undefined ? 53535 : dns.port;
  if (!Number.isInteger(dnsPort) || dnsPort < 1024 || dnsPort > 65535) throw Error('invalid_config');
  return {
    upstream: { baseURL: upstream.baseURL, apiKeyEnv: upstream.apiKeyEnv },
    models: value.models, tokenEnv, port, dns: { enabled: dnsEnabled, port: dnsPort },
    ...(value.subagents === undefined ? {} : { subagents: normalizeSubagentPolicy(value.subagents, value.models) }),
  };
}
