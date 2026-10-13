// 纯 Node.js / JavaScript 实现：多并发下载与任务调度引擎
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
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
    this.status = 'pending'; // pending, downloading, completed, skipped, failed, cancelled, updated
    this.error_msg = '';
    this.start_time = null;
    this.finish_time = null;
  }

  toDict() {
    let pct = 0.0;
    if (this.total_bytes > 0) {
      pct = Math.min(100.0, (this.downloaded_bytes / this.total_bytes) * 100);
    } else if (['completed', 'updated'].includes(this.status)) {
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
  constructor(maxWorkers = 5) {
    this.maxWorkers = maxWorkers;
    this.tasks = new Map();
    this.taskOrder = [];
    this.activeWorkers = 0;
    this.eventSubscribers = [];
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
      } catch (e) {
        // ignore subscriber errors
      }
    }
  }

  addTasks(bookItems, targetRoot) {
    let added = 0;
    for (const item of bookItems) {
      const bookId = item.id;
      if (this.tasks.has(bookId)) {
        const t = this.tasks.get(bookId);
        if (['failed', 'cancelled'].includes(t.status)) {
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
      this.activeWorkers++;

      this.downloadTask(pendingTask)
        .catch(err => {
          pendingTask.status = 'failed';
          pendingTask.error_msg = err.message || String(err);
        })
        .finally(() => {
          this.activeWorkers--;
          this.notify('task_finished', pendingTask.toDict());
          this.triggerWorkers();
        });
    }
  }

  async downloadTask(task) {
    const targetRootPath = path.resolve(task.target_root);
    const targetPath = path.resolve(task.target_full_path);
    const targetDir = path.dirname(targetPath);
    fs.mkdirSync(targetDir, { recursive: true });

    // 1. 检查本地已存在文件
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath);
      const localSize = stats.size;
      const expectedSize = task.total_bytes;

      // 如果大小吻合（允许5%误差），判定为已有最新版
      if (expectedSize > 0 && Math.abs(localSize - expectedSize) <= (expectedSize * 0.05)) {
        task.status = 'skipped';
        task.downloaded_bytes = localSize;
        return;
      } else {
        // 平台新上传了该书（大小改变，属于新版本）
        // 自动将本地原有旧版移动至 History/ 对应镜像子目录（已存在则替换）
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

    // 3. 获取下载链接
    let detailsUrl = `https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${task.id}.json`;
    let res = null;
    try {
      res = await fetch(detailsUrl, { headers: GLOBAL_HEADERS, signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        detailsUrl = `https://s-file-2.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${task.id}.json`;
        res = await fetch(detailsUrl, { headers: GLOBAL_HEADERS, signal: AbortSignal.timeout(20000) });
      }
    } catch (e) {
      detailsUrl = `https://s-file-2.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${task.id}.json`;
      res = await fetch(detailsUrl, { headers: GLOBAL_HEADERS, signal: AbortSignal.timeout(20000) });
    }

    if (!res || !res.ok) {
      task.status = 'failed';
      task.error_msg = `获取元数据失败 (HTTP ${res ? res.status : 'error'})`;
      return;
    }

    const data = await res.json();
    const items = data.ti_items || [];
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

    let downloadOk = false;
    for (const url of candidateUrls) {
      if (task.status === 'cancelled') return;

      try {
        const streamResp = await fetch(url, { headers: GLOBAL_HEADERS, signal: AbortSignal.timeout(180000) });
        if (!streamResp.ok || !streamResp.body) continue;

        const contentLen = streamResp.headers.get('content-length');
        if (contentLen) {
          task.total_bytes = parseInt(contentLen, 10);
        }

        const reader = streamResp.body.getReader();
        const fileWriteStream = fs.createWriteStream(tempPart);

        let written = 0;
        let isFirst = true;
        let isValidPdf = true;
        let lastTime = Date.now();
        let lastWritten = 0;

        while (true) {
          if (task.status === 'cancelled') {
            fileWriteStream.destroy();
            if (fs.existsSync(tempPart)) fs.unlinkSync(tempPart);
            return;
          }

          const { done, value } = await reader.read();
          if (done) break;

          if (isFirst) {
            isFirst = false;
            // 校验 %PDF 魔数
            if (value.length < 4 || value[0] !== 0x25 || value[1] !== 0x50 || value[2] !== 0x44 || value[3] !== 0x46) {
              isValidPdf = false;
              break;
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

        // 下载完成，原子移动
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
        if (fs.existsSync(tempPart)) {
          try { fs.unlinkSync(tempPart); } catch (e) {}
        }
        continue;
      }
    }

    if (!downloadOk && task.status !== 'cancelled') {
      task.status = 'failed';
      task.error_msg = '所有 CDN 镜像节点连接失败';
    }
  }

  getAllTasks() {
    return this.taskOrder.map(tid => this.tasks.get(tid).toDict());
  }

  clearCompleted() {
    const toRemove = [];
    for (const tid of this.taskOrder) {
      const t = this.tasks.get(tid);
      if (t && ['completed', 'skipped', 'updated'].includes(t.status)) {
        toRemove.push(tid);
      }
    }
    for (const tid of toRemove) {
      this.tasks.delete(tid);
      this.taskOrder = this.taskOrder.filter(id => id !== tid);
    }
    this.notify('tasks_cleared');
  }

  cancelAll() {
    for (const t of this.tasks.values()) {
      if (['pending', 'downloading'].includes(t.status)) {
        t.status = 'cancelled';
      }
    }
    this.notify('tasks_cancelled');
  }
}

module.exports = {
  GLOBAL_HEADERS,
  TaskItem,
  DownloadManager,
};
