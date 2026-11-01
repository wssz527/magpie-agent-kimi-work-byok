// The page Magpie serves for this plugin is only a shell. The host draws its
// frame with a policy that reaches no network (pagePolicy: connect-src
// 'none', frame-src 'none'), so the editor is drawn by the plugin's local
// service and this frame navigates to it. The theme the host posts to this
// frame is carried along, and anything posted later still lands on the
// service page, since it is this frame's document.
const DEFAULT_SERVICE = 'http://127.0.0.1:3428/';
const HELLO_ID = 'shell-hello';

function serviceURL(service, options) {
  try {
    if (service) return new URL(service, location.href).href;
    const port = options?.workPanelPort;
    if (Number.isInteger(port) && port > 0 && port < 65536) return 'http://127.0.0.1:' + port + '/';
  } catch { /* fall through to the default */ }
  return DEFAULT_SERVICE;
}

function hash(theme, agent) {
  const parts = [];
  if (theme) parts.push('theme=' + encodeURIComponent(JSON.stringify(theme)));
  if (agent) parts.push('agent=' + encodeURIComponent(agent));
  return parts.length ? '#' + parts.join('&') : '';
}

(() => {
  const say = text => { const node = document.getElementById('status'); if (node) node.textContent = text; };
  let theme, service, options, agent;
  // The host replaces a frame that says nothing within ten seconds; this
  // frame is about to leave, so it answers at once rather than waiting for
  // the plugin's options.
  parent.postMessage({ magpie: 1, id: HELLO_ID, method: 'hello', params: {} }, '*');
  addEventListener('message', event => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.magpie !== 1) return;
    if (message.event === 'theme') { theme = message.data; return; }
    if (message.id !== HELLO_ID || message.error) return;
    if (message.result?.tokens) theme = message.result;
    service = message.result?.service || '';
  });
  if (globalThis.magpie?.onAction) magpie.onAction(data => {
    // Only this agent's row belongs to this page; another row opens the
    // page too, and the service then says so instead of editing.
    agent = data?.agent?.id;
  });
  (async () => {
    try {
      await magpie.ready;
      theme ||= magpie.theme;
      service ||= magpie.service;
      options = await magpie.options.get();
    } catch { /* No host bridge: the service on this computer is still tried. */ }
    const target = serviceURL(service, options);
    say('正在连接本机 ' + target + ' …');
    location.replace(target.split('#')[0] + hash(theme, agent));
  })();
})();
