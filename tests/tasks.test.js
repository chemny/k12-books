const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-tasks-'));
process.env.CHINAK12_DATA_DIR = path.join(root, 'state');
const { DownloadManager, TaskItem } = require('../core/downloader');
const { atomicWrite, logDownload } = require('../core/storage');
const book = { id: 'book-id', title: '数学六年级', relative_path: '小学/数学/六年级.pdf', update_time: 'v1', pdf_size: 100 };
after(() => fs.rmSync(root, { recursive: true, force: true }));
function manager(t) {
  const m = new DownloadManager();
  m.tasks.clear(); m.taskOrder = [];
  t.after(() => { clearTimeout(m._saveTimer); });
  return m;
}
test('completed task can be requested in a new directory or after metadata changes', async t => {
  const m = manager(t); m.triggerWorkers = () => {};
  const old = new TaskItem(book, path.join(root, 'old')); old.status = 'completed';
  m.tasks.set(old.id, old); m.taskOrder.push(old.id);
  assert.equal(await m.addTasks([book], path.join(root, 'new')), 1);
  assert.equal(m.tasks.get(book.id).target_root, path.join(root, 'new'));
  m.tasks.get(book.id).status = 'failed';
  await m.addTasks([{ ...book, update_time: 'v2' }], path.join(root, 'new'));
  assert.equal(m.tasks.get(book.id).update_time, 'v2');
  assert.equal(m.taskOrder.length, 1);
});
test('immediate save is atomic and pending tasks recover paused', async t => {
  const m = manager(t); m.triggerWorkers = () => {};
  await m.addTasks([book], path.join(root, 'books'));
  m.saveToStorage(true);
  const file = path.join(process.env.CHINAK12_DATA_DIR, 'tasks.json');
  assert.equal(JSON.parse(fs.readFileSync(file))[0].id, book.id);
  const restored = new DownloadManager();
  assert.equal(restored.tasks.get(book.id).status, 'paused');
});
test('rapid pause and resume waits for the previous stream to settle', async t => {
  const m = manager(t);
  let runs = 0, simultaneous = 0, max = 0;
  m.downloadTask = async task => {
    runs++; simultaneous++; max = Math.max(max, simultaneous);
    try {
      if (runs === 1) await new Promise((resolve, reject) => {
        task.abortController.signal.addEventListener('abort', () => {
          setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 10);
        }, { once: true });
      });
      else task.status = 'completed';
    } finally { simultaneous--; }
  };
  await m.addTasks([book], path.join(root, 'books'));
  assert.equal(m.pauseTask(book.id), true);
  assert.equal(m.resumeTask(book.id), true);
  assert.equal(m.hasActiveTasks(), false);
  assert.equal(m.tasks.get(book.id).resumeRequested, true);
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('workers did not finish')); }, 5000);
    const timer = setInterval(() => {
      if (runs === 2 && m.activeWorkers === 0) { clearInterval(timer); clearTimeout(deadline); resolve(); }
    }, 20);
  });
  assert.equal(max, 1);
  assert.equal(m.tasks.get(book.id).status, 'completed');
});
test('failed tasks write diagnostic data without deleting completed history', t => {
  logDownload({ event: 'download_failed', id: book.id, host: 'example.test', error: 'HTTP_403' });
  const log = fs.readFileSync(path.join(process.env.CHINAK12_DATA_DIR, 'downloads.jsonl'), 'utf8');
  assert.equal(JSON.parse(log.trim()).error, 'HTTP_403');
  const m = manager(t); const archived = new TaskItem(book, root); archived.status = 'archived';
  m.tasks.set(book.id, archived); m.taskOrder.push(book.id);
  assert.equal(m.clearCompletedTasks(), 1);
  assert.equal(m.tasks.size, 0);
});
test('successful download preserves old file, writes a receipt, skips verified bytes and fetches a changed revision', async t => {
  const target = path.join(root, 'receipt-books');
  const original = new TaskItem(book, target);
  fs.mkdirSync(path.dirname(original.target_full_path), { recursive: true });
  fs.writeFileSync(original.target_full_path, 'original user file');
  let transfers = 0;
  const m = new DownloadManager(2, {
    requestJson: async () => ({ ti_items: [{ ti_format: 'pdf', ti_storages: ['https://example.test/book.pdf'] }] }),
    transfer: async ({ tempPartPath }) => {
      transfers++;
      const bytes = Buffer.from('%PDF-1.7\nrevision ' + transfers + '\n%%EOF');
      fs.writeFileSync(tempPartPath, bytes);
      return { written: bytes.length, totalBytes: bytes.length };
    },
  });
  t.after(() => clearTimeout(m._saveTimer));
  async function run(meta) {
    const task = new TaskItem(meta, target);
    task.status = 'downloading'; task.abortController = new AbortController();
    await m.downloadTask(task);
    return task;
  }
  assert.equal((await run(book)).status, 'completed');
  const preserved = fs.readdirSync(path.dirname(original.target_full_path)).find(n => n.includes('.previous-'));
  assert.ok(preserved);
  assert.equal(fs.readFileSync(path.join(path.dirname(original.target_full_path), preserved), 'utf8'), 'original user file');
  assert.equal((await run(book)).status, 'skipped');
  assert.equal(transfers, 1);
  assert.equal((await run({ ...book, update_time: 'v2' })).status, 'completed');
  assert.equal(transfers, 2);
  const receipt = JSON.parse(fs.readFileSync(original.target_full_path + '.download.json'));
  assert.equal(receipt.update_time, 'v2');
  // Equal-length local corruption must not be skipped simply because its size matches.
  const data = fs.readFileSync(original.target_full_path); data[10] ^= 1; fs.writeFileSync(original.target_full_path, data);
  assert.equal((await run({ ...book, update_time: 'v2' })).status, 'completed');
  assert.equal(transfers, 3);
});
test('original PDF uses a connection fallback on the same URL and validates official MD5', async t => {
  const crypto = require('crypto');
  const bytes = Buffer.from('%PDF-1.7\noriginal bytes\n%%EOF');
  const md5 = crypto.createHash('md5').update(bytes).digest('hex');
  const marker = { get() {} }, seen = [];
  const m = new DownloadManager(2, {
    requestJson: async () => ({ ti_items: [{ ti_format: 'pdf', ti_size: bytes.length, ti_md5: md5,
      ti_storages: ['https://r1-ndr-private.ykt.cbern.com.cn/book.pdf'] }] }),
    fallbackRoutes: () => [{ name: 'existing-proxy', transport: marker }],
    transfer: async opts => {
      seen.push({ url: opts.urlStr, transport: opts.transport });
      if (!opts.transport) throw Object.assign(new Error('HTTP 403'), { code: 'HTTP_403' });
      fs.writeFileSync(opts.tempPartPath, bytes);
      return { written: bytes.length };
    },
  });
  t.after(() => clearTimeout(m._saveTimer));
  const task = new TaskItem(book, path.join(root, 'fallback'));
  task.status = 'downloading'; task.abortController = new AbortController();
  await m.downloadTask(task);
  assert.equal(task.status, 'completed');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, seen[1].url);
  assert.equal(seen[1].transport, marker);
  assert.deepEqual(fs.readFileSync(task.target_full_path), bytes);
  const receipt = JSON.parse(fs.readFileSync(task.target_full_path + '.download.json'));
  assert.equal(receipt.official_md5, md5); assert.equal(receipt.md5, md5);
});
test('wrong original PDF checksum never replaces existing textbook', async t => {
  const bytes = Buffer.from('%PDF-1.7\nwrong bytes\n%%EOF');
  const m = new DownloadManager(2, {
    requestJson: async () => ({ ti_items: [{ ti_format: 'pdf', ti_size: bytes.length, ti_md5: '0'.repeat(32), ti_storages: ['https://example.test/file.pdf'] }] }),
    transfer: async ({ tempPartPath }) => { fs.writeFileSync(tempPartPath, bytes); return { written: bytes.length }; },
  });
  t.after(() => clearTimeout(m._saveTimer));
  const task = new TaskItem(book, path.join(root, 'wrong-md5'));
  fs.mkdirSync(path.dirname(task.target_full_path), { recursive: true });
  fs.writeFileSync(task.target_full_path, 'existing textbook');
  task.status = 'downloading'; task.abortController = new AbortController();
  await m.downloadTask(task);
  assert.equal(task.status, 'failed');
  assert.match(task.error_msg, /INTEGRITY_MISMATCH/);
  assert.equal(fs.readFileSync(task.target_full_path, 'utf8'), 'existing textbook');
});
test('restored child document downloads its official PDF from parent course metadata', async t => {
  const bytes = Buffer.from('%PDF-1.7\ncourse child original\n%%EOF');
  const md5 = require('crypto').createHash('md5').update(bytes).digest('hex');
  const m = new DownloadManager(2, {
    requestJson: async url => {
      if (url.includes('/details/')) throw Object.assign(new Error('HTTP 403'), { code: 'HTTP_403' });
      assert.match(url, /thematic_course\/parent\/resources\/list\.json$/);
      return [{ id: book.id, ti_items: [{ ti_format: 'pdf', ti_file_flag: 'pdf', ti_size: bytes.length,
        ti_md5: md5, ti_storages: ['https://example.test/child.pdf'] }] }];
    },
    transfer: async ({ tempPartPath }) => { fs.writeFileSync(tempPartPath, bytes); return { written: bytes.length }; },
  });
  t.after(() => clearTimeout(m._saveTimer));
  const task = new TaskItem({ ...book, parent_ids: ['parent'] }, path.join(root, 'child'));
  m.tasks.clear(); m.tasks.set(task.id, task); m.taskOrder = [task.id];
  m.saveToStorage(true);
  const restored = new DownloadManager();
  assert.deepEqual(restored.tasks.get(task.id).parent_ids, ['parent']);
  task.status = 'downloading'; task.abortController = new AbortController();
  await m.downloadTask(task);
  assert.equal(task.status, 'completed');
  assert.deepEqual(fs.readFileSync(task.target_full_path), bytes);
});
test('unsupported preview tasks are not restored into the original PDF queue', t => {
  const file = path.join(process.env.CHINAK12_DATA_DIR, 'tasks.json');
  atomicWrite(file, [{ ...book, id: book.id + ':preview', target_root: root, download_mode: 'public_preview', status: 'paused' }]);
  const m = manager(t);
  assert.equal(m.tasks.size, 0);
});
test('task creation persists immediately and write failures remain visible until a successful save', async t => {
  const m = manager(t); m.triggerWorkers = () => {};
  const file = path.join(process.env.CHINAK12_DATA_DIR, 'tasks.json');
  await m.addTasks([book], path.join(root, 'immediate'));
  assert.equal(JSON.parse(fs.readFileSync(file))[0].id, book.id);
  const backup = fs.readFileSync(file);
  fs.unlinkSync(file); fs.mkdirSync(file);
  t.after(() => { fs.rmSync(file, { recursive: true, force: true }); fs.writeFileSync(file, backup); });
  const events = []; m.subscribe(event => events.push(event));
  assert.equal(m.saveToStorage(), false);
  assert.match(m.storageError, /任务记录保存失败/);
  assert.equal(events.at(-1).type, 'storage_status');
  fs.rmdirSync(file);
  assert.equal(m.saveToStorage(), true); assert.equal(m.storageError, null);
  assert.equal(events.at(-1).data.error, null);
});
test('open folder passes special characters as arguments and reports OS failure', async t => {
  const file = path.join(root, '教材 $(dollar) `backtick` "quote" \'single\'.pdf');
  fs.writeFileSync(file, 'fixture');
  const calls = [];
  const m = new DownloadManager(2, { execFile: (command, args, options, callback) => {
    calls.push({ command, args }); callback(null);
  } });
  const task = new TaskItem({ ...book, relative_path: path.basename(file) }, root);
  m.tasks.clear(); m.tasks.set(task.id, task);
  t.after(() => clearTimeout(m._saveTimer));
  assert.equal(await m.openItemInFolder(task.id), true);
  assert.ok(calls[0].args.includes(file) || calls[0].args.includes(root));
  assert.ok(!calls[0].command.includes(file));
  m.execFile = (_, __, ___, callback) => callback(Object.assign(new Error('cannot launch'), { code: 'ENOENT' }));
  await assert.rejects(m.openItemInFolder(task.id), /打开目录失败/);
  await assert.rejects(m.openItemInFolder('missing'), /任务不存在/);
});
