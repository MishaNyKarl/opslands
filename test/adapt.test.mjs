import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { adaptationStore, adaptationDocument, applyAdaptation, cleanText } from '../lib/adapt.mjs';
import sharp from 'sharp';
import { zip, unzip } from '../lib/archive.mjs';

const pixel = (await sharp({create:{width:2,height:2,channels:3,background:'#445566'}}).png().toBuffer()).toString('base64');
const generatedPixel = (await sharp({create:{width:3,height:3,channels:3,background:'#889900'}}).png().toBuffer()).toString('base64');
const b64 = s => Buffer.from(s).toString('base64');
const html = '<!doctype html><html lang="ru"><title>История</title><body><h1>Анна <b>дома</b> сегодня</h1><img src="images/a.png" srcset="images/a.png 2x" data-src="images/a.png" alt="Портрет"><script>const token="private-script-token";</script><form action="old.php"><input name="name" placeholder="Имя"><input name="phone" placeholder="Телефон"><input type="hidden" name="token" value="private-hidden-token"><button>Отправить</button></form><p>+7 999 123 45 67</p><p>api_key=private-visible-token</p></body></html>';
const archive = zip({ 'index.html': b64(html), 'images/a.png': pixel, 'old.php': b64('private-php-token'), 'logs/customer.log': b64('private-personal-log'), '.env': b64('private-env-token') }).toString('base64');
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
    if (url.endsWith('/endpoints')) return Response.json({ endpoints: [{ provider_tag: 'seed', supported_parameters: { input_references: { max: 1 } }, pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }] }] });
    if (url.endsWith('/images')) return Response.json({ data: [{ b64_json: generatedPixel }], usage: { cost: 0.04 } });
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
    assert.match(result, /srcset="images\/a.png 2x"/); assert.match(result, /data-src="images\/a.png"/);
    assert.notEqual(files['images/a.png'], pixel); assert.equal((await sharp(Buffer.from(files['images/a.png'], 'base64')).metadata()).width, 2);
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
  const { store, calls, options } = fixture({ env: { OPSLANDS_AI_DAILY_USD: '0.06' } });
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
      if (url.endsWith('/endpoints')) return Response.json({ endpoints: [{ provider_tag: 'seed', supported_parameters: { input_references: { max: 1 } }, pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }] }] });
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

test('adaptation can remove an inline claim while requiring every id and rejecting an empty page', () => {
  const view = adaptationDocument({ 'index.html': b64('<html><h1>Better <b>forever</b>!</h1><p>Read more</p></html>') });
  const translated = view.fields.map(field => ({ id: field.id, text: field.text === 'forever' ? '' : field.text }));
  assert.match(applyAdaptation(view, translated, 'en-GB'), /Better <b><\/b>!/);
  assert.throws(() => applyAdaptation(view, translated.slice(1), 'en-GB'), /неполный/);
  assert.throws(() => applyAdaptation(view, translated.map(t => ({ ...t, text: '' })), 'en-GB'), /пустую страницу/);
});

test('a charged response rejected by validation still reports known cost without leaking its content', async () => {
  const { store } = fixture({ fetcher: async (url, options) => {
    const texts = JSON.parse(JSON.parse(options.body).messages[1].content).texts;
    texts[0].text = 'api_key=do-not-publish';
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ texts }) } }], usage: { cost: 0.003 } });
  } });
  try {
    const job = await store.create(user, input), status = await completed(store, job.id);
    assert.equal(status.state, 'failed'); assert.equal(status.costUsd, 0.003);
    assert.match(status.error, /t0:.*признаки/); assert.doesNotMatch(status.error, /do-not-publish/);
  } finally { store.close(); }
});

test('alternate model choices and tiered fixed image prices reserve reference charges while stripping reference metadata', async () => {
  const imageRequests = [];
  const { store } = fixture({ fetcher: async (url, options) => {
    if (url.endsWith('/endpoints')) return Response.json({ endpoints: [{ provider_tag: 'sourceful', supported_parameters: { input_references: { max: 1 } }, pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.02 }, { billable: 'output_image', unit: 'image', cost_usd: 0.04, variant: '2k' }, { billable: 'input_font', unit: 'image', cost_usd: 0.03 }, { billable: 'input_reference', unit: 'image', cost_usd: 0.2 }] }] });
    const body = JSON.parse(options.body);
    if (url.endsWith('/images')) { imageRequests.push(body); return Response.json({ data: [{ b64_json: generatedPixel }] }); }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ texts: JSON.parse(body.messages[1].content).texts }) } }] });
  } });
  try {
    assert.ok(store.config().textModels.includes('deepseek/deepseek-v3.2'));
    const job = await store.create(user, { ...input, textModel: 'qwen/qwen3-235b-a22b-2507', imageModel: 'sourceful/riverflow-v2-fast', images: ['i0'], budgetUsd: 0.5 });
    assert.equal((await completed(store, job.id)).state, 'ready'); assert.equal(imageRequests.length, 1);
    assert.equal(imageRequests[0].input_references.length, 1); assert.ok(!imageRequests[0].font_inputs);
    assert.ok(job.reservedUsd >= 0.26 && job.reservedUsd <= 0.5);
  } finally { store.close(); }
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
