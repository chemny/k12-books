/**
 * ChinaK12BookDownLoader 本地服务与 API 调度中心
 * =========================================================================
 * RESTful API、Server-Sent Events 实时事件流与前端静态资源托管。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const { exec } = require('child_process');

const { loadCatalogData, refreshCatalogFromPlatform } = require('./core/catalog');
const { DownloadManager } = require('./core/downloader');

const CURRENT_DIR = __dirname;
const WEB_DIR = path.join(CURRENT_DIR, 'web');
const CONFIG_FILE = path.join(os.homedir(), '.chinak12_downloader_config.json');

const DOWNLOAD_MANAGER = new DownloadManager(2);
let CATALOG_DATA = null;

const sseClients = new Set();
function broadcastSSE(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const clientRes of sseClients) {
    try {
      clientRes.write(data);
    } catch (e) {
      sseClients.delete(clientRes);
    }
  }
}

function getStoredConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (e) {
      // ignore
    }
  }
  const defaultDir = path.resolve(CURRENT_DIR, '../China12Books');
  return { download_dir: defaultDir };
}

function saveStoredConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    console.error('⚠️ 保存配置失败:', e.message);
  }
}

function sendJson(res, data, status = 200) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function serveStaticFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': content.length,
  });
  res.end(content);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('\n');

  sseClients.add(res);

  const onEvent = (payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
      // client disconnected
    }
  };

  DOWNLOAD_MANAGER.subscribe(onEvent);

  // 定时心跳与全量任务同步
  const timer = setInterval(() => {
    try {
      const tasks = DOWNLOAD_MANAGER.getAllTasks();
      const hb = { type: 'heartbeat', tasks, timestamp: Date.now() / 1000 };
      res.write(`data: ${JSON.stringify(hb)}\n\n`);
    } catch (e) {
      clearInterval(timer);
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(timer);
    sseClients.delete(res);
    DOWNLOAD_MANAGER.unsubscribe(onEvent);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLen = 0;
    req.on('data', chunk => {
      chunks.push(chunk);
      totalLen += chunk.length;
      if (totalLen > 10 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // CORS 预检
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // --- GET 路由 ---
  if (method === 'GET') {
    if (pathname === '/') {
      return serveStaticFile(res, path.join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8');
    }

    if (pathname === '/api/catalog') {
      if (!CATALOG_DATA) {
        CATALOG_DATA = loadCatalogData();
      }
      return sendJson(res, CATALOG_DATA);
    }

    if (pathname === '/api/config') {
      const cfg = getStoredConfig();
      const dpath = cfg.download_dir || '';
      cfg.exists = fs.existsSync(dpath);
      try {
        cfg.is_dir = cfg.exists && fs.statSync(dpath).isDirectory();
      } catch (e) {
        cfg.is_dir = false;
      }
      return sendJson(res, cfg);
    }

    if (pathname === '/api/tasks') {
      return sendJson(res, { tasks: DOWNLOAD_MANAGER.getAllTasks() });
    }

    if (pathname === '/api/events') {
      return handleSSE(req, res);
    }

    // 静态文件托管
    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    const localFilePath = path.join(WEB_DIR, safePath);
    if (fs.existsSync(localFilePath) && fs.statSync(localFilePath).isFile()) {
      const ext = path.extname(localFilePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      return serveStaticFile(res, localFilePath, contentType);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // --- POST 路由 ---
  if (method === 'POST') {
    const payload = await parseBody(req);

    if (pathname === '/api/config') {
      const newDir = (payload.download_dir || '').trim();
      if (!newDir) {
        return sendJson(res, { error: '下载目录不能为空' }, 400);
      }
      const resolvedDir = path.resolve(newDir);

      // 1. 如果路径指向 macOS 外接磁盘 (/Volumes/xxx)，先检查该磁盘是否挂载
      if (resolvedDir.startsWith('/Volumes/')) {
        const parts = resolvedDir.split(path.sep); // ['', 'Volumes', 'VolumeName', ...]
        const volumeName = parts[2];
        const volumeRoot = `/Volumes/${volumeName}`;
        if (!fs.existsSync(volumeRoot)) {
          return sendJson(res, {
            error: `外接磁盘 [${volumeName}] 当前未连接或未挂载，请确认外接硬盘已插紧并挂载！`
          }, 400);
        }
      }

      // 2. 检查或创建目录，并验证可读写权限
      try {
        if (!fs.existsSync(resolvedDir)) {
          fs.mkdirSync(resolvedDir, { recursive: true });
        }
        fs.accessSync(resolvedDir, fs.constants.R_OK | fs.constants.W_OK);
      } catch (e) {
        if (e.code === 'EACCES' || e.code === 'EPERM') {
          return sendJson(res, {
            error: `权限不足: macOS 拒绝访问该目录 (${e.message})。请检查系统设置 -> 隐私与安全性，或确认该目录具有写权限。`
          }, 400);
        }
        return sendJson(res, { error: `无法创建或访问该目录: ${e.message}` }, 400);
      }

      saveStoredConfig({ download_dir: resolvedDir });
      return sendJson(res, { success: true, download_dir: resolvedDir });
    }

    if (pathname === '/api/select_folder') {
      if (process.platform === 'darwin') {
        exec(`osascript -e 'POSIX path of (choose folder with prompt "请选择教材下载保存目录")'`, (err, stdout) => {
          if (err || !stdout || !stdout.trim()) {
            return sendJson(res, { canceled: true });
          }
          const chosen = stdout.trim();
          return sendJson(res, { success: true, path: chosen });
        });
        return;
      } else {
        return sendJson(res, { canceled: true, message: '请在桌面客户端选择目录' });
      }
    }

    if (pathname === '/api/refresh_catalog') {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      try {
        const onProgress = (info) => {
          res.write(JSON.stringify({ type: 'progress', ...info }) + '\n');
          broadcastSSE({ type: 'catalog_progress', ...info });
        };
        const newCatalog = await refreshCatalogFromPlatform(onProgress);
        CATALOG_DATA = newCatalog;
        const doneMsg = `共计获取最新教材信息 ${newCatalog.stats.total.toLocaleString()} 本（当前在用教材 ${newCatalog.stats.downloadable_pdf.toLocaleString()} 本）`;
        const donePayload = {
          type: 'done',
          total: newCatalog.stats.total,
          downloadable: newCatalog.stats.downloadable_pdf,
          message: doneMsg,
          catalog: newCatalog,
        };
        res.write(JSON.stringify(donePayload) + '\n');
        broadcastSSE(donePayload);
        res.end();
      } catch (err) {
        res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n');
        res.end();
      }
      return;
    }

    if (pathname === '/api/download') {
      const cfg = getStoredConfig();
      const targetRoot = cfg.download_dir || '';
      if (!targetRoot || !fs.existsSync(targetRoot)) {
        return sendJson(res, { error: '请先设置并确认有效的下载根目录！' }, 400);
      }

      const bookIds = new Set(payload.book_ids || []);
      if (bookIds.size === 0) {
        return sendJson(res, { error: '未指定要下载的书籍 ID' }, 400);
      }

      if (!CATALOG_DATA) {
        CATALOG_DATA = loadCatalogData();
      }

      const matchedBooks = CATALOG_DATA.books.filter(b => bookIds.has(b.id) && b.has_pdf);
      const addedCount = DOWNLOAD_MANAGER.addTasks(matchedBooks, targetRoot);
      return sendJson(res, { success: true, added_count: addedCount });
    }

    if (pathname === '/api/tasks/active') {
      return sendJson(res, { has_active: DOWNLOAD_MANAGER.hasActiveTasks() });
    }

    if (pathname === '/api/tasks/pause') {
      const paused = payload.id ? DOWNLOAD_MANAGER.pauseTask(payload.id) : DOWNLOAD_MANAGER.pauseAll();
      return sendJson(res, { success: true, count: paused });
    }

    if (pathname === '/api/tasks/resume') {
      const resumed = payload.id ? DOWNLOAD_MANAGER.resumeTask(payload.id) : DOWNLOAD_MANAGER.resumeAll();
      return sendJson(res, { success: true, count: resumed });
    }

    if (pathname === '/api/tasks/retry') {
      const retried = DOWNLOAD_MANAGER.retryFailedTasks(payload.task_ids || null);
      return sendJson(res, { success: true, count: retried });
    }

    if (pathname === '/api/tasks/delete') {
      if (payload.id) {
        DOWNLOAD_MANAGER.deleteTask(payload.id);
      } else if (payload.task_ids && Array.isArray(payload.task_ids)) {
        DOWNLOAD_MANAGER.deleteBatchTasks(payload.task_ids);
      }
      return sendJson(res, { success: true });
    }

    if (pathname === '/api/tasks/clear_downloading') {
      const count = DOWNLOAD_MANAGER.clearDownloadingTasks();
      return sendJson(res, { success: true, count });
    }

    if (pathname === '/api/tasks/clear_failed') {
      const count = DOWNLOAD_MANAGER.clearFailedTasks(payload.task_ids || null);
      return sendJson(res, { success: true, count });
    }

    if (pathname === '/api/tasks/clear_completed') {
      const count = DOWNLOAD_MANAGER.clearCompletedTasks();
      return sendJson(res, { success: true, count });
    }

    if (pathname === '/api/tasks/open_folder') {
      const ok = DOWNLOAD_MANAGER.openItemInFolder(payload.id);
      return sendJson(res, { success: ok });
    }

    if (pathname === '/api/tasks/clear') {
      DOWNLOAD_MANAGER.clearCompletedTasks();
      return sendJson(res, { success: true });
    }

    if (pathname === '/api/tasks/cancel') {
      DOWNLOAD_MANAGER.pauseAll();
      return sendJson(res, { success: true });
    }

    return sendJson(res, { error: 'Not Found' }, 404);
  }
});

function runServer(port = 8080, callback = null) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️ 端口 ${port} 已被占用，正在切换至备用端口 ${port + 1}...`);
      runServer(port + 1, callback);
    } else {
      console.error('服务器启动异常:', err);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`🚀 ChinaK12BookDownLoader (纯 Node.js 服务) 已就绪: http://127.0.0.1:${port}`);
    if (callback) callback(port);
  });
  return server;
}

if (require.main === module) {
  const argPort = process.argv[2] && !isNaN(process.argv[2]) ? parseInt(process.argv[2], 10) : 8080;
  runServer(argPort);
}

module.exports = {
  server,
  runServer,
  DOWNLOAD_MANAGER,
};
