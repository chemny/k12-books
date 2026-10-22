// Stream lifecycle, validated resume offsets and bounded retries, independent of UI.
const fs = require('fs');
const https = require('https');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { setTimeout: delay } = require('timers/promises');

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

function retryable(err) {
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
    'EHOSTUNREACH', 'ENETUNREACH', 'ERR_STREAM_PREMATURE_CLOSE', 'INCOMPLETE',
    'HTTP_408', 'HTTP_416', 'HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504'].includes(err.code);
}

async function withRetry(operation, { signal, attempts = 3, baseDelay = 1000, onRetry = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(attempt); }
    catch (err) {
      if (signal?.aborted || attempt >= attempts || !retryable(err)) throw err;
      const wait = Math.min(60000, Math.max(err.retryAfterMs || 0, baseDelay * 2 ** (attempt - 1))) + Math.floor(Math.random() * baseDelay / 2);
      onRetry(err, attempt, wait);
      await delay(wait, undefined, { signal });
    }
  }
}

async function streamDownloadToFile({ urlStr, tempPartPath, signal, onProgress,
  headers = {}, lookup, transport = https, connectTimeoutMs = 15000, idleTimeoutMs = 45000 }) {
  signal?.throwIfAborted();
  const sidecar = tempPartPath + '.json';
  let previous;
  try { previous = JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch {}
  const validator = previous?.etag && !previous.etag.startsWith('W/') ? previous.etag : previous?.lastModified;
  // Unknown or different resources must never be appended together.
  const offset = previous?.url === urlStr && validator && fs.existsSync(tempPartPath)
    ? fs.statSync(tempPartPath).size : 0;
  const requestHeaders = { ...headers, 'Accept-Encoding': 'identity' };
  if (offset) Object.assign(requestHeaders, { Range: `bytes=${offset}-`, 'If-Range': validator });
  let req;
  const response = await new Promise((resolve, reject) => {
    req = transport.get(urlStr, { headers: requestHeaders, lookup, signal }, resolve);
    req.setTimeout(connectTimeoutMs, () => req.destroy(failure('连接或响应超时', 'ETIMEDOUT')));
    req.once('error', reject);
  });
  try {
    const status = response.statusCode;
    if (status !== 200 && status !== 206) {
      if (status === 416) fs.rmSync(sidecar, { force: true });
      const err = failure(`HTTP ${status}`, `HTTP_${status}`);
      const retryAfter = response.headers['retry-after'];
      if (retryAfter) err.retryAfterMs = /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
      throw err;
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
    if (status === 206 && (!offset || !range || Number(range[1]) !== offset ||
      Number(range[2]) < offset || Number(range[2]) >= Number(range[3]) ||
      (previous.etag && response.headers.etag && previous.etag !== response.headers.etag))) {
      fs.rmSync(sidecar, { force: true });
      throw failure('续传响应与本地文件不一致，请重试以完整下载', 'INCOMPLETE');
    }
    const start = status === 206 ? offset : 0;
    const length = Number(response.headers['content-length']) || 0;
    const total = range && status === 206 ? Number(range[3]) : length;
    if (status === 206 && length && Number(range[2]) - start + 1 !== length) {
      fs.rmSync(sidecar, { force: true });
      throw failure('续传长度不一致', 'INCOMPLETE');
    }
    fs.writeFileSync(sidecar, JSON.stringify({ url: urlStr, etag: response.headers.etag,
      lastModified: response.headers['last-modified'] }));
    req.setTimeout(idleTimeoutMs, () => req.destroy(failure('下载数据传输超时', 'ETIMEDOUT')));
    let written = start;
    let first = Buffer.alloc(0);
    const counter = new Transform({ transform(chunk, encoding, callback) {
      written += chunk.length;
      if (!start && first.length < 5) {
        first = Buffer.concat([first, chunk]).subarray(0, 5);
        if (first.length === 5 && first.toString('ascii') !== '%PDF-') {
          return callback(failure('响应不是 PDF 文件', 'INVALID_PDF'));
        }
      }
      onProgress?.(written, total);
      callback(null, chunk);
    }});
    await pipeline(response, counter, fs.createWriteStream(tempPartPath, { flags: start ? 'a' : 'w' }), { signal });
    if ((total && written !== total) || written < 5) throw failure('下载文件长度不完整', 'INCOMPLETE');
    const fd = fs.openSync(tempPartPath, 'r');
    try {
      const magic = Buffer.alloc(5);
      fs.readSync(fd, magic, 0, 5, 0);
      if (magic.toString('ascii') !== '%PDF-') throw failure('PDF 文件头无效', 'INVALID_PDF');
      const tail = Buffer.alloc(Math.min(written, 2048));
      fs.readSync(fd, tail, 0, tail.length, written - tail.length);
      if (!tail.includes(Buffer.from('%%EOF'))) {
        fs.rmSync(sidecar, { force: true });
        throw failure('PDF 缺少结束标记，可能未下载完整', 'INCOMPLETE');
      }
    } finally { fs.closeSync(fd); }
    return { written, totalBytes: total };
  } finally {
    response.destroy();
    req.destroy();
  }
}

module.exports = { streamDownloadToFile, withRetry, retryable };
