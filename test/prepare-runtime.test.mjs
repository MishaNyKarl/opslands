import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { zip } from '../lib/archive.mjs';
import { prepareLanding } from '../lib/prepare.mjs';

test('generated PHP sends both API protocols, checks acceptance and writes protected correlated logs', { skip: !process.env.PHP_PATH }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opslands-php-'));
  const requests = []; let answer = { result: 'ok', localClickId: 'test-lead' }, status = 200;
  const api = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof answer === 'string' ? answer : JSON.stringify(answer));
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const origin = `http://127.0.0.1:${api.address().port}`, port = 44000 + Math.floor(Math.random() * 1000);
  const args = process.env.PHP_EXT_DIR ? ['-d', `extension_dir=${process.env.PHP_EXT_DIR}`, '-d', 'extension=curl'] : [];
  let php;
  const compile = partner => {
    const archive = zip({ 'index.html': Buffer.from('<form><input name="name"><input name="phone"></form>').toString('base64') }).toString('base64');
    const prepared = prepareLanding({ archive, partner, values: { token: 'qa-secret', offer: '123', flow: '456' } });
    for (const [path, value] of Object.entries(prepared.files)) {
      let bytes = Buffer.from(value, 'base64');
      if (path === 'ops-submit.php') bytes = Buffer.from(bytes.toString().replace('https://cashfactories.com/api/wm/push.json', origin + '/cash').replace('https://sendmelead.com/api/v3/lead/add', origin + '/lemon').replace('CURLPROTO_HTTPS', 'CURLPROTO_HTTP'));
      writeFileSync(join(dir, path), bytes);
    }
  };
  try {
    compile('lemonad');
    php = spawn(process.env.PHP_PATH, [...args, '-S', `127.0.0.1:${port}`, '-t', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = ''; php.stderr.on('data', d => diagnostics += d);
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) { try { await fetch(base + '/index.html'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 30)); } }
    assert.ok(ready, diagnostics);
    const submit = () => fetch(base + '/ops-submit.php', { method: 'POST', body: new URLSearchParams({ name: 'QA Name', phone: '1234567890', clickid: 'qa-click', token: 'evil', offer: '999' }), redirect: 'manual' });
    let res = await submit(); assert.equal(res.status, 303, await res.text());
    assert.equal(requests[0].headers['x-token'], 'qa-secret');
    assert.equal(JSON.parse(requests[0].body).offerId, '123');
    answer = { result: 'error' }; assert.equal((await submit()).status, 502);
    answer = {}; assert.equal((await submit()).status, 502);
    answer = 'not JSON'; assert.equal((await submit()).status, 502);
    answer = { result: 'ok' }; status = 500; assert.equal((await submit()).status, 502); status = 200;
    compile('cashfactorie'); answer = { status: 'ok' };
    assert.equal((await submit()).status, 303);
    const cash = requests.at(-1), url = new URL(cash.url, origin);
    assert.equal(url.searchParams.get('id'), 'qa-secret'); assert.equal(url.searchParams.get('offer'), '123');
    assert.equal(new URLSearchParams(cash.body).get('clickid'), 'qa-click');
    assert.equal(new URLSearchParams(cash.body).has('token'), false);
    const before = requests.length;
    assert.equal((await fetch(base + '/ops-submit.php', { method: 'POST', body: new URLSearchParams({ name: 'QA' }) })).status, 422);
    assert.equal(requests.length, before);
    const logName = readdirSync(join(dir, 'ops-logs'))[0], log = readFileSync(join(dir, 'ops-logs', logName), 'utf8');
    assert.equal(await (await fetch(base + '/ops-logs/' + logName)).text(), '');
    assert.equal(await (await fetch(base + '/ops-config.php')).text(), '');
    assert.doesNotMatch(log, /qa-secret|QA Name|1234567890|evil/);
    const events = log.trim().split('\n').slice(1).map(JSON.parse);
    assert.equal(events.filter(e => e.event === 'request').length, 6);
    for (const response of events.filter(e => e.event === 'response')) assert.ok(events.some(e => e.event === 'request' && e.request_id === response.request_id));
    for (const e of events.filter(e => e.event === 'request')) assert.ok(events.some(r => r.event === 'response' && r.request_id === e.request_id));
    assert.equal(await (await fetch(base + '/ops-logs/' + logName)).text(), '');
    assert.equal(await (await fetch(base + '/ops-config.php')).text(), '');
  } finally {
    if (php && php.exitCode === null) { const done = once(php, 'exit'); php.kill(); await done; }
    api.close(); await once(api, 'close'); rmSync(dir, { recursive: true, force: true });
  }
});
