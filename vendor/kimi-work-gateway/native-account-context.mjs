import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

export function nativeAccountScope(config) {
  const nativeID = config?.credentials?.kimiWeb?.userId;
  if (typeof nativeID === 'string' && nativeID && nativeID.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(nativeID)) return nativeID;
  const token = config?.credentials?.kimiCode?.apiKey;
  if (typeof token !== 'string') return null;
  const pieces = token.split('.');
  if (pieces.length !== 3 || pieces[1].length > 32768) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8')); } catch { return null; }
  const id = payload?.user_id ?? payload?.sub;
  return typeof id === 'string' && id && id.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(id) ? id : null;
}

function readDocument(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw Error('native_context_unavailable');
  return { value: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), stat };
}

export class NativeAccountContext {
  constructor({ kimiDir, authFile } = {}) {
    this.kimiDir = path.resolve(kimiDir);
    this.file = path.join(this.kimiDir, '.kimi-work-gateway-account.json');
    this.authFile = authFile || path.join(path.dirname(path.dirname(this.kimiDir)), 'bridge-store', 'token-store.json');
  }

  fingerprint() {
    const stat = fs.lstatSync(this.authFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('native_account_unavailable');
    return hash(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
  }

  capture(profileKey) {
    if (typeof profileKey !== 'string' || !/^[a-f0-9]{64}$/.test(profileKey)) throw Error('native_account_unavailable');
    const store = readDocument(path.join(this.kimiDir, 'byok-providers.json')).value;
    if (!plain(store.profiles) || !Object.hasOwn(store.profiles, profileKey)) throw Error('native_account_unavailable');
    writeSubagentJSON(this.file, { schemaVersion: 1, kimiHome: this.kimiDir, profileKey, authDigest: this.fingerprint() });
    return { accountScope: profileKey, profileKey };
  }

  read() {
    let auth;
    try { auth = this.fingerprint(); } catch { return {}; }
    let proof, nativeID;
    try { proof = readSubagentJSON(this.file); } catch {}
    try { nativeID = nativeAccountScope(readDocument(path.join(this.kimiDir, 'config.json')).value); } catch {}
    const proven = proof?.schemaVersion === 1 && proof.kimiHome === this.kimiDir && proof.authDigest === auth
      && /^[a-f0-9]{64}$/.test(proof.profileKey);
    if (nativeID) {
      const profileKey = hash(nativeID);
      if (!proven || proof.profileKey !== profileKey) {
        try { this.capture(profileKey); } catch {}
      }
      return { accountScope: profileKey, profileKey };
    }
    return proven ? { accountScope: proof.profileKey, profileKey: proof.profileKey } : {};
  }
}
