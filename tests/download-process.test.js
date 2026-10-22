const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');
const { once } = require('events');
const delay = ms => new Promise(r => setTimeout(r, ms));
const bytes = Buffer.from('%PDF-1.7\n' + 'test-only bytes\n'.repeat(24000) + '%%EOF');
const md5 = crypto.createHash('md5').update(bytes).digest('hex');
async function waitFor(operation, predicate, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await operation(); if (predicate(result)) return result; await delay(30); }
  throw new Error('download state timeout');
}
test('real streams survive disconnection, pause/resume, hard restart, failed retry and never change bytes', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-process-'));
  let mode = 'drop', drops = 0; const ranges = [];
  const server = http.createServer((req, res) => {
    if (mode === 'fail') { res.writeHead(403); res.end(); return; }
    const offset = req.headers.range ? Number(req.headers.range.match(/\d+/)[0]) : 0;
    ranges.push(offset);
    res.writeHead(offset ? 206 : 200, { 'Content-Length': bytes.length - offset, ETag: '"fixed"',
      ...(offset ? { 'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}) });
    let index = offset;
    const timer = setInterval(() => {
      const end = Math.min(bytes.length, index + 4096); res.write(bytes.subarray(index, end)); index = end;
      if (mode === 'drop' && !drops && index >= 16000) { drops++; res.destroy(); clearInterval(timer); }
      else if (index === bytes.length) { clearInterval(timer); res.end(); }
    }, 12);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const book = { id: 'fixture', filename: 'fixture.pdf', relative_path: 'fixture.pdf', update_time: 'v1', pdf_size: bytes.length };
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true });
  });
  async function start(state, dir) {
    const child = fork(require.resolve('./fixtures/download-process.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {
      ...process.env, CHINAK12_DATA_DIR: state, K12_TEST_DIR: dir, K12_TEST_BOOK: JSON.stringify(book), K12_TEST_MD5: md5,
      K12_TEST_URL: `http://127.0.0.1:${server.address().port}/fixture.pdf`,
    } }); children.push(child);
    const [ready] = await once(child, 'message'); let token = 0;
    return { child, ready, command: command => new Promise(resolve => {
      const id = ++token; const listener = message => { if (message.token === id) { child.off('message', listener); resolve(message.tasks); } };
      child.on('message', listener); child.send({ command, token: id });
    }) };
  }
  const state = path.join(root, 'state'), dir = path.join(root, 'books');
  let app = await start(state, dir); await app.command('add');
  await waitFor(() => app.command('status'), tasks => tasks[0]?.downloaded_bytes > 30000);
  assert.equal(drops, 1); assert.ok(ranges.some(n => n > 0));
  await app.command('pause');
  await delay(100);
  const paused = await app.command('status'); assert.equal(paused[0].status, 'paused');
  const count = paused[0].downloaded_bytes; await delay(100);
  assert.equal((await app.command('status'))[0].downloaded_bytes, count);
  await app.command('resume');
  await waitFor(() => app.command('status'), tasks => tasks[0]?.status === 'downloading' && tasks[0].downloaded_bytes > count);
  await waitFor(async () => fs.existsSync(path.join(state, 'tasks.json')), x => x);
  app.child.kill('SIGKILL'); await once(app.child, 'exit');
  mode = 'normal'; app = await start(state, dir);
  assert.equal(app.ready.tasks[0].status, 'paused');
  await app.command('resume');
  await waitFor(() => app.command('status'), tasks => tasks[0]?.status === 'completed');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'fixture.pdf')), bytes);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.pdf.download.json')));
  assert.equal(receipt.md5, md5); assert.equal(receipt.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  mode = 'fail'; const failedDir = path.join(root, 'retry-books');
  const retryApp = await start(path.join(root, 'retry-state'), failedDir); await retryApp.command('add');
  await waitFor(() => retryApp.command('status'), tasks => tasks[0]?.status === 'failed');
  assert.equal(fs.existsSync(path.join(failedDir, 'fixture.pdf')), false);
  mode = 'normal'; await retryApp.command('retry');
  await waitFor(() => retryApp.command('status'), tasks => tasks[0]?.status === 'completed');
  assert.deepEqual(fs.readFileSync(path.join(failedDir, 'fixture.pdf')), bytes);
});
