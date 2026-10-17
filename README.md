# ChinaK12BookDownLoader

[![GitHub release](https://img.shields.io/github/v/release/scott20201225/ChinaK12BookDownLoader?color=3b82f6&logo=github)](https://github.com/scott20201225/ChinaK12BookDownLoader/releases/latest)
[![Platform](https://img.shields.io/badge/Platform-macOS%20|%20Windows%20|%20Linux-brightgreen)](https://github.com/scott20201225/ChinaK12BookDownLoader/releases)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/scott20201225/ChinaK12BookDownLoader?style=social)](https://github.com/scott20201225/ChinaK12BookDownLoader)

> **国家中小学智慧教育平台（basic.smartedu.cn）K12 电子教材可视化批量下载器与版本归档管理系统**  
> 界面精简直观、极简暗黑质感，支持按学段/学科/版本/年级多维级联筛选、**一键全选批量下载**、**前置秒级核对与毫秒跳过**、**同目录下同名旧版与下架资源 History 智能归档**、**严格双并发防封限流**。

`#国家中小学智慧教育平台` `#电子教材下载器` `#电子课本` `#人教版` `#统编版` `#北师大版` `#苏教版` `#小学初中高中课本` `#教材PDF下载` `#智慧中小学`

---

## 📷 界面预览与功能展示

| 教材主界面与多维级联筛选 | 实时下载管理器抽屉（限并发/速率/状态管理） |
| :---: | :---: |
| ![教材主界面与多维级联筛选](assets/preview-main.png) | ![实时下载任务管理器抽屉](assets/preview-drawer.png) |

---

## 🌟 核心特性

1. **可视化目录选择与安全防护**：
   - 原生文件夹选择器，选择目录后自动生效；
   - 未设置目录时强制禁止下载并高亮预警，避免下载到错误路径。

2. **前置秒级核对与智能跳过（零重复流量）**：
   - 点击批量下载瞬间，毫秒级扫描本地磁盘与目标路径；
   - 本地已存在正版教材直接置为 `已存在(跳过)`，绝不推入排队队列空转；
   - 自动识别历史旧格式命名前缀并就地规范化为标准官方名称。

3. **严格的同目录同名教材归档（History 镜像存储）**：
   - **规则 1：同一个目录下的同名教材不是最新，归档**：新旧版本并存时，旧版课标教材自动安全迁移至 `History/` 对应镜像路径，主目录仅保留官方最新版；
   - **规则 2：官网已删除/下架但本地拥有的，归档**：历史资源自动迁移至 `History/` 镜像完整保存，绝不物理删除。

4. **一键全选与严格限并发下载**：
   - 支持勾选当前页及“全选筛选结果”，可一键将数千本课本加入下载队列；
   - 底层严格锁死 2 个并发 Worker 并引入动态随机休眠，避免冲击官方 CDN 导致 IP 封禁或 403 拒绝。

5. **实时三标签下载任务抽屉**：
   - 顶部实时展示任务统计 `(正在下载 / 失败 / 已完成)`，点击即可滑出任务抽屉；
   - 严格区分 `下载成功`（绿）、`已存在(跳过)`（紫）与 `已归档`（黄）；
   - 支持单任务与全部暂停、恢复、批量重试、删除以及在访达/资源管理器中一键高亮定位。

---

## 🚀 启动与使用方式

### 方式一：Node.js Web 模式（零配置秒开）

```bash
cd ChinaK12BookDownLoader
node server.js 8080
```
在浏览器打开：[http://127.0.0.1:8080](http://127.0.0.1:8080)

---

### 方式二：桌面客户端安装包（开箱即用）

进入 [Releases](https://github.com/scott20201225/ChinaK12BookDownLoader/releases) 页面直接下载对应系统的安装包：

| 操作系统 | 架构 | 安装包格式 |
| :--- | :--- | :--- |
| **macOS** | Apple Silicon (`arm64`) / Intel (`x64`) | `.dmg`、`.zip` |
| **Windows** | 64位 (`x64`) / 骁龙 ARM64 (`arm64`) | 安装包 (`-setup.exe`)、便携版 (`.zip`) |
| **Linux** | 64位 (`x64`) / 统信·麒麟·ARM64 (`arm64`) | `.AppImage`、`.deb`、`.tar.gz` |

---

### 方式三：开发者模式与本地打包

```bash
cd ChinaK12BookDownLoader
npm install

# 运行桌面版
npm start

# 构建本地安装包
npm run build:mac:arm64    # macOS Apple Silicon
npm run build:mac:x64      # macOS Intel
npm run build:win:x64      # Windows x64
npm run build:win:arm64    # Windows ARM64
npm run build:linux:x64    # Linux x64
npm run build:linux:arm64  # Linux ARM64
```

---

## 📁 课本存放目录规范

```
China12Books/
├── 小学/
│   ├── 数学/
│   │   └── 人教版-人民教育出版社/
│   │       └── 一年级/
│   │           └── 义务教育教科书·数学一年级上册 [2022修订版].pdf
│   └── 语文/
├── 初中/
├── 高中/
└── History/                          <-- 官方下架/更新的历史版本镜像归档
    └── 小学/
        └── 数学/
            └── 人教版-人民教育出版社/
                └── 一年级/
                    └── 义务教育教科书·数学一年级上册 [2012旧课标版].pdf
```
