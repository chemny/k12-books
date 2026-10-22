const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { inspectPdf } = require('../core/pdfFiles');
test('streaming verification invalidates cache after equal-length edits even with restored modification time', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'k12-pdf-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.pdf'); const original = Buffer.from('%PDF-1.7\nfixture\n%%EOF');
  await fs.writeFile(file, original); const stat = await fs.stat(file);
  const first = await inspectPdf(file);
  const modified = Buffer.from(original); modified[10] ^= 1;
  await fs.writeFile(file, modified); await fs.utimes(file, stat.atime, stat.mtime);
  assert.notEqual((await inspectPdf(file)).sha256, first.sha256);
  const aborted = new AbortController(); aborted.abort();
  const fresh = path.join(dir, 'fresh.pdf'); await fs.writeFile(fresh, original);
  await assert.rejects(inspectPdf(fresh, { signal: aborted.signal }), { name: 'AbortError' });
});
