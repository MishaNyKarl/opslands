import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { adaptationStore, adaptationDocument, applyAdaptation, cleanText } from '../lib/adapt.mjs';
import { zip, unzip } from '../lib/archive.mjs';

const b64 = s => Buffer.from(s).toString('base64');
const html = '<!doctype html><html lang="ru"><title>История</title><body><h1>Анна <b>дома</b> сегодня</h1><img src="images/a.png" srcset="old.png 2x" data-src="old.png" alt="Портрет"><script>const token="private-script-token";</script><form action="old.php"><input name="name" placeholder="Имя"><input name="phone" placeholder="Телефон"><input type="hidden" name="token" value="private-hidden-token"><button>Отправить</button></form><p>+7 999 123 45 67</p><p>api_key=private-visible-token</p></body></html>';
const archive = zip({ 'index.html': b64(html), 'images/a.png': b64('original-image'), 'old.php': b64('private-php-token'), 'logs/customer.log': b64('private-personal-log'), '.env': b64('private-env-token') }).toString('base64');
const input = { archive, entry: 'index.html', partner: 'cashfactorie', country: 'Испания', language: 'es', prompt: 'Переведи на испанский и назови героиню Мария', budgetUsd: 0.3, images: [] };
const user = { id: 'u1' }, other = { id: 'u2' };
function fixture({ env = {}, fetcher } = {}) {
  const records = new Map([['user:u1', user], ['user:u2', other]]), calls = [];
  const db = {
    all: kind => [...records.entries()].filter(([k]) => k.startsWith(`${kind}:`)).map(([, v]) => structuredClone(v)),
    get: (kind, id) => { const v = records.get(`${kind}:${id}`); if (!v) throw new Error('Запись не найдена'); return structuredClone(v); },
    save: (kind, value) => records.set(`${kind}:${value.id}`, structuredClone(value)),
    remove: (kind, id) => records.delete(`${kind}:${id}`)
  };
  const defaultFetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ url, body });
    if (url.endsWith('/endpoints')) return Response.json({ endpoints: [{ provider_tag: 'seed', pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }] }] });
    if (url.endsWith('/images')) return Response.json({ data: [{ b64_json: Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64') }], usage: { cost: 0.04 } });
    const data = JSON.parse(body.messages[1].content);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ texts: data.texts.map(t => ({ ...t, text: `ES ${t.text}` })) }) } }], usage: { cost: 0.001 } });
  };
  const options = { ...db, env: { OPENROUTER_API_KEY: 'mock-key-never-used-online', ...env }, fetcher: fetcher || defaultFetch };
  const store = adaptationStore(options);
  return { store, db, options, calls };
}
async function completed(store, id) {
  for (let i = 0; i < 100; i++) { const j = store.status(user, id); if (!['queued', 'running'].includes(j.state)) return j; await delay(10); }
  throw new Error('Job timeout');
}

test('AI allowlist excludes executable code, hidden credentials, contacts and logs; patches escape markup and preserve whitespace/forms', async () => {
  const { store, calls } = fixture();
  try {
    const job = await store.create(user, { ...input, images: ['i0'] });
    assert.equal((await completed(store, job.id)).state, 'ready');
    const sent = JSON.stringify(calls);
    assert.doesNotMatch(sent, /private-|999 123|old\.php|ops-config|original-image|name=|<form/);
    assert.match(sent, /json_schema/);
    assert.deepEqual(calls.find(c => c.url.endsWith('/images')).body.provider.only, ['seed']);
    const files = store.files(user, job.id), result = Buffer.from(files['index.html'], 'base64').toString();
    assert.match(result, /ES Анна <b>ES дома<\/b> ES сегодня/);
    assert.match(result, /lang="es"/); assert.match(result, /action="ops-submit.php" method="post"/);
    assert.doesNotMatch(result, /srcset=/); assert.match(result, /data-src="ops-ai-/);
    assert.equal(files['images/a.png'], b64('original-image'));
    assert.ok(!files['ops-config.php']); assert.ok(!files['old.php']);
    assert.throws(() => store.files(other, job.id), /не найдено/);
    assert.equal(store.list(other).length, 0);
    const downloaded = unzip(store.download(user, job.id, { values: { token: 'download-only-secret', offer: '123', flow: '456' } }));
    const config = Buffer.from(downloaded['ops-config.php'], 'base64').toString();
    assert.match(config, /base64_decode/);
    const params = JSON.parse(Buffer.from(config.match(/base64_decode\('([^']+)'/)[1], 'base64'));
    assert.equal(params.token, 'download-only-secret');
    assert.doesNotMatch(JSON.stringify(store.files(user, job.id)), /download-only-secret/);
    assert.equal(Buffer.from(downloaded['index.html'], 'base64').toString().match(/src="ops-tracking.js"/g).length, 1);
    assert.throws(() => store.download(user, job.id, { values: {} }), /Заполните/);
  } finally { store.close(); }
  const view = adaptationDocument({ 'index.html': b64(html) });
  const text = applyAdaptation(view, view.fields.map(t => ({ id: t.id, text: '<img src=x onerror=alert(1)>' })), 'es');
  assert.match(text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(cleanText('token=secret'), '');
});

test('budget and configured models are validated before paid calls; daily reservations survive restart', async () => {
  const { store, calls, options } = fixture({ env: { OPSLANDS_AI_DAILY_USD: '0.1' } });
  try {
    await assert.rejects(store.create(user, { ...input, budgetUsd: 0.001 }), /Резерв/);
    await assert.rejects(store.create(user, { ...input, textModel: 'unapproved/model' }), /не разрешена/);
    await assert.rejects(store.create(user, { ...input, prompt: 'token=secret' }), /без секретов/);
    assert.equal(calls.length, 0);
    const job = await store.create(user, input); await completed(store, job.id);
    store.close(); const restarted = adaptationStore(options);
    try { await assert.rejects(restarted.create(other, input), /Суточный лимит/); } finally { restarted.close(); }
  } finally { store.close(); }
});

test('malformed/truncated provider responses fail closed with no retry or image spend', async () => {
  for (const content of ['not JSON', JSON.stringify({ texts: [] })]) {
    let calls = 0;
    const { store } = fixture({ fetcher: async url => {
      if (url.endsWith('/endpoints')) return Response.json({ endpoints: [{ provider_tag: 'seed', pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }] }] });
      calls++; return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
    } });
    try {
      const job = await store.create(user, { ...input, images: ['i0'] });
      assert.equal((await completed(store, job.id)).state, 'failed'); assert.equal(calls, 1);
      assert.throws(() => store.files(user, job.id), /не готов/);
    } finally { store.close(); }
  }
});

test('unknown/token-based image pricing refuses generation', async () => {
  const { store } = fixture({ fetcher: async () => Response.json({ endpoints: [{ provider_tag: 'google', pricing: [{ billable: 'output_image', unit: 'token', cost_usd: 0.00003 }] }] }) });
  try { await assert.rejects(store.create(user, { ...input, images: ['i0'] }), /фиксированной ценой/); } finally { store.close(); }
});

test('cancellation aborts a running request, prevents publication and retains reservation', async () => {
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const { store } = fixture({ fetcher: async (url, { signal }) => { started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
  try {
    const job = await store.create(user, input); await start;
    await assert.rejects(store.create(user, input), /активное задание/);
    assert.throws(() => store.cancel(other, job.id), /не найдено/);
    store.cancel(user, job.id);
    const cancelled = await completed(store, job.id);
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.reservedUsd, job.reservedUsd);
    assert.throws(() => store.files(user, job.id), /не готов/);
  } finally { store.close(); }
});

test('restart interrupts pending jobs without repeating generation and expires ready artifacts', () => {
  const { store, db, options, calls } = fixture(); store.close();
  const base = { id: 'interrupted', ownerId: user.id, state: 'running', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10000).toISOString(), reservedUsd: 0.1 };
  db.save('adaptation', base);
  db.save('adaptation', { ...base, id: 'old', state: 'ready', expiresAt: new Date(Date.now() - 10000).toISOString(), files: { 'index.html': b64('private-result') } });
  const restarted = adaptationStore(options);
  try {
    assert.equal(restarted.status(user, base.id).state, 'failed');
    assert.equal(restarted.status(user, 'old').state, 'expired');
    assert.ok(!db.get('adaptation', 'old').files); assert.equal(calls.length, 0);
  } finally { restarted.close(); }
});
