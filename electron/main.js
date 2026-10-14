// Electron 桌面主进程窗口入口 (纯原生 JavaScript 实现，零 Python 依赖)
const { app, BrowserWindow } = require("electron");
const path = require("path");
const { runServer, server } = require("../server");

let mainWindow;
let activePort = 8080;

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

app.on("window-all-closed", () => {
  if (server) {
    try { server.close(); } catch (e) {}
  }
  if (process.platform !== "darwin") app.quit();
});
