// 在样式加载前恢复配色，避免刷新时闪烁；不写入下载配置。
(() => {
  const storageKey = 'k12-books-theme';
  let theme = 'dark';
  try {
    if (localStorage.getItem(storageKey) === 'light') theme = 'light';
  } catch (_) { /* 存储不可用时仍可切换本次页面的配色。 */ }
  document.documentElement.dataset.theme = theme;

  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('theme-select');
    select.value = theme;
    select.addEventListener('change', () => {
      theme = select.value === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.theme = theme;
      try { localStorage.setItem(storageKey, theme); } catch (_) { /* 保留本次选择。 */ }
    });
  });
})();
