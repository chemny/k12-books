const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { fallbackRoutes, tunnelTransport } = require('../core/cdnTransport');
test('existing proxy fallback is restricted to original platform overseas hosts', () => {
  const proxy = { host: '127.0.0.1', port: 12345 };
  assert.equal(fallbackRoutes('https://r1-ndr-oversea.ykt.cbern.com.cn/book.pdf', proxy).length, 2);
  assert.deepEqual(fallbackRoutes('https://r1-ndr-oversea.ykt.cbern.com.cn.attacker.test/book.pdf', proxy), []);
  assert.deepEqual(fallbackRoutes('https://r1-ndr-private.ykt.cbern.com.cn/book.pdf', proxy), []);
  assert.deepEqual(fallbackRoutes('https://r1-ndr-oversea.ykt.cbern.com.cn/book.pdf', null), []);
});
test('proxy rejection is surfaced as a failed request without forwarding an unauthenticated tunnel', async t => {
  let authority;
  const server = http.createServer();
  server.on('connect', (req, socket) => {
    authority = req.url;
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const transport = tunnelTransport({ host: '127.0.0.1', port: server.address().port }, '103.198.200.200');
  await assert.rejects(new Promise((resolve, reject) => {
    const req = transport.get('https://r1-ndr-oversea.ykt.cbern.com.cn/book.pdf', {}, resolve);
    req.on('error', reject);
  }), { code: 'HTTP_407' });
  assert.equal(authority, '103.198.200.200:443');
});
