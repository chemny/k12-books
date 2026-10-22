# K12 Books

**国家中小学智慧教育平台教材下载与管理工具。**

K12 Books 提供目录同步、教材筛选、批量下载和本地核对功能。下载官网发布的原始 PDF，保留文件内容。

## 界面

| 教材筛选 | 下载任务 |
| --- | --- |
| ![K12 Books 教材筛选](assets/preview-main.png) | ![K12 Books 下载任务](assets/preview-drawer.png) |

## 功能

- **同步目录**：读取官网目录，展示新增、信息变更和本次未出现的资源；同步失败时保留上次成功目录。
- **联动筛选**：学段、年级、学科、版本、册次与修订版联动，支持格式、资源状态及书名搜索。
- **批量下载**：选择本页或全部筛选结果，最多同时下载 2 本；支持暂停、继续与失败重试。
- **完整性校验**：检查 PDF 文件完整性和官网提供的有效整文件 MD5，保存本地校验记录，已校验的现有文件可跳过下载。
- **任务管理**：查看下载中、失败和已完成任务，支持清空记录、删除未完成任务及打开文件所在目录。
- **本地统计**：当前保存目录中的现行教材按资源去重，排除备份、旧版和归档；清空任务记录不影响已下载数量。
- **核对与归档**：手动执行，将能够确认来源的旧版或已下架教材移至 `History/`，不覆盖已有归档；未知文件保留原位。

目录同步不会自动下载、移动或归档教材。没有明确年份依据的教材标为“版本待确认”。

## 启动网页版

需要 **Node.js 18 或更新版本**。网页版使用 Node.js 内置模块，无需安装 Electron。

```bash
cd "K12 Books"
node server.js 8080
```

打开 [http://127.0.0.1:8080](http://127.0.0.1:8080)，选择保存位置后即可筛选和下载教材。

如果通过 Git 克隆，默认文件夹为 `k12-books`，进入该文件夹运行同一命令即可。macOS 也可双击“启动网页版.command”。

## 桌面版与打包

K12 Books 改名版本尚未发布安装包。目前可从源码运行或自行构建。

```bash
npm ci
npm start

# 构建安装包
npm run build:mac:arm64
npm run build:mac:x64
npm run build:win:x64
npm run build:win:arm64
npm run build:linux:x64
npm run build:linux:arm64
```

macOS 支持 `.dmg`、`.zip`；Windows 支持安装程序和便携版；Linux 支持 `.AppImage`、`.deb`、`.tar.gz`。实际构建依赖相应平台环境。

## 保存位置与数据

教材按“学段 / 学科 / 版本与出版社 / 年级”分目录保存。保存位置可在界面中选择。

程序配置、任务状态和日志默认存储在用户目录的 `.chinak12-downloader/`，沿用原项目的数据路径以保持兼容。可通过 `CHINAK12_DATA_DIR` 指定独立状态目录。

仓库中的 `data/catalog_cache.json` 是官网教材目录元数据，不包含教材 PDF、个人下载记录或登录凭据；实际资源以官网更新结果为准。

## 测试

```bash
npm test
```

自动化测试使用独立临时目录和受控测试数据，不操作用户的教材目录。

可选的联网验证会在独立临时目录下载一本官网教材：

```bash
node scripts/verify-live.js
```

可选的性能验证会生成独立批量测试数据：

```bash
node scripts/benchmark-local-processing.js
```

以上脚本的执行结果、教材文件及本地实验资料均不纳入仓库。

## 项目来源与许可证声明

K12 Books 基于 [scott20201225/ChinaK12BookDownLoader](https://github.com/scott20201225/ChinaK12BookDownLoader) 修改，原作者为 **scottcheng**。原项目的 `package.json` 声明许可证为 **MIT**，本项目保留该声明及原作者署名。

当前版本完善了下载稳定性、目录完整性、筛选交互、任务反馈、本地统计和批量处理性能。
