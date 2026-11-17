import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const DAYS = 180, lifetime = DAYS * 86400 * 1000;
export const publicUser = ({ id, name, login, role, createdAt, sso }) => ({ id, name, login, role, createdAt, ssoLinked: Boolean(sso), opsvaultName: sso?.name, credentialUrl: sso?.credentialUrl });
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
export function authStore({ all, get, save, remove, db }) {
  const users = () => all('user');
  const fingerprint = token => createHash('sha256').update(token).digest('hex');
  function cookie(res, token, maxAge = lifetime / 1000) {
    res.setHeader('Set-Cookie', `opslands_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.OPSLANDS_SECURE_COOKIE === '1' ? '; Secure' : ''}`);
  }
  async function createUser(input, role = input.role) {
    const login = String(input.login || '').trim().toLowerCase(), name = String(input.name || '').trim(), password = String(input.password || '');
    if (!/^[a-z0-9][a-z0-9_.@+-]{2,79}$/.test(login)) fail('Логин: от 3 до 80 символов, латиница, цифры, . _ @ + -');
    if (!name || name.length > 80) fail('Укажите имя до 80 символов');
    if (password.length < 8 || password.length > 200) fail('Пароль: от 8 до 200 символов');
    if (!['admin', 'member'].includes(role)) fail('Недопустимая роль');
    if (users().some(u => u.login === login)) fail('Этот логин уже занят');
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt, 64)).toString('hex');
    // Recheck after asynchronous password hashing, before the synchronous write.
    if (users().some(u => u.login === login)) fail('Этот логин уже занят');
    return { id: randomUUID(), login, name, role, salt, hash, createdAt: new Date().toISOString() };
  }
  function begin(res, user, extra = {}) {
    for (const old of all('session')) if (old.expiresAt <= Date.now()) remove('session', old.id);
    const token = randomBytes(32).toString('hex');
    save('session', { id: fingerprint(token), userId: user.id, expiresAt: Date.now() + lifetime, refreshedAt: Date.now(), ...extra });
    cookie(res, token);
  }
  function current(req, res) {
    const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('opslands_session='))?.slice(17);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    let session, user;
    try { session = get('session', fingerprint(token)); user = get('user', session.userId); } catch { return null; }
    if (session.expiresAt <= Date.now()) { remove('session', session.id); return null; }
    if (session.mode !== 'oidc') { remove('session', session.id); return null; }
    req.opsSession = session;
    if (Date.now() - session.refreshedAt > 86400000) {
      session.refreshedAt = Date.now(); session.expiresAt = Date.now() + lifetime; save('session', session); cookie(res, token);
    }
    return user;
  }
  function logout(req, res) {
    const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('opslands_session='))?.slice(17);
    if (token) remove('session', fingerprint(token)); cookie(res, '', 0);
  }
  function deleteUser(id, actor) {
    const user = get('user', id);
    if (id === actor.id) fail('Нельзя удалить свою учетную запись');
    if (user.role === 'admin' && users().filter(u => u.role === 'admin').length <= 1) fail('Нельзя удалить последнего администратора');
    db.exec('BEGIN');
    try {
      for (const session of all('session')) if (session.userId === id) remove('session', session.id);
      remove('user', id); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async function checkPassword(user, password) { return Boolean(user.hash) && timingSafeEqual(await derive(String(password || ''), user.salt, 64), Buffer.from(user.hash, 'hex')); }
  return { users, current, logout, createUser, begin, deleteUser, checkPassword };
}
export function requireAdmin(user) { if (user.role !== 'admin') fail('Доступ только для администратора', 403); }
export function canRead(user, landing) { return user.role === 'admin' || landing.isGlobal || landing.ownerId === user.id; }
export function requireLanding(user, landing) { if (!canRead(user, landing)) fail('Ленд не найден', 404); return landing; }
export function requireOwner(user, landing) { if (user.role !== 'admin' && landing.ownerId !== user.id) fail('Вы можете менять доступ только к своим лендам', 403); }
