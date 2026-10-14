## 🐧 Linux 安装与运行说明

- **AppImage 格式（推荐，全发行版通用）**：
  在终端中赋予可执行权限后直接启动：
  ```bash
  chmod +x chinak12-downloader-linux-*.AppImage
  ./chinak12-downloader-linux-*.AppImage
  ```
  *(若系统缺少 FUSE，可附加 `--appimage-extract-and-run` 参数或安装 `libfuse2`)*。

- **Debian / Ubuntu 系列（`.deb`）**：
  ```bash
  sudo dpkg -i chinak12-downloader-linux-*.deb
  ```
