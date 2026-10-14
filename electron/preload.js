// Electron 预加载安全上下文
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  selectDirectory: (defaultPath) => ipcRenderer.invoke("select-directory", defaultPath),
});

window.addEventListener("DOMContentLoaded", () => {
  console.log("ChinaK12BookDownLoader Electron 容器已初始化。");
});

