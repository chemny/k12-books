const http = require('http');
const https = require('https');
const tls = require('tls');
const { execFileSync } = require('child_process');

// Same addresses shipped in the original client. Preserve URL, Host and TLS SNI.
const OVERSEA_IPS = ['103.198.200.200', '103.198.200.201'];
let cachedProxy;
let checkedAt = 0;
function systemProxy() {
  if (Date.now() - checkedAt < 30000) return cachedProxy;
  checkedAt = Date.now(); cachedProxy = null;
  if (process.platform !== 'darwin') return null;
  try {
    const config = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 2000 });
    const value = key => config.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, 'm'))?.[1];
    const host = value('HTTPSProxy'), port = Number(value('HTTPSPort'));
    // Reuse only the existing local proxy; never select nodes or modify system settings.
    if (value('HTTPSEnable') === '1' && ['127.0.0.1', 'localhost', '::1'].includes(host) && port > 0 && port < 65536) {
      cachedProxy = { host, port };
    }
  } catch {}
  return cachedProxy;
}

function tunnelTransport(proxy, ip) {
  return { get(url, options, callback) {
    const host = new URL(url).hostname;
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = (tlsOptions, connected) => {
      let done = false;
      function finish(err, socket) {
        if (done) return;
        done = true; connected(err, socket);
      }
      const connect = http.request({ hostname: proxy.host, port: proxy.port, method: 'CONNECT',
        path: `${ip}:443`, headers: { Host: `${ip}:443` }, signal: options.signal });
      connect.setTimeout(15000, () => connect.destroy(Object.assign(new Error('代理连接超时'), { code: 'ETIMEDOUT' })));
      connect.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          return finish(Object.assign(new Error(`代理 CONNECT HTTP ${response.statusCode}`), { code: `HTTP_${response.statusCode}` }));
        }
        if (head.length) socket.unshift(head);
        const secure = tls.connect({ socket, servername: host, rejectUnauthorized: true });
        const abort = () => secure.destroy(Object.assign(new Error('AbortError'), { name: 'AbortError', code: 'ABORT_ERR' }));
        options.signal?.addEventListener('abort', abort, { once: true });
        secure.setTimeout(15000, () => secure.destroy(Object.assign(new Error('TLS 连接超时'), { code: 'ETIMEDOUT' })));
        secure.once('secureConnect', () => finish(null, secure));
        secure.once('error', err => finish(err));
        secure.once('close', () => options.signal?.removeEventListener('abort', abort));
        if (options.signal?.aborted) abort();
      });
      connect.once('error', err => finish(err));
      connect.end();
    };
    const request = https.get(url, { ...options, agent }, response => {
      response.once('close', () => agent.destroy());
      callback(response);
    });
    request.once('error', () => agent.destroy());
    return request;
  }};
}

function fallbackRoutes(url, proxy = systemProxy()) {
  if (!proxy || !/^r[123]-ndr-oversea\.ykt\.cbern\.com\.cn$/.test(new URL(url).hostname)) return [];
  return OVERSEA_IPS.map(ip => ({ name: `system-proxy-cdn-${ip}`, transport: tunnelTransport(proxy, ip) }));
}
module.exports = { systemProxy, tunnelTransport, fallbackRoutes };
