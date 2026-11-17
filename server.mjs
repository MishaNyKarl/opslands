import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { zip, unzip, safePath } from './lib/archive.mjs';
import { validatePartner, buildLanding } from './lib/build.mjs';
import { seeds } from './lib/seeds.mjs';
import { authStore, publicUser, requireAdmin, canRead, requireLanding, requireOwner } from './lib/auth.mjs';
import { ssoStore } from './lib/sso.mjs';
import { inspectPreparation, prepareLanding } from './lib/prepare.mjs';
import { adaptationStore } from './lib/adapt.mjs';
import { workflowStore } from './lib/workflows.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const externalOrigin = process.env.OPSLANDS_ORIGIN ? new URL(process.env.OPSLANDS_ORIGIN).origin : null;
const data = process.env.OPSLANDS_DATA || join(root, 'data');
mkdirSync(data, { recursive: true });
const db = new DatabaseSync(join(data, 'opslands.sqlite'));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, payload TEXT NOT NULL, PRIMARY KEY(kind,id));');
const all = kind => db.prepare('SELECT payload FROM records WHERE kind=?').all(kind).map(r => JSON.parse(r.payload));
const get = (kind, id) => { const row = db.prepare('SELECT payload FROM records WHERE kind=? AND id=?').get(kind, id); if (!row) throw new Error('Запись не найдена'); return JSON.parse(row.payload); };
const save = (kind, record) => db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?)').run(kind, record.id, JSON.stringify(record));
const remove = (kind, id) => db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
const auth = authStore({ all, get, save, remove, db });
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS sso_identity ON records(json_extract(payload,'$.sso.issuer'),json_extract(payload,'$.sso.subject')) WHERE kind='user' AND json_extract(payload,'$.sso.subject') IS NOT NULL");
const sso = ssoStore({ all, get, save, remove, db, auth });
const workflows = workflowStore({ all, get, save, db });
const adaptations = adaptationStore({ all, get, save, remove, onSource: (user, prepared, input) => {
  if (input.baseLandingId) {
    const base = requireLanding(user, get('landing', input.baseLandingId));
    if (base.ownerId === user.id && base.workflow?.sourceId) { const source = get('landing', base.workflow.sourceId); if (source.ownerId === user.id) return source; }
  }
  return workflows.source(user, prepared, input);
}, onResult: workflows.adapted });
workflows.recover();
if (!all('landing').length) for (const landing of seeds()) save('landing', landing);
if (!all('partner').length) save('partner', { id: 'generic', name: 'Универсальная форма', description: 'Прямое подключение к HTTP(S) обработчику. Поля заявки: name и phone. Для API с серверной авторизацией нужен отдельный адаптер.', method: 'POST', fields: [{ key: 'offer_id', target: 'offer_id', label: 'ID оффера', type: 'text', required: true }, { key: 'subid', target: 'subid', label: 'Sub ID', type: 'text', required: false }] });

const summary = ({ files, ...rest }) => ({ ...rest, fileCount: Object.keys(files).length, size: Object.values(files).reduce((n, b) => n + Buffer.from(b, 'base64').length, 0), ready: ['{{form_action}}', '{{form_method}}', '{{hidden_fields}}'].every(t => Buffer.from(files[rest.entry], 'base64').toString().includes(t)) });
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
function adaptationInput(user, input) {
  if (!input.baseLandingId) return { ...input, inheritedLocale: undefined };
  const landing = requireLanding(user, get('landing', String(input.baseLandingId)));
  const files = { ...landing.files }; delete files['ops-config.php'];
  if (files['index.html']) files['index.html'] = Buffer.from(Buffer.from(files['index.html'], 'base64').toString().replaceAll('<script src="ops-tracking.js" defer></script>', '')).toString('base64');
  return { ...input, archive: zip(files).toString('base64'), entry: landing.entry, partner: input.partner || landing.workflow?.partner, name: landing.name, inheritedLocale: { country: landing.workflow?.country || '', language: landing.workflow?.language || '' } };
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 30 * 1024 * 1024) throw new Error('Загрузка превышает 30 МБ'); chunks.push(c); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('Некорректный JSON'); }
  if (req.opsUser) await sso.authorize(req.opsUser, req, true);
  return value;
}
function createLanding(input, user) {
  if (!input.name?.trim() || input.name.length > 120) throw new Error('Укажите название (до 120 символов)');
  let files;
  const parent = input.parentId ? requireLanding(user, get('landing', input.parentId)) : null;
  if (input.archive) files = unzip(Buffer.from(input.archive, 'base64'));
  else if (parent) files = { ...parent.files };
  else files = { 'index.html': Buffer.from(String(input.html || '')).toString('base64') };
  if (!Object.keys(files).length) throw new Error('Архив пуст');
  const entry = input.entry || parent?.entry || Object.keys(files).find(p => /^index\.html?$/i.test(p)) || Object.keys(files).find(p => /\.html?$/i.test(p));
  if (!entry || !Object.hasOwn(files, safePath(entry))) throw new Error('Укажите существующий HTML файл точки входа');
  if (!/\.html?$/i.test(entry)) throw new Error('Точка входа должна быть HTML');
  if (input.html !== undefined) files[entry] = Buffer.from(String(input.html)).toString('base64');
  if (!Buffer.from(files[entry], 'base64').length) throw new Error('HTML не может быть пустым');
  if (input.asset) {
    const path = safePath(String(input.asset.path));
    if (path === entry) throw new Error('Основной HTML меняйте в редакторе');
    files[path] = Buffer.from(String(input.asset.data), 'base64').toString('base64');
  }
  if (Object.keys(files).length > 500 || Object.entries(files).reduce((total, [path, bytes]) => { safePath(path); return total + Buffer.from(bytes, 'base64').length; }, 0) > 40 * 1024 * 1024) throw new Error('Ленд превышает лимит: 500 файлов или 40 МБ');
  const landing = { id: randomUUID(), name: input.name.trim(), type: String(input.type || 'Другое').slice(0, 60), language: String(input.language || 'RU').slice(0, 20), description: String(input.description || '').slice(0, 1000), author: user.name, ownerId: user.id, isGlobal: input.isGlobal === true, color: parent?.color || 'sage', parentId: parent?.id || null, entry, files, downloads: 0, changes: 0, createdAt: new Date().toISOString(), demo: false };
  if (parent?.workflow) landing.workflow = { ...parent.workflow, kind: 'edited', jobId: undefined, fingerprint: undefined };
  db.exec('BEGIN');
  try { save('landing', landing); if (parent) { parent.changes++; save('landing', parent); } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  return summary(landing);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const host = req.headers.host;
    if (!/^127\.0\.0\.1:\d+$|^localhost:\d+$/.test(host || '') && (!externalOrigin || host !== new URL(externalOrigin).host)) return json(res, { error: 'Недопустимый host' }, 403);
    const url = new URL(req.url, `http://${host}`), path = url.pathname;
    const requestOrigin = externalOrigin && host === new URL(externalOrigin).host ? externalOrigin : `http://${host}`;
    if (req.method === 'POST' && (req.headers.origin && req.headers.origin !== requestOrigin || !req.headers['content-type']?.startsWith('application/json'))) return json(res, { error: 'Запрос должен исходить из приложения' }, 403);
    const user = auth.current(req, res);
    const removedPaths = ['/api/auth/login', '/api/auth/setup', '/api/admin/users', '/auth/opsvault/link/start', '/auth/opsvault/link/confirm'];
    if (removedPaths.includes(path)) return json(res, { error: 'Вход и создание аккаунта доступны только через OpsVault' }, 410);
    if (req.method === 'POST' && path.startsWith('/auth/') && req.headers.origin !== requestOrigin) return json(res, { error: 'Недопустимый источник запроса' }, 403);
    if (path === '/auth/opsvault/login' && req.method === 'GET') { res.writeHead(302, { Location: await sso.begin(req, res), 'Cache-Control': 'no-store' }); return res.end(); }
    if (path === '/auth/opsvault/callback' && req.method === 'GET') {
      try { const destination = await sso.callback(req, res, new URL(req.url, externalOrigin || `http://${host}`)); res.writeHead(302, { Location: destination, 'Cache-Control': 'no-store' }); }
      catch { res.writeHead(302, { Location: '/?opsvault=error', 'Cache-Control': 'no-store' }); }
      return res.end();
    }
    if (user && (path.startsWith('/preview/') || path.startsWith('/api/') && path !== '/api/auth/logout')) { await sso.authorize(user, req, req.method !== 'GET'); req.opsUser = user; }
    if (path === '/api/auth/me' && req.method === 'GET') return json(res, { user: user ? { ...publicUser(user), sessionMode: req.opsSession.mode } : null, needsSetup: false, ssoEnabled: sso.enabled(), ssoJitEnabled: sso.jitEnabled() });
    if (path === '/auth/opsvault/logout' && req.method === 'POST') { if (!user) return json(res, { error: 'Войдите в аккаунт' }, 401); await body(req); await sso.globalLogout(req, res, user); return json(res, { ok: true }); }
    if ((path.startsWith('/api/') || path.startsWith('/preview/')) && !user) return json(res, { error: 'Войдите в учетную запись' }, 401);
    if (path === '/api/auth/logout' && req.method === 'POST') { auth.logout(req, res); return json(res, { ok: true }); }
    if (path === '/api/adapt/config' && req.method === 'GET') return json(res, adaptations.config());
    if (path === '/api/adapt/inspect' && req.method === 'POST') return json(res, await adaptations.inspect(adaptationInput(user, await body(req))));
    if (path === '/api/adapt/jobs' && req.method === 'GET') return json(res, { jobs: adaptations.list(user) });
    if (path === '/api/adapt/jobs' && req.method === 'POST') return json(res, await adaptations.create(user, adaptationInput(user, await body(req))), 202);
    const adaptation = path.match(/^\/api\/adapt\/jobs\/([^/]+)(?:\/(cancel|download|preview)(?:\/(.+))?)?$/);
    if (adaptation) {
      const [, id, action, asset] = adaptation;
      if (!action && req.method === 'GET') return json(res, adaptations.status(user, id));
      if (action === 'cancel' && req.method === 'POST') { await body(req); return json(res, adaptations.cancel(user, id)); }
      if (action === 'download' && req.method === 'POST') {
        const archive = adaptations.download(user, id, await body(req));
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="opslands-ai.zip"', 'Cache-Control': 'no-store' }); return res.end(archive);
      }
      if (action === 'preview' && asset && req.method === 'GET') {
        const files = adaptations.files(user, id), filename = safePath(decodeURIComponent(asset));
        const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }[extname(filename).toLowerCase()];
        if (!mime || !Object.hasOwn(files, filename)) return json(res, { error: 'Файл не найден' }, 404);
        res.setHeader('Content-Security-Policy', "sandbox allow-same-origin; default-src 'none'; style-src 'unsafe-inline' 'self'; img-src data: 'self'; font-src data: 'self'; form-action 'none'; base-uri 'none'");
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }); return res.end(Buffer.from(files[filename], 'base64'));
      }
    }
    if (path === '/api/prepare/inspect' && req.method === 'POST') return json(res, inspectPreparation((await body(req)).archive));
    if (path === '/api/prepare/build' && req.method === 'POST') {
      const input = await body(req), prepared = prepareLanding(input);
      const archive = zip(prepared.files);
      const landing = workflows.prepared(user, prepared, input);
      res.setHeader('X-OPSLands-Landing', landing.id);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="opslands-${prepared.partner}.zip"`, 'Content-Length': archive.length, 'Cache-Control': 'no-store' });
      return res.end(archive);
    }
    if (path === '/api/catalog' && req.method === 'GET') return json(res, { landings: all('landing').filter(l => canRead(user, l)).map(summary), partners: all('partner') });
    if (path === '/api/admin' && req.method === 'GET') { requireAdmin(user); return json(res, { users: auth.users().map(publicUser), landings: all('landing').map(summary) }); }
    const deleteUser = path.match(/^\/api\/admin\/users\/([^/]+)\/delete$/);
    if (deleteUser && req.method === 'POST') { requireAdmin(user); auth.deleteUser(deleteUser[1], user); return json(res, { ok: true }); }
    const visibility = path.match(/^\/api\/landings\/([^/]+)\/visibility$/);
    if (visibility && req.method === 'POST') {
      const landing = requireLanding(user, get('landing', visibility[1])); requireOwner(user, landing);
      const input = await body(req); if (typeof input.isGlobal !== 'boolean') throw new Error('Укажите видимость ленда');
      requireOwner(user, landing);
      landing.isGlobal = input.isGlobal; save('landing', landing); return json(res, summary(landing));
    }
    const landingMatch = path.match(/^\/api\/landings\/([^/]+)$/);
    if (landingMatch && req.method === 'GET') return json(res, requireLanding(user, get('landing', landingMatch[1])));
    if (path === '/api/landings' && req.method === 'POST') return json(res, createLanding(await body(req), user), 201);
    const workflowDownload = path.match(/^\/api\/landings\/([^/]+)\/workflow-download$/);
    if (workflowDownload && req.method === 'POST') {
      const input = await body(req), landing = requireLanding(user, get('landing', workflowDownload[1]));
      const archive = workflows.download(landing, input.values);
      landing.downloads++; save('landing', landing);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="opslands-landing.zip"', 'Cache-Control': 'no-store' }); return res.end(archive);
    }
    if (path === '/api/partners' && req.method === 'POST') {
      requireAdmin(user);
      const input = await body(req), partner = { ...validatePartner(input), id: input.id || randomUUID() };
      requireAdmin(user);
      if (input.id) get('partner', input.id);
      save('partner', partner); return json(res, partner, input.id ? 200 : 201);
    }
    const buildMatch = path.match(/^\/api\/landings\/([^/]+)\/build$/);
    if (buildMatch && req.method === 'POST') {
      const input = await body(req), landing = requireLanding(user, get('landing', buildMatch[1])), partner = get('partner', input.partnerId);
      const archive = zip(buildLanding(landing, partner, input.values, input.action));
      landing.downloads++; save('landing', landing);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="opslands-${landing.id}.zip"`, 'Content-Length': archive.length, 'Cache-Control': 'no-store' }); return res.end(archive);
    }
    const preview = path.match(/^\/preview\/([^/]+)\/(.+)$/);
    if (preview && req.method === 'GET') {
      const landing = requireLanding(user, get('landing', preview[1])), filename = safePath(decodeURIComponent(preview[2]));
      if (!Object.hasOwn(landing.files, filename)) return json(res, { error: 'Файл не найден' }, 404);
      const mime = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.woff2': 'font/woff2' }[extname(filename).toLowerCase()] || 'application/octet-stream';
      res.setHeader('Content-Security-Policy', `sandbox allow-same-origin; default-src 'none'; style-src 'unsafe-inline' 'self'; img-src data: 'self'; font-src data: 'self'; media-src 'self'; form-action 'none'`);
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(200, { 'Content-Type': mime }); return res.end(Buffer.from(landing.files[filename], 'base64'));
    }
    if (req.method === 'GET' && /^\/fonts\/(space-grotesk|manrope)-(400|500|600|700)\.ttf$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'font/ttf' }); return res.end(readFileSync(join(root, 'public', path.slice(1))));
    }
    if (req.method === 'GET' && ['/', '/app.js', '/icons.js', '/style.css', '/favicon.ico', '/favicon.svg', '/favicon.png', '/apple-touch-icon.png'].includes(path)) {
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      const file = path === '/' ? 'index.html' : path.slice(1);
      res.writeHead(200, { 'Content-Type': { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'icons.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8', 'favicon.svg': 'image/svg+xml', 'favicon.ico': 'image/vnd.microsoft.icon', 'favicon.png': 'image/png', 'apple-touch-icon.png': 'image/png' }[file] }); return res.end(readFileSync(join(root, 'public', file)));
    }
    json(res, { error: 'Не найдено' }, 404);
  } catch (e) { json(res, { error: e.message }, e.status || (e.message === 'Запись не найдена' ? 404 : 400)); }
});
const port = Number(process.env.PORT || 3000);
server.listen(port, '127.0.0.1', () => console.log(`OPSLands: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { adaptations.close(); server.close(() => { db.close(); process.exit(0); }); });
