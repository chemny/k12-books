const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-reconcile-'));
process.env.CHINAK12_DATA_DIR = path.join(root, 'state');
const { DownloadManager, TaskItem } = require('../core/downloader');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const bytes = Buffer.from('%PDF-1.7\nfixture\n%%EOF');
const meta = { id: 'known', title: '语文', filename: '语文.pdf', relative_path: '初中/语文/人教版/七年级/语文.pdf',
  is_active: true, has_pdf: true, update_time: 'v2', pdf_size: bytes.length };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, 'books-'));
  const m = new DownloadManager(); m.tasks.clear(); m.taskOrder = [];
  t.after(() => clearTimeout(m._saveTimer));
  return { dir, m };
}
function write(dir, rel, id, version = 'v2') {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  if (id) fs.writeFileSync(file + '.download.json', JSON.stringify({ id, update_time: version,
    size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }));
  return file;
}
test('unknown PDFs of identical size never become textbooks or get archived', async t => {
  const { dir, m } = fixture(t);
  const unknown = write(dir, path.dirname(meta.relative_path) + '/个人笔记.pdf');
  const result = await m.reconcileAndArchive(dir, [meta]);
  assert.equal(result.active_kept, 0); assert.equal(result.total_archived, 0);
  assert.equal(m.tasks.size, 0); assert.deepEqual(fs.readFileSync(unknown), bytes);
});
test('known current PDF survives and repeated reconcile is idempotent', async t => {
  const { dir, m } = fixture(t); const file = write(dir, meta.relative_path, meta.id);
  assert.equal((await m.reconcileAndArchive(dir, [meta])).active_kept, 1);
  assert.equal((await m.reconcileAndArchive(dir, [meta])).total_archived, 0);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(m.tasks.get(meta.id).status, 'skipped');
});
test('older and removed resources archive with receipts and never overwrite history', async t => {
  const { dir, m } = fixture(t);
  const file = write(dir, meta.relative_path, meta.id, 'v1');
  const task = new TaskItem(meta, dir); task.status = 'completed';
  m.tasks.set(task.id, task); m.taskOrder.push(task.id);
  const history = write(dir, 'History/' + meta.relative_path, meta.id, 'older');
  assert.equal((await m.reconcileAndArchive(dir, [meta])).rule1_archived, 1);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(file + '.download.json'), false);
  assert.deepEqual(fs.readFileSync(history), bytes);
  assert.equal(JSON.parse(fs.readFileSync(history + '.download.json')).update_time, 'older');
  const archived = history.replace('.pdf', ' (1).pdf');
  assert.equal(JSON.parse(fs.readFileSync(archived + '.download.json')).update_time, 'v1');
  assert.equal(task.target_full_path, archived); assert.equal(task.status, 'archived');
  m.saveToStorage(true);
  const restored = new DownloadManager();
  assert.equal(restored.tasks.get(meta.id).target_full_path, archived);
  write(dir, 'removed.pdf', 'removed');
  assert.equal((await m.reconcileAndArchive(dir, [meta])).rule2_archived, 1);
  assert.equal((await m.reconcileAndArchive(dir, [meta])).total_archived, 0);
});
test('empty catalog and active transfer block archive before touching files', async t => {
  const { dir, m } = fixture(t); const file = write(dir, meta.relative_path, meta.id);
  await assert.rejects(() => m.reconcileAndArchive(dir, []), /目录为空/);
  const task = new TaskItem(meta, dir); m.tasks.set(meta.id, task); m.taskOrder.push(meta.id);
  await assert.rejects(() => m.reconcileAndArchive(dir, [meta]), /暂停下载/);
  assert.deepEqual(fs.readFileSync(file), bytes);
});
test('verified filename normalization moves receipt too and does not overwrite collisions', async t => {
  const { dir, m } = fixture(t); const file = write(dir, 'old-name.pdf', meta.id);
  assert.equal((await m.reconcileAndArchive(dir, [meta])).renamed_normalized, 1);
  const standard = path.join(dir, meta.relative_path);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(standard + '.download.json'), true);
  const duplicate = write(dir, 'other-name.pdf', meta.id);
  assert.equal((await m.reconcileAndArchive(dir, [meta])).renamed_normalized, 0);
  assert.deepEqual(fs.readFileSync(duplicate), bytes); assert.deepEqual(fs.readFileSync(standard), bytes);
});
test('asynchronous reconciliation and batch validation protect each other from concurrent mutations', async t => {
  const { dir, m } = fixture(t); write(dir, meta.relative_path, meta.id);
  const reconciliation = m.reconcileAndArchive(dir, [meta]);
  await assert.rejects(m.addTasks([meta], dir), /核对/);
  await reconciliation;
  const addition = m.addTasks([meta], dir);
  await assert.rejects(m.reconcileAndArchive(dir, [meta]), /等待完成/);
  assert.equal(await addition, 0);
  assert.equal(m.tasks.get(meta.id).status, 'skipped');
});
