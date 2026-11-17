import { posix } from 'node:path';
import sharp from 'sharp';

export const textLimits = { maxFields: 20000, maxBytes: 1024 * 1024, batchBytes: 10000, batchFields: 100, outputTokens: 6000 };
export function textPlan(fields) {
  const parts = [], groups = new Map();
  for (const field of fields) {
    let remaining = field.text; const ids = [];
    while (Buffer.byteLength(remaining) > 8000) {
      let length = 0; const chars = []; for (const char of remaining) { const bytes = Buffer.byteLength(char); if (length + bytes > 7600) break; chars.push(char); length += bytes; } let prefix = chars.join('');
      const space = prefix.lastIndexOf(' '); if (space > prefix.length / 2) prefix = prefix.slice(0, space + 1);
      const id = `${field.id}p${ids.length}`; parts.push({ id, text: prefix.trim() }); ids.push(id); remaining = remaining.slice(prefix.length);
    }
    const id = ids.length ? `${field.id}p${ids.length}` : field.id; parts.push({ id, text: remaining }); ids.push(id); groups.set(field.id, ids);
  }
  const batches = []; let batch = [], bytes = 2;
  for (const part of parts) {
    const length = Buffer.byteLength(JSON.stringify(part)) + 1;
    if (batch.length && (bytes + length > textLimits.batchBytes || batch.length >= textLimits.batchFields)) { batches.push(batch); batch = []; bytes = 2; }
    batch.push(part); bytes += length;
  }
  if (batch.length) batches.push(batch);
  return { batches, groups };
}
export function diagnostics(fields) {
  const textBytes = Buffer.byteLength(JSON.stringify(fields.map(({ id, text }) => ({ id, text }))));
  const issues = [];
  if (!fields.length) issues.push('В выбранном index не найдено обычного текста для адаптации. Он может находиться в JavaScript, на изображениях или быть исключен фильтром реквизитов.');
  if (fields.length > textLimits.maxFields) issues.push(`Найдено ${fields.length} текстовых фрагментов, поддерживается до ${textLimits.maxFields}. Разделите страницу на несколько лендингов.`);
  if (textBytes > textLimits.maxBytes) issues.push(`Текст занимает ${(textBytes / 1024).toFixed(1)} КБ, предел — ${textLimits.maxBytes / 1024} КБ. Удалите из index ненужные разделы или разделите страницу.`);
  return { fragments: fields.length, textBytes, batches: issues.length ? 0 : textPlan(fields).batches.length, limits: textLimits, issues, canAdaptText: !issues.length };
}

const walk = (node, fn) => { fn(node); for (const child of node.childNodes || []) walk(child, fn); };
function localPath(reference, base = 'index.html') {
  if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) return null;
  try {
    const value = decodeURIComponent(reference.split(/[?#]/)[0]);
    if (value.includes('\\') || value.includes('\0')) return null;
    const path = posix.normalize(value.startsWith('/') ? value.slice(1) : posix.join(posix.dirname(base), value));
    return path.startsWith('../') || path === '..' ? null : path;
  } catch { return null; }
}
export function imageInventory(files, view) {
  const used = new Set(), css = new Set(), labels = new Map(), external = new Set();
  const reference = (value, base, label) => {
    const path = localPath(value, base);
    if (path && Object.hasOwn(files, path)) { used.add(path); if (label) labels.set(path, label); }
    else if (/^https?:|^\/\//i.test(value || '')) external.add(value);
  };
  const srcset = (value, base) => { if (!value?.startsWith('data:')) for (const part of (value || '').split(',')) reference(part.trim().split(/\s+/)[0], base); };
  const styles = (text, base) => {
    for (const match of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) reference(match[2], base);
    for (const match of text.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/gi)) { const path = localPath(match[1], base); if (path && files[path] && !css.has(path) && css.size < 500) { css.add(path); styles(Buffer.from(files[path], 'base64').toString(), path); } }
  };
  walk(view.document, node => {
    const attrs = Object.fromEntries((node.attrs || []).map(a => [a.name, a.value]));
    if (['img', 'source', 'image', 'input', 'video', 'link'].includes(node.tagName)) {
      for (const name of ['src', 'data-src', 'data-original', 'data-lazy-src', 'poster', 'href', 'xlink:href']) if (attrs[name]) reference(attrs[name], 'index.html', node.tagName === 'img' ? attrs.alt : null);
      for (const name of ['srcset', 'data-srcset']) srcset(attrs[name], 'index.html');
      if (node.tagName === 'link' && /stylesheet/i.test(attrs.rel || '')) { const path = localPath(attrs.href); if (path && files[path] && !css.has(path)) { css.add(path); styles(Buffer.from(files[path], 'base64').toString(), path); } }
    }
    if (attrs.style) styles(attrs.style, 'index.html');
    if (node.tagName === 'style') styles((node.childNodes || []).map(n => n.value || '').join(''), 'index.html');
  });
  const paths = Object.keys(files).filter(path => /\.(?:png|jpe?g|webp|gif|avif|svg|bmp|ico)$/i.test(path));
  const images = paths.map((path, n) => {
    // Keep original per-img ids where possible for old clients/jobs; duplicates share one file.
    const old = view.images.find(i => (i.references || [i.source]).some(source => localPath(source) === path));
    const supported = /\.(?:png|jpe?g|webp|gif|avif)$/i.test(path);
    const bytes = Buffer.from(files[path], 'base64').length;
    return { id: old?.id || `asset${n}`, source: path, path, label: labels.get(path) || path.split('/').at(-1), used: used.has(path), bytes, supported: supported && bytes <= 8 * 1024 * 1024, reason: !supported ? 'Этот формат пока не поддерживается для редактирования' : bytes > 8 * 1024 * 1024 ? 'Файл больше 8 МБ' : null };
  });
  return { images: images.sort((a, b) => Number(b.used) - Number(a.used) || a.path.localeCompare(b.path)), externalCount: external.size };
}
const imageOptions = { limitInputPixels: 16 * 1024 * 1024, failOn: 'error' };
const raster = metadata => ['png', 'jpeg', 'webp', 'gif', 'heif', 'avif'].includes(metadata.format);
export async function imageReference(data, path) {
  const input = Buffer.from(data, 'base64');
  let metadata, reference;
  try {
    metadata = await sharp(input, imageOptions).metadata();
    if (!raster(metadata) || (metadata.pages || 1) > 1) throw new Error('unsupported or animated');
    const side = metadata.hasAlpha ? 800 : 1536;
    const pipeline = sharp(input, imageOptions).rotate().resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true });
    reference = metadata.hasAlpha ? await pipeline.png().toBuffer() : await pipeline.jpeg({ quality: 85 }).toBuffer();
  } catch { throw new Error(`Изображение «${path}» не удалось прочитать. Нужен статичный PNG/JPEG/WebP/GIF/AVIF до 16 Мп; анимация не поддерживается.`); }
  return { url: `data:image/${metadata.hasAlpha ? 'png' : 'jpeg'};base64,${reference.toString('base64')}`, width: metadata.autoOrient?.width || metadata.width, height: metadata.autoOrient?.height || metadata.height };
}
export async function replaceImage(data, image) {
  const format = ({ '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp', '.gif': 'gif', '.avif': 'avif' })[posix.extname(image.path).toLowerCase()];
  try { const input = sharp(Buffer.from(data, 'base64'), imageOptions); const metadata = await input.metadata(); if (!raster(metadata) || (metadata.pages || 1) > 1) throw new Error('unsupported'); return await input.rotate().resize(image.reference.width, image.reference.height, { fit: 'cover' }).toFormat(format).toBuffer(); }
  catch { throw new Error(`Провайдер вернул поврежденное изображение для «${image.path}»`); }
}
export async function imageThumbnails(files, images) {
  let total = 0;
  return Promise.all(images.map(async (image, n) => {
    let thumbnail;
    if (image.supported && n < 120 && total < 3 * 1024 * 1024) {
      try { const input = sharp(Buffer.from(files[image.path], 'base64'), imageOptions); if (!raster(await input.metadata())) return { ...image, supported: false, reason: 'Содержимое файла не является поддерживаемым растровым изображением' }; const bytes = await input.rotate().resize({ width: 160, height: 100, fit: 'inside', withoutEnlargement: true }).webp({ quality: 60 }).toBuffer(); total += bytes.length; thumbnail = `data:image/webp;base64,${bytes.toString('base64')}`; } catch {}
    }
    return { ...image, thumbnail };
  }));
}
