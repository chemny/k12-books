// 纯 Node.js / JavaScript 实现：历史版本镜像归档引擎
const fs = require('fs');
const path = require('path');

/**
 * 将单个旧版本文件安全剪切/移动至 History/ 对应镜像子目录。
 * 若 History 中已存在该文件，则直接覆盖替换！
 */
function archiveSingleFileToHistory(sourceFile, rootPath) {
  const relPath = path.relative(rootPath, sourceFile);
  const historyTarget = path.join(rootPath, "History", relPath);
  const historyDir = path.dirname(historyTarget);

  fs.mkdirSync(historyDir, { recursive: true });

  if (fs.existsSync(historyTarget)) {
    fs.unlinkSync(historyTarget);
  }

  // 跨卷或跨目录安全移动
  try {
    fs.renameSync(sourceFile, historyTarget);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(sourceFile, historyTarget);
      fs.unlinkSync(sourceFile);
    } else {
      throw err;
    }
  }

  return historyTarget;
}

/**
 * 递归扫描目录（排除忽略目录）
 */
function walkDir(currentDir, rootPath, fileList = []) {
  const IGNORED = new Set(["History", ".download_temp", ".git", "node_modules", ".DS_Store"]);
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      walkDir(fullPath, rootPath, fileList);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      fileList.push(fullPath);
    }
  }

  return fileList;
}

/**
 * 清理空目录（排除 History 与根目录）
 */
function cleanEmptyDirs(dir, rootPath) {
  if (dir === rootPath || dir.includes(path.sep + "History")) return;
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) {
      fs.rmdirSync(dir);
      cleanEmptyDirs(path.dirname(dir), rootPath);
    }
  } catch (e) {
    // ignore
  }
}

/**
 * 扫描 targetRoot 目录，核对不在 validRelativePaths 中的文件，
 * 将其安全移动至 targetRoot/History/... 镜像目录（已存在则直接覆盖替换）。
 */
function auditAndArchiveHistory(targetRoot, validRelativePaths) {
  const rootPath = path.resolve(targetRoot);
  if (!fs.existsSync(rootPath)) {
    return { error: "目标根目录不存在" };
  }

  const historyRoot = path.join(rootPath, "History");
  fs.mkdirSync(historyRoot, { recursive: true });

  const validSet = new Set(validRelativePaths);
  const allPdfFiles = walkDir(rootPath, rootPath);
  const archivedItems = [];

  for (const filePath of allPdfFiles) {
    const relPath = path.relative(rootPath, filePath);
    if (!validSet.has(relPath)) {
      try {
        const stats = fs.statSync(filePath);
        const dest = archiveSingleFileToHistory(filePath, rootPath);
        archivedItems.push({
          filename: path.basename(filePath),
          source: relPath,
          destination: `History/${relPath}`,
          size: stats.size,
        });
        cleanEmptyDirs(path.dirname(filePath), rootPath);
      } catch (e) {
        console.error(`⚠️ 移动历史文件失败: ${relPath} -> ${e.message}`);
      }
    }
  }

  return {
    success: true,
    archived_count: archivedItems.length,
    archived_items: archivedItems,
  };
}

module.exports = {
  archiveSingleFileToHistory,
  auditAndArchiveHistory,
};
