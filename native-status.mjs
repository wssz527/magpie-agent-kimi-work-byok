import fs from 'node:fs';
import { lookup } from 'node:dns/promises';
import { BYOK_DOMAIN, nativePrivateAddress } from './native-dns.mjs';

export class NativeSetupProbe {
  constructor({ flagFile, lookupFn = lookup, timeoutMs = 1500, cacheMs = 60000 } = {}) {
    Object.assign(this, { flagFile, lookupFn, timeoutMs, cacheMs });
  }

  async dns() {
    if (this.pending) return this.pending;
    if (this.cached && Date.now() - this.cached.at < this.cacheMs) return this.cached.result;
    this.pending = (async () => {
      let timer;
      try {
        const result = await Promise.race([
          this.lookupFn(BYOK_DOMAIN),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('dns_timeout')), this.timeoutMs); }),
        ]);
        return { passed: nativePrivateAddress(result.address), address: result.address };
      } catch { return { passed: false, error: 'dns_unavailable' }; }
      finally { clearTimeout(timer); }
    })();
    try {
      const result = await this.pending;
      this.cached = { at: Date.now(), result };
      return result;
    } finally { this.pending = null; }
  }

  async check() {
    let revealed = false, flag = 'missing';
    try {
      const stat = fs.statSync(this.flagFile);
      if (!stat.isFile() || stat.size > 65536) throw Error('invalid_flag');
      revealed = JSON.parse(fs.readFileSync(this.flagFile, 'utf8')).revealed === true;
      flag = revealed ? 'revealed' : 'hidden';
    } catch (failure) { if (failure.code !== 'ENOENT') flag = 'unavailable'; }
    return { revealed, flag, intranet: await this.dns() };
  }
}
