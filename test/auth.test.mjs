import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('private access, user administration and durable/revocable sessions', async () => {
  const data = mkdtempSync(join(tmpdir(), 'opslands-auth-'));
  const port = 44000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
  let server;
  async function start() {
    server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port), OPSLANDS_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { server.once('exit', c => reject(new Error(`Exit ${c}`))); server.stdout.on('data', d => String(d).includes('OPSLands:') && resolve()); });
  }
  async function stop() { const done = once(server, 'exit'); server.kill(); await done; }
  const client = () => ({ cookie: '' });
  const admin = client(), alice = client(), bob = client(), anon = client();
  async function request(who, path, body) {
    const response = await fetch(base + path, { headers: { Cookie: who.cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    if (response.headers.get('set-cookie')) who.cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  const html = '<html><body><form action="{{form_action}}" method="{{form_method}}">{{hidden_fields}}<input name="name"><input name="phone"></form></body></html>';
  try {
    await start();
    assert.equal((await request(anon, '/api/catalog')).status, 401);
    const setup = await request(admin, '/api/auth/setup', { name: 'Admin', login: 'admin', password: 'password-admin' });
    assert.equal(setup.status, 201);
    assert.ok(setup.headers.get('set-cookie').includes('HttpOnly'));
    assert.ok(setup.headers.get('set-cookie').includes('Max-Age=15552000'));
    const root = (await setup.json()).user;
    assert.equal((await request(anon, '/api/auth/setup', { name: 'Second', login: 'second', password: 'password-second' })).status, 409);
    const aliceResponse = await request(admin, '/api/admin/users', { name: 'Alice', login: 'alice', password: 'password-alice', role: 'member' });
    assert.equal(aliceResponse.status, 201); const aliceUser = await aliceResponse.json(); assert.ok(!aliceUser.hash);
    const bobResponse = await request(admin, '/api/admin/users', { name: 'Bob', login: 'bob', password: 'password-bob', role: 'member' });
    const bobUser = await bobResponse.json();
    assert.equal((await request(alice, '/api/auth/login', { login: 'alice', password: 'wrong' })).status, 401);
    assert.equal((await request(alice, '/api/auth/login', { login: 'alice', password: 'password-alice' })).status, 200);
    assert.equal((await request(bob, '/api/auth/login', { login: 'bob', password: 'password-bob' })).status, 200);
    const personal = await (await request(alice, '/api/landings', { name: 'Private Alice', html, ownerId: bobUser.id, author: 'Spoofed' })).json();
    assert.equal(personal.ownerId, aliceUser.id); assert.equal(personal.author, 'Alice'); assert.equal(personal.isGlobal, false);
    const shared = await (await request(alice, '/api/landings', { name: 'Shared Alice', html, isGlobal: true })).json();
    const bobCatalog = await (await request(bob, '/api/catalog')).json();
    assert.ok(bobCatalog.landings.some(l => l.id === shared.id)); assert.ok(!bobCatalog.landings.some(l => l.id === personal.id));
    for (const path of [`/api/landings/${personal.id}`, `/preview/${personal.id}/index.html`]) assert.equal((await request(bob, path)).status, 404);
    assert.equal((await request(anon, `/preview/${personal.id}/index.html`)).status, 401);
    assert.equal((await request(bob, `/api/landings/${personal.id}/build`, { partnerId: 'generic', values: { offer_id: '1' }, action: 'https://example.com' })).status, 404);
    assert.equal((await request(bob, '/api/landings', { name: 'Stolen', parentId: personal.id })).status, 404);
    assert.equal((await request(bob, `/api/landings/${shared.id}/visibility`, { isGlobal: false })).status, 403);
    assert.equal((await request(bob, '/api/admin')).status, 403);
    assert.equal((await request(bob, '/api/admin/users', { name: 'Intruder', login: 'intruder', password: 'password-intruder', role: 'admin' })).status, 403);
    assert.equal((await request(bob, `/api/admin/users/${aliceUser.id}/delete`, {})).status, 403);
    assert.equal((await request(bob, '/api/partners', {})).status, 403);
    const adminData = await (await request(admin, '/api/admin')).json(); assert.ok(adminData.landings.some(l => l.id === personal.id));
    assert.ok(adminData.users.every(u => !u.hash && !u.salt));
    assert.equal((await request(admin, `/api/admin/users/${root.id}/delete`, {})).status, 400);
    await stop(); await start();
    assert.equal((await request(alice, '/api/catalog')).status, 200);
    assert.equal((await request(admin, '/api/admin')).status, 200);
    // Exercise sliding renewal using a controlled, older refresh timestamp.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(data, 'opslands.sqlite'));
    for (const row of db.prepare("SELECT id,payload FROM records WHERE kind='session'").all()) {
      const session = JSON.parse(row.payload);
      if (session.userId === aliceUser.id) { session.refreshedAt = Date.now() - 2 * 86400000; db.prepare("UPDATE records SET payload=? WHERE kind='session' AND id=?").run(JSON.stringify(session), row.id); }
    }
    db.close();
    const renewal = await request(alice, '/api/auth/me'); assert.ok(renewal.headers.get('set-cookie'));
    assert.equal((await request(admin, `/api/admin/users/${aliceUser.id}/delete`, {})).status, 200);
    assert.equal((await request(alice, '/api/catalog')).status, 401);
    assert.equal((await request(alice, '/api/auth/login', { login: 'alice', password: 'password-alice' })).status, 401);
    assert.equal((await request(admin, `/api/landings/${personal.id}`)).status, 200);
    const orphanCatalog = await (await request(bob, '/api/catalog')).json(); assert.ok(orphanCatalog.landings.some(l => l.id === shared.id));
    const oldCookie = bob.cookie; assert.equal((await request(bob, '/api/auth/logout', {})).status, 200);
    bob.cookie = oldCookie; assert.equal((await request(bob, '/api/catalog')).status, 401);
  } finally { if (server && server.exitCode === null) await stop(); rmSync(data, { recursive: true, force: true }); }
});
