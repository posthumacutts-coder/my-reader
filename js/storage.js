/**
 * storage.js —— 数据持久化层
 * IndexedDB 存储电子书原始文件
 * localStorage 存储书架元数据和用户设置
 */

const DB_NAME = 'MyReaderDB';
const DB_VERSION = 1;
const STORE_NAME = 'books';
const SHELF_KEY = 'myreader_bookshelf';
const SETTINGS_KEY = 'myreader_settings';
const PROGRESS_KEY = 'myreader_progress';

let db = null;

// ===== IndexedDB =====

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = (event) => {
      console.error('IndexedDB 打开失败:', event.target.error);
      reject(event.target.error);
    };
  });
}

/** 保存电子书原始文件到 IndexedDB */
async function saveBookFile(id, fileBuffer, metadata) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record = {
      id,
      file: fileBuffer,
      title: metadata.title,
      author: metadata.author,
      cover: metadata.cover || '',
      addedAt: metadata.addedAt || Date.now(),
    };
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/** 获取电子书原始文件 */
async function getBookFile(id) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

/** 删除电子书 */
async function deleteBookFile(id) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ===== localStorage 书架元数据 =====

/** 获取书架列表（轻量元数据，不包含文件内容） */
function getBookshelf() {
  try {
    const raw = localStorage.getItem(SHELF_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

/** 保存书架列表 */
function saveBookshelf(shelf) {
  localStorage.setItem(SHELF_KEY, JSON.stringify(shelf));
}

/** 添加书籍到书架 */
function addToBookshelf(bookMeta) {
  const shelf = getBookshelf();
  // 避免重复
  const exists = shelf.findIndex(b => b.id === bookMeta.id);
  if (exists >= 0) {
    shelf[exists] = { ...shelf[exists], ...bookMeta };
  } else {
    shelf.unshift(bookMeta);
  }
  saveBookshelf(shelf);
  return shelf;
}

/** 从书架移除 */
function removeFromBookshelf(id) {
  const shelf = getBookshelf().filter(b => b.id !== id);
  saveBookshelf(shelf);
  return shelf;
}

/** 更新书籍元数据（如改名） */
function updateBookMeta(id, updates) {
  const shelf = getBookshelf();
  const idx = shelf.findIndex(b => b.id === id);
  if (idx >= 0) {
    shelf[idx] = { ...shelf[idx], ...updates };
    saveBookshelf(shelf);
  }
  return shelf;
}

// ===== 用户设置 =====

const DEFAULT_SETTINGS = {
  bgColor: '#f5f1e8',
  fontSize: 16,
  fontFamily: "'PingFang SC','Microsoft YaHei',sans-serif",
};

function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  const current = getSettings();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...settings }));
}

// ===== 阅读进度 =====

function getProgress(bookId) {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    const all = raw ? JSON.parse(raw) : {};
    return all[bookId] || { scrollTop: 0, percent: 0 };
  } catch (e) {
    return { scrollTop: 0, percent: 0 };
  }
}

function saveProgress(bookId, scrollTop, percent) {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[bookId] = { scrollTop, percent, timestamp: Date.now() };
    // 只保留最近 50 本书的进度
    const keys = Object.keys(all).slice(-50);
    const trimmed = {};
    keys.forEach(k => { trimmed[k] = all[k]; });
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(trimmed));
  } catch (e) { /* 忽略 */ }
}
