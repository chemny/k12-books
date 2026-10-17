// 低并发稳定下载、持久化、暂停/恢复、断点续传与失败隔离引擎
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { exec } = require('child_process');
const { customDnsLookup } = require('./dnsResolver');

function archiveSingleFileToHistory(sourceFile, rootPath) {
  const relPath = path.relative(rootPath, sourceFile);
  const historyTarget = path.join(rootPath, 'History', relPath);
  const historyDir = path.dirname(historyTarget);

  fs.mkdirSync(historyDir, { recursive: true });

  if (fs.existsSync(historyTarget)) {
    fs.unlinkSync(historyTarget);
  }

  try {
    fs.renameSync(sourceFile, historyTarget);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(sourceFile, historyTarget);
      fs.unlinkSync(sourceFile);
    } else {
      throw err;
    }
  }

  return historyTarget;
}

const GLOBAL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://basic.smartedu.cn/',
  'Origin': 'https://basic.smartedu.cn',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const FLAG_PRIORITY = { source: 0, pdf: 1, pptx: 1 };

function pickBestPdfItem(items) {
  const candidates = (items || []).filter(it => {
    const fmt = (it.ti_format || '').toLowerCase();
    const storages = it.ti_storages || (it.ti_storage ? [it.ti_storage] : []);
    return fmt === 'pdf' && storages.length > 0;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const prioA = FLAG_PRIORITY[a.ti_file_flag] !== undefined ? FLAG_PRIORITY[a.ti_file_flag] : 9;
    const prioB = FLAG_PRIORITY[b.ti_file_flag] !== undefined ? FLAG_PRIORITY[b.ti_file_flag] : 9;
    if (prioA !== prioB) return prioA - prioB;
    return (b.ti_size || 0) - (a.ti_size || 0); // 优先高画质完整版
  });
  return candidates[0];
}

function requestJson(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const signal = options.signal;
    if (signal && signal.aborted) {
      return reject(new Error('AbortError'));
    }

    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        ...GLOBAL_HEADERS,
        'Accept': 'application/json, text/plain, */*',
        ...(options.headers || {})
      },
      lookup: customDnsLookup,
      timeout: options.timeout || 12000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Invalid JSON: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('AbortError'));
      }, { once: true });
    }

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

function streamDownloadToFile({
  urlStr,
  tempPartPath,
  existingBytes,
  signal,
  onProgress,
  connectTimeoutMs = 12000,
  idleTimeoutMs = 30000,
}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    if (signal && signal.aborted) {
      return reject(new Error('AbortError'));
    }

    const headers = {
      ...GLOBAL_HEADERS,
      'Host': u.hostname,
    };

    let isResume = false;
    if (existingBytes > 4) {
      headers['Range'] = `bytes=${existingBytes}-`;
      isResume = true;
    }

    let fileWriteStream = null;
    let timer = null;
    let isCleanedUp = false;
    let responseRef = null;

    const resetIdleTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Stream idle timeout'));
      }, idleTimeoutMs);
    };

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      if (timer) { clearTimeout(timer); timer = null; }

      if (responseRef) {
        try {
          responseRef.removeAllListeners('data');
          responseRef.removeAllListeners('end');
          responseRef.removeAllListeners('error');
          responseRef.destroy();
        } catch (e) {}
      }

      try { req.destroy(); } catch (e) {}

      if (fileWriteStream) {
        try {
          if (!fileWriteStream.destroyed) {
            fileWriteStream.destroy();
          }
        } catch (e) {}
      }
    };

    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      lookup: customDnsLookup,
      timeout: connectTimeoutMs,
    }, (res) => {
      responseRef = res;

      if (isCleanedUp || (signal && signal.aborted)) {
        cleanup();
        return reject(new Error('AbortError'));
      }

      if (res.statusCode === 401 || res.statusCode === 403) {
        cleanup();
        return reject(new Error(`官方限制 (HTTP ${res.statusCode})`));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        cleanup();
        return reject(new Error(`CDN 节点异常 (HTTP ${res.statusCode})`));
      }

      let totalBytes = 0;
      const contentLen = res.headers['content-length'];
      if (contentLen) {
        const len = parseInt(contentLen, 10);
        totalBytes = (res.statusCode === 206) ? (existingBytes + len) : len;
      }

      const fileFlags = (res.statusCode === 206) ? 'a' : 'w';
      let written = (res.statusCode === 206) ? existingBytes : 0;
      fileWriteStream = fs.createWriteStream(tempPartPath, { flags: fileFlags });

      // 静默捕获文件流异常，杜绝 ERR_STREAM_DESTROYED 冒泡
      fileWriteStream.on('error', (err) => {
        cleanup();
      });

      let isFirstChunk = (written === 0);
      let isValidPdf = true;

      resetIdleTimer();

      res.on('data', (chunk) => {
        resetIdleTimer();

        if (isCleanedUp || (signal && signal.aborted) || !fileWriteStream || fileWriteStream.destroyed || fileWriteStream.closed) {
          cleanup();
          return reject(new Error('AbortError'));
        }

        if (isFirstChunk) {
          isFirstChunk = false;
          // 校验 %PDF 魔数 (0x25 0x50 0x44 0x46)
          if (chunk.length >= 4) {
            if (chunk[0] !== 0x25 || chunk[1] !== 0x50 || chunk[2] !== 0x44 || chunk[3] !== 0x46) {
              isValidPdf = false;
              cleanup();
              return reject(new Error('Invalid PDF magic header'));
            }
          }
        }

        try {
          if (!fileWriteStream.destroyed && !fileWriteStream.closed) {
            fileWriteStream.write(chunk);
            written += chunk.length;
            if (onProgress) {
              onProgress(written, totalBytes);
            }
          }
        } catch (err) {
          cleanup();
        }
      });

      res.on('end', () => {
        if (timer) clearTimeout(timer);
        if (isCleanedUp) return;
        try {
          fileWriteStream.end(() => {
            if (!isValidPdf || written < 20 * 1024) {
              return reject(new Error('File incomplete or invalid'));
            }
            resolve({ written, totalBytes });
          });
        } catch (e) {
          cleanup();
        }
      });

      res.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        cleanup();
        reject(new Error('AbortError'));
      }, { once: true });
    }

    req.on('timeout', () => {
      cleanup();
      reject(new Error('Connection timeout'));
    });

    req.on('error', (err) => {
      cleanup();
      reject(err);
    });

    req.end();
  });
}

const TASKS_STORAGE_FILE = path.join(os.homedir(), '.chinak12_downloader_tasks.json');

class TaskItem {
  constructor(bookMeta, targetRoot) {
    this.id = bookMeta.id;
    this.seq = bookMeta.seq || 0;
    this.title = bookMeta.title || '';
    this.clean_title = bookMeta.clean_title || '';
    this.edition_tag = bookMeta.edition_tag || '';
    this.filename = bookMeta.filename || '';
    this.relative_path = bookMeta.relative_path || '';
    this.update_time = bookMeta.update_time || '';
    this.target_root = targetRoot;
    this.target_full_path = path.join(targetRoot, this.relative_path);
    this.total_bytes = bookMeta.pdf_size || 0;
    this.downloaded_bytes = 0;
    this.speed = 0.0;
    // 状态: pending (排队), downloading (下载中), paused (暂停), completed (完成), skipped (已存在跳过), failed (失败)
    this.status = 'pending';
    this.error_msg = '';
    this.start_time = null;
    this.finish_time = null;

    // 运行时流控制器（不参与持久化）
    this.abortController = null;
  }

  toDict() {
    let pct = 0.0;
    if (this.total_bytes > 0) {
      pct = Math.min(100.0, (this.downloaded_bytes / this.total_bytes) * 100);
    } else if (['completed', 'skipped'].includes(this.status)) {
      pct = 100.0;
    }

    return {
      id: this.id,
      seq: this.seq,
      title: this.title,
      clean_title: this.clean_title,
      edition_tag: this.edition_tag,
      filename: this.filename,
      relative_path: this.relative_path,
      target_full_path: this.target_full_path,
      total_bytes: this.total_bytes,
      downloaded_bytes: this.downloaded_bytes,
      percent: Math.round(pct * 10) / 10,
      speed_formatted: this.formatSpeed(),
      status: this.status,
      error_msg: this.error_msg,
    };
  }

  formatSpeed() {
    if (this.status !== 'downloading' || this.speed <= 0) {
      return '';
    }
    if (this.speed > 1024 * 1024) {
      return `${(this.speed / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    return `${Math.round(this.speed / 1024)} KB/s`;
  }
}

class DownloadManager {
  constructor(maxWorkers = 2) {
    // 降低默认并发至 2，避免触发 CDN 频率限制与 403 拒绝
    this.maxWorkers = maxWorkers;
    this.tasks = new Map();
    this.taskOrder = [];
    this.activeWorkers = 0;
    this.eventSubscribers = [];
    this._saveTimer = null;

    // 启动时从持久化存储恢复任务
    this.loadFromStorage();
  }

  subscribe(callback) {
    this.eventSubscribers.push(callback);
  }

  unsubscribe(callback) {
    this.eventSubscribers = this.eventSubscribers.filter(cb => cb !== callback);
  }

  notify(eventType, data = null) {
    const payload = { type: eventType, data, timestamp: Date.now() / 1000 };
    for (const cb of this.eventSubscribers) {
      try {
        cb(payload);
      } catch (e) {}
    }
  }

  // --- 持久化存储与恢复 ---
  saveToStorage() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        const serialized = this.taskOrder.map(tid => {
          const t = this.tasks.get(tid);
          return {
            id: t.id,
            seq: t.seq,
            title: t.title,
            clean_title: t.clean_title,
            edition_tag: t.edition_tag,
            filename: t.filename,
            relative_path: t.relative_path,
            update_time: t.update_time,
            target_root: t.target_root,
            total_bytes: t.total_bytes,
            downloaded_bytes: t.downloaded_bytes,
            status: t.status === 'downloading' ? 'paused' : t.status, // 若退出时在下载中，恢复为暂停状态
            error_msg: t.error_msg,
          };
        });
        fs.writeFileSync(TASKS_STORAGE_FILE, JSON.stringify(serialized, null, 2), 'utf-8');
      } catch (e) {
        console.warn('⚠️ 保存下载任务到磁盘失败:', e.message);
      }
    }, 500);
  }

  loadFromStorage() {
    if (!fs.existsSync(TASKS_STORAGE_FILE)) return;
    try {
      const data = JSON.parse(fs.readFileSync(TASKS_STORAGE_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const item of data) {
          if (!item.id) continue;
          const task = new TaskItem(item, item.target_root);
          task.total_bytes = item.total_bytes || 0;
          task.downloaded_bytes = item.downloaded_bytes || 0;
          task.status = item.status === 'downloading' ? 'paused' : item.status;
          task.error_msg = item.error_msg || '';

          this.tasks.set(task.id, task);
          this.taskOrder.push(task.id);
        }
        console.log(`📥 已从本地磁盘恢复 ${this.tasks.size} 个下载任务状态`);
      }
    } catch (e) {
      console.warn('⚠️ 从磁盘读取下载任务失败:', e.message);
    }
  }

  hasActiveTasks() {
    for (const t of this.tasks.values()) {
      if (t.status === 'downloading' || t.status === 'pending') {
        return true;
      }
    }
    return false;
  }

  addTasks(bookItems, targetRoot) {
    let added = 0;
    for (const item of bookItems) {
      const bookId = item.id;
      if (this.tasks.has(bookId)) {
        const t = this.tasks.get(bookId);
        if (['failed', 'paused'].includes(t.status)) {
          t.status = 'pending';
          t.error_msg = '';
          t.target_root = targetRoot;
          t.target_full_path = path.join(targetRoot, t.relative_path);
          added++;
        }
        continue;
      }

      const task = new TaskItem(item, targetRoot);
      const targetPath = task.target_full_path;
      const targetDir = path.dirname(targetPath);

      // 快速核对：如果本地已有该书（或旧前缀命名文件），立即置为 skipped，绝不排入 pending 队列！
      let alreadyOnDisk = false;
      let matchedSize = 0;
      if (fs.existsSync(targetPath)) {
        const s = fs.statSync(targetPath).size;
        if (task.total_bytes > 0 && Math.abs(s - task.total_bytes) <= (task.total_bytes * 0.05)) {
          alreadyOnDisk = true;
          matchedSize = s;
        }
      } else if (fs.existsSync(targetDir)) {
        try {
          const files = fs.readdirSync(targetDir);
          for (const f of files) {
            if (!f.endsWith('.pdf') || f.startsWith('.')) continue;
            const fPath = path.join(targetDir, f);
            const s = fs.statSync(fPath).size;
            if (task.total_bytes > 0 && Math.abs(s - task.total_bytes) <= (task.total_bytes * 0.05)) {
              const bCore = task.clean_title ? task.clean_title.replace(/^[（(][^）)]+[）)]/, '').trim() : '';
              if ((task.edition_tag && f.includes(task.edition_tag)) || (bCore && f.includes(bCore))) {
                fs.renameSync(fPath, targetPath);
                alreadyOnDisk = true;
                matchedSize = s;
                break;
              }
            }
          }
        } catch (e) {}
      }

      if (alreadyOnDisk) {
        task.status = 'skipped';
        task.downloaded_bytes = matchedSize;
        task.total_bytes = matchedSize;
        task.finish_time = Date.now();
      } else {
        task.status = 'pending';
        added++;
      }

      this.tasks.set(bookId, task);
      this.taskOrder.push(bookId);
    }

    this.saveToStorage();
    this.notify('tasks_updated', { added_count: added });
    this.triggerWorkers();
    return added;
  }

  hasPendingTasks() {
    for (const tid of this.taskOrder) {
      const t = this.tasks.get(tid);
      if (t && t.status === 'pending') return true;
    }
    return false;
  }

  _pickNextPendingTask() {
    for (const tid of this.taskOrder) {
      const t = this.tasks.get(tid);
      if (t && t.status === 'pending') return t;
    }
    return null;
  }

  triggerWorkers() {
    this.maxWorkers = 2; // 严苛硬锁为 2，绝对杜绝任何超额并发
    while (this.activeWorkers < this.maxWorkers) {
      if (!this.hasPendingTasks()) {
        break;
      }
      this.activeWorkers++;
      const workerIndex = this.activeWorkers;
      console.log(`⚡ [Worker调度] 启动第 ${workerIndex} 个 Worker (上限: ${this.maxWorkers})`);
      this._runWorkerLoop(workerIndex).catch(err => {
        console.error('Worker loop exception:', err);
      });
    }
  }

  async _runWorkerLoop(workerIndex = 1) {
    try {
      // 错峰启动防护：如果是第 2 个 Worker，轻微错开 400ms 建立握手，避免同时冲击 CDN
      if (workerIndex > 1) {
        await new Promise(r => setTimeout(r, 400));
      }

      while (true) {
        const task = this._pickNextPendingTask();
        if (!task) {
          break; // 没有任务了，本 worker 正常退出
        }

        task.status = 'downloading';
        task.start_time = Date.now();
        task.abortController = new AbortController();
        console.log(`🚀 [下载开始] 《${task.filename}》 (活跃Worker: ${this.activeWorkers}/${this.maxWorkers})`);
        this.saveToStorage();
        this.notify('task_started', task.toDict());

        try {
          await this.downloadTask(task);
        } catch (err) {
          if (task.status !== 'paused') {
            task.status = 'failed';
            task.error_msg = err.message || String(err);
          }
        } finally {
          task.abortController = null;
          this.saveToStorage();
          this.notify('task_finished', task.toDict());
          // 上下任务之间礼貌休眠防护：800ms~1200ms 动态随机抖动，彻底规避 CDN 机械化频控与封锁
          const jitterDelay = 800 + Math.floor(Math.random() * 400);
          await new Promise(r => setTimeout(r, jitterDelay));
        }
      }
    } finally {
      this.activeWorkers--;
      console.log(`⏹️ [Worker释放] 剩余活跃Worker: ${this.activeWorkers}`);
      // 若还有剩余待下载任务，唤醒新 worker
      if (this.hasPendingTasks()) {
        this.triggerWorkers();
      }
    }
  }

  async downloadTask(task) {
    const targetRootPath = path.resolve(task.target_root);
    const targetPath = path.resolve(task.target_full_path);
    const targetDir = path.dirname(targetPath);
    fs.mkdirSync(targetDir, { recursive: true });

    // 1. 检查本地已存在正版文件
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath);
      const localSize = stats.size;
      const expectedSize = task.total_bytes;

      if (expectedSize > 0 && Math.abs(localSize - expectedSize) <= (expectedSize * 0.05)) {
        task.status = 'skipped';
        task.downloaded_bytes = localSize;
        return;
      } else {
        console.warn(`⚠️ 本地文件大小(${localSize})与预期(${expectedSize})不匹配，判定为未完成残缺文件，准备重新下载`);
      }
    } else if (fs.existsSync(targetDir)) {
      // 检查目录内是否存在带历史前缀命名的同款文件
      try {
        const files = fs.readdirSync(targetDir);
        for (const f of files) {
          if (!f.endsWith('.pdf') || f.startsWith('.')) continue;
          const fPath = path.join(targetDir, f);
          const s = fs.statSync(fPath).size;
          if (task.total_bytes > 0 && Math.abs(s - task.total_bytes) <= (task.total_bytes * 0.05)) {
            const bCore = task.clean_title ? task.clean_title.replace(/^[（(][^）)]+[）)]/, '').trim() : '';
            if ((task.edition_tag && f.includes(task.edition_tag)) || (bCore && f.includes(bCore))) {
              fs.renameSync(fPath, targetPath);
              task.status = 'skipped';
              task.downloaded_bytes = s;
              task.total_bytes = s;
              return;
            }
          }
        }
      } catch (e) {}
    }

    // 2. 临时下载目录
    const tempDir = path.join(targetRootPath, '.download_temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPart = path.join(tempDir, `${task.id}.pdf.part`);
    const tempFinished = path.join(tempDir, `${task.id}.pdf`);

    // 3. 获取下载链接 (包含重试与备用接口)
    let detailsData = null;
    const detailsUrls = [
      `https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${task.id}.json`,
      `https://s-file-2.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${task.id}.json`,
      `https://s-file-3.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${task.id}.json`,
    ];

    for (const dUrl of detailsUrls) {
      if (task.status === 'paused') return;
      try {
        detailsData = await requestJson(dUrl, {
          signal: task.abortController ? task.abortController.signal : null,
          timeout: 10000,
        });
        if (detailsData) break;
      } catch (e) {
        if (e.message === 'AbortError') return;
      }
    }

    if (!detailsData) {
      task.status = 'failed';
      task.error_msg = '官方元数据解析超时或拒绝 (请点击重试)';
      return;
    }

    const items = detailsData.ti_items || [];
    const pdfItem = pickBestPdfItem(items);
    if (!pdfItem) {
      task.status = 'failed';
      task.error_msg = '官方未发布有效 PDF';
      return;
    }

    let rawStorages = pdfItem.ti_storages || [];
    if (rawStorages.length === 0 && pdfItem.ti_storage) {
      rawStorages = [pdfItem.ti_storage.replace('cs_path:${ref-path}', 'https://r1-ndr-private.ykt.cbern.com.cn')];
    }

    // 核心对齐原作者算法: 将 *-ndr-private 扩展为公开镜像 *-ndr-oversea (匿名可用)，再 fallback 回原始镜像
    const candidateUrls = [];
    for (const storage of rawStorages) {
      const candidates = [
        storage.replace('-ndr-private', '-ndr-oversea'),
        storage
      ];
      for (const cand of candidates) {
        const encoded = encodeURI(cand);
        if (!candidateUrls.includes(encoded)) {
          candidateUrls.push(encoded);
        }
      }
    }

    if (candidateUrls.length === 0) {
      task.status = 'failed';
      task.error_msg = '无法解析 CDN 下载地址';
      return;
    }

    // 4. 断点续传准备
    let existingBytes = 0;
    if (fs.existsSync(tempPart)) {
      try {
        existingBytes = fs.statSync(tempPart).size;
      } catch (e) {}
    }

    let downloadOk = false;
    let lastErrorReason = '';
    for (const url of candidateUrls) {
      if (task.status !== 'downloading') return;

      try {
        let lastSpeedTime = Date.now();
        let lastSpeedBytes = existingBytes;

        const res = await streamDownloadToFile({
          urlStr: url,
          tempPartPath: tempPart,
          existingBytes: existingBytes,
          signal: task.abortController ? task.abortController.signal : null,
          onProgress: (downloaded, total) => {
            task.downloaded_bytes = downloaded;
            if (total > 0) task.total_bytes = total;
            const now = Date.now();
            const dt = (now - lastSpeedTime) / 1000;
            if (dt >= 0.5) {
              task.speed = Math.max(0, (downloaded - lastSpeedBytes) / dt);
              lastSpeedTime = now;
              lastSpeedBytes = downloaded;
            }
          }
        });

        // 下载完成，原子归档到目标位置
        if (fs.existsSync(tempFinished)) fs.unlinkSync(tempFinished);
        fs.renameSync(tempPart, tempFinished);

        try {
          if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
          fs.renameSync(tempFinished, targetPath);
        } catch (err) {
          if (err.code === 'EXDEV') {
            fs.copyFileSync(tempFinished, targetPath);
            fs.unlinkSync(tempFinished);
          } else {
            throw err;
          }
        }

        task.status = 'completed';
        task.speed = 0;
        task.error_msg = '';
        task.downloaded_bytes = res.written;
        task.total_bytes = res.written;
        task.finish_time = Date.now();
        downloadOk = true;
        console.log(`✅ [下载完成] 《${task.filename}》 (${Math.round(res.written / 1024 / 1024 * 10) / 10} MB)`);
        break;
      } catch (err) {
        if (task.status === 'paused' || (task.abortController && task.abortController.signal.aborted)) {
          return;
        }
        lastErrorReason = err.message || String(err);
        if (lastErrorReason.includes('Invalid PDF magic header')) {
          try { if (fs.existsSync(tempPart)) fs.unlinkSync(tempPart); } catch (e) {}
          existingBytes = 0;
        }
        console.warn(`⚠️ [镜像重试] 《${task.filename}》: ${lastErrorReason}`);
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
    }

    if (!downloadOk && task.status === 'downloading') {
      task.status = 'failed';
      task.error_msg = lastErrorReason || '所有 CDN 节点连接超时或拒绝 (请稍后重试)';
    }
  }

  // --- 暂停、恢复与重试控制 ---

  pauseTask(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    if (t.status === 'downloading' || t.status === 'pending') {
      t.status = 'paused';
      t.speed = 0;
      if (t.abortController) {
        t.abortController.abort();
        t.abortController = null;
      }
      this.saveToStorage();
      this.notify('task_updated', t.toDict());
      return true;
    }
    return false;
  }

  pauseAll() {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'downloading' || t.status === 'pending') {
        t.status = 'paused';
        t.speed = 0;
        if (t.abortController) {
          t.abortController.abort();
          t.abortController = null;
        }
        count++;
      }
    }
    this.saveToStorage();
    this.notify('tasks_updated');
    return count;
  }

  resumeTask(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    if (t.status === 'paused' || t.status === 'failed') {
      t.status = 'pending';
      t.error_msg = '';
      this.saveToStorage();
      this.notify('task_updated', t.toDict());
      this.triggerWorkers();
      return true;
    }
    return false;
  }

  resumeAll() {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'paused') {
        t.status = 'pending';
        t.error_msg = '';
        count++;
      }
    }
    this.saveToStorage();
    this.notify('tasks_updated');
    this.triggerWorkers();
    return count;
  }

  retryFailedTasks(taskIds = null) {
    const idsToRetry = taskIds ? new Set(taskIds) : null;
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'failed') {
        if (!idsToRetry || idsToRetry.has(t.id)) {
          t.status = 'pending';
          t.error_msg = '';
          count++;
        }
      }
    }
    this.saveToStorage();
    this.notify('tasks_updated');
    this.triggerWorkers();
    return count;
  }

  // --- 删除任务与清理文件规则 ---

  deleteTask(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return false;

    // 1. 如果正在下载，先中止网络流
    if (t.abortController) {
      t.abortController.abort();
      t.abortController = null;
    }

    // 2. 按照用户要求：若未完成（downloading, pending, paused, failed），删除任务的同时删除下载中的文件/临时分块
    if (['pending', 'downloading', 'paused', 'failed'].includes(t.status)) {
      const tempPart = path.join(t.target_root, '.download_temp', `${t.id}.pdf.part`);
      const tempFinished = path.join(t.target_root, '.download_temp', `${t.id}.pdf`);
      const safeUnlink = (p) => {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e) {
          setTimeout(() => {
            try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (err) {}
          }, 300);
        }
      };
      safeUnlink(tempPart);
      safeUnlink(tempFinished);
    }
    // 已经下载完整的书籍保留，不删除实际文件

    this.tasks.delete(taskId);
    this.taskOrder = this.taskOrder.filter(id => id !== taskId);
    this.saveToStorage();
    this.notify('tasks_updated');
    return true;
  }

  deleteBatchTasks(taskIds) {
    const idSet = new Set(taskIds);
    let count = 0;
    for (const id of idSet) {
      if (this.deleteTask(id)) count++;
    }
    return count;
  }

  clearDownloadingTasks() {
    // 正在下载页面：清空所有任务删除，下载中的也停止，同时删除未完整下载的书籍，已经下载完整的书籍保留不删除
    const toRemove = [];
    for (const t of this.tasks.values()) {
      if (['pending', 'downloading', 'paused'].includes(t.status)) {
        toRemove.push(t.id);
      }
    }
    return this.deleteBatchTasks(toRemove);
  }

  clearFailedTasks(taskIds = null) {
    // 清空失败任务：删除失败的任务，同时删除对应的失败临时文件
    const toRemove = [];
    const idSet = taskIds ? new Set(taskIds) : null;
    for (const t of this.tasks.values()) {
      if (t.status === 'failed') {
        if (!idSet || idSet.has(t.id)) {
          toRemove.push(t.id);
        }
      }
    }
    return this.deleteBatchTasks(toRemove);
  }

  clearCompletedTasks() {
    // 成功页面：清空列表，保留本地已下载完整的书籍
    const toRemove = [];
    for (const t of this.tasks.values()) {
      if (['completed', 'skipped'].includes(t.status)) {
        toRemove.push(t.id);
      }
    }
    for (const id of toRemove) {
      this.tasks.delete(id);
      this.taskOrder = this.taskOrder.filter(tid => tid !== id);
    }
    this.saveToStorage();
    this.notify('tasks_updated');
    return toRemove.length;
  }

  // --- 打开文件与所在目录 (支持 macOS, Windows, Linux) ---
  openItemInFolder(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    const fullPath = t.target_full_path;
    if (fs.existsSync(fullPath)) {
      if (process.platform === 'darwin') {
        exec(`open -R "${fullPath}"`);
      } else if (process.platform === 'win32') {
        exec(`explorer.exe /select,"${fullPath.replace(/\//g, '\\')}"`);
      } else {
        exec(`xdg-open "${path.dirname(fullPath)}"`);
      }
      return true;
    } else {
      // 若文件不存在，尝试打开其所在目录
      const dir = path.dirname(fullPath);
      if (fs.existsSync(dir)) {
        if (process.platform === 'darwin') {
          exec(`open "${dir}"`);
        } else if (process.platform === 'win32') {
          exec(`explorer.exe "${dir.replace(/\//g, '\\')}"`);
        } else {
          exec(`xdg-open "${dir}"`);
        }
        return true;
      }
    }
    return false;
  }

  // --- 本地教材核对与归档引擎 (严格遵循同目录同名规则与官网下架规则) ---
  reconcileAndArchive(targetRoot, catalogBooks = null) {
    if (!catalogBooks) {
      const { loadCatalogData } = require('./catalog');
      const cat = loadCatalogData();
      catalogBooks = cat.books || [];
    }

    const targetRootPath = path.resolve(targetRoot);
    if (!fs.existsSync(targetRootPath)) {
      return { success: false, error: '指定的下载根目录不存在' };
    }

    const activeBooks = catalogBooks.filter(b => b.is_active && b.has_pdf);
    const allBooks = catalogBooks;

    // 1. 递归扫描本地磁盘上的所有实际存在的 PDF 文件（排除 History 目录与 .download_temp 目录）
    const localFiles = [];
    const scanDir = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name !== 'History' && ent.name !== '.download_temp') {
            scanDir(full);
          }
        } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.pdf')) {
          const stat = fs.statSync(full);
          localFiles.push({
            fullPath: full,
            relPath: path.relative(targetRootPath, full),
            dir: dir,
            filename: ent.name,
            size: stat.size,
          });
        }
      }
    };
    scanDir(targetRootPath);

    // 2. 按所在目录对本地文件进行归类（严格落实“同一个目录下的同名”）
    const filesByDir = new Map();
    for (const f of localFiles) {
      if (!filesByDir.has(f.dir)) filesByDir.set(f.dir, []);
      filesByDir.get(f.dir).push(f);
    }

    let keptActiveCount = 0;
    let renamedCount = 0;
    const rule1Archived = []; // 规则 1：同一个目录下的同名教材不是最新，归档
    const rule2Archived = []; // 规则 2：官网已删除但本地拥有的，归档

    // 辅助匹配函数：针对同一个目录，计算文件与官方在用教材的最佳匹配
    const matchBestBook = (file, books) => {
      let best = null;
      let bestScore = -1;
      let bestDiff = 999;

      for (const b of books) {
        let score = 0;
        // 册次匹配 (上册/下册/全一册)
        if (b.volume && file.filename.includes(b.volume)) score += 100;
        else if (!b.volume && (file.filename.includes('全一册') || !file.filename.includes('册'))) score += 50;

        // 修订版本标签匹配 (如 2022修订版)
        if (b.edition_tag && file.filename.includes(b.edition_tag)) score += 50;

        // 书名核心匹配
        const bCore = (b.clean_title || b.title).replace(/^[（(][^）)]+[）)]/, '').replace(/^[^\s·]+版[（(][^）)]+[）)]/, '').trim();
        if (bCore && file.filename.includes(bCore)) score += 80;

        // 大小匹配容差 (5% 以内)
        const diff = b.pdf_size ? Math.abs(file.size - b.pdf_size) / b.pdf_size : 1;
        if (diff <= 0.05) score += 50;
        if (diff <= 0.01) score += 20;

        if (score > bestScore || (score === bestScore && diff < bestDiff)) {
          bestScore = score;
          bestDiff = diff;
          best = b;
        }
      }
      return { book: best, score: bestScore, diff: bestDiff };
    };

    // 3. 逐个目录执行同目录核对与归档
    for (const [dir, files] of filesByDir.entries()) {
      const relDir = path.relative(targetRootPath, dir);
      const parts = relDir.split(path.sep);

      // 找到属于该目录的官方最新在用教材 (考虑出版社目录命名的轻微别名差异)
      const dirActiveBooks = activeBooks.filter(b => {
        const bDir = path.dirname(path.join(targetRootPath, b.relative_path));
        if (bDir === dir) return true;
        return parts.length >= 4 && parts[0] === b.stage && parts[1] === b.subject && parts[3] === b.grade &&
          (b.publisher_dir.includes(parts[2].replace(/-.*$/, '')) || parts[2].includes(b.version));
      });

      const claimedActiveBookIds = new Set();
      const unclaimedFiles = [];

      // 优先给与官方标准文件名完全一致的文件匹配
      files.sort((a, b) => {
        const aExact = dirActiveBooks.some(bk => bk.filename === a.filename);
        const bExact = dirActiveBooks.some(bk => bk.filename === b.filename);
        if (aExact !== bExact) return bExact ? 1 : -1;
        return 0;
      });

      for (const file of files) {
        const availableBooks = dirActiveBooks.filter(b => !claimedActiveBookIds.has(b.id));
        const res = matchBestBook(file, availableBooks);

        if (res.book && res.diff <= 0.05) {
          claimedActiveBookIds.add(res.book.id);
          keptActiveCount++;

          const standardPath = path.join(dir, res.book.filename);
          if (file.fullPath !== standardPath) {
            try {
              if (fs.existsSync(standardPath)) fs.unlinkSync(standardPath);
              fs.renameSync(file.fullPath, standardPath);
              file.fullPath = standardPath;
              file.filename = res.book.filename;
              renamedCount++;
            } catch (e) {
              console.warn(`重命名文件失败: ${e.message}`);
            }
          }

          // 在任务管理器中同步或更新状态为 skipped (已存在跳过)
          let t = this.tasks.get(res.book.id);
          if (!t) {
            t = new TaskItem(res.book, targetRootPath);
            this.tasks.set(res.book.id, t);
            this.taskOrder.push(res.book.id);
          }
          t.status = 'skipped';
          t.downloaded_bytes = file.size;
          t.total_bytes = file.size;
          t.finish_time = Date.now();
        } else {
          unclaimedFiles.push(file);
        }
      }

      // 处理该目录下剩余未匹配为当前最新官方教材的文件：
      for (const file of unclaimedFiles) {
        const dirAllBooks = allBooks.filter(b => {
          const bDir = path.dirname(path.join(targetRootPath, b.relative_path));
          if (bDir === dir) return true;
          return parts.length >= 4 && parts[0] === b.stage && parts[1] === b.subject && parts[3] === b.grade;
        });

        // 规则 1：同一个目录下的同名教材不是最新，归档
        // 判定：同目录下已有在用教材匹配同一课程书名，或者在历史书单中存在但属于非最新版(is_active === false)
        const sameCourseActive = dirActiveBooks.find(b => {
          const bCore = (b.clean_title || b.title).replace(/^[（(][^）)]+[）)]/, '').replace(/^[^\s·]+版[（(][^）)]+[）)]/, '').trim();
          return bCore && file.filename.includes(bCore);
        });

        const matchAll = dirAllBooks.find(b => !b.is_active && (b.filename === file.filename || (b.pdf_size && Math.abs(file.size - b.pdf_size) <= (b.pdf_size * 0.05))));

        if (sameCourseActive || matchAll) {
          try {
            const histTarget = archiveSingleFileToHistory(file.fullPath, targetRootPath);
            rule1Archived.push({
              filename: file.filename,
              relPath: file.relPath,
              dest: path.relative(targetRootPath, histTarget),
              reason: sameCourseActive ? `同目录下已有最新在用版: ${sameCourseActive.filename}` : '同名教材非最新版 (已由最新版替代)'
            });
            if (matchAll && this.tasks.has(matchAll.id)) {
              this.tasks.get(matchAll.id).status = 'archived';
            }
          } catch (e) {
            console.warn(`⚠️ 规则1归档失败: ${file.relPath} -> ${e.message}`);
          }
        } else {
          // 规则 2：官网已删除但我们有的，归档
          try {
            const histTarget = archiveSingleFileToHistory(file.fullPath, targetRootPath);
            rule2Archived.push({
              filename: file.filename,
              relPath: file.relPath,
              dest: path.relative(targetRootPath, histTarget),
              reason: '官网当前目录已下架/不存在该资源'
            });
          } catch (e) {
            console.warn(`⚠️ 规则2归档失败: ${file.relPath} -> ${e.message}`);
          }
        }
      }
    }

    // 4. 清理移动后可能留下的空目录
    try {
      const cleanEmpty = (d) => {
        if (!fs.existsSync(d)) return;
        const items = fs.readdirSync(d);
        for (const item of items) {
          if (item === 'History' || item === '.download_temp' || item.startsWith('.')) continue;
          const sub = path.join(d, item);
          if (fs.statSync(sub).isDirectory()) {
            cleanEmpty(sub);
            try {
              if (fs.readdirSync(sub).length === 0) {
                fs.rmdirSync(sub);
              }
            } catch (err) {}
          }
        }
      };
      cleanEmpty(targetRootPath);
    } catch (e) {}

    // 5. 保存状态并广播通知
    this.saveToStorage();
    const result = {
      success: true,
      total_local_files: localFiles.length,
      active_kept: keptActiveCount,
      renamed_normalized: renamedCount,
      rule1_archived: rule1Archived.length,
      rule2_archived: rule2Archived.length,
      total_archived: rule1Archived.length + rule2Archived.length,
      missing_to_download: Math.max(0, activeBooks.length - keptActiveCount),
      rule1_samples: rule1Archived.slice(0, 5),
      rule2_samples: rule2Archived.slice(0, 5),
    };

    this.notify('reconcile_completed', result);
    return result;
  }

  getAllTasks() {
    return this.taskOrder.map(tid => this.tasks.get(tid).toDict());
  }
}

module.exports = {
  GLOBAL_HEADERS,
  TaskItem,
  DownloadManager,
};
