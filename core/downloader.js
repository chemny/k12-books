// 纯 Node.js / JavaScript 实现：低并发稳定下载、持久化、暂停/恢复、断点续传与失败隔离引擎
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { archiveSingleFileToHistory } = require('./historyArchiver');

const GLOBAL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://basic.smartedu.cn/',
  'Origin': 'https://basic.smartedu.cn',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Authorization': 'Bearer 0',
  'X-ND-AUTH': 'MAC id="0",nonce="0",mac="0"',
};

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
      this.tasks.set(bookId, task);
      this.taskOrder.push(bookId);
      added++;
    }

    this.saveToStorage();
    this.notify('tasks_updated', { added_count: added });
    this.triggerWorkers();
    return added;
  }

  triggerWorkers() {
    while (this.activeWorkers < this.maxWorkers) {
      let pendingTask = null;
      for (const tid of this.taskOrder) {
        const t = this.tasks.get(tid);
        if (t && t.status === 'pending') {
          pendingTask = t;
          break;
        }
      }

      if (!pendingTask) {
        break;
      }

      pendingTask.status = 'downloading';
      pendingTask.start_time = Date.now();
      pendingTask.abortController = new AbortController();
      this.activeWorkers++;

      // 任务启动轻微抖动延迟，防并发冲击 CDN
      setTimeout(() => {
        this.downloadTask(pendingTask)
          .catch(err => {
            if (pendingTask.status !== 'paused') {
              pendingTask.status = 'failed';
              pendingTask.error_msg = err.message || String(err);
            }
          })
          .finally(() => {
            pendingTask.abortController = null;
            this.activeWorkers--;
            this.saveToStorage();
            this.notify('task_finished', pendingTask.toDict());
            this.triggerWorkers();
          });
      }, 200);
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
        // 平台新版本覆盖，原旧版本归档至 History 对应镜像
        try {
          archiveSingleFileToHistory(targetPath, targetRootPath);
        } catch (e) {
          console.warn(`⚠️ 归档旧版本失败: ${e.message}`);
        }
      }
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
    ];

    for (const dUrl of detailsUrls) {
      if (task.status === 'paused') return;
      try {
        const dRes = await fetch(dUrl, {
          headers: GLOBAL_HEADERS,
          signal: task.abortController ? task.abortController.signal : AbortSignal.timeout(15000),
        });
        if (dRes.ok) {
          detailsData = await dRes.json();
          break;
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }

    if (!detailsData) {
      task.status = 'failed';
      task.error_msg = '官方元数据解析超时或拒绝 (请点击重试)';
      return;
    }

    const items = detailsData.ti_items || [];
    const pdfItem = items.find(it => it.ti_format === 'pdf');
    if (!pdfItem) {
      task.status = 'failed';
      task.error_msg = '官方未发布有效 PDF';
      return;
    }

    let candidateUrls = pdfItem.ti_storages || [];
    if (candidateUrls.length === 0 && pdfItem.ti_storage) {
      candidateUrls = [pdfItem.ti_storage.replace('cs_path:${ref-path}', 'https://r1-ndr-private.ykt.cbern.com.cn')];
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
    for (const url of candidateUrls) {
      if (task.status === 'paused') return;

      try {
        const fetchHeaders = { ...GLOBAL_HEADERS };
        let isResume = false;

        // 如果本地已有部分分块且大于 4 字节（且符合 %PDF），尝试 Range 续传
        if (existingBytes > 4) {
          fetchHeaders['Range'] = `bytes=${existingBytes}-`;
          isResume = true;
        }

        const streamResp = await fetch(url, {
          headers: fetchHeaders,
          signal: task.abortController ? task.abortController.signal : AbortSignal.timeout(180000),
        });

        if (streamResp.status !== 200 && streamResp.status !== 206) {
          continue;
        }

        const contentLen = streamResp.headers.get('content-length');
        if (contentLen) {
          const len = parseInt(contentLen, 10);
          task.total_bytes = isResume ? (existingBytes + len) : len;
        }

        // 打开写入流 (如果是 206 部分内容则追加 'a'，否则重新覆盖 'w')
        const fileFlags = (streamResp.status === 206) ? 'a' : 'w';
        if (fileFlags === 'w') {
          existingBytes = 0;
        }

        const reader = streamResp.body.getReader();
        const fileWriteStream = fs.createWriteStream(tempPart, { flags: fileFlags });

        let written = existingBytes;
        task.downloaded_bytes = written;
        let isFirst = (existingBytes === 0);
        let isValidPdf = true;
        let lastTime = Date.now();
        let lastWritten = written;

        while (true) {
          if (task.status === 'paused') {
            fileWriteStream.destroy();
            return;
          }

          const { done, value } = await reader.read();
          if (done) break;

          if (isFirst) {
            isFirst = false;
            // 校验 %PDF 魔数 (0x25 0x50 0x44 0x46)
            if (value.length >= 4) {
              if (value[0] !== 0x25 || value[1] !== 0x50 || value[2] !== 0x44 || value[3] !== 0x46) {
                isValidPdf = false;
                break;
              }
            }
          }

          fileWriteStream.write(Buffer.from(value));
          written += value.length;
          task.downloaded_bytes = written;

          const now = Date.now();
          const dt = (now - lastTime) / 1000;
          if (dt >= 0.5) {
            task.speed = (written - lastWritten) / dt;
            lastTime = now;
            lastWritten = written;
          }
        }

        await new Promise((resolve, reject) => {
          fileWriteStream.end(() => resolve());
          fileWriteStream.on('error', reject);
        });

        if (!isValidPdf || written < 20 * 1024) {
          if (fs.existsSync(tempPart)) fs.unlinkSync(tempPart);
          continue;
        }

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

        downloadOk = true;
        task.status = 'completed';
        task.downloaded_bytes = written;
        task.finish_time = Date.now();
        break;
      } catch (err) {
        if (task.status === 'paused') return;
        continue;
      }
    }

    if (!downloadOk && task.status !== 'paused') {
      task.status = 'failed';
      task.error_msg = '所有 CDN 节点连接超时或拒绝 (请稍后重试)';
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
      try { if (fs.existsSync(tempPart)) fs.unlinkSync(tempPart); } catch (e) {}
      try { if (fs.existsSync(tempFinished)) fs.unlinkSync(tempFinished); } catch (e) {}
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

  // --- 打开文件与所在目录 ---
  openItemInFolder(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    const fullPath = t.target_full_path;
    if (fs.existsSync(fullPath)) {
      exec(`open -R "${fullPath}"`);
      return true;
    } else {
      // 若文件不存在，尝试打开其所在目录
      const dir = path.dirname(fullPath);
      if (fs.existsSync(dir)) {
        exec(`open "${dir}"`);
        return true;
      }
    }
    return false;
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
