// ChinaK12BookDownLoader 现代化前端交互引擎 (含三标签下载管理器与精准生命周期控制)

let allBooks = [];
let filteredBooks = [];
let selectedBookIds = new Set();
let currentDownloadDir = "";
let currentPage = 1;
const pageSize = 50;

let currentTasks = [];
let currentDrawerTab = "downloading"; // "downloading" | "failed" | "completed"
let failedSelectedIds = new Set();

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

// 抽屉与标签栏 DOM
const elDownloadDrawer = document.getElementById("download-drawer");
const elBtnToggleDrawer = document.getElementById("btn-toggle-drawer");
const elBtnCloseDrawer = document.getElementById("btn-close-drawer");
const elActiveBadge = document.getElementById("active-badge");
const elDrawerSummary = document.getElementById("drawer-summary");
const elDrawerTasksList = document.getElementById("drawer-tasks-list");

const elTabBtnDownloading = document.getElementById("tab-btn-downloading");
const elTabBtnFailed = document.getElementById("tab-btn-failed");
const elTabBtnCompleted = document.getElementById("tab-btn-completed");
const elBadgeTabDownloading = document.getElementById("badge-tab-downloading");
const elBadgeTabFailed = document.getElementById("badge-tab-failed");
const elBadgeTabCompleted = document.getElementById("badge-tab-completed");

const elSubbarDownloading = document.getElementById("subbar-downloading");
const elSubbarFailed = document.getElementById("subbar-failed");
const elSubbarCompleted = document.getElementById("subbar-completed");

const elBtnPauseAll = document.getElementById("btn-pause-all");
const elBtnResumeAll = document.getElementById("btn-resume-all");
const elBtnClearDownloading = document.getElementById("btn-clear-downloading");

const elChkFailedSelectAll = document.getElementById("chk-failed-select-all");
const elFailedSelectedCount = document.getElementById("failed-selected-count");
const elBtnRetrySelected = document.getElementById("btn-retry-selected");
const elBtnDeleteSelected = document.getElementById("btn-delete-selected");
const elBtnRetryAllFailed = document.getElementById("btn-retry-all-failed");
const elBtnClearFailed = document.getElementById("btn-clear-failed");

const elBtnClearCompleted = document.getElementById("btn-clear-completed");

// 初始化
document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  setupBeforeUnload();
  await loadConfig();
  await loadCatalog();
  initSSE();
});

// 退出/关闭窗口安全提醒拦截
function setupBeforeUnload() {
  window.addEventListener("beforeunload", (e) => {
    const hasActive = currentTasks.some(t => t.status === "downloading" || t.status === "pending");
    if (hasActive) {
      e.preventDefault();
      e.returnValue = "当前有正在进行的下载任务，关闭后下载将被终止。确定离开吗？";
      return e.returnValue;
    }
  });
}

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

// 2. 加载教材数据与维度 (以官方最新在用为准)
async function loadCatalog() {
  try {
    elCatalogStatus.textContent = "正在载入目录...";
    const res = await fetch("/api/catalog");
    const data = await res.json();

    allBooks = data.books || [];
    const activeCount = allBooks.filter(b => b.has_pdf && b.is_active).length;
    elCatalogStatus.textContent = `✅ 目录已就绪 (${activeCount.toLocaleString()} 本在用教材)`;

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

// 3. 筛选过滤
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
      const matchClean = (book.clean_title || "").toLowerCase().includes(search);
      const matchPub = (book.publisher_dir || "").toLowerCase().includes(search);
      if (!matchTitle && !matchClean && !matchPub) return false;
    }

    return true;
  });

  currentPage = 1;
  updateStats();
  renderTable();
}

function updateStats() {
  elFilteredTotal.textContent = filteredBooks.length.toLocaleString();
  elStatDownloadable.textContent = allBooks.filter(b => b.has_pdf && b.is_active).length.toLocaleString();
  elStatCurrentMatched.textContent = filteredBooks.length.toLocaleString();
  elAllFilteredNum.textContent = filteredBooks.length.toLocaleString();
  elSelectedTotalNum.textContent = selectedBookIds.size.toLocaleString();
}

// 4. 表格渲染
function renderTable() {
  const totalPages = Math.max(1, Math.ceil(filteredBooks.length / pageSize));
  elCurPageNum.textContent = currentPage;
  elTotalPageNum.textContent = totalPages;
  elBtnPrevPage.disabled = currentPage <= 1;
  elBtnNextPage.disabled = currentPage >= totalPages;

  const startIdx = (currentPage - 1) * pageSize;
  const pageItems = filteredBooks.slice(startIdx, startIdx + pageSize);
  elPageCountNum.textContent = pageItems.length;

  if (pageItems.length === 0) {
    elBooksTbody.innerHTML = `<tr><td colspan="6" class="loading-td">没有匹配的教材资源，请调整左上方筛选条件。</td></tr>`;
    elChkMaster.checked = false;
    elChkSelectPage.checked = false;
    return;
  }

  let html = "";
  pageItems.forEach((book, idx) => {
    const isChecked = selectedBookIds.has(book.id) ? "checked" : "";
    const seqNum = startIdx + idx + 1;
    const sizeMb = book.pdf_size ? (book.pdf_size / (1024 * 1024)).toFixed(1) + " MB" : "未知大小";

    html += `
      <tr class="${isChecked ? "row-selected" : ""}" data-id="${book.id}">
        <td><input type="checkbox" class="chk-book" data-id="${book.id}" ${isChecked} /></td>
        <td class="td-seq">${seqNum}</td>
        <td>
          <div class="book-title-cell">
            <span class="book-title-text">${escapeHtml(book.clean_title)}</span>
            <span class="edition-badge">${escapeHtml(book.edition_tag)}</span>
          </div>
        </td>
        <td>
          <span class="cat-pill">${escapeHtml(book.stage)}</span>
          <span class="cat-pill cat-sub">${escapeHtml(book.subject)}</span>
          <span class="cat-pill cat-pub">${escapeHtml(book.publisher_dir.split("-")[0])}</span>
        </td>
        <td>
          <span class="format-tag tag-pdf">PDF (${sizeMb})</span>
        </td>
        <td>
          <button class="action-btn small-btn btn-single-dl" data-id="${book.id}">下载</button>
        </td>
      </tr>
    `;
  });

  elBooksTbody.innerHTML = html;
  updateMasterCheckboxState(pageItems);
}

function updateMasterCheckboxState(pageItems) {
  if (!pageItems || pageItems.length === 0) {
    elChkMaster.checked = false;
    elChkSelectPage.checked = false;
    return;
  }
  const allPageSelected = pageItems.every(b => selectedBookIds.has(b.id));
  elChkMaster.checked = allPageSelected;
  elChkSelectPage.checked = allPageSelected;
}

// 5. 事件监听器绑定
function setupEventListeners() {
  // 筛选事件
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

  // 保存目录
  elBtnSaveDir.addEventListener("click", async () => {
    const val = elInputDownloadDir.value.trim();
    if (!val) {
      showToast("⚠️ 下载根目录路径不能为空！");
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
        showToast("✅ 下载根目录已保存并成功绑定！");
      } else {
        showToast(`❌ 保存失败: ${data.error}`);
      }
    } catch (e) {
      showToast(`❌ 请求失败: ${e}`);
    }
  });

  // 历史版本审计
  elBtnAuditHistory.addEventListener("click", async () => {
    if (!currentDownloadDir) {
      showToast("⚠️ 请先设置下载根目录！");
      return;
    }
    showToast("🔍 正在扫描本地目录与比对官方最新清单...");
    try {
      const res = await fetch("/api/audit_history", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showToast(`📦 审计完成！共发现并归档了 ${data.archived_count} 本历史教材至 History/ 目录。`);
      } else {
        showToast(`❌ 历史归档失败: ${data.error}`);
      }
    } catch (e) {
      showToast(`❌ 请求错误: ${e}`);
    }
  });

  // 表格多选事件
  elBooksTbody.addEventListener("change", (e) => {
    if (e.target.classList.contains("chk-book")) {
      const id = e.target.getAttribute("data-id");
      if (e.target.checked) {
        selectedBookIds.add(id);
      } else {
        selectedBookIds.delete(id);
      }
      updateStats();
      const startIdx = (currentPage - 1) * pageSize;
      const pageItems = filteredBooks.slice(startIdx, startIdx + pageSize);
      updateMasterCheckboxState(pageItems);
    }
  });

  // 单本下载
  elBooksTbody.addEventListener("click", (e) => {
    if (e.target.classList.contains("btn-single-dl")) {
      const id = e.target.getAttribute("data-id");
      triggerDownload([id]);
    }
  });

  // 选中当前页
  const togglePageSelection = (checked) => {
    const startIdx = (currentPage - 1) * pageSize;
    const pageItems = filteredBooks.slice(startIdx, startIdx + pageSize);
    pageItems.forEach(b => {
      if (checked) selectedBookIds.add(b.id);
      else selectedBookIds.delete(b.id);
    });
    updateStats();
    renderTable();
  };

  elChkMaster.addEventListener("change", (e) => togglePageSelection(e.target.checked));
  elChkSelectPage.addEventListener("change", (e) => togglePageSelection(e.target.checked));

  // 全选筛选结果
  elBtnSelectAllFiltered.addEventListener("click", () => {
    const allSelected = filteredBooks.every(b => selectedBookIds.has(b.id));
    if (allSelected) {
      filteredBooks.forEach(b => selectedBookIds.delete(b.id));
      showToast("已取消全选当前筛选结果");
    } else {
      filteredBooks.forEach(b => selectedBookIds.add(b.id));
      showToast(`✨ 已全选当前筛选出的 ${filteredBooks.length} 本教材！`);
    }
    updateStats();
    renderTable();
  });

  // 批量下载
  elBtnBatchDownload.addEventListener("click", () => {
    if (selectedBookIds.size === 0) {
      showToast("⚠️ 请先勾选要下载的课本，或点击“全选筛选结果”！");
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

  // --- 抽屉 3 标签页切换逻辑 ---
  [elTabBtnDownloading, elTabBtnFailed, elTabBtnCompleted].forEach(btn => {
    btn.addEventListener("click", () => {
      [elTabBtnDownloading, elTabBtnFailed, elTabBtnCompleted].forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentDrawerTab = btn.getAttribute("data-tab");

      // 切换对应的子工具栏
      elSubbarDownloading.classList.toggle("hidden", currentDrawerTab !== "downloading");
      elSubbarFailed.classList.toggle("hidden", currentDrawerTab !== "failed");
      elSubbarCompleted.classList.toggle("hidden", currentDrawerTab !== "completed");

      refreshTasksList();
    });
  });

  // --- 正在下载页操作 ---
  elBtnPauseAll.addEventListener("click", async () => {
    await fetch("/api/tasks/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    showToast("⏸️ 已暂停所有下载任务");
  });

  elBtnResumeAll.addEventListener("click", async () => {
    await fetch("/api/tasks/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    showToast("▶️ 已恢复所有下载任务");
  });

  elBtnClearDownloading.addEventListener("click", async () => {
    if (!confirm("确定要清空所有未完成的任务吗？\n下载中的临时文件将被删除，已下载完整的书籍将保留。")) return;
    const res = await fetch("/api/tasks/clear_downloading", { method: "POST" });
    const data = await res.json();
    showToast(`🗑️ 已清空 ${data.count || 0} 个未完成任务并清理临时文件`);
    refreshTasksList();
  });

  // --- 下载失败页操作 ---
  elChkFailedSelectAll.addEventListener("change", (e) => {
    const failedTasks = currentTasks.filter(t => t.status === "failed");
    if (e.target.checked) {
      failedTasks.forEach(t => failedSelectedIds.add(t.id));
    } else {
      failedSelectedIds.clear();
    }
    updateFailedSelectionUI();
    renderFailedTab();
  });

  elBtnRetryAllFailed.addEventListener("click", async () => {
    const res = await fetch("/api/tasks/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    showToast(`🔄 已将 ${data.count || 0} 个失败任务重新加入下载队列！`);
  });

  elBtnRetrySelected.addEventListener("click", async () => {
    if (failedSelectedIds.size === 0) return;
    const res = await fetch("/api/tasks/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_ids: Array.from(failedSelectedIds) }),
    });
    const data = await res.json();
    showToast(`🔄 已重新加入 ${data.count || 0} 个选中任务`);
    failedSelectedIds.clear();
    updateFailedSelectionUI();
  });

  elBtnClearFailed.addEventListener("click", async () => {
    if (!confirm("确定要清空所有失败任务吗？对应的失败/损坏文件将被删除。")) return;
    const res = await fetch("/api/tasks/clear_failed", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const data = await res.json();
    showToast(`🗑️ 已清除 ${data.count || 0} 个失败任务及临时文件`);
    failedSelectedIds.clear();
    updateFailedSelectionUI();
    refreshTasksList();
  });

  elBtnDeleteSelected.addEventListener("click", async () => {
    if (failedSelectedIds.size === 0) return;
    if (!confirm(`确定要删除选中的 ${failedSelectedIds.size} 个失败任务吗？对应的失败文件将被删除。`)) return;
    await fetch("/api/tasks/clear_failed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_ids: Array.from(failedSelectedIds) }),
    });
    showToast(`🗑️ 已删除选中的 ${failedSelectedIds.size} 个失败任务`);
    failedSelectedIds.clear();
    updateFailedSelectionUI();
    refreshTasksList();
  });

  // --- 下载成功页操作 ---
  elBtnClearCompleted.addEventListener("click", async () => {
    await fetch("/api/tasks/clear_completed", { method: "POST" });
    showToast("🗑️ 已清空已完成记录（本地文件完好保留）");
    refreshTasksList();
  });

  // --- 抽屉列表项按钮事件代理 ---
  elDrawerTasksList.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const taskId = btn.getAttribute("data-id");
    if (!action || !taskId) return;

    if (action === "pause") {
      await fetch("/api/tasks/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: taskId }),
      });
      showToast("⏸️ 任务已暂停");
    } else if (action === "resume") {
      await fetch("/api/tasks/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: taskId }),
      });
      showToast("▶️ 任务已恢复");
    } else if (action === "retry-single") {
      await fetch("/api/tasks/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_ids: [taskId] }),
      });
      showToast("🔄 已加入重试队列");
    } else if (action === "delete") {
      await fetch("/api/tasks/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: taskId }),
      });
      showToast("🗑️ 任务已删除");
      failedSelectedIds.delete(taskId);
      updateFailedSelectionUI();
      refreshTasksList();
    } else if (action === "open-folder") {
      const res = await fetch("/api/tasks/open_folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: taskId }),
      });
      const data = await res.json();
      if (!data.success) {
        showToast("⚠️ 未能定位到文件，可能文件已被移动");
      }
    }
  });

  // 失败项单项勾选代理
  elDrawerTasksList.addEventListener("change", (e) => {
    if (e.target.classList.contains("chk-failed-item")) {
      const id = e.target.getAttribute("data-id");
      if (e.target.checked) {
        failedSelectedIds.add(id);
      } else {
        failedSelectedIds.delete(id);
      }
      updateFailedSelectionUI();
    }
  });
}

function updateFailedSelectionUI() {
  const count = failedSelectedIds.size;
  elFailedSelectedCount.textContent = count;
  elBtnRetrySelected.classList.toggle("hidden", count === 0);
  elBtnDeleteSelected.classList.toggle("hidden", count === 0);

  const failedTasks = currentTasks.filter(t => t.status === "failed");
  elChkFailedSelectAll.checked = failedTasks.length > 0 && failedTasks.every(t => failedSelectedIds.has(t.id));
}

// 6. 触发批量下载
async function triggerDownload(bookIds) {
  if (!currentDownloadDir) {
    showToast("⚠️ 请先在上方设置并确认有效的下载根目录 (China12Books)！");
    elInputDownloadDir.focus();
    return;
  }

  showToast(`🚀 正在提交 ${bookIds.length} 本教材至下载队列...`);
  elDownloadDrawer.classList.remove("hidden");
  // 切换到正在下载标签
  elTabBtnDownloading.click();

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ book_ids: bookIds }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ 成功添加 ${data.added_count} 个下载任务，正在稳定传输！`);
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

// 8. 刷新下载列表展示 (按三大 Tab 精准过滤)
function refreshTasksList() {
  const downloadingTasks = currentTasks.filter(t => ["pending", "downloading", "paused"].includes(t.status));
  const failedTasks = currentTasks.filter(t => t.status === "failed");
  const completedTasks = currentTasks.filter(t => ["completed", "skipped"].includes(t.status));

  // 更新徽章数字
  elBadgeTabDownloading.textContent = downloadingTasks.length;
  elBadgeTabFailed.textContent = failedTasks.length;
  elBadgeTabCompleted.textContent = completedTasks.length;

  const activeDownloading = currentTasks.filter(t => t.status === "downloading").length;
  elActiveBadge.textContent = activeDownloading || downloadingTasks.length;
  elDrawerSummary.textContent = `进行中: ${downloadingTasks.length} | 失败: ${failedTasks.length} | 已完成: ${completedTasks.length}`;

  if (currentDrawerTab === "downloading") {
    renderDownloadingTab(downloadingTasks);
  } else if (currentDrawerTab === "failed") {
    renderFailedTab(failedTasks);
  } else if (currentDrawerTab === "completed") {
    renderCompletedTab(completedTasks);
  }
}

function renderDownloadingTab(tasks) {
  if (tasks.length === 0) {
    elDrawerTasksList.innerHTML = `<div class="empty-tasks">暂无下载中或排队中的任务。<br>在主表格勾选课本后点击“批量下载”即可加入。</div>`;
    return;
  }

  let html = "";
  tasks.forEach(task => {
    let statusText = "下载中";
    let statusClass = "task-status-downloading";
    let actionBtnHtml = `<button class="task-btn" data-action="pause" data-id="${task.id}">⏸️ 暂停</button>`;

    if (task.status === "pending") {
      statusText = "排队中";
      statusClass = "task-status-downloading";
      actionBtnHtml = `<button class="task-btn" data-action="pause" data-id="${task.id}">⏸️ 暂停</button>`;
    } else if (task.status === "paused") {
      statusText = "已暂停";
      statusClass = "task-status-paused";
      actionBtnHtml = `<button class="task-btn task-btn-primary" data-action="resume" data-id="${task.id}">▶️ 恢复</button>`;
    }

    const downloadedMb = (task.downloaded_bytes / (1024 * 1024)).toFixed(1);
    const totalMb = task.total_bytes ? (task.total_bytes / (1024 * 1024)).toFixed(1) : "未知";

    html += `
      <div class="task-card">
        <div class="task-card-header">
          <div class="task-card-title-row">
            <span class="task-status-tag ${statusClass}">${statusText}</span>
            <span class="task-card-title">${escapeHtml(task.filename)}</span>
          </div>
          <div class="task-card-actions">
            ${actionBtnHtml}
            <button class="task-btn task-btn-danger" data-action="delete" data-id="${task.id}" title="删除该任务并清理未完成临时文件">🗑️ 删除</button>
          </div>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${task.percent}%;"></div>
        </div>
        <div class="task-card-footer">
          <span>${downloadedMb} MB / ${totalMb} MB (${task.percent}%)</span>
          <span>${task.speed_formatted || ""}</span>
        </div>
      </div>
    `;
  });

  elDrawerTasksList.innerHTML = html;
}

function renderFailedTab(tasks = null) {
  const failedTasks = tasks || currentTasks.filter(t => t.status === "failed");
  if (failedTasks.length === 0) {
    elDrawerTasksList.innerHTML = `<div class="empty-tasks">太棒了！当前没有任何失败的任务。</div>`;
    return;
  }

  let html = "";
  failedTasks.forEach(task => {
    const isChecked = failedSelectedIds.has(task.id) ? "checked" : "";
    html += `
      <div class="task-card" style="border-left: 3px solid var(--danger);">
        <div class="task-card-header">
          <div class="task-card-title-row">
            <input type="checkbox" class="chk-failed-item" data-id="${task.id}" ${isChecked} />
            <span class="task-status-tag task-status-failed">失败</span>
            <span class="task-card-title">${escapeHtml(task.filename)}</span>
          </div>
          <div class="task-card-actions">
            <button class="task-btn task-btn-primary" data-action="retry-single" data-id="${task.id}">🔄 重新下载</button>
            <button class="task-btn task-btn-danger" data-action="delete" data-id="${task.id}" title="删除任务并删除对应的失败临时文件">🗑️ 删除</button>
          </div>
        </div>
        <div style="color:var(--danger);font-size:12px;background:rgba(239,68,68,0.08);padding:6px 10px;border-radius:4px;">
          ⚠️ 失败原因: ${escapeHtml(task.error_msg || "CDN 节点响应超时或拒绝")}
        </div>
      </div>
    `;
  });

  elDrawerTasksList.innerHTML = html;
}

function renderCompletedTab(tasks) {
  if (tasks.length === 0) {
    elDrawerTasksList.innerHTML = `<div class="empty-tasks">暂无下载完成的任务。</div>`;
    return;
  }

  let html = "";
  tasks.forEach(task => {
    const sizeMb = task.downloaded_bytes ? (task.downloaded_bytes / (1024 * 1024)).toFixed(1) + " MB" : "";
    const isSkipped = task.status === "skipped";

    html += `
      <div class="task-card" style="border-left: 3px solid var(--success);">
        <div class="task-card-header">
          <div class="task-card-title-row">
            <span class="task-status-tag ${isSkipped ? "task-status-skipped" : "task-status-completed"}">
              ${isSkipped ? "已存在(跳过)" : "已归档"}
            </span>
            <span class="task-card-title">${escapeHtml(task.filename)}</span>
          </div>
          <div class="task-card-actions">
            <button class="task-btn" data-action="open-folder" data-id="${task.id}" title="在访达中高亮定位该文件">📂 打开所在目录</button>
          </div>
        </div>
        <div class="task-card-footer">
          <span style="color:var(--text-sub);font-size:11px;">${escapeHtml(task.relative_path || "")}</span>
          <span>${sizeMb}</span>
        </div>
      </div>
    `;
  });

  elDrawerTasksList.innerHTML = html;
}

// 辅助工具函数
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
