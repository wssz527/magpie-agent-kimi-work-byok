import fs from 'node:fs';
import { Resolver } from 'node:dns/promises';
import { BYOK_DOMAIN, nativePrivateAddress } from './native-dns.mjs';

// A plain `lookup()` leaves a GetAddrInfoReqWrap behind when the answer never
// arrives; that handle keeps the process alive, so a panel or serve stopped
// with SIGINT would hang. A Resolver can be cancelled, which releases it.
async function resolveAddress(domain, timeoutMs) {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  let timer;
  try {
    const addresses = await Promise.race([
      resolver.resolve4(domain),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('dns_timeout')), timeoutMs); }),
    ]);
    return addresses[0];
  } finally {
    clearTimeout(timer);
    try { resolver.cancel(); } catch {}
  }
}

export class NativeSetupProbe {
  constructor({ flagFile, lookupFn, timeoutMs = 1500, cacheMs = 60000 } = {}) {
    Object.assign(this, { flagFile, lookupFn, timeoutMs, cacheMs });
  }

  async dns() {
    if (this.pending) return this.pending;
    if (this.cached && Date.now() - this.cached.at < this.cacheMs) return this.cached.result;
    this.pending = (async () => {
      let timer;
      try {
        const address = this.lookupFn
          ? (await Promise.race([
            Promise.resolve(this.lookupFn(BYOK_DOMAIN)).then(result => result.address),
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error('dns_timeout')), this.timeoutMs); }),
          ]))
          : await resolveAddress(BYOK_DOMAIN, this.timeoutMs);
        return { passed: nativePrivateAddress(address), address };
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
