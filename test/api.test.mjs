import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { unzip, zip } from '../lib/archive.mjs';

test('persistent catalog, custom partner, version creation, asset import and real download', async () => {
  const data = mkdtempSync(join(tmpdir(), 'opslands-test-'));
  const port = 30000 + Math.floor(Math.random() * 10000), base = `http://127.0.0.1:${port}`;
  let server;
  async function start() {
    server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port), OPSLANDS_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server timeout')), 10000);
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
      server.stdout.on('data', d => { if (String(d).includes('OPSLands:')) { clearTimeout(timeout); resolve(); } });
    });
  }
  async function stop() { const done = once(server, 'exit'); server.kill(); await done; }
  let cookie = '';
  async function request(path, body) {
    const response = await fetch(base + path, { headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  try {
    await start();
    assert.equal((await request('/api/adapt/jobs')).status, 401);
    assert.equal((await request('/api/adapt/config')).status, 401);
    assert.equal((await request('/api/prepare/inspect', { archive: '' })).status, 401);
    const setup = await request('/api/auth/setup', { name: 'Tester', login: 'tester', password: 'test-password' });
    assert.equal(setup.status, 201); const owner = (await setup.json()).user;
    const aiConfig = await (await request('/api/adapt/config')).json();
    assert.ok(!JSON.stringify(aiConfig).includes('OPENROUTER_API_KEY'));
    assert.deepEqual((await (await request('/api/adapt/jobs')).json()).jobs, []);
    // Seed a completed synthetic result to exercise HTTP delivery without any provider charges.
    const aiJob = { id: 'fixture-ai', ownerId: owner.id, partner: 'lemonad', state: 'ready', stage: 'Готово', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), reservedUsd: 0.1, files: { 'index.html': Buffer.from('<html><body><h1>Hola</h1><form action="ops-submit.php" method="post"><input name="name"><input name="phone"></form></body></html>').toString('base64'), 'ops-config.php': Buffer.from('never-serve-config').toString('base64') } };
    const fixtureDb = new DatabaseSync(join(data, 'opslands.sqlite'));
    fixtureDb.prepare('INSERT INTO records VALUES (?,?,?)').run('adaptation', aiJob.id, JSON.stringify(aiJob));
    fixtureDb.prepare('INSERT INTO records VALUES (?,?,?)').run('adaptation', 'another-owner', JSON.stringify({ ...aiJob, id: 'another-owner', ownerId: 'someone-else' })); fixtureDb.close();
    const aiPreview = await request('/api/adapt/jobs/fixture-ai/preview/index.html');
    assert.equal(aiPreview.status, 200); assert.match(aiPreview.headers.get('content-security-policy'), /sandbox/);
    assert.match(await aiPreview.text(), /Hola/);
    assert.equal((await request('/api/adapt/jobs/fixture-ai/preview/ops-config.php')).status, 404);
    for (const suffix of ['', '/preview/index.html', '/download', '/cancel']) assert.equal((await request('/api/adapt/jobs/another-owner' + suffix, ['/download', '/cancel'].includes(suffix) ? {} : undefined)).status, 404);
    assert.equal((await request('/api/adapt/jobs/fixture-ai/download', { values: {} })).status, 400);
    const aiDownload = await request('/api/adapt/jobs/fixture-ai/download', { values: { token: 'temporary-download-token', offer: '1' } });
    assert.equal(aiDownload.status, 200); assert.ok(unzip(Buffer.from(await aiDownload.arrayBuffer()))['ops-submit.php']);
    const preparationArchive = zip({ 'index.html': Buffer.from('<form><input name="name"><input name="phone"></form>').toString('base64') }).toString('base64');
    assert.equal((await request('/api/prepare/inspect', { archive: preparationArchive })).status, 200);
    const preparation = await request('/api/prepare/build', { archive: preparationArchive, partner: 'lemonad', values: { token: 'test-token', offer: 'test-offer' } });
    assert.equal(preparation.status, 200);
    assert.ok(unzip(Buffer.from(await preparation.arrayBuffer()))['ops-submit.php']);
    let catalog = await (await request('/api/catalog')).json(); assert.equal(catalog.landings.length, 5);
    const workflowLandings = catalog.landings.filter(l => l.workflow);
    assert.equal(workflowLandings.length, 2);
    const preparedSaved = workflowLandings.find(l => l.workflow.kind === 'prepared');
    assert.ok(preparedSaved.parentId);
    const savedPrepared = await (await request(`/api/landings/${preparedSaved.id}`)).json();
    assert.ok(!savedPrepared.files['ops-config.php']);
    const inspectedBase = await request('/api/adapt/inspect', { baseLandingId: preparedSaved.id, partner: 'lemonad' });
    assert.equal(inspectedBase.status, 200); assert.ok((await inspectedBase.json()).diagnostics);
    const again = await request(`/api/landings/${preparedSaved.id}/workflow-download`, { values: { token: 'download-only', offer: '1' } });
    assert.equal(again.status, 200); assert.ok(unzip(Buffer.from(await again.arrayBuffer()))['ops-config.php']);
    await request('/api/admin/users', { name: 'Other', login: 'other-reader', password: 'other-password', role: 'member' });
    const otherLogin = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'other-reader', password: 'other-password' }) });
    const otherCookie = otherLogin.headers.get('set-cookie').split(';')[0];
    const deniedDownload = await fetch(`${base}/api/landings/${preparedSaved.id}/workflow-download`, { method: 'POST', headers: { Cookie: otherCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: { token: 'x', offer: '1' } }) });
    assert.equal(deniedDownload.status, 404);
    assert.equal((await fetch(`${base}/preview/${preparedSaved.parentId}/index.html`, { headers: { Cookie: otherCookie } })).status, 404);
    for (const path of ['/api/adapt/inspect', '/api/adapt/jobs']) {
      const deniedBase = await fetch(base + path, { method: 'POST', headers: { Cookie: otherCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ baseLandingId: preparedSaved.id, partner: 'lemonad', prompt: 'Для Турции', mode: 'images' }) });
      assert.equal(deniedBase.status, 404);
    }
    const partner = await (await request('/api/partners', { name: 'Test PP', method: 'POST', fields: [{ key: 'campaign', target: 'offer', label: 'Campaign', type: 'text', required: true }] })).json();
    const source = await (await request('/api/landings/story')).json();
    const modified = Buffer.from(source.files['index.html'], 'base64').toString().replace('Маленькие привычки.', 'Новый заголовок.');
    const variationResponse = await request('/api/landings', { parentId: source.id, name: 'My variation', author: 'Tester', html: modified, asset: { path: 'images/a.png', data: Buffer.from([1, 2, 3]).toString('base64') } });
    assert.equal(variationResponse.status, 201); const variation = await variationResponse.json();
    assert.equal(variation.parentId, 'story');
    const failed = await request(`/api/landings/${variation.id}/build`, { partnerId: partner.id, action: 'https://example.com', values: {} }); assert.equal(failed.status, 400);
    const archiveResponse = await request(`/api/landings/${variation.id}/build`, { partnerId: partner.id, action: 'https://example.com/submit', values: { campaign: '123' } });
    assert.equal(archiveResponse.status, 200); assert.equal(archiveResponse.headers.get('content-type'), 'application/zip');
    const files = unzip(Buffer.from(await archiveResponse.arrayBuffer()));
    assert.ok(Buffer.from(files['index.html'], 'base64').toString().includes('name="offer" value="123"'));
    assert.equal(files['images/a.png'], Buffer.from([1, 2, 3]).toString('base64'));
    const imported = await request('/api/landings', { name: 'Imported', archive: zip({ 'wrapped/index.html': source.files['index.html'], 'wrapped/assets/main.css': Buffer.from('body{color:red}').toString('base64') }).toString('base64') }); assert.equal(imported.status, 201);
    const preview = await request(`/preview/${variation.id}/index.html`); assert.ok(preview.headers.get('content-security-policy').includes('sandbox'));
    const forbidden = await fetch(base + '/api/partners', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' }); assert.equal(forbidden.status, 403);
    await stop(); await start();
    catalog = await (await request('/api/catalog')).json();
    assert.equal(catalog.landings.find(l => l.id === 'story').changes, 1);
    assert.equal(catalog.landings.find(l => l.id === variation.id).downloads, 1);
    assert.ok(catalog.partners.some(p => p.id === partner.id));
    const original = await (await request('/api/landings/story')).json(); assert.equal(original.files['index.html'], source.files['index.html']);
  } finally { if (server && server.exitCode === null) await stop(); rmSync(data, { recursive: true, force: true }); }
});
