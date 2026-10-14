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
const elBtnFetchLatest = document.getElementById("btn-fetch-latest") || document.getElementById("btn-reindex");
const elBadgeDlRunning = document.getElementById("badge-dl-running");
const elBadgeDlFailed = document.getElementById("badge-dl-failed");
const elBadgeDlCompleted = document.getElementById("badge-dl-completed");
const elInputDownloadDir = document.getElementById("input-download-dir");
const elBtnSaveDir = document.getElementById("btn-save-dir");
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

const elLabelSelectPage = document.getElementById("label-select-page");
const elChkSelectPage = document.getElementById("chk-select-page");
const elPageCountNum = document.getElementById("page-count-num");
const elLabelSelectAllFiltered = document.getElementById("label-select-all-filtered");
const elChkSelectAllFiltered = document.getElementById("chk-select-all-filtered");
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

function populateDropdown(selectEl, items, clearFirst = false) {
  if (clearFirst) {
    const firstOpt = selectEl.options[0];
    selectEl.innerHTML = "";
    if (firstOpt) selectEl.appendChild(firstOpt);
  }
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
    syncSelectionUI();
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
  syncSelectionUI();
}

// 统一同步全选/本页选态及显隐互斥联动
function syncSelectionUI() {
  const isAllFilteredSelected = filteredBooks.length > 0 && filteredBooks.every(b => selectedBookIds.has(b.id));

  // 1. 全选筛选结果勾选框状态
  if (elChkSelectAllFiltered) {
    elChkSelectAllFiltered.checked = isAllFilteredSelected;
    elChkSelectAllFiltered.disabled = filteredBooks.length === 0;
  }

  // 2. 交互互斥：当勾选全选筛选结果后，选中本页的勾选框隐藏；全选取消后，选中本页才展示
  if (elLabelSelectPage) {
    if (isAllFilteredSelected) {
      elLabelSelectPage.classList.add("hidden");
    } else {
      elLabelSelectPage.classList.remove("hidden");
    }
  }

  // 3. 计算并更新当前页的选中状态 (本页复选框 与 表头全选复选框)
  const startIdx = (currentPage - 1) * pageSize;
  const pageItems = filteredBooks.slice(startIdx, startIdx + pageSize);
  const isPageAllSelected = pageItems.length > 0 && pageItems.every(b => selectedBookIds.has(b.id));

  if (elChkSelectPage) {
    elChkSelectPage.checked = isPageAllSelected;
    elChkSelectPage.disabled = pageItems.length === 0;
  }
  if (elChkMaster) {
    elChkMaster.checked = isPageAllSelected;
    elChkMaster.disabled = pageItems.length === 0;
  }
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

  // 通用确认弹窗
  function showConfirmDialog({ title, message, confirmText = "继续", cancelText = "取消" }) {
    return new Promise((resolve) => {
      const elModal = document.getElementById("confirm-modal");
      const elTitle = document.getElementById("modal-title");
      const elBody = document.getElementById("modal-body");
      const elBtnConfirm = document.getElementById("modal-btn-confirm");
      const elBtnCancel = document.getElementById("modal-btn-cancel");

      if (!elModal || !elBtnConfirm || !elBtnCancel) {
        const plainMsg = (message || "").replace(/<br\s*[\/]?>/gi, "\n").replace(/<[^>]+>/g, "");
        const ok = window.confirm(`${title ? title + "\n\n" : ""}${plainMsg}`);
        return resolve(ok);
      }

      if (elTitle) elTitle.textContent = title || "下载提示";
      if (elBody) elBody.innerHTML = message;
      elBtnConfirm.textContent = confirmText;
      elBtnCancel.textContent = cancelText;

      const cleanup = () => {
        elModal.classList.add("hidden");
        elBtnConfirm.removeEventListener("click", onConfirm);
        elBtnCancel.removeEventListener("click", onCancel);
        elModal.removeEventListener("click", onOverlayClick);
        window.removeEventListener("keydown", onKeyDown);
      };

      const onConfirm = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      const onOverlayClick = (e) => { if (e.target === elModal) onCancel(); };
      const onKeyDown = (e) => { if (e.key === "Escape") onCancel(); };

      elBtnConfirm.addEventListener("click", onConfirm);
      elBtnCancel.addEventListener("click", onCancel);
      elModal.addEventListener("click", onOverlayClick);
      window.addEventListener("keydown", onKeyDown);
      elModal.classList.remove("hidden");
    });
  }

  // 文件夹选择对话框与自动生效逻辑
  async function chooseDownloadDirectory() {
    let chosenPath = null;
    if (window.electronAPI && typeof window.electronAPI.selectDirectory === "function") {
      chosenPath = await window.electronAPI.selectDirectory(currentDownloadDir);
    } else {
      try {
        const res = await fetch("/api/select_folder", { method: "POST" });
        const data = await res.json();
        if (data && data.success && data.path) {
          chosenPath = data.path;
        }
      } catch (e) {
        console.warn("调用文件夹选择失败:", e);
      }
    }

    // 操作可以取消，就是不生效
    if (!chosenPath) {
      return;
    }

    // 选择之后会自动生效
    await applyDownloadDir(chosenPath);
  }

  async function applyDownloadDir(val) {
    const dir = (val || "").trim();
    if (!dir) return;
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ download_dir: dir }),
      });
      const data = await res.json();
      if (data.success) {
        currentDownloadDir = data.download_dir;
        elInputDownloadDir.value = currentDownloadDir;
        updateDirStatus(true);
        showToast(`✅ 下载根目录已选择并自动生效: ${currentDownloadDir}`);
      } else {
        showToast(`❌ 设置目录失败: ${data.error}`);
      }
    } catch (e) {
      showToast(`❌ 请求失败: ${e}`);
    }
  }

  // 点击“选择保存目录”按钮或输入框均可打开原生文件夹选择器
  elBtnSaveDir.addEventListener("click", chooseDownloadDirectory);
  elInputDownloadDir.addEventListener("click", chooseDownloadDirectory);

  // 获取最新教材信息
  if (elBtnFetchLatest) {
    elBtnFetchLatest.addEventListener("click", handleFetchLatestCatalog);
  }

  async function handleFetchLatestCatalog() {
    if (!elBtnFetchLatest) return;
    elBtnFetchLatest.disabled = true;
    const originalText = elBtnFetchLatest.textContent;
    elBtnFetchLatest.textContent = "⏳ 正在连接...";
    elCatalogStatus.textContent = "⏳ 正在连接平台...";

    showToast("🌐 正在连接国家中小学智慧教育平台，准备获取最新教材信息...");

    try {
      const res = await fetch("/api/refresh_catalog", { method: "POST" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const payload = JSON.parse(line);
            if (payload.type === "progress") {
              elCatalogStatus.textContent = `⏳ ${payload.message}...`;
              elBtnFetchLatest.textContent = `⏳ ${payload.message}...`;
              showToast(payload.message, 2500);
            } else if (payload.type === "done") {
              const cat = payload.catalog;
              if (cat) {
                allBooks = cat.books || [];
                const activeCount = allBooks.filter(b => b.has_pdf && b.is_active).length;
                elCatalogStatus.textContent = `✅ 目录已就绪 (${activeCount.toLocaleString()} 本在用教材)`;

                // 重新填充筛选下拉框
                populateDropdown(elFilterStage, cat.dimensions.stages, true);
                populateDropdown(elFilterSubject, cat.dimensions.subjects, true);
                populateDropdown(elFilterVersion, cat.dimensions.versions, true);
                populateDropdown(elFilterGrade, cat.dimensions.grades, true);
                populateDropdown(elFilterVolume, cat.dimensions.volumes, true);

                applyFilters();
              }
              showToast(`🎉 获取完成！${payload.message}`, 5000);
            } else if (payload.type === "error") {
              showToast(`❌ 获取最新教材信息失败: ${payload.error}`, 4000);
            }
          } catch (e) {
            console.warn("解析进度数据失败:", e);
          }
        }
      }
    } catch (err) {
      showToast(`❌ 请求平台失败: ${err.message}`, 4000);
    } finally {
      elBtnFetchLatest.disabled = false;
      elBtnFetchLatest.textContent = originalText;
    }
  }

  // 表格多选事件
  elBooksTbody.addEventListener("change", (e) => {
    if (e.target.classList.contains("chk-book")) {
      const id = e.target.getAttribute("data-id");
      const tr = e.target.closest("tr");
      if (e.target.checked) {
        selectedBookIds.add(id);
        if (tr) tr.classList.add("row-selected");
      } else {
        selectedBookIds.delete(id);
        if (tr) tr.classList.remove("row-selected");
      }
      updateStats();
      syncSelectionUI();
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

  if (elChkMaster) elChkMaster.addEventListener("change", (e) => togglePageSelection(e.target.checked));
  if (elChkSelectPage) elChkSelectPage.addEventListener("change", (e) => togglePageSelection(e.target.checked));

  // 全选筛选结果勾选框事件
  if (elChkSelectAllFiltered) {
    elChkSelectAllFiltered.addEventListener("change", (e) => {
      if (filteredBooks.length === 0) {
        elChkSelectAllFiltered.checked = false;
        return;
      }
      if (e.target.checked) {
        filteredBooks.forEach(b => selectedBookIds.add(b.id));
        showToast(`✨ 已全选当前筛选出的 ${filteredBooks.length} 本教材！`);
      } else {
        filteredBooks.forEach(b => selectedBookIds.delete(b.id));
        showToast("已取消全选当前筛选结果");
      }
      updateStats();
      renderTable();
    });
  }

  // 批量下载
  elBtnBatchDownload.addEventListener("click", async () => {
    if (selectedBookIds.size === 0) {
      showToast("⚠️ 请先勾选要下载的课本，或点击“全选筛选结果”！");
      return;
    }

    const count = selectedBookIds.size;
    // 勾选项目大于100条时，提示下载文件较多，将会占用较大空间，是否继续
    if (count > 100) {
      const confirmed = await showConfirmDialog({
        title: "批量下载提示",
        message: `当前已勾选 <strong>${count}</strong> 本教材，下载文件较多，将会占用较大空间，是否继续？`,
        confirmText: "继续",
        cancelText: "取消",
      });
      if (!confirmed) {
        return; // 点击取消，则不下载
      }
    }

    // 点击继续，则继续下载
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

  // 更新顶部“下载列表”按钮内三段式数量徽标：正在下载列表数量(含进行中、暂停、队列等)/失败列表数量/完成列表数量
  if (elBadgeDlRunning) elBadgeDlRunning.textContent = downloadingTasks.length;
  if (elBadgeDlFailed) elBadgeDlFailed.textContent = failedTasks.length;
  if (elBadgeDlCompleted) elBadgeDlCompleted.textContent = completedTasks.length;
  if (elActiveBadge) elActiveBadge.textContent = downloadingTasks.length;

  const activeDownloading = currentTasks.filter(t => t.status === "downloading").length;
  const pendingCount = currentTasks.filter(t => t.status === "pending").length;
  elDrawerSummary.textContent = `下载中: ${activeDownloading} | 排队中: ${pendingCount} | 失败: ${failedTasks.length} | 已完成: ${completedTasks.length}`;

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

  // 严格排序：正在下载(downloading)置顶，暂停(paused)居中，排队(pending)放后
  const sortedTasks = [...tasks].sort((a, b) => {
    const priority = { downloading: 0, paused: 1, pending: 2 };
    return (priority[a.status] ?? 3) - (priority[b.status] ?? 3);
  });

  const MAX_RENDER = 80;
  const renderList = sortedTasks.slice(0, MAX_RENDER);
  const remainingCount = sortedTasks.length - renderList.length;

  let html = "";
  const activeCount = tasks.filter(t => t.status === "downloading").length;
  html += `
    <div style="background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2);padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">
      <span>🌐 底层活跃网络连接: <strong style="color:var(--primary);">${activeCount} / 2</strong></span>
      <span style="color:var(--text-sub);font-size:11px;">(其余排队任务无任何网络流量)</span>
    </div>
  `;

  renderList.forEach(task => {
    let statusText = "🚀 正在下载";
    let statusClass = "task-status-downloading";
    let progressClass = "progress-bar-fill";
    let actionBtnHtml = `<button class="task-btn" data-action="pause" data-id="${task.id}">⏸️ 暂停</button>`;

    const downloadedMb = (task.downloaded_bytes / (1024 * 1024)).toFixed(1);
    const totalMb = task.total_bytes ? (task.total_bytes / (1024 * 1024)).toFixed(1) : "未知";
    let speedInfo = "";

    if (task.status === "downloading") {
      statusText = "🚀 正在下载";
      statusClass = "task-status-downloading";
      progressClass = "progress-bar-fill"; // 亮蓝色活动进度条
      speedInfo = task.speed_formatted || "正在建立 CDN 传输...";
    } else if (task.status === "pending") {
      statusText = "⏳ 队列等待中";
      statusClass = "task-status-pending";
      progressClass = "progress-bar-fill progress-bar-cached"; // 灰暗静态条
      speedInfo = task.downloaded_bytes > 0 ? `断点缓存已存 ${downloadedMb} MB (未连接网络)` : "等待 Worker 拾取 (无网络)";
      actionBtnHtml = `<button class="task-btn" data-action="pause" data-id="${task.id}">⏸️ 暂停</button>`;
    } else if (task.status === "paused") {
      statusText = "⏸️ 已暂停";
      statusClass = "task-status-paused";
      progressClass = "progress-bar-fill progress-bar-cached";
      speedInfo = "任务已暂停 (无网络)";
      actionBtnHtml = `<button class="task-btn task-btn-primary" data-action="resume" data-id="${task.id}">▶️ 恢复</button>`;
    }

    html += `
      <div class="task-card" style="${task.status === 'downloading' ? 'border-left: 3px solid var(--primary);' : ''}">
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
          <div class="${progressClass}" style="width: ${task.percent}%;"></div>
        </div>
        <div class="task-card-footer">
          <span>${downloadedMb} MB / ${totalMb} MB (${task.percent}%)</span>
          <span style="font-size:11px;color:${task.status === 'downloading' ? 'var(--primary)' : 'var(--text-sub)'}">${speedInfo}</span>
        </div>
      </div>
    `;
  });

  if (remainingCount > 0) {
    html += `<div style="text-align:center;padding:12px;color:var(--text-sub);font-size:12px;border-top:1px dashed var(--border);">还有 ${remainingCount} 本教材正在队列中等待传输...</div>`;
  }

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
function showToast(msg, duration = 3500) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => {
    t.remove();
  }, duration);
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
