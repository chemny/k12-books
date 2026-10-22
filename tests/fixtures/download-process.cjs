const http = require('http');
const { DownloadManager } = require('../../core/downloader');
const { streamDownloadToFile } = require('../../core/transfer');
const book = JSON.parse(process.env.K12_TEST_BOOK);
const m = new DownloadManager(2, {
  requestJson: async () => ({ ti_items: [{ ti_format: 'pdf', ti_size: book.pdf_size,
    ti_md5: process.env.K12_TEST_MD5, ti_storages: ['https://example.test/fixture.pdf'] }] }),
  fallbackRoutes: () => [],
  transfer: options => streamDownloadToFile({ ...options, urlStr: process.env.K12_TEST_URL, transport: http }),
});
process.on('message', async ({ command, token }) => {
  if (command === 'add') await m.addTasks([book], process.env.K12_TEST_DIR);
  if (command === 'pause') m.pauseAll();
  if (command === 'resume') m.resumeAll();
  if (command === 'retry') m.retryFailedTasks();
  process.send({ token, tasks: m.getAllTasks() });
});
process.send({ ready: true, tasks: m.getAllTasks() });
