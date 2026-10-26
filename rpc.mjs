export function controlEndpoint(state) {
  const endpoint = state?.control?.endpoint;
  let url;
  try { url = new URL(endpoint?.url); } catch { throw Error('kimi_control_unavailable'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || !url.port || url.pathname !== '/control' || url.username || url.password
      || url.search || url.hash || typeof endpoint?.auth?.token !== 'string'
      || !endpoint.auth.token) throw Error('kimi_control_unavailable');
  return endpoint;
}

// Bun supplies the authenticated WebSocket client; no browser or Kimi Code CLI.
export async function rpc(state, method, params = {}, { timeout = 6000, Socket = globalThis.WebSocket } = {}) {
  if (!['models.current', 'conversations.setModel', 'conversations.getKimiModelList',
    'conversations.updateKimiModelList'].includes(method)) throw Error('unsupported_control_method');
  const endpoint = controlEndpoint(state);
  return new Promise((resolve, reject) => {
    let socket, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* Already closed. */ }
      error ? reject(Error(error)) : resolve(value);
    };
    const timer = setTimeout(() => finish('kimi_control_timeout'), timeout);
    try {
      socket = new Socket(endpoint.url, { headers: { Authorization: 'Bearer ' + endpoint.auth.token } });
      socket.addEventListener('error', () => finish('kimi_control_unavailable'));
      socket.addEventListener('close', () => finish('kimi_control_closed'));
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      });
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.id !== 1) return;
        finish(message.error ? 'kimi_control_rejected' : null, message.result);
      });
    } catch { finish('kimi_control_unavailable'); }
  });
}
