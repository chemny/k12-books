const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { streamDownloadToFile, withRetry } = require('../core/transfer');
const pdf = Buffer.from('%PDF-1.7\n' + 'textbook\n'.repeat(10000) + '\n%%EOF');
async function fixture(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-transfer-'));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file: path.join(dir, 'book.part'), url: `http://127.0.0.1:${server.address().port}/book` };
}
function download(f, extra = {}) { return streamDownloadToFile({ urlStr: f.url, tempPartPath: f.file, transport: http, ...extra }); }
test('interrupted transfer resumes using actual bytes and If-Range', async t => {
  const ranges = [];
  let calls = 0;
  const f = await fixture(t, (req, res) => {
    ranges.push(req.headers.range);
    if (!calls++) {
      res.writeHead(200, { 'Content-Length': pdf.length, ETag: '"v1"' });
      res.write(pdf.subarray(0, 25000));
      setTimeout(() => res.destroy(), 20);
    } else {
      const offset = Number(req.headers.range.match(/\d+/)[0]);
      assert.equal(req.headers['if-range'], '"v1"');
      res.writeHead(206, { 'Content-Length': pdf.length - offset, 'Content-Range': `bytes ${offset}-${pdf.length - 1}/${pdf.length}`, ETag: '"v1"' });
      res.end(pdf.subarray(offset));
    }
  });
  await assert.rejects(download(f));
  const size = fs.statSync(f.file).size;
  assert.ok(size > 0 && size < pdf.length);
  await download(f);
  assert.equal(ranges[1], `bytes=${size}-`);
  assert.deepEqual(fs.readFileSync(f.file), pdf);
});
test('server ignoring Range restarts cleanly instead of appending', async t => {
  const f = await fixture(t, (_, res) => { res.setHeader('ETag', '"v2"'); res.end(pdf); });
  fs.writeFileSync(f.file, pdf.subarray(0, 100));
  fs.writeFileSync(f.file + '.json', JSON.stringify({ url: f.url, etag: '"v1"' }));
  await download(f);
  assert.deepEqual(fs.readFileSync(f.file), pdf);
});
test('incorrect Content-Range is rejected and next attempt restarts', async t => {
  const f = await fixture(t, (_, res) => {
    res.writeHead(206, { 'Content-Range': `bytes 0-${pdf.length - 1}/${pdf.length}` }); res.end(pdf);
  });
  fs.writeFileSync(f.file, pdf.subarray(0, 100));
  fs.writeFileSync(f.file + '.json', JSON.stringify({ url: f.url, etag: '"v1"' }));
  await assert.rejects(download(f), { code: 'INCOMPLETE' });
  assert.equal(fs.existsSync(f.file + '.json'), false);
  assert.equal(fs.statSync(f.file).size, 100);
});
test('different mirror never appends unrelated partial bytes', async t => {
  let range;
  const f = await fixture(t, (req, res) => { range = req.headers.range; res.end(pdf); });
  fs.writeFileSync(f.file, 'old bytes');
  fs.writeFileSync(f.file + '.json', JSON.stringify({ url: f.url + '-other', etag: '"v1"' }));
  await download(f);
  assert.equal(range, undefined);
  assert.deepEqual(fs.readFileSync(f.file), pdf);
});
test('split PDF header works; HTML response fails', async t => {
  const f = await fixture(t, (_, res) => { res.write('%P'); setTimeout(() => res.end(pdf.subarray(2)), 5); });
  await download(f);
  assert.deepEqual(fs.readFileSync(f.file), pdf);
  const bad = await fixture(t, (_, res) => res.end('<html>error</html>'));
  await assert.rejects(download(bad), { code: 'INVALID_PDF' });
});
test('destination write failure rejects promptly', async t => {
  const f = await fixture(t, (_, res) => res.end(pdf));
  // Sidecar can be written but destination itself is a directory.
  fs.mkdirSync(f.file);
  await assert.rejects(download(f), { code: 'EISDIR' });
});
test('pause aborts an active stream and closes the destination', async t => {
  const f = await fixture(t, (_, res) => { res.setHeader('ETag', '"v1"'); res.write(pdf.subarray(0, 100)); });
  const controller = new AbortController();
  await assert.rejects(download(f, { signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  fs.renameSync(f.file, f.file + '.closed');
});
test('retry transient failures but do not retry forbidden or local disk errors', async () => {
  let count = 0;
  const result = await withRetry(async () => { if (++count < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); return 42; }, { baseDelay: 1 });
  assert.equal(result, 42); assert.equal(count, 3);
  for (const code of ['HTTP_403', 'ENOSPC']) {
    count = 0;
    await assert.rejects(withRetry(async () => { count++; throw Object.assign(new Error(code), { code }); }, { baseDelay: 1 }));
    assert.equal(count, 1);
  }
});
test('idle response times out instead of occupying a worker forever', async t => {
  const f = await fixture(t, (_, res) => { res.writeHead(200); res.write('%PDF-'); });
  await assert.rejects(download(f, { idleTimeoutMs: 30 }), err => ['ETIMEDOUT', 'ECONNRESET'].includes(err.code));
});
test('length-matching response without PDF EOF is not accepted as complete', async t => {
  const truncated = pdf.subarray(0, pdf.length - 10);
  const f = await fixture(t, (_, res) => res.end(truncated));
  await assert.rejects(download(f), { code: 'INCOMPLETE' });
});
test('rate-limited request recovers after bounded retry', async t => {
  let requests = 0;
  const f = await fixture(t, (_, res) => {
    if (++requests === 1) { res.writeHead(429, { 'Retry-After': '0' }); res.end(); }
    else res.end(pdf);
  });
  await withRetry(() => download(f), { baseDelay: 1 });
  assert.equal(requests, 2);
  assert.deepEqual(fs.readFileSync(f.file), pdf);
});
