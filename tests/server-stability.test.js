const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const entry = require.resolve('../server');
async function start(t, state) {
  const child = spawn(process.execPath, ['-e', `const app = require(${JSON.stringify(entry)}); app.runServer(0, () => process.send(app.server.address().port))`], {
    env: { ...process.env, CHINAK12_DATA_DIR: state }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const port = await Promise.race([once(child, 'message').then(([p]) => p),
    once(child, 'exit').then(([c]) => { throw new Error('server exited ' + c); })]);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } });
  return { child, url: 'http://127.0.0.1:' + port };
}
async function post(url, download_dir) {
  const response = await fetch(url + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ download_dir }) });
  return { status: response.status, data: await response.json() };
}
test('save folder validates files, persists across real process restart and reports save failures', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-server-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  let app = await start(t, state);
  const folder = path.join(root, '教材 保存目录');
  assert.equal((await post(app.url, folder)).status, 200);
  const file = path.join(root, 'not-a-folder'); fs.writeFileSync(file, 'keep');
  assert.equal((await post(app.url, file)).status, 400);
  assert.equal((await post(app.url, '')).status, 400);
  assert.equal((await post(app.url, path.join(root, 'Client.app', 'books'))).status, 400);
  assert.equal((await (await fetch(app.url + '/api/config')).json()).download_dir, folder);
  app.child.kill(); await once(app.child, 'exit');
  app = await start(t, state);
  assert.equal((await (await fetch(app.url + '/api/config')).json()).download_dir, folder);
  const config = path.join(state, 'config.json');
  fs.renameSync(config, config + '.backup'); fs.mkdirSync(config);
  assert.equal((await post(app.url, folder)).status, 400);
});
test('SSE delivers persisted task snapshot immediately rather than waiting for heartbeat', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-sse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify([{ id: 'saved', target_root: root,
    relative_path: 'saved.pdf', filename: 'saved.pdf', status: 'completed' }]));
  const app = await start(t, root);
  const controller = new AbortController();
  const response = await fetch(app.url + '/api/events', { signal: controller.signal });
  const reader = response.body.getReader();
  try {
    const { value } = await reader.read();
    const text = Buffer.from(value).toString();
    assert.match(text, /"type":"snapshot"/); assert.match(text, /"id":"saved"/);
  } finally { controller.abort(); }
});
test('task endpoints expose persistence failures, unchanged tasks and missing open paths honestly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-actions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'paused', target_root: root, relative_path: 'missing/file.pdf', status: 'paused' }]));
  const app = await start(t, root);
  async function action(endpoint, body = {}) {
    const res = await fetch(app.url + '/api/tasks/' + endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  }
  assert.equal((await action('pause', { id: 'not-found' })).status, 409);
  assert.equal((await action('delete', { id: 'not-found' })).status, 409);
  const missing = await action('open_folder', { id: 'paused' });
  assert.equal(missing.status, 400); assert.equal(missing.data.success, false);
  fs.renameSync(file, file + '.old'); fs.mkdirSync(file);
  const failure = await action('delete', { id: 'paused' });
  assert.equal(failure.status, 500); assert.equal(failure.data.success, false);
  assert.match(failure.data.error, /当前会话生效.*保存失败/);
  const snapshot = await (await fetch(app.url + '/api/tasks')).json();
  assert.match(snapshot.storage_error, /保存失败/);
  fs.rmdirSync(file);
  assert.equal((await action('clear_completed')).status, 200);
  assert.equal((await (await fetch(app.url + '/api/tasks')).json()).storage_error, null);
});
