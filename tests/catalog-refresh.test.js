const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-sync-'));
process.env.CHINAK12_DATA_DIR = root;
const { refreshCatalogFromPlatform } = require('../core/catalog');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const file = path.join(root, 'catalog.json');
const book = id => ({ id, title: '教材' + id, custom_properties: { format: 'pdf', size: 100 } });
test('failed, empty, duplicate and suspicious sync leave the last successful catalog byte-for-byte intact', async t => {
  const original = JSON.stringify({ books: Array.from({ length: 10 }, (_, i) => ({ id: String(i), title: '教材' + i })), stats: { total: 10 } });
  let mode = 'malformed';
  t.mock.method(https, 'get', (options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {};
    process.nextTick(() => {
      const version = options.path.includes('data_version.json');
      let body = version ? { urls: ['https://example.test/catalog'] } : [];
      if (!version && mode === 'duplicate') body = [book('x'), book('x')];
      if (!version && mode === 'short') body = [book('x')];
      if (!version && mode === 'success') body = Array.from({ length: 10 }, (_, i) => book(String(i)));
      const res = Readable.from([Buffer.from(!version && mode === 'malformed' ? '{broken' : JSON.stringify(body))]);
      res.statusCode = 200; callback(res);
    });
    return req;
  });
  for (mode of ['malformed', 'empty', 'duplicate', 'short']) {
    fs.writeFileSync(file, original);
    await assert.rejects(refreshCatalogFromPlatform());
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
  mode = 'success';
  const catalog = await refreshCatalogFromPlatform();
  assert.equal(catalog.stats.total, 10);
  assert.equal(JSON.parse(fs.readFileSync(file)).books.length, 10);
  assert.equal(fs.readFileSync(path.join(root, 'catalog.previous.json'), 'utf8').includes('教材0'), true);
});
