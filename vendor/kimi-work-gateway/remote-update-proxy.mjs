const EVENTS = new Set(['checking-for-update', 'update-available', 'update-not-available', 'update-downloaded', 'error']);
const METHODS = ['setFeedURL', 'getFeedURL', 'checkForUpdates', 'quitAndInstall'];

export function installRemoteUpdateProxy({ updater, app, request, onState = () => {} } = {}) {
  if (!updater || typeof updater.emit !== 'function' || !METHODS.every(name => typeof updater[name] === 'function')
    || typeof app?.quit !== 'function' || typeof request !== 'function') throw Error('remote_updater_contract_unverified');
  const descriptors = new Map(METHODS.map(name => [name, Object.getOwnPropertyDescriptor(updater, name)]));
  if ([...descriptors.values()].some(value => value && !value.configurable)) throw Error('remote_updater_contract_unverified');
  let feed, removed = false, installing = false;
  const report = state => { try { onState({ state }); } catch {} };
  const failure = () => {
    report('helper-unavailable');
    updater.emit('error', Error('remote_update_helper_unavailable'));
  };
  let pending = Promise.resolve(), feedReady = false;
  const send = (operation, value) => {
    const result = pending.then(async () => {
      if (removed) throw Error('remote_update_proxy_removed');
      if (operation === 'set-feed') feedReady = false;
      if (operation === 'check' && !feedReady) throw Error('remote_update_feed_unavailable');
      const response = await request(operation, value);
      if (response?.ok !== true) throw Error('remote_update_helper_unavailable');
      if (operation === 'set-feed') feedReady = true;
      return response;
    });
    pending = result.catch(() => {});
    return result;
  };
  const replacements = {
    setFeedURL(value) {
      feed = typeof value === 'string' ? value : value?.url;
      void send('set-feed', value).catch(failure);
    },
    getFeedURL() { return feed ?? ''; },
    checkForUpdates() { void send('check').catch(failure); },
    quitAndInstall() {
      if (installing) return;
      installing = true;
      void send('relaunch-after-parent-exit').then(() => {
        if (removed) return;
        report('waiting-parent-exit');
        updater.emit('before-quit-for-update');
        app.quit();
      }).catch(() => { installing = false; failure(); });
    },
  };
  try {
    for (const name of METHODS) Object.defineProperty(updater, name,
      { configurable: true, enumerable: descriptors.get(name)?.enumerable ?? false, writable: true, value: replacements[name] });
  } catch {
    for (const name of METHODS) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(updater, name, descriptor);
      else delete updater[name];
    }
    throw Error('remote_updater_contract_unverified');
  }
  report('delegated');
  return {
    receive(event) {
      if (removed || !EVENTS.has(event?.type)) return false;
      if (event.type === 'error') { failure(); return true; }
      if (event.type === 'update-downloaded') {
        report('staged-by-official-helper');
        updater.emit(event.type, {}, typeof event.releaseNotes === 'string' ? event.releaseNotes : '',
          typeof event.releaseName === 'string' ? event.releaseName : '',
          new Date(event.releaseDate ?? 0), typeof event.updateURL === 'string' ? event.updateURL : '');
      } else updater.emit(event.type);
      return true;
    },
    uninstall() {
      if (removed) return false;
      removed = true;
      for (const name of METHODS) {
        if (updater[name] !== replacements[name]) continue;
        const descriptor = descriptors.get(name);
        if (descriptor) Object.defineProperty(updater, name, descriptor);
        else delete updater[name];
      }
      report('removed');
      return true;
    },
  };
}
