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

  return {
    title,
    author,
    cover,          // base64 data URL 或空字符串
    chapters,       // [{ id, label, html }]
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
    if (id && href) {
      manifest[id] = { href, mediaType };
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

  return { meta, manifest, spine, coverId };
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
  baseParts.pop(); // 去掉文件名，保留目录
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
