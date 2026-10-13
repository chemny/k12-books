// ChinaK12BookDownLoader 现代化前端交互引擎 (以官方最新为准)

let allBooks = [];
let filteredBooks = [];
let selectedBookIds = new Set();
let currentDownloadDir = "";
let currentPage = 1;
const pageSize = 50;
let currentTasks = [];

// DOM 元素引用
const elCatalogStatus = document.getElementById("catalog-status");
const elInputDownloadDir = document.getElementById("input-download-dir");
const elBtnSaveDir = document.getElementById("btn-save-dir");
const elBtnAuditHistory = document.getElementById("btn-audit-history");
const elDirStatusPill = document.getElementById("dir-status-pill");
const elDirWarningAlert = document.getElementById("dir-warning-alert");

const elFilterStage = document.getElementById("filter-stage");
const elFilterSubject = document.getElementById("filter-subject");
const elFilterVersion = document.getElementById("filter-version");
const elFilterGrade = document.getElementById("filter-grade");
const elFilterVolume = document.getElementById("filter-volume");
const elFilterFormat = document.getElementById("filter-format");
const elFilterStatus = document.getElementById("filter-status");
const elFilterSearch = document.getElementById("filter-search");
const elBtnResetFilters = document.getElementById("btn-reset-filters");

const elFilteredTotal = document.getElementById("filtered-total");
const elStatDownloadable = document.getElementById("stat-downloadable");
const elStatCurrentMatched = document.getElementById("stat-current-matched");

const elChkSelectPage = document.getElementById("chk-select-page");
const elPageCountNum = document.getElementById("page-count-num");
const elBtnSelectAllFiltered = document.getElementById("btn-select-all-filtered");
const elAllFilteredNum = document.getElementById("all-filtered-num");
const elBtnBatchDownload = document.getElementById("btn-batch-download");
const elSelectedTotalNum = document.getElementById("selected-total-num");

const elBooksTbody = document.getElementById("books-tbody");
const elChkMaster = document.getElementById("chk-master");
const elCurPageNum = document.getElementById("cur-page-num");
const elTotalPageNum = document.getElementById("total-page-num");
const elBtnPrevPage = document.getElementById("btn-prev-page");
const elBtnNextPage = document.getElementById("btn-next-page");

const elDownloadDrawer = document.getElementById("download-drawer");
const elBtnToggleDrawer = document.getElementById("btn-toggle-drawer");
const elBtnCloseDrawer = document.getElementById("btn-close-drawer");
const elActiveBadge = document.getElementById("active-badge");
const elDrawerSummary = document.getElementById("drawer-summary");
const elDrawerTasksList = document.getElementById("drawer-tasks-list");
const elBtnClearCompleted = document.getElementById("btn-clear-completed");

// 初始化
document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await loadConfig();
  await loadCatalog();
  initSSE();
});

// 1. 加载下载目录配置
async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    currentDownloadDir = cfg.download_dir || "";
    elInputDownloadDir.value = currentDownloadDir;
    updateDirStatus(cfg.exists && currentDownloadDir.length > 0);
  } catch (e) {
    console.error("加载配置失败:", e);
  }
}

function updateDirStatus(isReady) {
  if (isReady) {
    elDirStatusPill.textContent = "🟢 目录已就绪";
    elDirStatusPill.className = "dir-pill dir-ready";
    elDirWarningAlert.classList.add("hidden");
    elBtnBatchDownload.disabled = false;
  } else {
    elDirStatusPill.textContent = "🔴 目录未指定";
    elDirStatusPill.className = "dir-pill dir-pending";
    elDirWarningAlert.classList.remove("hidden");
    elBtnBatchDownload.disabled = true;
  }
}

// 2. 加载教材数据与维度 (默认只选官方最新在用版)
async function loadCatalog() {
  try {
    elCatalogStatus.textContent = "正在载入目录...";
    const res = await fetch("/api/catalog");
    const data = await res.json();

    allBooks = data.books || [];
    const activeCount = allBooks.filter(b => b.has_pdf && b.is_active).length;
    elCatalogStatus.textContent = `✅ 目录已就绪 (${activeCount.toLocaleString()} 本最新教材)`;

    populateDropdown(elFilterStage, data.dimensions.stages);
    populateDropdown(elFilterSubject, data.dimensions.subjects);
    populateDropdown(elFilterVersion, data.dimensions.versions);
    populateDropdown(elFilterGrade, data.dimensions.grades);
    populateDropdown(elFilterVolume, data.dimensions.volumes);

    applyFilters();
  } catch (e) {
    elCatalogStatus.textContent = "❌ 目录加载失败";
    console.error("加载目录失败:", e);
  }
}

function populateDropdown(selectEl, items) {
  items.forEach(val => {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = val;
    selectEl.appendChild(opt);
  });
}

// 3. 筛选过滤 (默认以官网最新在用为准，排除过时重复件)
function applyFilters() {
  const stage = elFilterStage.value;
  const subject = elFilterSubject.value;
  const version = elFilterVersion.value;
  const grade = elFilterGrade.value;
  const volume = elFilterVolume.value;
  const format = elFilterFormat.value;
  const status = elFilterStatus.value;
  const search = elFilterSearch.value.trim().toLowerCase();

  filteredBooks = allBooks.filter(book => {
    // 核心改进：以官方最新在用为准，自动折叠旧重复条目
    if (!book.is_active) return false;

    if (stage && book.stage !== stage) return false;
    if (subject && book.subject !== subject) return false;
    if (version && book.version !== version) return false;
    if (grade && book.grade !== grade) return false;
    if (volume && book.volume !== volume) return false;

    if (format === "pdf" && !book.has_pdf) return false;
    if (format === "pptx" && !book.has_pptx) return false;

    if (status === "downloadable" && book.kind !== "downloadable") return false;

    if (search) {
      const matchTitle = (book.title || "").toLowerCase().includes(search);
      const matchPath = (book.relative_path || "").toLowerCase().includes(search);
      if (!matchTitle && !matchPath) return false;
    }
    return true;
  });

  currentPage = 1;
  renderTable();
  updateStats();
}

function updateStats() {
  elFilteredTotal.textContent = filteredBooks.length.toLocaleString();
  const downloadableCount = filteredBooks.filter(b => b.has_pdf).length;
  elStatDownloadable.textContent = downloadableCount.toLocaleString();
  elStatCurrentMatched.textContent = filteredBooks.length.toLocaleString();

  elAllFilteredNum.textContent = downloadableCount.toLocaleString();
  elSelectedTotalNum.textContent = selectedBookIds.size.toLocaleString();
}

// 4. 表格渲染与分页
function renderTable() {
  const totalPages = Math.max(1, Math.ceil(filteredBooks.length / pageSize));
  elCurPageNum.textContent = currentPage;
  elTotalPageNum.textContent = totalPages;

  elBtnPrevPage.disabled = currentPage <= 1;
  elBtnNextPage.disabled = currentPage >= totalPages;

  const start = (currentPage - 1) * pageSize;
  const pageBooks = filteredBooks.slice(start, start + pageSize);
  elPageCountNum.textContent = pageBooks.length;

  if (pageBooks.length === 0) {
    elBooksTbody.innerHTML = `<tr><td colspan="6" class="loading-td">未找到匹配的教材资源</td></tr>`;
    elChkMaster.checked = false;
    elChkSelectPage.checked = false;
    return;
  }

  let html = "";
  let pageAllChecked = true;

  pageBooks.forEach(book => {
    const isChecked = selectedBookIds.has(book.id);
    if (!isChecked) pageAllChecked = false;

    const sizeMb = (book.pdf_size / (1024 * 1024)).toFixed(1);
    const editionTagHtml = book.edition_tag
      ? `<span class="edition-badge">${escapeHtml(book.edition_tag)}</span>`
      : "";

    html += `
      <tr>
        <td><input type="checkbox" class="row-chk" data-id="${book.id}" ${isChecked ? "checked" : ""} /></td>
        <td style="color: var(--text-sub);">${book.seq}</td>
        <td class="book-title-cell">
          ${escapeHtml(book.clean_title || book.title)}
          ${editionTagHtml}
          <span style="font-size:11px;color:#38bdf8;background:rgba(56,189,248,0.1);padding:1px 5px;border-radius:4px;margin-left:4px;">最新在用</span>
        </td>
        <td class="category-cell">
          ${escapeHtml(book.stage)} · ${escapeHtml(book.subject)} · ${escapeHtml(book.publisher_dir)} · ${escapeHtml(book.grade)}
        </td>
        <td>
          ${book.has_pdf ? `<span class="tag-file-badge">PDF ${sizeMb} MB</span>` : `<span style="color:var(--text-sub)">无PDF</span>`}
        </td>
        <td>
          <button class="action-btn small-btn single-download-btn" data-id="${book.id}">下载</button>
        </td>
      </tr>
    `;
  });

  elBooksTbody.innerHTML = html;
  elChkMaster.checked = pageAllChecked && pageBooks.length > 0;
  elChkSelectPage.checked = pageAllChecked && pageBooks.length > 0;

  // 绑定行选择事件
  document.querySelectorAll(".row-chk").forEach(chk => {
    chk.addEventListener("change", e => {
      const id = e.target.getAttribute("data-id");
      if (e.target.checked) {
        selectedBookIds.add(id);
      } else {
        selectedBookIds.delete(id);
      }
      updateStats();
    });
  });

  // 绑定单本下载
  document.querySelectorAll(".single-download-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      const id = e.target.getAttribute("data-id");
      triggerDownload([id]);
    });
  });
}

// 5. 事件监听器
function setupEventListeners() {
  [elFilterStage, elFilterSubject, elFilterVersion, elFilterGrade, elFilterVolume, elFilterFormat, elFilterStatus].forEach(el => {
    el.addEventListener("change", applyFilters);
  });
  elFilterSearch.addEventListener("input", debounce(applyFilters, 300));

  elBtnResetFilters.addEventListener("click", () => {
    elFilterStage.value = "";
    elFilterSubject.value = "";
    elFilterVersion.value = "";
    elFilterGrade.value = "";
    elFilterVolume.value = "";
    elFilterFormat.value = "pdf";
    elFilterStatus.value = "downloadable";
    elFilterSearch.value = "";
    applyFilters();
  });

  // 保存下载根目录
  elBtnSaveDir.addEventListener("click", async () => {
    const val = elInputDownloadDir.value.trim();
    if (!val) {
      showToast("⚠️ 请输入有效的下载根目录路径");
      return;
    }
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ download_dir: val }),
      });
      const data = await res.json();
      if (data.success) {
        currentDownloadDir = data.download_dir;
        updateDirStatus(true);
        showToast("✅ 下载根目录已保存并生效！");
      } else {
        showToast(`❌ 保存失败: ${data.error}`);
      }
    } catch (e) {
      showToast(`❌ 网络请求失败: ${e}`);
    }
  });

  // 历史版本审计与归档 (若已存在则替换)
  elBtnAuditHistory.addEventListener("click", async () => {
    if (!currentDownloadDir) {
      showToast("⚠️ 请先设置下载根目录");
      return;
    }
    showToast("🔍 正在比对本地教材与平台最新版本，扫描下架旧版...");
    try {
      const res = await fetch("/api/audit_history", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        if (data.archived_count > 0) {
          showToast(`📦 审计完成！已将 ${data.archived_count} 个历史旧版文件安全归档至 History/ 对应目录（存在已自动替换）`);
        } else {
          showToast("✨ 审计完成！本地所有教材均为当前最新版本，未发现需归档的旧版文件。");
        }
      } else {
        showToast(`❌ 审计失败: ${data.error}`);
      }
    } catch (e) {
      showToast(`❌ 请求异常: ${e}`);
    }
  });

  // 选中当前页
  const togglePageSelection = (isChecked) => {
    const start = (currentPage - 1) * pageSize;
    const pageBooks = filteredBooks.slice(start, start + pageSize);
    pageBooks.forEach(b => {
      if (isChecked) selectedBookIds.add(b.id);
      else selectedBookIds.delete(b.id);
    });
    renderTable();
    updateStats();
  };

  elChkSelectPage.addEventListener("change", e => togglePageSelection(e.target.checked));
  elChkMaster.addEventListener("change", e => togglePageSelection(e.target.checked));

  // 全选当前筛选出的所有最新教材
  elBtnSelectAllFiltered.addEventListener("click", () => {
    filteredBooks.forEach(b => {
      if (b.has_pdf) selectedBookIds.add(b.id);
    });
    renderTable();
    updateStats();
    showToast(`✅ 已全选当前筛选出的全部 ${selectedBookIds.size} 本最新在用教材！`);
  });

  // 批量下载
  elBtnBatchDownload.addEventListener("click", () => {
    if (selectedBookIds.size === 0) {
      showToast("⚠️ 请先勾选要下载的课本，或点击“全选筛选结果”");
      return;
    }
    triggerDownload(Array.from(selectedBookIds));
  });

  // 分页按钮
  elBtnPrevPage.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      renderTable();
    }
  });
  elBtnNextPage.addEventListener("click", () => {
    const totalPages = Math.ceil(filteredBooks.length / pageSize);
    if (currentPage < totalPages) {
      currentPage++;
      renderTable();
    }
  });

  // 抽屉展开/关闭
  elBtnToggleDrawer.addEventListener("click", () => {
    elDownloadDrawer.classList.toggle("hidden");
  });
  elBtnCloseDrawer.addEventListener("click", () => {
    elDownloadDrawer.classList.add("hidden");
  });

  elBtnClearCompleted.addEventListener("click", async () => {
    await fetch("/api/tasks/clear", { method: "POST" });
    refreshTasksList();
  });
}

// 6. 触发下载
async function triggerDownload(bookIds) {
  if (!currentDownloadDir) {
    showToast("⚠️ 请先在上方设置并确认有效的下载根目录 (China12Books)！");
    elInputDownloadDir.focus();
    return;
  }

  showToast(`🚀 正在提交 ${bookIds.length} 本教材至下载队列...`);
  elDownloadDrawer.classList.remove("hidden");

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ book_ids: bookIds }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ 成功添加 ${data.added_count} 个下载任务，后台正在加速传输！`);
    } else {
      showToast(`❌ 提交下载失败: ${data.error}`);
    }
  } catch (e) {
    showToast(`❌ 请求错误: ${e}`);
  }
}

// 7. SSE 实时长连接
function initSSE() {
  const sse = new EventSource("/api/events");
  sse.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.tasks) {
        currentTasks = payload.tasks;
        refreshTasksList();
      }
    } catch (e) {}
  };
}

function refreshTasksList() {
  if (!currentTasks || currentTasks.length === 0) {
    elDrawerTasksList.innerHTML = `<div class="empty-tasks">暂无下载任务，在主界面勾选课本后点击“批量下载”即可加入队列。</div>`;
    elActiveBadge.textContent = "0";
    elDrawerSummary.textContent = "0 个任务";
    return;
  }

  const activeCount = currentTasks.filter(t => t.status === "downloading" || t.status === "pending").length;
  elActiveBadge.textContent = activeCount;
  elDrawerSummary.textContent = `进行中: ${activeCount} | 总计: ${currentTasks.length}`;

  let html = "";
  currentTasks.forEach(task => {
    let statusBadgeClass = "task-status-downloading";
    let statusText = "下载中";

    if (task.status === "pending") {
      statusText = "排队中";
      statusBadgeClass = "task-status-downloading";
    } else if (task.status === "completed") {
      statusText = "已归档";
      statusBadgeClass = "task-status-completed";
    } else if (task.status === "updated") {
      statusText = "已更新(旧版归档)";
      statusBadgeClass = "task-status-completed";
    } else if (task.status === "skipped") {
      statusText = "已存在(跳过)";
      statusBadgeClass = "task-status-skipped";
    } else if (task.status === "failed") {
      statusText = "失败";
      statusBadgeClass = "task-status-failed";
    }

    const downloadedMb = (task.downloaded_bytes / (1024 * 1024)).toFixed(1);
    const totalMb = (task.total_bytes / (1024 * 1024)).toFixed(1);

    html += `
      <div class="task-card">
        <div class="task-card-header">
          <span class="task-card-title">${escapeHtml(task.filename)}</span>
          <span class="task-status-tag ${statusBadgeClass}">${statusText}</span>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${task.percent}%;"></div>
        </div>
        <div class="task-card-footer">
          <span>${downloadedMb} MB / ${totalMb} MB (${task.percent}%)</span>
          <span>${task.speed_formatted || (task.status === "completed" ? "100%" : "")}</span>
        </div>
        ${task.error_msg ? `<div style="color:var(--danger);font-size:11px;">⚠️ ${escapeHtml(task.error_msg)}</div>` : ""}
      </div>
    `;
  });

  elDrawerTasksList.innerHTML = html;
}

function showToast(msg) {
  const container = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => {
    t.remove();
  }, 3500);
}

function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/[&<>'"]/g, tag => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[tag] || tag));
}
