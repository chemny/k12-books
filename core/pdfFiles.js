const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// Bounded, metadata-invalidated cache; never retain PDF contents in memory.
const cache = new Map();
const inFlight = new Map();
const LIMIT = 8192;
function stamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
async function inspectPdf(file, { signal } = {}) {
  const key = path.resolve(file);
  const before = await fsp.lstat(key, { bigint: true });
  if (!before.isFile()) throw Object.assign(new Error('不是普通 PDF 文件'), { code: 'INVALID_PDF' });
  const fingerprint = stamp(before);
  const cached = cache.get(key);
  if (cached?.stamp === fingerprint) return cached.result;
  const jobKey = key + '\0' + fingerprint;
  if (!signal && inFlight.has(jobKey)) return inFlight.get(jobKey);
  const job = (async () => {
    const sha256 = crypto.createHash('sha256'), md5 = crypto.createHash('md5');
    let head = Buffer.alloc(0), tail = Buffer.alloc(0), size = 0;
    for await (const chunk of fs.createReadStream(key, { highWaterMark: 256 * 1024, signal })) {
      sha256.update(chunk); md5.update(chunk); size += chunk.length;
      if (head.length < 5) head = Buffer.concat([head, chunk.subarray(0, 5 - head.length)]);
      tail = chunk.length >= 2048 ? Buffer.from(chunk.subarray(-2048)) : Buffer.concat([tail, chunk]).subarray(-2048);
    }
    const after = await fsp.lstat(key, { bigint: true });
    if (stamp(after) !== fingerprint || BigInt(size) !== before.size) {
      throw Object.assign(new Error('文件在校验过程中发生变化，请重试'), { code: 'FILE_CHANGED' });
    }
    const result = { size, complete: head.toString() === '%PDF-' && tail.includes(Buffer.from('%%EOF')),
      sha256: sha256.digest('hex'), md5: md5.digest('hex') };
    cache.delete(key); cache.set(key, { stamp: fingerprint, result });
    if (cache.size > LIMIT) cache.delete(cache.keys().next().value);
    return result;
  })();
  if (!signal) inFlight.set(jobKey, job);
  try { return await job; } finally { if (!signal) inFlight.delete(jobKey); }
}

async function* walkPdfs(root) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'History') continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walkPdfs(file);
    else if (entry.isFile() && /\.pdf$/i.test(entry.name)) yield file;
  }
}
async function readReceipt(file) {
  try { return JSON.parse(await fsp.readFile(file + '.download.json', 'utf8')); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; if (error instanceof SyntaxError) return { invalid: true }; throw error; }
}
module.exports = { inspectPdf, walkPdfs, readReceipt };
