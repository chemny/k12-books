// 低并发稳定下载、持久化、暂停/恢复、断点续传与失败隔离引擎
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { inspectPdf, walkPdfs, readReceipt } = require('./pdfFiles');
const { execFile } = require('child_process');
const { customDnsLookup } = require('./dnsResolver');
const { fetchCourseChild } = require('./courseResources');

function archiveSingleFileToHistory(sourceFile, rootPath) {
  const relPath = path.relative(rootPath, sourceFile);
  const historyTarget = path.join(rootPath, 'History', relPath);
  const historyDir = path.dirname(historyTarget);

  fs.mkdirSync(historyDir, { recursive: true });

  // 重复归档保留每一份历史文件，不覆盖先前归档。
  let destination = historyTarget;
  let suffix = 1;
  while (fs.existsSync(destination) || fs.existsSync(destination + '.download.json')) {
    destination = historyTarget.replace(/\.pdf$/i, ` (${suffix++}).pdf`);
  }
  const move = (source, target) => {
    try { fs.renameSync(source, target); }
    catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(source);
    }
  };
  move(sourceFile, destination);
  if (fs.existsSync(sourceFile + '.download.json')) {
    try { move(sourceFile + '.download.json', destination + '.download.json'); }
    catch (err) { move(destination, sourceFile); throw err; }
  }

  return destination;
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

const { streamDownloadToFile: transfer, withRetry } = require('./transfer');
const { DATA_DIR, atomicWrite, logDownload } = require('./storage');
const { fallbackRoutes } = require('./cdnTransport');

async function requestJson(urlStr, options = {}) {
  return withRetry(() => new Promise((resolve, reject) => {
    const req = https.get(urlStr, {
      signal: options.signal, lookup: customDnsLookup,
      headers: { ...GLOBAL_HEADERS, Accept: 'application/json' },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const err = Object.assign(new Error(`HTTP ${res.statusCode}`), { code: `HTTP_${res.statusCode}` });
          const value = res.headers['retry-after'];
          if (value) err.retryAfterMs = /^\d+$/.test(value) ? Number(value) * 1000 : Math.max(0, Date.parse(value) - Date.now());
          return reject(err);
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { reject(err); }
      });
    });
    req.setTimeout(options.timeout || 15000, () => req.destroy(Object.assign(new Error('元数据请求超时'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  }), options);
}

async function isVerifiedFile(task) {
  try {
    const receipt = await readReceipt(task.target_full_path);
    if (!receipt || receipt.id !== task.id || receipt.update_time !== task.update_time) return false;
    const info = await inspectPdf(task.target_full_path, { signal: task.abortController?.signal });
    return info.complete && receipt.size === info.size && receipt.sha256 === info.sha256;
  } catch (error) { if (task.abortController?.signal.aborted) throw error; return false; }
}

const TASKS_STORAGE_FILE = path.join(DATA_DIR, 'tasks.json');

class TaskItem {
  constructor(bookMeta, targetRoot) {
    this.id = bookMeta.id;
    this.resource_id = bookMeta.resource_id || bookMeta.id;
    this.parent_ids = bookMeta.parent_ids || [];
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
      resource_id: this.resource_id,
      parent_ids: this.parent_ids,
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
  constructor(maxWorkers = 2, dependencies = {}) {
    this.execFile = dependencies.execFile || execFile;
    this.storageError = null;
    this.reconcilingRoots = new Set();
    this.preparingRoots = new Set();
    this.requestJson = dependencies.requestJson || requestJson;
    this.transfer = dependencies.transfer || transfer;
    this.fallbackRoutes = dependencies.fallbackRoutes || fallbackRoutes;
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
  saveToStorage(immediate = true) {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    const save = () => {
      try {
        const serialized = this.taskOrder.map(tid => {
          const t = this.tasks.get(tid);
          return {
            id: t.id,
            resource_id: t.resource_id,
            parent_ids: t.parent_ids,
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
        atomicWrite(TASKS_STORAGE_FILE, serialized);
        const recovered = this.storageError !== null;
        this.storageError = null;
        if (recovered) this.notify('storage_status', { error: null });
        return true;
      } catch (e) {
        this.storageError = `任务记录保存失败（${e.code || '写入错误'}），当前状态尚未保存，重启后可能丢失。`;
        this.notify('storage_status', { error: this.storageError });
        console.warn('⚠️ 保存下载任务到磁盘失败:', e.message);
        return false;
      }
    };
    if (immediate) return save();
    else this._saveTimer = setTimeout(save, 500);
  }

  loadFromStorage() {
    const storedFile = fs.existsSync(TASKS_STORAGE_FILE) ? TASKS_STORAGE_FILE :
      process.env.CHINAK12_DATA_DIR ? null : path.join(os.homedir(), '.chinak12_downloader_tasks.json');
    if (!storedFile || !fs.existsSync(storedFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(storedFile, 'utf-8'));
      if (Array.isArray(data)) {
        for (const item of data) {
          if (!item.id || item.download_mode === 'public_preview' || item.id.endsWith(':preview')) continue;
          const task = new TaskItem(item, item.target_root);
          task.total_bytes = item.total_bytes || 0;
          task.downloaded_bytes = item.downloaded_bytes || 0;
          task.status = ['downloading', 'pending'].includes(item.status) ? 'paused' : item.status;
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

  async addTasks(bookItems, targetRoot) {
    const root = path.resolve(targetRoot);
    if (this.reconcilingRoots.has(root) || this.preparingRoots.has(root)) throw new Error('当前目录正在核对，请完成后再下载');
    this.preparingRoots.add(root);
    try {
      const prepared = [];
      for (const item of bookItems) {
        const task = new TaskItem(item, targetRoot);
        const old = this.tasks.get(task.id);
        if (old && (['downloading', 'pending'].includes(old.status) || old.abortController)) continue;
        const relative = path.relative(root, path.resolve(task.target_full_path));
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('教材路径超出下载目录');
        if (await isVerifiedFile(task)) {
          task.status = 'skipped';
          task.downloaded_bytes = (await fs.promises.stat(task.target_full_path)).size;
          task.total_bytes = task.downloaded_bytes;
        }
        prepared.push(task);
      }
      let added = 0;
      const replaced = new Set();
      for (const task of prepared) {
        const old = this.tasks.get(task.id);
        if (old && (['downloading', 'pending'].includes(old.status) || old.abortController)) continue;
        replaced.add(task.id);
        this.tasks.set(task.id, task);
        if (task.status === 'pending') added++;
      }
      this.taskOrder = this.taskOrder.filter(id => !replaced.has(id));
      this.taskOrder.push(...replaced);
      this.saveToStorage();
      this.notify('tasks_updated', { added_count: added });
      this.triggerWorkers();
      return added;
    } finally { this.preparingRoots.delete(root); }
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
          if (!['paused', 'cancelled'].includes(task.status)) {
            task.status = 'failed';
            task.error_msg = `${err.code || err.name}: ${err.message || String(err)}`;
            logDownload({ event: 'task_failed', id: task.id, error: task.error_msg });
          }
        } finally {
          task.abortController = null;
          if (task.resumeRequested && this.tasks.get(task.id) === task) {
            task.resumeRequested = false;
            task.status = 'pending';
          }
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
    const relative = path.relative(targetRootPath, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('教材路径超出下载目录');
    fs.mkdirSync(targetDir, { recursive: true });
    if (await isVerifiedFile(task)) {
      task.status = 'skipped';
      task.downloaded_bytes = fs.statSync(targetPath).size;
      return;
    }

    // 2. 临时下载目录
    const tempDir = path.join(targetRootPath, '.download_temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPart = path.join(tempDir, `${String(task.id).replace(/[^a-zA-Z0-9_-]/g, '_')}-${require('crypto').createHash('sha256').update(task.update_time || '').digest('hex').slice(0, 12)}.pdf.part`);
    const tempFinished = tempPart + '.complete';

    // 3. 获取下载链接 (包含重试与备用接口)
    let detailsData = null;
    const detailsUrls = [
      `https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${encodeURIComponent(task.resource_id)}.json`,
      `https://s-file-2.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${encodeURIComponent(task.resource_id)}.json`,
      `https://s-file-3.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${encodeURIComponent(task.resource_id)}.json`,
    ];

    let metadataError = '';
    for (const dUrl of detailsUrls) {
      if (task.status !== 'downloading') return;
      try {
        detailsData = await this.requestJson(dUrl, {
          signal: task.abortController ? task.abortController.signal : null,
          timeout: 10000,
        });
        if (detailsData) break;
      } catch (e) {
        if (task.abortController?.signal.aborted) return;
        metadataError = `${e.code || e.name}: ${e.message}`;
        logDownload({ event: 'metadata_failed', id: task.id, host: new URL(dUrl).hostname, error: metadataError });
      }
    }

    if (!detailsData && task.parent_ids.length) {
      try {
        detailsData = await fetchCourseChild(task.resource_id, task.parent_ids,
          url => this.requestJson(url, { signal: task.abortController?.signal, timeout: 10000 }));
      } catch (err) {
        if (task.abortController?.signal.aborted) return;
        metadataError = err.message;
      }
    }
    if (!detailsData) {
      task.status = 'failed';
      task.error_msg = `教材详情获取失败：${metadataError}`;
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
        let encoded;
        try { const u = new URL(cand); if (u.protocol !== 'https:') continue; encoded = u.href; } catch { continue; }
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

    let downloadOk = false;
    let lastErrorReason = '';
    const routes = candidateUrls.map(url => ({ url, name: 'direct' }));
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const { url, transport, name: routeName } = routes[routeIndex];
      if (task.status !== 'downloading') return;

      try {
        let lastSpeedTime = Date.now();
        let lastSpeedBytes = 0;

        const res = await withRetry(() => this.transfer({
          urlStr: url,
          transport,
          tempPartPath: tempPart,
          headers: GLOBAL_HEADERS,
          lookup: customDnsLookup,
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
        }), {
          signal: task.abortController?.signal,
          onRetry: (err, attempt, wait) => logDownload({ event: 'retry', id: task.id,
            host: new URL(url).hostname, code: err.code, attempt, wait_ms: wait }),
        });
        if (task.abortController?.signal.aborted || task.status !== 'downloading') return;

        const info = await inspectPdf(tempPart, { signal: task.abortController?.signal });
        if (!info.complete) throw Object.assign(new Error('下载文件不是完整 PDF'), { code: 'INVALID_PDF' });
        if (pdfItem.ti_size > 0 && info.size !== Number(pdfItem.ti_size)) {
          fs.rmSync(tempPart + '.json', { force: true });
          throw Object.assign(new Error('文件长度与官网原始 PDF 记录不一致'), { code: 'INTEGRITY_MISMATCH' });
        }
        const md5 = info.md5;
        if (/^[a-f0-9]{32}$/i.test(pdfItem.ti_md5 || '') && md5 !== pdfItem.ti_md5.toLowerCase()) {
          fs.rmSync(tempPart + '.json', { force: true });
          throw Object.assign(new Error('文件摘要与官网原始 PDF 不一致，未保存为教材'), { code: 'INTEGRITY_MISMATCH' });
        }
        res.official_md5 = pdfItem.ti_md5 || null;
        res.md5 = md5;
        res.sha256 = info.sha256;
        res.route = routeName;
        if (task.abortController?.signal.aborted || task.status !== 'downloading') return;
        fs.renameSync(tempPart, tempFinished);
        await this.completeDownload(task, tempFinished, res);
        fs.rmSync(tempPart + '.json', { force: true });
        downloadOk = true;
        console.log(`✅ [下载完成] 《${task.filename}》 (${Math.round(res.written / 1024 / 1024 * 10) / 10} MB)`);
        break;
      } catch (err) {
        if (task.status === 'paused' || (task.abortController && task.abortController.signal.aborted)) {
          return;
        }
        lastErrorReason = `${err.code || err.name}: ${err.message || String(err)}`;
        logDownload({ event: 'download_failed', id: task.id, host: new URL(url).hostname, route: routeName, error: lastErrorReason });
        if (!transport && (/^HTTP_(401|403)$/.test(err.code || '') || ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(err.code))) {
          const fallbacks = this.fallbackRoutes(url).map(route => ({ ...route, url }));
          routes.splice(routeIndex + 1, 0, ...fallbacks);
        }
        if (['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO'].includes(err.code)) throw err;
        if (lastErrorReason.includes('Invalid PDF magic header')) {
          try { if (fs.existsSync(tempPart)) fs.unlinkSync(tempPart); } catch (e) {}
        }
        if (err.code === 'INVALID_PDF') fs.rmSync(tempPart + '.json', { force: true });
        console.warn(`⚠️ [镜像重试] 《${task.filename}》: ${lastErrorReason}`);
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
    }

    if (!downloadOk && task.status === 'downloading') {
      task.status = 'failed';
      task.error_msg = /HTTP_40[13]/.test(lastErrorReason)
        ? `原始 PDF 节点拒绝本次访问（401/403），当前连接方式及备用节点均未成功；未替换为预览图片。详情：${lastErrorReason}`
        : lastErrorReason || '所有 CDN 节点连接失败，请查看下载日志';
    }
  }

  async completeDownload(task, tempFile, result) {
    const target = task.target_full_path;
    if (fs.existsSync(target)) fs.renameSync(target, `${target}.previous-${Date.now()}.pdf`);
    try { fs.renameSync(tempFile, target); }
    catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.copyFileSync(tempFile, target, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(tempFile);
    }
    const sha256 = result.sha256 || (await inspectPdf(target)).sha256;
    atomicWrite(target + '.download.json', { id: task.id, resource_id: task.resource_id,
      update_time: task.update_time, size: result.written, sha256,
      official_md5: result.official_md5 || null, md5: result.md5 || null, route: result.route || 'direct',
      downloaded_at: new Date().toISOString() });
    task.status = 'completed'; task.speed = 0; task.error_msg = '';
    task.downloaded_bytes = result.written; task.total_bytes = result.written; task.finish_time = Date.now();
    logDownload({ event: 'completed', id: task.id, size: result.written,
      route: result.route || 'direct', official_md5: result.official_md5 || null });
  }

  // --- 暂停、恢复与重试控制 ---

  pauseTask(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    if (t.status === 'paused') t.resumeRequested = false;
    if (t.status === 'downloading' || t.status === 'pending') {
      t.status = 'paused';
      t.resumeRequested = false;
      t.speed = 0;
      if (t.abortController) {
        t.abortController.abort();
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
      t.resumeRequested = false;
      if (t.status === 'downloading' || t.status === 'pending') {
        t.status = 'paused';
        t.resumeRequested = false;
        t.speed = 0;
        if (t.abortController) {
          t.abortController.abort();
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
      if (t.abortController) { t.resumeRequested = true; return true; }
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
        if (t.abortController) { t.resumeRequested = true; count++; continue; }
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
    const priorStatus = t.status;
    t.resumeRequested = false;
    t.status = 'cancelled';
    if (t.abortController) {
      t.abortController.abort();
      t.abortController = null;
    }

    // 2. 按照用户要求：若未完成（downloading, pending, paused, failed），删除任务的同时删除下载中的文件/临时分块
    if (['pending', 'downloading', 'paused', 'failed'].includes(priorStatus)) {
      const tempPart = path.join(t.target_root, '.download_temp', `${String(t.id).replace(/[^a-zA-Z0-9_-]/g, '_')}-${require('crypto').createHash('sha256').update(t.update_time || '').digest('hex').slice(0, 12)}.pdf.part`);
      const tempFinished = tempPart + '.complete';
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
      safeUnlink(tempPart + '.json');
      safeUnlink(tempFinished);
      safeUnlink(tempPart + '.assembled.pdf');
      try { fs.rmSync(tempPart + '.pages', { recursive: true, force: true }); } catch {}
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
      if (['completed', 'skipped', 'archived'].includes(t.status)) {
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
  async openItemInFolder(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('任务不存在，请刷新任务列表');
    const fullPath = path.resolve(task.target_full_path);
    const exists = fs.existsSync(fullPath);
    const directory = path.dirname(fullPath);
    if (!exists && !fs.existsSync(directory)) throw new Error('文件和所在目录不存在，可能已被移动');
    let command, args;
    if (process.platform === 'darwin') {
      command = 'open'; args = exists ? ['-R', fullPath] : [directory];
    } else if (process.platform === 'win32') {
      command = 'explorer.exe'; args = exists ? ['/select,', fullPath] : [directory];
    } else {
      command = 'xdg-open'; args = [directory];
    }
    await new Promise((resolve, reject) => this.execFile(command, args, { timeout: 15000 }, error => {
      if (error) reject(new Error(`打开目录失败（${error.code || '系统错误'}）`));
      else resolve();
    }));
    return true;
  }

  // --- 本地教材核对与归档引擎 (严格遵循同目录同名规则与官网下架规则) ---
  async reconcileAndArchive(targetRoot, catalogBooks = null) {
    if (!catalogBooks) {
      const { loadCatalogData } = require('./catalog');
      const cat = loadCatalogData();
      catalogBooks = cat.books || [];
    }

    const targetRootPath = path.resolve(targetRoot);
    if (!fs.existsSync(targetRootPath)) {
      return { success: false, error: '指定的下载根目录不存在' };
    }

    if (!Array.isArray(catalogBooks) || !catalogBooks.length) {
      throw new Error('目录为空，未执行归档');
    }
    if (!fs.statSync(targetRootPath).isDirectory()) throw new Error('下载根目录不是文件夹');
    if ([...this.tasks.values()].some(t => (t.abortController || ['downloading', 'pending'].includes(t.status)) &&
      path.resolve(t.target_root) === targetRootPath)) throw new Error('请先暂停下载，再核对与归档');

    if (this.reconcilingRoots.has(targetRootPath) || this.preparingRoots.has(targetRootPath)) throw new Error('正在核对与归档，请等待完成');
    this.reconcilingRoots.add(targetRootPath);
    try {
    const activeBooks = catalogBooks.filter(b => b.is_active && b.has_pdf);
    const byId = new Map(catalogBooks.map(b => [b.id, b]));
    const byPath = new Map();
    for (const book of catalogBooks) {
      const key = path.normalize(book.relative_path);
      if (!byPath.has(key) || (book.is_active && book.has_pdf)) byPath.set(key, book);
    }
    let totalLocalFiles = 0;
    let keptActiveCount = 0;
    let renamedCount = 0;
    const rule1Archived = [], rule2Archived = [];
    const claimed = new Set();
    const localFiles = [];
    for await (const fullPath of walkPdfs(targetRootPath)) localFiles.push(fullPath);
    for (const fullPath of localFiles) {
      totalLocalFiles++;
      const file = { fullPath, relPath: path.relative(targetRootPath, fullPath), filename: path.basename(fullPath) };
      const receipt = await readReceipt(file.fullPath);
      if (receipt?.invalid) continue;
      const candidate = byPath.get(file.relPath);
      // Unknown files need no full-file read; valid provenance can still identify removed resources.
      if (!receipt?.id && !candidate) continue;
      let info;
      try { info = await inspectPdf(file.fullPath); }
      catch (error) { if (['ENOENT', 'FILE_CHANGED', 'INVALID_PDF'].includes(error.code)) continue; throw error; }
      const { complete, size } = info;
      const verified = complete && receipt?.id && receipt.size === size && receipt.sha256 === info.sha256;
      const book = verified ? byId.get(receipt.id) : candidate;
      if (!complete) continue;
      if (!verified && (!book || !book.pdf_size || book.pdf_size !== size)) continue;
      if (book?.is_active && book.has_pdf && (!verified || receipt.update_time === book.update_time)) {
        if (claimed.has(book.id)) continue;
        claimed.add(book.id);
        keptActiveCount++;
        const standardPath = path.resolve(targetRootPath, book.relative_path);
        const relative = path.relative(targetRootPath, standardPath);
        if (verified && standardPath !== file.fullPath && !relative.startsWith('..') &&
          !path.isAbsolute(relative) && !fs.existsSync(standardPath) && !fs.existsSync(standardPath + '.download.json')) {
          fs.mkdirSync(path.dirname(standardPath), { recursive: true });
          fs.renameSync(file.fullPath, standardPath);
          try { fs.renameSync(file.fullPath + '.download.json', standardPath + '.download.json'); }
          catch (err) { fs.renameSync(standardPath, file.fullPath); throw err; }
          file.fullPath = standardPath; file.relPath = relative; file.filename = path.basename(standardPath);
          renamedCount++;
        }
        // 只同步当前保存位置下的任务，保留其他位置的下载记录。
        const existing = this.tasks.get(book.id);
        if (!existing || path.resolve(existing.target_root) === targetRootPath) {
          const task = new TaskItem(book, targetRootPath);
          task.relative_path = file.relPath;
          task.filename = file.filename;
          task.target_full_path = file.fullPath;
          task.status = 'skipped';
          task.downloaded_bytes = size; task.total_bytes = size;
          this.tasks.set(book.id, task);
          if (!existing) this.taskOrder.push(book.id);
        }
        continue;
      }
      // 仅有明确来源的下架文件或已知旧版本才能归档，未知文件保持原位。
      const outdated = book && (!book.is_active || (verified && receipt.update_time !== book.update_time));
      const removed = verified && !book;
      if (!outdated && !removed) continue;
      const dest = archiveSingleFileToHistory(file.fullPath, targetRootPath);
      const records = outdated ? rule1Archived : rule2Archived;
      records.push({ filename: file.filename, relPath: file.relPath,
        dest: path.relative(targetRootPath, dest),
        reason: outdated ? '已知教材旧版本' : '已下载资源 ID 不在当前官网目录中' });
      const task = this.tasks.get(receipt?.id || book?.id);
      if (task && task.target_full_path === file.fullPath) {
        task.status = 'archived';
        task.target_full_path = dest;
        task.relative_path = path.relative(targetRootPath, dest);
        task.filename = path.basename(dest);
      }
    }

    // 5. 保存状态并广播通知
    this.saveToStorage();
    const result = {
      success: true,
      total_local_files: totalLocalFiles,
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
    } finally { this.reconcilingRoots.delete(targetRootPath); }
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
