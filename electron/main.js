// Electron 桌面主进程窗口入口
const { app, BrowserWindow } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

let mainWindow;
let pythonServer;

function startBackendServer() {
  const serverScript = path.join(__dirname, "../server.py");
  pythonServer = spawn("python3", [serverScript, "8080"], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "ChinaK12BookDownLoader - 教材下载器",
    backgroundColor: "#0c0d12",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // 延迟 500ms 等待后端服务就绪后加载
  setTimeout(() => {
    mainWindow.loadURL("http://127.0.0.1:8080");
  }, 500);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startBackendServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (pythonServer) pythonServer.kill();
  if (process.platform !== "darwin") app.quit();
});
