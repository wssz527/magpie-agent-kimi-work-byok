// The core owns this file; the plugin only re-exports it so there is one
// implementation of the resolver and hosts handling. `vendor/kimi-work-gateway`
// is the fixed copy recorded in VENDOR.json.
export { NativeSetup, resolverScript, hostsScript, updateHosts, hostsEntry, HOSTS_MARKER,
  DEFAULT_HOSTS, defaultHostsPath } from './vendor/kimi-work-gateway/native-setup.mjs';
