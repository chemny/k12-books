const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { countDownloadedPdfs } = require('../core/inventory');
const pdf = Buffer.from('%PDF-1.7\ncontent\n%%EOF\n');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'k12-inventory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const book = { id: 'math', is_active: true, has_pdf: true, relative_path: '小学/math.pdf', update_time: 'v1', pdf_size: pdf.length };
  async function write(rel, receipt, data = pdf) {
    const file = path.join(root, rel); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data);
    if (receipt) await fs.writeFile(file + '.download.json', JSON.stringify({ id: book.id, update_time: 'v1', size: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'), ...receipt }));
    return file;
  }
  return { root, book, write };
}
test('inventory counts distinct identified current textbooks independent of task history', async t => {
  const { root, book, write } = await fixture(t);
  await write(book.relative_path);
  await write('个人笔记.pdf'); await write('备份.pdf');
  await write('副本.pdf', {});
  await write('旧版.pdf', { update_time: 'v0' });
  await write('History/old.pdf', {}); await write('.download_temp/temporary.pdf', {});
  await write('小学/math.pdf.previous-123.pdf', {});
  await fs.symlink(path.join(root, book.relative_path), path.join(root, 'link.pdf'));
  const books = [book];
  assert.equal((await countDownloadedPdfs(root, books)).downloaded_pdf, 1);
  await fs.writeFile(path.join(root, 'tasks.json'), '[]');
  assert.equal((await countDownloadedPdfs(root, books)).downloaded_pdf, 1);
  await fs.unlink(path.join(root, book.relative_path));
  assert.equal((await countDownloadedPdfs(root, books)).downloaded_pdf, 1);
  await fs.unlink(path.join(root, '副本.pdf'));
  assert.equal((await countDownloadedPdfs(root, books)).downloaded_pdf, 0);
});
test('inventory invalidates cached digests for same-length corruption, replacements and receipt changes', async t => {
  const { root, book, write } = await fixture(t);
  const file = await write(book.relative_path, {});
  const books = [book];
  assert.equal((await countDownloadedPdfs(root, books)).downloaded_pdf, 1);
  const damaged = Buffer.from(pdf); damaged[10] ^= 1; await fs.writeFile(file, damaged);
  assert.equal((await countDownloadedPdfs(root, books)).downloaded_pdf, 0);
  await fs.writeFile(file, pdf);
  assert.equal((await countDownloadedPdfs(root, books)).downloaded_pdf, 1);
  await fs.writeFile(file + '.download.json', '{broken');
  assert.equal((await countDownloadedPdfs(root, books)).downloaded_pdf, 0);
  await fs.writeFile(file + '.download.json', JSON.stringify({ id: 'unknown', update_time: 'v1' }));
  assert.equal((await countDownloadedPdfs(root, books)).downloaded_pdf, 0);
});
test('catalog updates, different directories and concurrent inventory requests never share stale counts', async t => {
  const { root, book, write } = await fixture(t);
  await write(book.relative_path, {});
  const books = [book];
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => countDownloadedPdfs(root, books))), Array(5).fill({ downloaded_pdf: 1 }));
  assert.equal((await countDownloadedPdfs(root, [{ ...book, update_time: 'v2' }])).downloaded_pdf, 0);
  assert.equal((await countDownloadedPdfs(root, [{ ...book, is_active: false }])).downloaded_pdf, 0);
  assert.equal((await countDownloadedPdfs(path.join(root, 'missing'), books)).downloaded_pdf, 0);
});
