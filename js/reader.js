/**
 * reader.js —— 阅读器视图逻辑
 * 内容渲染、三区点击导航、工具栏自动隐藏、设置面板
 */

let currentBookId = null;
let currentEpubData = null;
let toolbarsVisible = true;
let hideTimer = null;
let lastScrollSave = 0;
let readerStatePushed = false;

/** 打开阅读器 */
async function openReader(bookId) {
  currentBookId = bookId;

  // 切换到阅读器视图
  document.getElementById('view-bookshelf').classList.add('hidden');
  document.getElementById('view-reader').classList.remove('hidden');

  // 加载设置
  const settings = getSettings();
  applySettings(settings);

  // 显示加载状态
  const contentDiv = document.getElementById('readerContent');
  contentDiv.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>加载中...</p></div>';

  try {
    // 从 IndexedDB 获取文件
    const record = await getBookFile(bookId);
    if (!record || !record.file) {
      contentDiv.innerHTML = '<div class="empty-state"><p>无法加载此书</p></div>';
      return;
    }

    // 解析 EPUB
    currentEpubData = await parseEpub(record.file);

    // 更新工具栏标题
    document.getElementById('readerTitle').textContent = record.title || currentEpubData.title || '未知书名';
    document.getElementById('readerAuthor').textContent = record.author || currentEpubData.author || '';

    // 渲染章节
    renderAllChapters(currentEpubData);

    // 恢复阅读进度
    restoreReadingPosition(bookId);

    // 显示工具栏
    showToolbars();
    scheduleHideToolbars();

    // 推入历史记录，使系统返回键回到书架而非退出
    if (!readerStatePushed) {
      history.pushState({ view: 'reader' }, '', location.href);
      readerStatePushed = true;
    }

  } catch (err) {
    console.error('打开书籍失败:', err);
    contentDiv.innerHTML = '<div class="empty-state"><p>打开失败：' + (err.message || '未知错误') + '</p></div>';
  }
}

/** 渲染所有章节 */
function renderAllChapters(epubData) {
  const container = document.getElementById('readerContent');
  let html = '';

  for (const chapter of epubData.chapters) {
    html += `<section class="chapter" id="${chapter.id}">
      <h2 class="chapter-title">${escapeHtml(chapter.label)}</h2>
      <div class="chapter-content">${chapter.html}</div>
    </section>`;
  }

  container.innerHTML = html;
}

/** 关闭阅读器，返回书架 */
function closeReader() {
  // 重置历史状态标记
  readerStatePushed = false;

  // 保存阅读进度
  if (currentBookId) {
    saveCurrentProgress();
  }

  // 清理 blob URLs
  if (currentEpubData && currentEpubData.manifestFiles) {
    // blob URLs 在页面刷新时会自动释放，这里不做强制清理
  }

  currentBookId = null;
  currentEpubData = null;
  clearTimeout(hideTimer);

  document.getElementById('view-reader').classList.add('hidden');
  document.getElementById('view-bookshelf').classList.remove('hidden');

  // 刷新书架（书名可能有更新）
  renderBookshelf();
}

// ===== 三区点击导航 =====

function setupReaderInteractions() {
  const viewport = document.getElementById('readerViewport');

  // 点击导航
  viewport.addEventListener('click', (e) => {
    // 不拦截链接、按钮等交互元素
    const target = e.target;
    if (target.closest('a, button, input, select, img')) return;

    const y = e.clientY;
    const height = window.innerHeight;
    const relY = y / height;

    if (relY < 0.25) {
      // 上部：向上滚动约一屏
      viewport.scrollBy({ top: -height * 0.75, behavior: 'smooth' });
    } else if (relY > 0.75) {
      // 下部：向下滚动约一屏
      viewport.scrollBy({ top: height * 0.75, behavior: 'smooth' });
    } else {
      // 中间：切换工具栏
      toggleToolbars();
    }
  });

  // 滚动时更新进度
  viewport.addEventListener('scroll', () => {
    updateProgressBar();
    // 防抖保存进度
    const now = Date.now();
    if (now - lastScrollSave > 2000) {
      lastScrollSave = now;
      saveCurrentProgress();
    }
  });

  // 键盘快捷键
  document.addEventListener('keydown', handleKeyboard);
}

/** 键盘快捷键 */
function handleKeyboard(e) {
  if (!currentBookId) return; // 不在阅读模式

  const viewport = document.getElementById('readerViewport');
  const h = window.innerHeight;

  switch (e.key) {
    case 'ArrowUp':
    case 'w':
      e.preventDefault();
      viewport.scrollBy({ top: -h * 0.5, behavior: 'smooth' });
      break;
    case 'ArrowDown':
    case 's':
    case ' ':
      e.preventDefault();
      viewport.scrollBy({ top: h * 0.5, behavior: 'smooth' });
      break;
    case 'Escape':
      e.preventDefault();
      history.back();
      break;
  }
}

// ===== 工具栏管理 =====

function showToolbars() {
  document.getElementById('readerTopbar').classList.remove('hidden-bar');
  document.getElementById('readerBottombar').classList.remove('hidden-bar');
  toolbarsVisible = true;
}

function hideToolbars() {
  document.getElementById('readerTopbar').classList.add('hidden-bar');
  document.getElementById('readerBottombar').classList.add('hidden-bar');
  toolbarsVisible = false;
}

function toggleToolbars() {
  if (toolbarsVisible) {
    hideToolbars();
    clearTimeout(hideTimer);
  } else {
    showToolbars();
    scheduleHideToolbars();
  }
}

function scheduleHideToolbars() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (toolbarsVisible) hideToolbars();
  }, 4000); // 4 秒无操作后隐藏
}

// ===== 设置面板 =====

function setupSettings() {
  // 背景颜色
  document.getElementById('colorPresets').addEventListener('click', (e) => {
    const dot = e.target.closest('.color-dot');
    if (!dot) return;
    const color = dot.dataset.color;
    applyBgColor(color);

    // 更新选中状态
    document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
    dot.classList.add('active');

    saveSettings({ bgColor: color });
    scheduleHideToolbars();
  });

  // 字号调节
  document.getElementById('fontSizeDown').addEventListener('click', () => {
    changeFontSize(-1);
    scheduleHideToolbars();
  });

  document.getElementById('fontSizeUp').addEventListener('click', () => {
    changeFontSize(1);
    scheduleHideToolbars();
  });

  // 字体选择
  document.getElementById('fontFamilySelect').addEventListener('change', (e) => {
    const font = e.target.value;
    applyFontFamily(font);
    saveSettings({ fontFamily: font });
    scheduleHideToolbars();
  });
}

function applySettings(settings) {
  if (settings.bgColor) applyBgColor(settings.bgColor);
  if (settings.fontSize) applyFontSize(settings.fontSize);
  if (settings.fontFamily) applyFontFamily(settings.fontFamily);
}

function applyBgColor(color) {
  const view = document.getElementById('view-reader');
  view.style.backgroundColor = color;
  document.documentElement.style.setProperty('--reader-bg', color);

  // 使用 CSS class 控制深色/浅色模式
  if (isDarkColor(color)) {
    view.classList.add('dark-mode');
  } else {
    view.classList.remove('dark-mode');
  }

  // 同步颜色预设选中状态
  document.querySelectorAll('.color-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.color === color);
  });
}

function applyFontSize(size) {
  document.documentElement.style.setProperty('--reader-size', size + 'px');
  document.getElementById('fontSizeLabel').textContent = size + 'px';
}

function applyFontFamily(font) {
  document.documentElement.style.setProperty('--reader-font', font);
  document.getElementById('fontFamilySelect').value = font;
}

function changeFontSize(delta) {
  const settings = getSettings();
  const newSize = Math.max(12, Math.min(28, settings.fontSize + delta));
  applyFontSize(newSize);
  saveSettings({ fontSize: newSize });
}

/** 判断颜色是否为深色 */
function isDarkColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

// ===== 阅读进度 =====

function updateProgressBar() {
  const viewport = document.getElementById('readerViewport');
  const scrollTop = viewport.scrollTop;
  const scrollHeight = viewport.scrollHeight;
  const clientHeight = viewport.clientHeight;
  const maxScroll = scrollHeight - clientHeight;

  if (maxScroll <= 0) {
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressText').textContent = '0%';
    return;
  }

  const percent = Math.min(100, Math.round((scrollTop / maxScroll) * 100));
  document.getElementById('progressFill').style.width = percent + '%';
  document.getElementById('progressText').textContent = percent + '%';
}

function saveCurrentProgress() {
  if (!currentBookId) return;
  const viewport = document.getElementById('readerViewport');
  const scrollTop = viewport.scrollTop;
  const maxScroll = viewport.scrollHeight - viewport.clientHeight;
  const percent = maxScroll > 0 ? Math.round((scrollTop / maxScroll) * 100) : 0;
  saveProgress(currentBookId, scrollTop, percent);
}

function restoreReadingPosition(bookId) {
  const progress = getProgress(bookId);
  const viewport = document.getElementById('readerViewport');

  if (progress.scrollTop <= 0) {
    updateProgressBar();
    return;
  }

  // 确保 DOM 布局完成后再恢复滚动位置
  function doRestore() {
    viewport.scrollTop = progress.scrollTop;
    updateProgressBar();
    // 防止恢复触发的 scroll 事件覆盖正确的进度
    lastScrollSave = Date.now();

    // 如果恢复后位置偏差较大，说明内容还没渲染完，延迟重试
    if (Math.abs(viewport.scrollTop - progress.scrollTop) > 10) {
      setTimeout(() => {
        viewport.scrollTop = progress.scrollTop;
        updateProgressBar();
        lastScrollSave = Date.now();
      }, 400);
    }
  }

  // 双 rAF 确保浏览器完成至少一次布局
  requestAnimationFrame(() => {
    requestAnimationFrame(doRestore);
  });
}

// ===== 辅助 =====

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
