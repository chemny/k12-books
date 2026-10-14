// 纯 Node.js / JavaScript 实现：教材目录分类、版本标注与最新在用优选引擎
const fs = require('fs');
const path = require('path');
const os = require('os');

// 出版社标准名称映射表（对齐 ChinaTextbook 标准）
const PUBLISHER_MAPPING = {
  "人教版": "人教版-人民教育出版社",
  "统编版": "统编版-人民教育出版社",
  "部编版": "统编版-人民教育出版社",
  "北师大版": "北师大版-北京师范大学出版社",
  "苏教版": "苏教版-江苏凤凰教育出版社",
  "苏科版": "苏科版-江苏凤凰科学技术出版社",
  "冀教版": "冀教版-河北教育出版社",
  "鲁教版": "鲁教版-山东教育出版社",
  "鲁人版": "鲁人版-山东人民出版社",
  "鲁科版": "鲁科版-山东科学技术出版社",
  "北京版": "北京版-北京出版社",
  "京版": "北京版-北京出版社",
  "华东师大版": "华东师范大学版-华东师范大学出版社",
  "沪科版": "沪科技版-上海科学技术出版社",
  "沪科技版": "沪科技版-上海科学技术出版社",
  "沪教版": "沪教版-上海教育出版社",
  "浙教版": "浙教版-浙江教育出版社",
  "湘教版": "湘教版-湖南教育出版社",
  "青岛版": "青岛版-青岛出版社",
  "教科版": "教科版-教育科学出版社",
  "科粤版": "科粤版-广东科技出版社/科学出版社",
  "粤教版": "粤教版-广东教育出版社",
  "中图版": "中图版-中国地图出版社",
  "外研版": "外研版-外语教学与研究出版社",
  "仁爱版": "仁爱版-北京仁爱教育研究所",
  "译林版": "译林版-译林出版社",
  "接力版": "接力版-接力出版社",
  "商务印书馆": "商务印书馆版-商务印书馆",
};

const CACHE_INDEX_PATH = path.join(os.homedir(), "Library/Caches/textbook-downloader/web_index.json");
const ASSET_INDEX_PATH = path.join(os.homedir(), "Library/Caches/textbook-downloader/asset_index.json");

/**
 * 提取标准化版本号，如 '2024修订版', '2022修订版', '2019课标版', '第4版'
 */
function extractEditionTag(title, bookMeta = {}) {
  let m = title.match(/根据(20\d\d)年(?:版)?课程标准(?:修订)?/);
  if (m) return `${m[1]}修订版`;

  m = title.match(/(20\d\d)年(?:教育部)?审定/);
  if (m) return `${m[1]}审定版`;

  m = title.match(/(20\d\d)年[秋春]季?/);
  if (m) return `${m[1]}秋季版`;

  m = title.match(/第([0-9一二三四五六七八九十]+)版/);
  if (m) return `第${m[1]}版`;

  m = title.match(/(20\d\d)年版/);
  if (m) return `${m[1]}版`;

  if (title.includes("普通高中教科书") || title.includes("高中")) {
    return "2019课标版";
  }

  if (title.includes("义务教育教科书")) {
    return "2012课标版";
  }

  if (bookMeta && bookMeta.update_time) {
    const ut = String(bookMeta.update_time);
    if (ut.length >= 4 && ["2023", "2024", "2025", "2026"].includes(ut.substring(0, 4))) {
      return `${ut.substring(0, 4)}最新版`;
    }
  }

  return "标准审定版";
}

/**
 * 清理书名中冗余前缀与长括号
 */
function cleanBookTitle(title) {
  let clean = title.replace(/^[（(][^）)]+[）)]/, "");
  clean = clean.replace(/统编版[（(][^）)]+[）)]/, "统编版·");
  clean = clean.replace(/··/g, "·").trim();
  return clean;
}

/**
 * 从 asset_index.json 加载每本书精确的 update_time
 */
function loadUpdateTimeMap() {
  const timeMap = {};
  if (fs.existsSync(ASSET_INDEX_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(ASSET_INDEX_PATH, 'utf-8'));
      const books = data.books || [];
      for (const b of books) {
        if (b.id) {
          timeMap[b.id] = b.update_time || "";
        }
      }
    } catch (e) {
      console.warn("⚠️ 读取 asset_index.json 失败:", e.message);
    }
  }
  return timeMap;
}

/**
 * 解析单本书的规范化分类、版本与时间戳
 */
function resolveBookItem(book, timeMap) {
  const rawStage = (book.stage && book.stage[0]) || "未标注";
  const rawSubject = (book.subject && book.subject[0]) || "未标注";
  const rawVersion = (book.version && book.version[0]) || "未标注";
  const rawGrade = (book.grade && book.grade[0]) || "全一册";
  const rawVolume = (book.volume && book.volume[0]) || "";
  const title = book.title || "";
  const bookId = book.id || "";

  // 学段规范化
  let stage = rawStage;
  if (stage.includes("五•四") || stage.includes("五四")) {
    if (stage.includes("初中")) {
      stage = "初中（五•四学制）";
    } else if (stage.includes("小学")) {
      stage = "小学（五•四学制）";
    }
  }

  // 学科规范化
  const subject = rawSubject.replace(/\//g, "、");

  // 版本-出版社规范化
  let publisherDir = "通用版";
  if (PUBLISHER_MAPPING[rawVersion]) {
    publisherDir = PUBLISHER_MAPPING[rawVersion];
  } else if (rawVersion !== "未标注") {
    publisherDir = `${rawVersion}版`;
  } else {
    let guessed = null;
    for (const [v, pub] of Object.entries(PUBLISHER_MAPPING)) {
      const shortPub = pub.split("-").pop();
      if (title.includes(v) || title.includes(shortPub)) {
        guessed = pub;
        break;
      }
    }
    publisherDir = guessed || "通用版";
  }

  // 年级规范化
  let gradeDir = rawGrade;
  if (["未标注", "全一册"].includes(rawGrade) && rawVolume) {
    gradeDir = rawVolume;
  }

  // 获取更新时间戳
  const updateTime = timeMap[bookId] || book.update_time || "";

  // 版本号提取
  const editionTag = extractEditionTag(title, { update_time: updateTime });

  // 规范化文件名 (带版本标签)
  let baseName = cleanBookTitle(title);
  if (baseName.endsWith(".pdf")) {
    baseName = baseName.slice(0, -4);
  }

  let cleanFilename = baseName;
  if (!baseName.includes(`[${editionTag}]`)) {
    cleanFilename = `${baseName} [${editionTag}].pdf`;
  } else {
    cleanFilename = `${baseName}.pdf`;
  }

  cleanFilename = cleanFilename.replace(/[/\\:*?"<>|]/g, "_");
  const relPath = `${stage}/${subject}/${publisherDir}/${gradeDir}/${cleanFilename}`;

  const formats = book.formats || {};
  const pdfSize = formats.pdf || 0;

  return {
    id: bookId,
    seq: book.seq || 0,
    title: title,
    clean_title: baseName,
    stage: stage,
    subject: subject,
    version: rawVersion,
    publisher_dir: publisherDir,
    grade: gradeDir,
    volume: rawVolume,
    edition_tag: editionTag,
    filename: cleanFilename,
    relative_path: relPath,
    kind: book.kind || "downloadable",
    has_pdf: "pdf" in formats,
    pdf_size: pdfSize,
    has_pptx: "pptx" in formats,
    pptx_size: formats.pptx || 0,
    update_time: updateTime,
    formats: formats,
    is_active: true, // 默认在用，后续去重逻辑计算
    is_latest_official: true,
  };
}

/**
 * 针对同年级、同学科、同版本、同名的重复课本（164对记录）：
 * 比对 update_time / seq，智能选出官网当前在用的最新一本标记为 is_active = true，
 * 较老的副本标记为 is_active = false，并在界面与下载队列中以最新为准！
 */
function deduplicateAndPickLatest(books) {
  const groups = new Map();
  for (const b of books) {
    if (!b.has_pdf) continue;
    // 分组标识: 学段__学科__出版社__年级__规范化书名
    const key = `${b.stage}__${b.subject}__${b.publisher_dir}__${b.grade}__${b.clean_title}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(b);
  }

  for (const [, items] of groups.entries()) {
    if (items.length <= 1) continue;

    // 存在多版本！按更新时间降序（若无更新时间则按 seq 序号）
    items.sort((a, b) => {
      const timeA = String(a.update_time || "");
      const timeB = String(b.update_time || "");
      if (timeA !== timeB) {
        return timeB.localeCompare(timeA);
      }
      return (b.seq || 0) - (a.seq || 0);
    });

    // 最新的为当前官方在用
    const latestItem = items[0];
    latestItem.is_active = true;
    latestItem.is_latest_official = true;

    // 其他旧版本标记为已被替代
    for (let i = 1; i < items.length; i++) {
      const older = items[i];
      older.is_active = false;
      older.is_latest_official = false;
      older.superseded_by = latestItem.id;
    }
  }

  return books;
}

/**
 * 加载全部教材数据并构建过滤树选项（智能优选最新在用版）
 */
function loadCatalogData() {
  const bundledCachePath = path.resolve(__dirname, '../data/catalog_cache.json');
  if (fs.existsSync(bundledCachePath)) {
    try {
      return JSON.parse(fs.readFileSync(bundledCachePath, 'utf-8'));
    } catch (e) {
      console.warn("⚠️ 读取预置 catalog_cache 失败:", e.message);
    }
  }

  let rawBooks = [];
  if (fs.existsSync(CACHE_INDEX_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CACHE_INDEX_PATH, 'utf-8'));
      rawBooks = data.books || [];
    } catch (e) {
      console.warn("⚠️ 读取 web_index 缓存失败:", e.message);
    }
  }

  // 备用：如果系统缓存未生成，尝试读取邻近 ChinaK12Books 目录的 manifest
  if (rawBooks.length === 0) {
    const altManifestPath = path.resolve(__dirname, "../../ChinaK12Books/textbooks_manifest.json");
    if (fs.existsSync(altManifestPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(altManifestPath, 'utf-8'));
        rawBooks = data.books || [];
      } catch (e) {
        console.warn("⚠️ 读取备用 manifest 失败:", e.message);
      }
    }
  }

  const timeMap = loadUpdateTimeMap();
  let resolvedBooks = rawBooks.map(b => resolveBookItem(b, timeMap));
  resolvedBooks = deduplicateAndPickLatest(resolvedBooks);

  // 统计数据
  const activePdfBooks = resolvedBooks.filter(b => b.has_pdf && b.is_active);

  const stages = new Set();
  const subjects = new Set();
  const versions = new Set();
  const grades = new Set();
  const volumes = new Set();

  for (const item of activePdfBooks) {
    stages.add(item.stage);
    subjects.add(item.subject);
    if (item.version !== "未标注") versions.add(item.version);
    if (item.grade !== "未标注") grades.add(item.grade);
    if (item.volume) volumes.add(item.volume);
  }

  const stats = {
    total: resolvedBooks.length,
    downloadable_pdf: activePdfBooks.length,
    duplicates_filtered: resolvedBooks.filter(b => b.has_pdf && !b.is_active).length,
  };

  return {
    books: resolvedBooks,
    stats: stats,
    dimensions: {
      stages: Array.from(stages).sort(),
      subjects: Array.from(subjects).sort(),
      versions: Array.from(versions).sort(),
      grades: Array.from(grades).sort(),
      volumes: Array.from(volumes).sort(),
    },
  };
}

module.exports = {
  PUBLISHER_MAPPING,
  extractEditionTag,
  cleanBookTitle,
  resolveBookItem,
  deduplicateAndPickLatest,
  loadCatalogData,
};
