const path = require('path');
const { inspectPdf, walkPdfs, readReceipt } = require('./pdfFiles');

// Count distinct current textbooks, independently of disposable task records.
// Unknown PDFs, old revisions, archives and backup copies do not inflate the count.
const pending = new Map();
async function countDownloadedPdfs(root, books = []) {
  if (!root) return { downloaded_pdf: 0 };
  const key = path.resolve(root);
  const previous = pending.get(key);
  if (previous?.books === books) return previous.promise;
  const promise = scan(key, books);
  const entry = { books, promise }; pending.set(key, entry);
  try { return await promise; } finally { if (pending.get(key) === entry) pending.delete(key); }
}
async function scan(root, books) {
  const active = books.filter(book => book.is_active && book.has_pdf);
  const byId = new Map(active.map(book => [book.id, book]));
  const byPath = new Map(active.map(book => [path.normalize(book.relative_path), book]));
  const found = new Set();
  const check = async file => {
    try {
      // App-created prior-file backups are never active textbooks, even with stray receipts.
      if (/\.previous-\d+(?:\.pdf)?$/i.test(file)) return;
      const receipt = await readReceipt(file);
      const book = receipt ? byId.get(receipt.id) : byPath.get(path.relative(root, file));
      if (!book || found.has(book.id)) return;
      if (receipt && receipt.update_time !== book.update_time) return;
      const info = await inspectPdf(file);
      if (!info.complete) return;
      if (receipt ? receipt.size !== info.size || receipt.sha256 !== info.sha256 : !book.pdf_size || book.pdf_size !== info.size) return;
      found.add(book.id);
    } catch (error) { if (!['ENOENT', 'FILE_CHANGED', 'INVALID_PDF'].includes(error.code)) throw error; }
  };
  // Limit open files and disk pressure while yielding between every asynchronous read.
  const running = new Set();
  for await (const file of walkPdfs(root)) {
    const job = check(file); running.add(job);
    job.then(() => running.delete(job), () => {});
    if (running.size >= 4) await Promise.race(running);
  }
  await Promise.all(running);
  return { downloaded_pdf: found.size };
}
module.exports = { countDownloadedPdfs };
