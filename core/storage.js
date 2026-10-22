const fs = require('fs');
const path = require('path');
const os = require('os');
const DATA_DIR = process.env.CHINAK12_DATA_DIR || path.join(os.homedir(), '.chinak12-downloader');

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function logDownload(event) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, 'downloads.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) {
      fs.renameSync(file, file + '.1');
    }
    // Log host, not signed resource URLs or authorization headers.
    fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n');
  } catch (err) { console.warn('下载日志保存失败:', err.message); }
}

module.exports = { DATA_DIR, atomicWrite, logDownload };
