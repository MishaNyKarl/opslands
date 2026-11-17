import { parse } from 'parse5';
import { readFileSync } from 'node:fs';
import { unzip, safePath } from './archive.mjs';

export const preparationPartners = [
  { id: 'cashfactorie', name: 'Cashfactorie', fields: ['token', 'offer', 'flow'] },
  { id: 'lemonad', name: 'Lemonad', fields: ['token', 'offer'] }
];
const encode = s => Buffer.from(s).toString('base64');
const decode = s => Buffer.from(s, 'base64').toString('utf8');
const walk = (node, fn) => { fn(node); for (const child of node.childNodes || []) walk(child, fn); };
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const ignored = p => p.split('/').some(s => s === '__MACOSX' || s === '.DS_Store' || s.startsWith('._') || ['logs', 'ops-logs', '.git', 'node_modules'].includes(s)) || /(?:\.log|\.env|\.bak|\.sqlite)$/i.test(p) || /(^|\/)log[_-]/i.test(p);

function archiveFiles(archive) {
  if (typeof archive !== 'string' || !archive.length) throw new Error('Загрузите ZIP с лендом');
  const files = Object.fromEntries(Object.entries(unzip(Buffer.from(archive, 'base64'))).filter(([p]) => !ignored(p)));
  // Ignore Mac metadata before removing a shared wrapper directory.
  const paths = Object.keys(files), prefix = paths[0]?.split('/')[0] + '/';
  return paths.length && paths.every(p => p.startsWith(prefix)) ? Object.fromEntries(paths.map(p => [p.slice(prefix.length), files[p]])) : files;
}
function entries(files) {
  return Object.keys(files).filter(p => /(^|\/)index\.(?:php|html?)$/i.test(p));
}
export function inspectPreparation(archive) {
  const files = archiveFiles(archive);
  const candidates = entries(files);
  if (!candidates.length) throw new Error('Не найден index.php или index.html');
  return { candidates: candidates.map(entry => ({ entry, name: entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : 'Ленд из архива' })), partners: preparationPartners };
}
export function prepareLanding(input) {
  const source = archiveFiles(input.archive);
  const candidates = entries(source), entry = safePath(String(input.entry || (candidates.length === 1 ? candidates[0] : '')));
  if (!candidates.includes(entry)) throw new Error('Выберите ленд из архива');
  const partner = preparationPartners.find(p => p.id === input.partner);
  if (!partner) throw new Error('Выберите Cashfactorie или Lemonad');
  const values = {};
  for (const key of partner.fields) {
    const value = String(input.values?.[key] || '').trim();
    if (!value || value.length > 500 || /[\x00-\x1f]/.test(value)) throw new Error(`Заполните поле ${key} (до 500 символов)`);
    values[key] = value;
  }
  if (partner.id === 'cashfactorie' && (!/^\d+$/.test(values.offer) || !/^\d+$/.test(values.flow))) throw new Error('ID оффера и потока Cashfactorie должны быть числами');
  const prefix = entry.slice(0, entry.lastIndexOf('/') + 1);
  const files = Object.fromEntries(Object.entries(source).filter(([p]) => p.startsWith(prefix)).map(([p, data]) => [p.slice(prefix.length), data]));
  const localEntry = entry.slice(prefix.length);
  let html = decode(files[localEntry]);
  // Only the simple GET tracking snippets from the reference lands are supported.
  html = html.replace(/<\?(?:php|=)[\s\S]*?\?>/gi, block => {
    if (/\$_GET\s*\[/.test(block) || /^<\?php\s*endif\s*;?\s*\?>$/i.test(block)) return '';
    throw new Error('В странице есть PHP-логика, требующая ручной адаптации');
  });
  const document = parse(html, { sourceCodeLocationInfo: true }), edits = [];
  let forms = 0;
  walk(document, form => {
    if (form.tagName !== 'form') return;
    const controls = [];
    walk(form, node => { if (['input', 'button', 'select', 'textarea'].includes(node.tagName)) controls.push(node); });
    if (!controls.some(n => attr(n, 'name') === 'name') || !controls.some(n => attr(n, 'name') === 'phone')) return;
    if (attr(form, 'onsubmit') || controls.some(n => attr(n, 'formaction'))) throw new Error('Форма с onsubmit/formaction требует ручной адаптации');
    const loc = form.sourceCodeLocation;
    if (!loc?.endTag) throw new Error('У формы заявки нет закрывающего тега');
    const attrs = (form.attrs || []).filter(a => !['action', 'method', 'target'].includes(a.name));
    const escape = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    edits.push([loc.startTag.startOffset, loc.startTag.endOffset, `<form${attrs.map(a => ` ${a.name}="${escape(a.value)}"`).join('')} action="ops-submit.php" method="post">`]);
    // Remove inherited routing, tracking and credentials; tracking is restored from the visit URL.
    for (const control of controls) {
      const name = attr(control, 'name') || '';
      if (attr(control, 'type') === 'hidden' && /^(?:utm_\w+|clickid|subid\d*|fbpxl|offer(?:Id|_id)?|flow|id|token|api_key)$/i.test(name)) {
        const c = control.sourceCodeLocation;
        if (c) edits.push([c.startOffset, c.endOffset, '']);
      }
    }
    forms++;
  });
  if (!forms) throw new Error('Не найдена форма с полями name и phone');
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) html = html.slice(0, start) + text + html.slice(end);
  const tracking = `<script src="ops-tracking.js" defer></script>`;
  html = html.includes('</body>') ? html.replace('</body>', tracking + '</body>') : html + tracking;
  for (const path of Object.keys(files)) {
    if (/\.php$/i.test(path) || /(^|\/)(?:\.htaccess|\.user.ini)$/i.test(path)) delete files[path];
  }
  delete files[localEntry];
  files['index.html'] = encode(html);
  // Config is an executable PHP return file, never a public JSON containing a token.
  const config = { partner: partner.id, ...values };
  files['ops-config.php'] = encode(`<?php\nreturn json_decode(base64_decode('${Buffer.from(JSON.stringify(config)).toString('base64')}'), true);\n`);
  files['ops-submit.php'] = encode(readFileSync(new URL('./templates/submit.php', import.meta.url)));
  files['ops-tracking.js'] = encode(`const keys = ['utm_source','utm_content','utm_medium','utm_campaign','utm_term','clickid','subid','subid1','subid2','subid3','subid4','subid5','fbpxl'];\nfor (const form of document.forms) { if (!form.querySelector('[name="name"]') || !form.querySelector('[name="phone"]')) continue; for (const key of keys) { const value = new URLSearchParams(location.search).get(key); if (value === null) continue; let field = form.elements.namedItem(key); if (!field) { field = document.createElement('input'); field.type = 'hidden'; field.name = key; form.append(field); } field.value = value; } }\n`);
  files['ops-success.html'] = encode('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you</title><body><h1>Thank you!</h1><p>Your request has been received.</p></body></html>');
  files['OPSLANDS-README.txt'] = encode(`Partner: ${partner.name}\nEntry: index.html\nForms connected: ${forms}\nRequires PHP 8.2+ and cURL on the target hosting.\nLogs: ops-logs/YYYY-MM-DD.php, JSON lines after a PHP exit guard. Request IDs join request and response events. Tokens, names, full phones and raw responses are never logged.\nNo automatic retries: an uncertain API response must be checked in the partner dashboard before resending.\nOld PHP handlers, success page, credentials and logs were removed. The thank-you page is ops-success.html. Existing scripts and assets are preserved: test the form on your hosting before traffic.\nFacebook conversion pixels from the old success page are not transferred.\nLemonad API reference: https://docs.limonad.com/doc/ru-lead-sending\n`);
  return { files, forms, partner: partner.id };
}
