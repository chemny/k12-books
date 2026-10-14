// Electron 桌面主进程窗口入口
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const { runServer, server, DOWNLOAD_MANAGER } = require("../server");

// 拦截并静默处理流中断与取消异常，杜绝弹出 Electron 系统报错弹窗
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'ERR_STREAM_DESTROYED' || err.code === 'ECONNRESET' || err.message?.includes('stream was destroyed'))) {
    return;
  }
  console.error('⚠️ [Main Process Exception]', err);
});
process.on('unhandledRejection', (reason) => {
  if (reason && (reason.message === 'AbortError' || reason.code === 'ERR_STREAM_DESTROYED')) {
    return;
  }
  console.error('⚠️ [Unhandled Rejection]', reason);
});

// 处理渲染进程请求打开本地文件夹选择对话框
ipcMain.handle("select-directory", async (event, defaultPath) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const res = await dialog.showOpenDialog(win, {
    title: "选择教材下载保存目录",
    defaultPath: defaultPath || undefined,
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
    return null;
  }
  return res.filePaths[0];
});

let mainWindow;
let activePort = 8080;
let isForceQuitting = false;

function createWindow(port = 8080) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "ChinaK12BookDownLoader - 国家智慧教育平台教材下载器",
    icon: path.join(__dirname, "../build/icon.png"),
    backgroundColor: "#0c0d12",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      defaultEncoding: "utf-8",
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  // 程序关闭拦截与安全退出提醒
  mainWindow.on("close", (e) => {
    if (isForceQuitting) return;

    if (DOWNLOAD_MANAGER && DOWNLOAD_MANAGER.hasActiveTasks()) {
      e.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "warning",
        buttons: ["确认退出", "取消"],
        defaultId: 1,
        cancelId: 1,
        title: "退出确认",
        message: "当前有正在进行的下载任务，退出程序后所有下载将被终止。\n确定要退出吗？",
      });

      if (choice === 0) {
        // 用户确认退出：暂停所有下载、清理并保存状态
        isForceQuitting = true;
        DOWNLOAD_MANAGER.pauseAll();
        DOWNLOAD_MANAGER.saveToStorage();
        if (server) {
          try { server.close(); } catch (err) {}
        }
        mainWindow.destroy();
        app.quit();
      }
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // 原生启动 Node.js HTTP 核心服务，端口就绪后加载窗口
  runServer(8080, (port) => {
    activePort = port;
    createWindow(port);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(activePort);
    }
  });
});

app.on("before-quit", () => {
  if (DOWNLOAD_MANAGER) {
    DOWNLOAD_MANAGER.pauseAll();
    DOWNLOAD_MANAGER.saveToStorage();
  }
  if (server) {
    try { server.close(); } catch (e) {}
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
