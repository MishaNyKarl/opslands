import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
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
    assert.equal((await request('/api/auth/setup', { name: 'Tester', login: 'tester', password: 'test-password' })).status, 201);
    let catalog = await (await request('/api/catalog')).json(); assert.equal(catalog.landings.length, 3);
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
