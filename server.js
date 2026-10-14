#!/usr/bin/env node
/**
 * ChinaK12BookDownLoader 本地服务与 API 调度中心 (纯 Node.js / JavaScript 实现)
 * =========================================================================
 * 零 Python 依赖，原生 RESTful API、Server-Sent Events 实时事件流与前端静态资源托管。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const { loadCatalogData } = require('./core/catalog');
const { DownloadManager } = require('./core/downloader');
const { auditAndArchiveHistory } = require('./core/historyArchiver');

const CURRENT_DIR = __dirname;
const WEB_DIR = path.join(CURRENT_DIR, 'web');
const CONFIG_FILE = path.join(os.homedir(), '.chinak12_downloader_config.json');

const DOWNLOAD_MANAGER = new DownloadManager(5);
let CATALOG_DATA = null;

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
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('\n');

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
    DOWNLOAD_MANAGER.unsubscribe(onEvent);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
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
      try {
        fs.mkdirSync(newDir, { recursive: true });
      } catch (e) {
        return sendJson(res, { error: `无法创建或访问该目录: ${e.message}` }, 400);
      }
      const resolvedDir = path.resolve(newDir);
      saveStoredConfig({ download_dir: resolvedDir });
      return sendJson(res, { success: true, download_dir: resolvedDir });
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

    if (pathname === '/api/tasks/clear') {
      DOWNLOAD_MANAGER.clearCompleted();
      return sendJson(res, { success: true });
    }

    if (pathname === '/api/tasks/cancel') {
      DOWNLOAD_MANAGER.cancelAll();
      return sendJson(res, { success: true });
    }

    if (pathname === '/api/audit_history') {
      const cfg = getStoredConfig();
      const targetRoot = cfg.download_dir || '';
      if (!targetRoot || !fs.existsSync(targetRoot)) {
        return sendJson(res, { error: '下载目录尚未设置或不存在' }, 400);
      }

      if (!CATALOG_DATA) {
        CATALOG_DATA = loadCatalogData();
      }

      const validRelPaths = new Set(
        CATALOG_DATA.books.filter(b => b.has_pdf).map(b => b.relative_path)
      );
      const result = auditAndArchiveHistory(targetRoot, validRelPaths);
      return sendJson(res, result);
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
