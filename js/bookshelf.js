/**
 * bookshelf.js —— 书架视图逻辑
 * 书籍卡片渲染、添加、删除、重命名、排序
 */

let pendingRenameId = null;

// 排序模式: 'added_desc' | 'added_asc' | 'name_asc' | 'name_desc'
const SORT_MODES = ['added_desc', 'added_asc', 'name_asc', 'name_desc'];
const SORT_LABELS = ['最新在前', '最早在前', '书名 A-Z', '书名 Z-A'];
let currentSort = localStorage.getItem('myreader_sort') || 'added_desc';

/** 获取排序后的书架 */
function getSortedBookshelf() {
  const shelf = getBookshelf();
  const sorted = [...shelf];

  switch (currentSort) {
    case 'added_desc':
      sorted.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      break;
    case 'added_asc':
      sorted.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
      break;
    case 'name_asc':
      sorted.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'));
      break;
    case 'name_desc':
      sorted.sort((a, b) => (b.title || '').localeCompare(a.title || '', 'zh'));
      break;
  }
  return sorted;
}

/** 切换到下一个排序模式 */
function cycleSort() {
  const idx = SORT_MODES.indexOf(currentSort);
  currentSort = SORT_MODES[(idx + 1) % SORT_MODES.length];
  localStorage.setItem('myreader_sort', currentSort);
  updateSortButton();
  renderBookshelf();
}

/** 更新排序按钮外观 */
function updateSortButton() {
  const btn = document.getElementById('sortBtn');
  if (!btn) return;
  const idx = SORT_MODES.indexOf(currentSort);
  btn.textContent = idx >= 0 ? ['↓', '↑', 'A↑', 'A↓'][idx] : '⇅';
  btn.title = '排序：' + (SORT_LABELS[idx] || '最新在前');
  // 非默认排序时高亮按钮
  btn.classList.toggle('active-sort', currentSort !== 'added_desc');
}

/** 渲染书架 */
function renderBookshelf() {
  const grid = document.getElementById('bookshelfGrid');
  const shelf = getSortedBookshelf();
  updateSortButton();

  grid.innerHTML = '';

  if (shelf.length === 0) {
    grid.classList.add('empty');
    return;
  }

  grid.classList.remove('empty');

  shelf.forEach((book, index) => {
    const card = createBookCard(book, index);
    grid.appendChild(card);
  });
}

/** 创建单本书卡片 */
function createBookCard(book, index) {
  const card = document.createElement('div');
  card.className = 'book-card';
  card.style.animationDelay = `${index * 0.04}s`;
  card.dataset.bookId = book.id;

  // 封面区域
  const coverDiv = document.createElement('div');
  coverDiv.className = 'book-cover';
  if (book.cover) {
    const img = document.createElement('img');
    img.src = book.cover;
    img.alt = book.title;
    img.loading = 'lazy';
    coverDiv.appendChild(img);
  } else {
    coverDiv.textContent = '📖';
  }

  // 书籍信息
  const infoDiv = document.createElement('div');
  infoDiv.className = 'book-info';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'book-name';
  nameSpan.textContent = book.title;
  nameSpan.title = '点击修改书名';

  const authorSpan = document.createElement('span');
  authorSpan.className = 'book-author-card';
  authorSpan.textContent = book.author || '';

  infoDiv.appendChild(nameSpan);
  infoDiv.appendChild(authorSpan);

  // 操作按钮区
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'book-actions';

  const renameBtn = document.createElement('button');
  renameBtn.className = 'book-action-btn';
  renameBtn.textContent = '✎ 改名';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openRenameDialog(book);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'book-action-btn delete';
  deleteBtn.textContent = '✕ 删除';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteBook(book.id);
  });

  actionsDiv.appendChild(renameBtn);
  actionsDiv.appendChild(deleteBtn);

  card.appendChild(coverDiv);
  card.appendChild(infoDiv);
  card.appendChild(actionsDiv);

  // 点击卡片 → 打开阅读器
  card.addEventListener('click', () => {
    openReader(book.id);
  });

  return card;
}

/** 添加书籍流程 */
async function addBook(file) {
  if (!file) return;

  // 检查文件类型
  if (!file.name.toLowerCase().endsWith('.epub')) {
    alert('请选择 .epub 格式的电子书文件');
    return;
  }

  try {
    // 显示加载状态
    showToast('正在导入《' + file.name.replace(/\.epub$/i, '') + '》...');

    // 读取文件
    const arrayBuffer = await readFileAsArrayBuffer(file);

    // 解析 EPUB
    const epubData = await parseEpub(arrayBuffer);

    // 生成唯一 ID
    const id = 'book_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    // 书名：优先用 EPUB 元数据，否则用文件名
    const title = epubData.title && epubData.title !== '未知书名'
      ? epubData.title
      : file.name.replace(/\.epub$/i, '');

    const author = epubData.author !== '未知作者' ? epubData.author : '';

    // 封面缩略图（缩小以减少 localStorage 占用）
    const coverThumb = epubData.cover
      ? await resizeCover(epubData.cover, 200)
      : '';

    // 保存到 IndexedDB（原文件 + 原封面）
    await saveBookFile(id, arrayBuffer, {
      title,
      author,
      cover: epubData.cover, // 保存原图
    });

    // 添加到书架（localStorage 存缩略图）
    const bookMeta = { id, title, author, cover: coverThumb, addedAt: Date.now() };
    addToBookshelf(bookMeta);

    // 刷新书架
    renderBookshelf();
    showToast('《' + title + '》已添加到书架');
  } catch (err) {
    console.error('导入书籍失败:', err);
    alert('导入失败：' + (err.message || '未知错误'));
  }
}

/** 从原生文件选择器接收文件（Android APK 专用，更可靠） */
window.receiveNativeFile = async function(fileName, base64Data) {
  try {
    showToast('正在导入《' + fileName.replace(/\.epub$/i, '') + '》...');

    // base64 → ArrayBuffer
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const arrayBuffer = bytes.buffer;

    // 解析 EPUB
    const epubData = await parseEpub(arrayBuffer);

    const id = 'book_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const title = epubData.title && epubData.title !== '未知书名'
      ? epubData.title
      : fileName.replace(/\.epub$/i, '');
    const author = epubData.author !== '未知作者' ? epubData.author : '';

    const coverThumb = epubData.cover
      ? await resizeCover(epubData.cover, 200)
      : '';

    await saveBookFile(id, arrayBuffer, { title, author, cover: epubData.cover });
    addToBookshelf({ id, title, author, cover: coverThumb, addedAt: Date.now() });
    renderBookshelf();
    showToast('《' + title + '》已添加到书架');
  } catch (err) {
    console.error('导入失败:', err);
    alert('导入失败：' + (err.message || '未知错误'));
  }
};

/** 删除书籍 */
async function deleteBook(id) {
  const shelf = getBookshelf();
  const book = shelf.find(b => b.id === id);
  const title = book ? book.title : '这本书';

  if (!confirm('确定要删除《' + title + '》吗？此操作不可撤销。')) return;

  await deleteBookFile(id);
  removeFromBookshelf(id);
  renderBookshelf();
  showToast('已删除《' + title + '》');
}

/** 打开重命名弹窗 */
function openRenameDialog(book) {
  pendingRenameId = book.id;
  document.getElementById('renameInput').value = book.title;
  document.getElementById('renameOverlay').classList.remove('hidden');
  setTimeout(() => {
    document.getElementById('renameInput').focus();
    document.getElementById('renameInput').select();
  }, 100);
}

/** 确认重命名 */
function confirmRename() {
  const input = document.getElementById('renameInput');
  const newTitle = input.value.trim();
  if (!newTitle || !pendingRenameId) {
    closeRenameDialog();
    return;
  }

  updateBookMeta(pendingRenameId, { title: newTitle });
  renderBookshelf();
  closeRenameDialog();
  showToast('书名已修改');
}

/** 关闭重命名弹窗 */
function closeRenameDialog() {
  pendingRenameId = null;
  document.getElementById('renameOverlay').classList.add('hidden');
}

// ===== 辅助函数 =====

/** 读取 File 为 ArrayBuffer */
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsArrayBuffer(file);
  });
}

/** 缩小封面图片（减少 localStorage 占用） */
function resizeCover(dataUrl, maxSize) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
      if (ratio >= 1) {
        resolve(dataUrl); // 无需缩小
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = img.width * ratio;
      canvas.height = img.height * ratio;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve(''); // 加载失败则不显示封面
    img.src = dataUrl;
  });
}

/** Toast 提示 */
let toastTimer = null;
function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = `
      position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,0.78); color: #fff; padding: 10px 20px;
      border-radius: 20px; font-size: 14px; z-index: 999;
      pointer-events: none; transition: opacity 0.3s;
      white-space: nowrap; max-width: 85vw; overflow: hidden; text-overflow: ellipsis;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 2000);
}
