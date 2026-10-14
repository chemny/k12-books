// Electron 桌面主进程窗口入口 (纯原生 JavaScript 实现，零 Python 依赖)
const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const { runServer, server, DOWNLOAD_MANAGER } = require("../server");

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
    backgroundColor: "#0c0d12",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
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
