/**
 * epub.js —— EPUB 电子书解析器
 * 基于 JSZip 解析 EPUB 文件（EPUB = ZIP + XML + XHTML）
 * 提取元数据、封面图片、章节内容
 */

/**
 * 解析 EPUB 文件
 * @param {ArrayBuffer} arrayBuffer - EPUB 文件的二进制数据
 * @returns {Object} { title, author, cover, chapters, manifestFiles }
 */
async function parseEpub(arrayBuffer) {
  const zip = new JSZip();
  const book = await zip.loadAsync(arrayBuffer);

  // 1. 找到 OPF 文件路径
  const opfPath = await findOpfPath(book);
  if (!opfPath) throw new Error('无法找到 OPF 文件，该 EPUB 可能已损坏');

  // 2. 解析 OPF 文件
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);
  const opfXml = await book.file(opfPath).async('string');
  const opf = parseOpfXml(opfXml);

  // 3. 提取标题和作者
  const title = opf.meta.title || '未知书名';
  const author = opf.meta.author || '未知作者';

  // 4. 提取封面图片
  const cover = await extractCover(book, opf, opfDir);

  // 5. 按 spine 顺序提取章节内容
  const chapters = await extractChapters(book, opf, opfDir);

  // 6. 提取目录 (TOC)
  const toc = await extractToc(book, opf, opfDir);

  return {
    title,
    author,
    cover,          // base64 data URL 或空字符串
    chapters,       // [{ id, label, html }]
    toc,            // [{ label, level, chapterIndex, anchor }] 或 null
    opfDir,         // OPF 所在目录，用于资源路径解析
    manifestFiles: opf.manifest,  // { id: { href, mediaType } }
  };
}

/** 从 container.xml 找到 OPF 文件路径 */
async function findOpfPath(book) {
  const containerPath = 'META-INF/container.xml';
  const containerFile = book.file(containerPath);
  if (!containerFile) return null;

  const xml = await containerFile.async('string');
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const rootfile = doc.querySelector('rootfile');
  return rootfile ? rootfile.getAttribute('full-path') : null;
}

/** 解析 OPF XML */
function parseOpfXml(xml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  // 元数据
  const meta = {};
  const titleEl = doc.querySelector('title');
  const creatorEl = doc.querySelector('creator');
  const langEl = doc.querySelector('language');

  meta.title = titleEl ? titleEl.textContent.trim() : '';
  meta.author = creatorEl ? creatorEl.textContent.trim() : '';
  meta.language = langEl ? langEl.textContent.trim() : '';

  // Manifest: 所有资源文件
  const manifest = {};
  const items = doc.querySelectorAll('manifest item');
  items.forEach(item => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type');
    const properties = item.getAttribute('properties') || '';
    if (id && href) {
      manifest[id] = { href, mediaType, properties };
    }
  });

  // Spine: 阅读顺序
  const spine = [];
  const itemrefs = doc.querySelectorAll('spine itemref');
  itemrefs.forEach(ref => {
    const idref = ref.getAttribute('idref');
    if (idref && manifest[idref]) {
      spine.push(idref);
    }
  });

  // 寻找封面 ID
  let coverId = null;
  const metaCover = doc.querySelector('meta[name="cover"]');
  if (metaCover) {
    coverId = metaCover.getAttribute('content');
  }

  // spine 上的 toc 属性（EPUB2 指定 NCX）
  const spineEl = doc.querySelector('spine');
  const spineToc = spineEl ? spineEl.getAttribute('toc') : null;

  return { meta, manifest, spine, coverId, spineToc };
}

/** 提取封面图片 */
async function extractCover(book, opf, opfDir) {
  let coverHref = null;

  // 方法1: 通过 meta cover ID
  if (opf.coverId && opf.manifest[opf.coverId]) {
    coverHref = opf.manifest[opf.coverId].href;
  }

  // 方法2: 在 manifest 中搜索 cover / cover-image
  if (!coverHref) {
    for (const [id, item] of Object.entries(opf.manifest)) {
      if (/cover/i.test(id) && /image/i.test(item.mediaType)) {
        coverHref = item.href;
        break;
      }
    }
  }

  // 方法3: 找第一个图片
  if (!coverHref) {
    for (const [id, item] of Object.entries(opf.manifest)) {
      if (/image/i.test(item.mediaType)) {
        coverHref = item.href;
        break;
      }
    }
  }

  if (!coverHref) return '';

  try {
    const fullPath = resolvePath(opfDir, coverHref);
    const file = book.file(fullPath);
    if (!file) return '';

    const data = await file.async('base64');
    const ext = coverHref.split('.').pop().toLowerCase();
    const mime = ext === 'png' ? 'image/png' :
                 ext === 'gif' ? 'image/gif' :
                 ext === 'svg' ? 'image/svg+xml' :
                 'image/jpeg';
    return `data:${mime};base64,${data}`;
  } catch (e) {
    console.warn('封面提取失败:', e);
    return '';
  }
}

/** 提取章节内容 */
async function extractChapters(book, opf, opfDir) {
  const chapters = [];
  const spineItems = opf.spine;

  // 收集所有资源文件，用于后续替换路径
  const resourceBlobs = await buildResourceMap(book, opf, opfDir);

  for (let i = 0; i < spineItems.length; i++) {
    const idref = spineItems[i];
    const item = opf.manifest[idref];
    if (!item) continue;

    try {
      const fullPath = resolvePath(opfDir, item.href);
      const file = book.file(fullPath);
      if (!file) continue;

      let html = await file.async('string');

      // 处理 HTML: 去除 XML 声明和 DOCTYPE
      html = html.replace(/<\?xml[^>]*\?>/gi, '')
                 .replace(/<!DOCTYPE[^>]*>/gi, '');

      // 提取 body 内容
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      const content = bodyMatch ? bodyMatch[1] : html.replace(/<html[^>]*>|<\/html>|<head[^>]*>[\s\S]*?<\/head>/gi, '');

      // 替换图片路径为 blob URL
      const processedContent = replaceResourcePaths(content, resourceBlobs, opfDir, item.href);

      // 提取章节标题
      const hMatch = content.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/i);
      let label = hMatch ? hMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      if (!label) {
        // 尝试从 TOC (NCX) 获取标题，否则使用序号
        label = `第 ${i + 1} 章`;
      }

      chapters.push({
        id: `ch-${i}`,
        index: i,
        label,
        html: processedContent,
      });
    } catch (e) {
      console.warn(`章节 ${idref} 解析失败:`, e);
    }
  }

  return chapters;
}

/** 构建资源文件 Blob URL 映射 */
async function buildResourceMap(book, opf, opfDir) {
  const map = new Map();

  for (const [id, item] of Object.entries(opf.manifest)) {
    if (/image/i.test(item.mediaType) || /css/i.test(item.mediaType)) {
      try {
        const fullPath = resolvePath(opfDir, item.href);
        const file = book.file(fullPath);
        if (!file) continue;

        const data = await file.async('blob');
        const blobUrl = URL.createObjectURL(data);
        // 用文件名作为 key
        const filename = item.href.split('/').pop();
        map.set(item.href, blobUrl);
        map.set(filename, blobUrl);
      } catch (e) { /* 跳过损坏的资源 */ }
    }
  }

  return map;
}

/** 替换 HTML 中的资源路径为 Blob URL */
function replaceResourcePaths(html, resourceBlobs, opfDir, chapterHref) {
  // 替换 img src
  html = html.replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, (match, src) => {
    const resolved = resolvePath(opfDir, resolveRelative(chapterHref, src));
    const blobUrl = resourceBlobs.get(resolved) || resourceBlobs.get(src.split('/').pop());
    if (blobUrl) {
      return match.replace(src, blobUrl);
    }
    return match;
  });

  // 替换 image 标签（SVG 中常见）
  html = html.replace(/<image[^>]+href=["']([^"']+)["'][^>]*>/gi, (match, href) => {
    const resolved = resolvePath(opfDir, resolveRelative(chapterHref, href));
    const blobUrl = resourceBlobs.get(resolved) || resourceBlobs.get(href.split('/').pop());
    if (blobUrl) {
      return match.replace(href, blobUrl);
    }
    return match;
  });

  return html;
}

/** 路径拼接（处理 .. 和 .） */
function resolvePath(base, relative) {
  if (relative.startsWith('/')) return relative.substring(1);
  const baseParts = base.split('/').filter(Boolean);
  // 去掉文件名，保留目录。但如果 base 以 / 结尾（是目录而非文件），则不 pop
  if (baseParts.length > 0 && !base.endsWith('/')) {
    baseParts.pop();
  }
  const relParts = relative.split('/');
  for (const part of relParts) {
    if (part === '..') baseParts.pop();
    else if (part !== '.') baseParts.push(part);
  }
  return baseParts.join('/');
}

/** 基于章节文件路径拼接相对路径 */
function resolveRelative(chapterHref, relativePath) {
  if (relativePath.startsWith('/') || relativePath.includes('://')) return relativePath;
  const dir = chapterHref.substring(0, chapterHref.lastIndexOf('/') + 1);
  return resolvePath(dir, relativePath);
}

// ===== 目录 (TOC) 解析 =====

/**
 * 提取 EPUB 目录
 * 优先 EPUB3 nav.xhtml，其次 EPUB2 NCX
 * @returns {Array|null} [{ label, level, chapterIndex, anchor }]
 */
async function extractToc(book, opf, opfDir) {
  const navInfo = findNavFile(opf);
  if (!navInfo) return null;

  const navFullPath = resolvePath(opfDir, navInfo.href);
  const navFile = book.file(navFullPath);
  if (!navFile) return null;

  // 导航文件所在目录，用于解析相对路径
  const navDir = navFullPath.substring(0, navFullPath.lastIndexOf('/') + 1);

  let rawEntries;
  try {
    const content = await navFile.async('string');
    rawEntries = navInfo.type === 'nav'
      ? parseNavXhtml(content)
      : parseNcx(content);
  } catch (e) {
    console.warn('目录解析失败:', e);
    return null;
  }

  if (!rawEntries || !rawEntries.length) return null;

  // 建立 spine 文件路径 -> 章节索引 的映射
  const spineMap = buildSpineMap(opf, opfDir);

  // 把每条目映射到章节索引
  return rawEntries.map(entry => {
    let chapterIndex = -1;
    let anchor = '';

    if (entry.href) {
      const hashIdx = entry.href.indexOf('#');
      let fileHref = entry.href;
      if (hashIdx >= 0) {
        anchor = safeDecode(entry.href.slice(hashIdx + 1));
        fileHref = entry.href.slice(0, hashIdx);
      }

      if (fileHref) {
        const resolved = resolvePath(navDir, fileHref);
        if (spineMap[resolved] !== undefined) {
          chapterIndex = spineMap[resolved];
        }
      }
    }

    return { label: entry.label, level: entry.level, chapterIndex, anchor };
  });
}

/** 定位导航文件（nav.xhtml 或 NCX） */
function findNavFile(opf) {
  // EPUB3: manifest 中 properties 含 nav 的项
  for (const [id, item] of Object.entries(opf.manifest)) {
    if (item.properties && /\bnav\b/.test(item.properties)) {
      return { href: item.href, type: 'nav' };
    }
  }

  // EPUB2: spine 的 toc 属性指向 NCX
  if (opf.spineToc && opf.manifest[opf.spineToc]) {
    return { href: opf.manifest[opf.spineToc].href, type: 'ncx' };
  }

  // EPUB2: manifest 中 media-type 为 NCX 的项
  for (const [id, item] of Object.entries(opf.manifest)) {
    if (/application\/x-dtbncx\+xml/i.test(item.mediaType || '')) {
      return { href: item.href, type: 'ncx' };
    }
  }

  return null;
}

/** 解析 NCX (EPUB2) */
function parseNcx(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const navMap = doc.querySelector('navMap');
  if (!navMap) return [];

  const entries = [];
  walkNavPoints(navMap, entries, 0);
  return entries;
}

function walkNavPoints(parent, entries, level) {
  const children = Array.from(parent.children || [])
    .filter(el => el.tagName && el.tagName.toLowerCase() === 'navpoint');

  children.forEach(point => {
    let label = '';
    const textEl = point.querySelector('navLabel > text');
    if (textEl) label = textEl.textContent.trim();

    const content = point.querySelector('content');
    const href = content ? content.getAttribute('src') : null;

    entries.push({ label, href, level });
    walkNavPoints(point, entries, level + 1);
  });
}

/** 解析 nav.xhtml (EPUB3) */
function parseNavXhtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 优先 epub:type="toc" 的 nav，否则取第一个 nav
  const nav = doc.querySelector('nav[epub\\:type="toc"]') || doc.querySelector('nav');
  if (!nav) return [];

  const entries = [];
  walkNavList(nav, entries, 0);
  return entries;
}

function walkNavList(parent, entries, level) {
  const list = Array.from(parent.children || [])
    .find(el => el.tagName && /^(OL|UL)$/i.test(el.tagName));
  if (!list) return;

  Array.from(list.children).forEach(li => {
    if (!/^LI$/i.test(li.tagName)) return;

    // 取条目自身链接（直接子 a 优先，避免误取子级链接）
    let label = '';
    let href = null;
    const directA = Array.from(li.children).find(c => c.tagName && c.tagName.toLowerCase() === 'a');
    if (directA) {
      label = directA.textContent.trim();
      href = directA.getAttribute('href');
    } else {
      const a = li.querySelector('a');
      if (a) {
        label = a.textContent.trim();
        href = a.getAttribute('href');
      } else {
        // 不带链接的分组标题（如 "第一部"）
        const span = Array.from(li.children).find(c => /^(SPAN|H[1-6])$/i.test(c.tagName));
        label = span ? span.textContent.trim() : li.textContent.trim();
      }
    }

    entries.push({ label, href, level });
    walkNavList(li, entries, level + 1);
  });
}

/** 建立 spine 文件路径 -> 章节索引 映射 */
function buildSpineMap(opf, opfDir) {
  const map = {};
  opf.spine.forEach((idref, index) => {
    const item = opf.manifest[idref];
    if (!item) return;
    map[resolvePath(opfDir, item.href)] = index;
  });
  return map;
}

/** 安全的 decodeURIComponent */
function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch (e) {
    return str;
  }
}
