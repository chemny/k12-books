// Explicit, isolated smoke test: one small textbook; never uses the saved download directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinak12-live-'));
process.env.CHINAK12_DATA_DIR = path.join(root, 'state');
const { TaskItem, DownloadManager } = require('../core/downloader');
const { refreshCatalogFromPlatform } = require('../core/catalog');
async function main() {
  console.log('ISOLATED_ROOT', root);
  const catalog = await refreshCatalogFromPlatform(info => console.log(info.message));
  console.log('SYNC_RESULT', JSON.stringify({ stats: catalog.stats, sync: catalog.sync.checked_at, changes: {
    added: catalog.sync.changes.added, changed: catalog.sync.changes.changed, missing: catalog.sync.changes.missing,
  } }));
  const requestedId = process.argv[2];
  const book = requestedId ? catalog.books.find(b => b.id === requestedId) : catalog.books.filter(b => b.is_active && b.has_pdf && b.stage === '小学' &&
    b.grade === '六年级' && b.subject === '数学' && b.version === '人教版').sort((a,b) => a.pdf_size - b.pdf_size)[0];
  if (!book) throw new Error('未找到验证教材');
  const manager = new DownloadManager();
  const task = new TaskItem(book, path.join(root, 'books'));
  task.status = 'downloading';
  task.abortController = new AbortController();
  const timeout = setTimeout(() => task.abortController.abort(), 120000);
  try { await manager.downloadTask(task); } finally { clearTimeout(timeout); }
  if (task.status !== 'completed') throw new Error(task.error_msg || task.status);
  const receipt = JSON.parse(fs.readFileSync(task.target_full_path + '.download.json'));
  if (!receipt.official_md5 || receipt.md5 !== receipt.official_md5.toLowerCase()) throw new Error('未通过官网原始 PDF 摘要校验');
  console.log('DOWNLOAD_RESULT', JSON.stringify({ status: task.status, size: task.total_bytes, title: book.title, official_md5_match: true, route: receipt.route, path: task.target_full_path }));
  const check = new TaskItem(book, path.join(root, 'books'));
  check.status = 'downloading';
  check.abortController = new AbortController();
  await manager.downloadTask(check);
  if (check.status !== 'skipped') throw new Error('下载后完整性核对未通过');
  console.log('VERIFIED_SKIP', check.status);
}
main().catch(err => { console.error('LIVE_CHECK_FAILED', err.code || err.name, err.message); process.exitCode = 1; });
