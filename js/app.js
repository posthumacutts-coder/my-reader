/**
 * app.js —— 主控制器
 * 初始化、事件绑定、PWA 注册、视图协调
 */

// ===== 初始化 =====

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  // 初始化 IndexedDB
  try {
    await openDB();
  } catch (e) {
    console.warn('IndexedDB 初始化失败，离线存储不可用:', e);
  }

  // 渲染书架
  renderBookshelf();

  // 绑定书架事件
  bindBookshelfEvents();

  // 绑定阅读器事件
  setupReaderInteractions();
  setupSettings();

  // 绑定重命名弹窗事件
  bindRenameDialogEvents();

  // 绑定键盘快捷键（全局）
  bindGlobalKeys();

  // 注册 Service Worker
  registerSW();

  // 监听 PWA 安装
  listenInstallPrompt();

  console.log('📖 我的阅读 已就绪');
}

// ===== 书架事件 =====

function bindBookshelfEvents() {
  // 添加书籍按钮
  document.getElementById('addBookBtn').addEventListener('click', () => {
    document.getElementById('fileInput').click();
  });

  // 文件选择
  document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) addBook(file);
    // 重置以允许重复选择同一文件
    e.target.value = '';
  });

  // 拖拽添加（桌面端）
  const bookshelf = document.getElementById('view-bookshelf');
  bookshelf.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  bookshelf.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files[0];
    if (file && file.name.toLowerCase().endsWith('.epub')) {
      addBook(file);
    } else if (file) {
      alert('请拖入 .epub 格式的电子书文件');
    }
  });
}

// ===== 阅读器事件 =====

// 返回按钮（在 reader.js 的 HTML 中绑定，这里确保有备用）
document.addEventListener('click', (e) => {
  if (e.target.closest('#btnBack')) {
    closeReader();
  }
});

// ===== 重命名弹窗 =====

function bindRenameDialogEvents() {
  document.getElementById('renameConfirm').addEventListener('click', confirmRename);
  document.getElementById('renameCancel').addEventListener('click', closeRenameDialog);

  // 回车确认
  document.getElementById('renameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmRename();
    if (e.key === 'Escape') closeRenameDialog();
  });

  // 点击遮罩关闭
  document.getElementById('renameOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeRenameDialog();
  });
}

// ===== 全局键盘快捷键 =====

function bindGlobalKeys() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+O 打开文件
    if (e.ctrlKey && e.key === 'o') {
      e.preventDefault();
      document.getElementById('fileInput').click();
    }
  });
}

// ===== PWA =====

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker 已注册'))
      .catch(err => console.warn('Service Worker 注册失败:', err));
  }
}

let deferredPrompt = null;

function listenInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    console.log('PWA 已安装');
  });
}

function showInstallBanner() {
  // 在书架底部显示安装提示
  const banner = document.createElement('div');
  banner.id = 'installBanner';
  banner.style.cssText = `
    position: fixed; bottom: 90px; left: 16px; right: 80px;
    background: #fff; border-radius: 12px; padding: 14px 18px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15); z-index: 90;
    display: flex; align-items: center; gap: 12px;
    font-size: 14px; animation: slideUp 0.3s ease;
  `;
  banner.innerHTML = `
    <span style="flex:1">将此应用安装到桌面，随时随地阅读</span>
    <button id="installBtn" style="
      background: #c9a96e; color: #fff; border: none;
      padding: 8px 16px; border-radius: 20px; font-size: 13px;
      cursor: pointer; white-space: nowrap;
    ">安装</button>
    <button id="dismissBanner" style="
      background: none; border: none; font-size: 18px;
      cursor: pointer; color: #999; padding: 0 4px;
    ">✕</button>
  `;
  document.body.appendChild(banner);

  document.getElementById('installBtn').addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const result = await deferredPrompt.userChoice;
      console.log('PWA 安装:', result.outcome);
      deferredPrompt = null;
    }
    banner.remove();
  });

  document.getElementById('dismissBanner').addEventListener('click', () => {
    banner.remove();
  });
}
