import { mergeRemoteWorkConfig } from './remote-work-models.mjs';

const METHOD = 'app.models.getWorkConfig';

export function locateRemoteControlPlane(source) {
  if (typeof source !== 'string') throw Error('remote_main_source_invalid');
  const candidates = [...source.matchAll(/^class\s+([A-Za-z_$][\w$]*)\s*\{[\s\S]*?^\}/gm)]
    .filter(match => ['#localMethods;', '#isRemoteAllowed;', '#dispatchInner(', '#invokeLocal(']
      .every(marker => match[0].includes(marker)));
  if (candidates.length !== 1) throw Error('remote_control_plane_unverified');
  const match = candidates[0];
  return { name: match[1], end: match.index + match[0].length };
}

export function locateNativeRemoteProfile(source, decode = value => value) {
  const candidates = [];
  for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\(([^,\n]+), (async \(\) => \{[\s\S]*?\n  \})\)/g)) {
    const channel = decode(match[2]);
    if (!/\["BYOK_GET_PROFILE"\]$/.test(channel)) continue;
    const handler = decode(match[3]);
    if (!handler.includes('["getUserId"]()') || !handler.includes('"profile"')) continue;
    const start = match.index + match[0].indexOf(match[3]);
    candidates.push({ start, end: start + match[3].length });
  }
  if (candidates.length !== 1) throw Error('remote_profile_contract_unverified');
  return candidates[0];
}

export function transformRemoteMain(source, installExpression, { profileExpression, decode } = {}) {
  if (typeof installExpression !== 'string'
    || !/^globalThis\.__kwgRemoteInstall_[a-f0-9]{32}$/.test(installExpression)) {
    throw Error('remote_install_expression_invalid');
  }
  const target = locateRemoteControlPlane(source);
  const edits = [{ start: target.end, end: target.end,
    value: '\n' + installExpression + '(' + target.name + ');\n' }];
  if (profileExpression !== undefined) {
    if (!/^globalThis\.__kwgRemoteProfile_[a-f0-9]{32}$/.test(profileExpression)) {
      throw Error('remote_profile_expression_invalid');
    }
    const profile = locateNativeRemoteProfile(source, decode);
    edits.push({ ...profile, value: profileExpression + '(' + source.slice(profile.start, profile.end) + ')' });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  }
  return source;
}

export function installRemoteWorkCatalog(Type, { getProfile, onStatus = () => {} } = {}) {
  const descriptor = typeof Type === 'function' && Type.prototype
    ? Object.getOwnPropertyDescriptor(Type.prototype, 'dispatch') : null;
  if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.writable
    || typeof getProfile !== 'function') throw Error('remote_control_plane_unverified');
  const original = descriptor.value;
  const report = value => { try { onStatus(value); } catch {} };
  const dispatch = async function(origin, request) {
    const response = await original.call(this, origin, request);
    if (origin?.kind !== 'remote' || request?.method !== METHOD || response?.ok !== true) return response;
    try {
      const profile = await getProfile();
      const result = mergeRemoteWorkConfig(response.result, profile);
      const added = Array.isArray(result?.models) && Array.isArray(response.result?.models)
        ? result.models.length - response.result.models.length : 0;
      report({ state: added > 0 ? 'catalog-extended' : 'catalog-unchanged', added });
      return result === response.result ? response : { ...response, result };
    } catch {
      report({ state: 'catalog-unavailable', added: 0 });
      return response;
    }
  };
  Object.defineProperty(Type.prototype, 'dispatch', { ...descriptor, value: dispatch });
  report({ state: 'installed', added: 0 });
  return () => {
    if (Type.prototype.dispatch !== dispatch) return false;
    Object.defineProperty(Type.prototype, 'dispatch', descriptor);
    report({ state: 'removed', added: 0 });
    return true;
  };
}
