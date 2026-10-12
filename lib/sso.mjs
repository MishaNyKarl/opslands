import * as oidc from 'openid-client';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

const issuer = 'https://portalwiki.world/sso';
const fail = (message, status = 403) => { throw Object.assign(new Error(message), { status }); };
const digest = x => createHash('sha256').update(x).digest('hex');
const roleOf = response => { if (!['admin', 'user'].includes(response.role)) fail('Некорректный ответ политики OpsVault', 503); return response.role === 'admin' ? 'admin' : 'member'; };
export function ssoStore({ all, get, save, remove, db, auth, env = process.env, fetcher = fetch, configure }) {
  const configured = Boolean(env.SSO_CLIENT_ID && env.SSO_CLIENT_SECRET && env.SSO_ENCRYPTION_KEY);
  const enabled = () => configured && env.SSO_ENABLED === '1';
  const key = configured ? Buffer.from(env.SSO_ENCRYPTION_KEY, 'base64url') : null;
  if (key && key.length !== 32) throw new Error('SSO_ENCRYPTION_KEY must contain 32 bytes');
  const whitelist = new Set((env.SSO_LINK_USERS || '').split(',').filter(Boolean));
  const emergency = new Set((env.SSO_EMERGENCY_USERS || '').split(',').filter(Boolean));
  const cleanup = setInterval(() => {
    for (const kind of ['sso-attempt', 'sso-pending']) for (const record of all(kind)) if (record.expiresAt <= Date.now()) remove(kind, record.id);
  }, 60000);
  cleanup.unref();
  const cache = new Map(); let configuration;
  const seal = async value => new EncryptJWT({ value }).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(key);
  const open = async value => (await jwtDecrypt(value, key, { keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] })).payload.value;
  async function config() {
    if (!enabled()) fail('Вход через OpsVault отключен');
    if (!configuration) configuration = (configure ? configure() : oidc.discovery(new URL(issuer), env.SSO_CLIENT_ID, { id_token_signed_response_alg: 'RS256' }, oidc.ClientSecretBasic(env.SSO_CLIENT_SECRET), { timeout: 8, execute: [oidc.enableNonRepudiationChecks] })).then(c => {
      for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (new URL(c.serverMetadata()[field]).origin !== new URL(issuer).origin) fail('Недопустимый адрес провайдера', 503);
      return c;
    }).catch(() => { configuration = null; fail('OpsVault временно недоступен', 503); });
    return configuration;
  }
  async function policy(path, payload) {
    if (!enabled()) fail('Доступ связанного аккаунта отключен');
    let response, value;
    try {
      response = await fetcher(`${issuer}/${path}/`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${env.SSO_CLIENT_ID}:${env.SSO_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000), redirect: 'error' });
      if ([401, 403].includes(response.status)) fail('Доступ в OpsVault отозван', 403);
      if (response.status === 409) fail('Конфликт реквизитов в OpsVault', 409);
      if (!response.ok) fail('OpsVault временно недоступен', 503);
      value = await response.json();
    } catch (error) { if (error.status) throw error; fail('OpsVault временно недоступен', 503); }
    if ((path === 'access' && payload.action !== 'logout') || path === 'local-access') {
      roleOf(value); const valid = Number(value.valid_for);
      if (!Number.isFinite(valid) || valid <= 0 || valid > 60) fail('Некорректный ответ политики OpsVault', 503);
    }
    return value;
  }
  async function localAccess(user) { const result = await policy('local-access', { subject: user.sso.subject, local_user_id: user.id }); roleOf(result); return result; }
  async function authorize(user, req, fresh = false) {
    if (!user.sso) {
      if (configured && !emergency.has(user.id)) fail('Свяжите аккаунт с OpsVault для доступа');
      return user;
    }
    if (user.sso.issuer !== issuer || !enabled()) fail('Доступ связанного аккаунта отключен');
    const session = req?.opsSession, id = session?.id;
    if (id) { try { if (get('session', id).userId !== user.id) fail('Сессия завершена', 401); } catch { fail('Сессия завершена', 401); } }
    const started = Date.now(), cached = id && cache.get(id);
    let result;
    try {
      if (!fresh && cached && cached.subject === user.sso.subject && cached.until > started) result = cached.result;
      else {
        if (session?.mode === 'oidc') {
          const secret = await open(session.ssoSecret);
          if (secret.subject !== user.sso.subject) fail('Связь аккаунта изменилась');
          result = await policy('access', { lease_token: secret.lease });
        } else result = await localAccess(user);
        const valid = Number(result.valid_for);
        if (!Number.isFinite(valid) || valid <= 0 || valid > 60) fail('Некорректный ответ политики OpsVault', 503);
        roleOf(result);
        if (id) { get('session', id); cache.set(id, { subject: user.sso.subject, result, until: started + valid * 1000 }); }
      }
    } catch (error) { if ([401, 403].includes(error.status) && id) { remove('session', id); cache.delete(id); } throw error; }
    user.role = roleOf(result); return user;
  }
  const browser = req => req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('opslands_oidc='))?.slice(14);
  function browserCookie(res, value, age = 300) {
    const cookie = `opslands_oidc=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
    const existing = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', [...(existing ? Array.isArray(existing) ? existing : [existing] : []), cookie]);
  }
  function take(kind, req) {
    const token = browser(req); if (!token || !/^[a-f0-9]{64}$/.test(token)) fail('Попытка входа истекла');
    const id = digest(token); let record;
    try { record = get(kind, id); } catch { fail('Попытка входа уже использована'); }
    remove(kind, id); if (record.expiresAt < Date.now()) fail('Попытка входа истекла'); return { record, id };
  }
  async function begin(req, res, user, input) {
    const c = await config(); let linking;
    if (user) {
      if (user.sso || !req.opsSession || req.opsSession.mode === 'oidc') fail('Войдите в несвязанный локальный аккаунт');
      if (!whitelist.has(user.id)) fail('Этот аккаунт пока не включен в пилот связывания');
      if (input.consent !== true || !await auth.checkPassword(user, input.password)) fail('Подтвердите пароль OPSLands и согласие на сохранение в OpsVault');
      linking = { userId: user.id, sessionId: req.opsSession.id, hash: user.hash, password: input.password };
    }
    const token = randomBytes(32).toString('hex'), state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
    save('sso-attempt', { id: digest(token), expiresAt: Date.now() + 300000, encrypted: await seal({ state, nonce, verifier, linking }) });
    browserCookie(res, token);
    return oidc.buildAuthorizationUrl(c, { redirect_uri: env.SSO_REDIRECT_URI, scope: 'openid profile', state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' }).href;
  }
  async function issue(res, user, result, req) {
    if (req) auth.logout(req, res);
    auth.begin(res, user, { mode: 'oidc', expiresAt: result.expiresAt, ssoSecret: await seal({ lease: result.lease, subject: result.subject }) });
    browserCookie(res, '', 0);
  }
  async function callback(req, res, url, currentUser) {
    const { record, id } = take('sso-attempt', req), attempt = await open(record.encrypted), c = await config();
    let tokens;
    try { tokens = await oidc.authorizationCodeGrant(c, url, { expectedState: attempt.state, expectedNonce: attempt.nonce, pkceCodeVerifier: attempt.verifier, idTokenExpected: true }); } catch { fail('Проверка входа OpsVault не пройдена'); }
    const claims = tokens.claims();
    if (claims?.at_hash && claims.at_hash !== createHash('sha256').update(tokens.access_token).digest().subarray(0, 16).toString('base64url')) fail('Подпись входа не соответствует токену доступа');
    if (!claims?.sid || !/^[a-f0-9-]{36}$/i.test(claims.sub || '') || !Number.isFinite(claims.iat) || claims.iat > Date.now() / 1000 + 30) fail('Некорректные данные входа');
    const result = await policy('session', { access_token: tokens.access_token });
    if (result.issuer !== issuer || result.subject !== claims.sub || result.sid !== claims.sid || typeof result.lease_token !== 'string' || !result.lease_token || result.lease_token.length > 1024) fail('Сессия OpsVault не соответствует подписанному входу');
    const expiresAt = Number.isFinite(Number(result.expires_at)) ? Number(result.expires_at) * 1000 : Date.parse(result.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) fail('Сессия OpsVault истекла');
    roleOf(result);
    const identity = { subject: claims.sub, name: String(claims.name || claims.preferred_username || claims.sub), lease: result.lease_token, expiresAt };
    if (attempt.linking) {
      if (!currentUser || currentUser.id !== attempt.linking.userId || req.opsSession?.id !== attempt.linking.sessionId) fail('Локальная сессия изменилась');
      save('sso-pending', { id, expiresAt: Date.now() + 300000, encrypted: await seal({ ...identity, linking: attempt.linking }) });
      return '/?opsvault=pending';
    }
    let user = auth.users().find(u => u.sso?.issuer === issuer && u.sso.subject === identity.subject);
    if (!user) {
      if (env.SSO_JIT !== '1') fail('Сначала войдите в существующий аккаунт OPSLands и свяжите OpsVault');
      const stored = await policy('credentials/read', { lease_token: identity.lease, subject: identity.subject });
      if (typeof stored.found !== 'boolean') fail('Некорректный ответ хранилища OpsVault', 503);
      if (stored.found && ['local_user_id', 'username', 'password'].some(field => typeof stored[field] !== 'string' || !stored[field] || stored[field].length > 1024)) fail('Некорректный ответ хранилища OpsVault', 503);
      const id = stored.found ? stored.local_user_id : randomUUID(), login = stored.found ? stored.username : `ov_${randomBytes(10).toString('hex')}`, password = stored.found ? stored.password : randomBytes(32).toString('base64url');
      if (auth.users().some(u => u.id === id || u.login === login)) fail('Конфликт существующего аккаунта. Требуется явное связывание', 409);
      user = await auth.createUser({ name: identity.name.slice(0, 80), login, password, role: 'member' }); user.id = id;
      await publish(user, identity, password);
      await policy('access', { lease_token: identity.lease });
      save('user', user);
    }
    const grant = await policy('access', { lease_token: identity.lease }); user.role = roleOf(grant);
    await issue(res, user, identity, req); return '/';
  }
  async function publish(user, identity, password) {
    const result = await policy('credentials', { lease_token: identity.lease, subject: identity.subject, local_user_id: user.id, username: user.login, password });
    if (result.saved !== true || !Number.isInteger(result.credential_id) || typeof result.credential_url !== 'string' || !result.credential_url.startsWith('/vault/') || result.credential_url.startsWith('//')) fail('OpsVault не подтвердил сохранение реквизитов', 503);
    user.sso = { issuer, subject: identity.subject, name: identity.name, credentialUrl: `https://portalwiki.world${result.credential_url}` };
  }
  async function pending(req, user) {
    const id = browser(req); if (!id) return null;
    let record; try { record = get('sso-pending', digest(id)); } catch { return null; }
    if (record.expiresAt <= Date.now()) { remove('sso-pending', record.id); return null; }
    const value = await open(record.encrypted);
    if (value.linking.userId !== user.id || value.linking.sessionId !== req.opsSession?.id) fail('Подтверждение принадлежит другой сессии');
    return { localLogin: user.login, opsvaultName: value.name };
  }
  async function confirm(req, res, user) {
    const { record } = take('sso-pending', req), value = await open(record.encrypted);
    if (value.linking.userId !== user.id || value.linking.sessionId !== req.opsSession?.id || value.linking.hash !== user.hash || user.sso) fail('Аккаунт или сессия изменились');
    const grant = await policy('access', { lease_token: value.lease }); roleOf(grant);
    await publish(user, value, value.linking.password);
    const latestGrant = await policy('access', { lease_token: value.lease }); roleOf(latestGrant);
    db.exec('BEGIN');
    try {
      const latest = get('user', user.id); get('session', value.linking.sessionId);
      if (latest.sso || latest.hash !== value.linking.hash || auth.users().some(u => u.sso?.issuer === issuer && u.sso.subject === value.subject)) fail('Конфликт связывания', 409);
      latest.sso = user.sso; save('user', latest);
      for (const session of all('session')) if (session.userId === user.id) { remove('session', session.id); cache.delete(session.id); }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    user.role = roleOf(latestGrant); await issue(res, user, value); return { ok: true };
  }
  async function globalLogout(req, res, user) {
    if (req.opsSession?.mode !== 'oidc') fail('Общий выход доступен только для входа через OpsVault');
    const secret = await open(req.opsSession.ssoSecret); await policy('access', { lease_token: secret.lease, action: 'logout' }); auth.logout(req, res);
  }
  return { enabled, configured, authorize, localAccess, begin, callback, pending, confirm, globalLogout };
}
