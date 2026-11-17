import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { setTimeout as delay } from 'node:timers/promises';
import { adaptationStore, adaptationDocument } from '../lib/adapt.mjs';
import { textPlan } from '../lib/adapt-planning.mjs';
import { zip } from '../lib/archive.mjs';

const b64 = s => Buffer.from(s).toString('base64');
const pixel = (await sharp({ create: { width: 6, height: 4, channels: 3, background: '#335544' } }).withMetadata({ exif: { IFD0: { Copyright: 'private-exif-metadata' } } }).jpeg().toBuffer()).toString('base64');
const generated = (await sharp({ create: { width: 10, height: 10, channels: 3, background: '#998855' } }).png().toBuffer()).toString('base64');
const form = '<form><input name="name"><input name="phone"><button>Send</button></form>';
const user = { id: 'owner' };
function fixture(extra = {}) {
  const rows = new Map([['user:owner', user]]), calls = [];
  const store = adaptationStore({
    all: kind => [...rows.entries()].filter(([key]) => key.startsWith(kind + ':')).map(([, value]) => structuredClone(value)),
    get: (kind, id) => { const value = rows.get(kind + ':' + id); if (!value) throw new Error('Missing record'); return structuredClone(value); },
    save: (kind, value) => rows.set(kind + ':' + value.id, structuredClone(value)), remove: (kind, id) => rows.delete(kind + ':' + id),
    env: { OPENROUTER_API_KEY: 'mock-only', OPSLANDS_AI_MAX_JOB_USD: '2', ...extra.env },
    fetcher: async (url, options) => {
      const body = options.body && JSON.parse(options.body); calls.push({ url, body });
      if (url.endsWith('/endpoints')) return Response.json({ endpoints: [{ provider_tag: 'seed', supported_parameters: { input_references: { max: 1 } }, pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }] }] });
      if (url.endsWith('/images')) return Response.json({ data: [{ b64_json: generated }], usage: { cost: 0.04 } });
      const value = body.response_format.json_schema.name === 'adaptation_locale' ? extra.locale || { country: 'Turkey', language: 'tr' } : { texts: JSON.parse(body.messages[1].content).texts.map(t => ({ ...t, text: 'TR ' + t.text })) };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { cost: 0.001 } });
    }
  });
  const input = { partner: 'lemonad', entry: 'index.html', prompt: 'Для Турции на турецком. Адаптируй страницу.', budgetUsd: 2 };
  return { store, calls, input };
}
async function finish(store, id) {
  for (let n = 0; n < 500; n++) { const status = store.status(user, id); if (!['queued', 'running'].includes(status.state)) return status; await delay(10); }
  throw new Error('Timed out');
}

test('country and language come from prompt; a page over the old fragment/byte limits is adapted in bounded chunks', async () => {
  const { store, calls, input } = fixture();
  try {
    const archive = zip({ 'index.html': b64(`<html lang="ru">${'<p>История героя и его привычки.</p>'.repeat(1700)}${form}</html>`) }).toString('base64');
    const inspected = await store.inspect({ ...input, archive });
    assert.ok(inspected.diagnostics.fragments > 1500); assert.ok(inspected.diagnostics.textBytes > 36000); assert.equal(inspected.diagnostics.canAdaptText, true); assert.ok(inspected.diagnostics.batches > 1);
    assert.equal(calls.length, 0, 'Inspection must not invoke a paid model');
    const job = await store.create(user, { ...input, archive }); const done = await finish(store, job.id);
    assert.equal(done.state, 'ready', done.error); assert.equal(done.country, 'Turkey'); assert.equal(done.language, 'tr');
    const textCalls = calls.filter(c => c.body?.response_format?.json_schema.name === 'landing_translation');
    assert.equal(textCalls.length, inspected.diagnostics.batches);
    for (const call of textCalls) { const payload = JSON.parse(call.body.messages[1].content); assert.equal(payload.language, 'tr'); assert.ok(payload.texts.length <= 100); assert.ok(Buffer.byteLength(JSON.stringify(payload.texts)) <= 10000); }
    const html = Buffer.from(store.files(user, job.id)['index.html'], 'base64').toString();
    assert.match(html, /lang="tr"/); assert.equal((html.match(/TR История/g) || []).length, 1700);
    assert.equal(done.costUsd, 0.001 * (textCalls.length + 1));
  } finally { store.close(); }
});

test('inventory separates index/img/picture/srcset/CSS images from other archive images and never fetches external URLs', async () => {
  const { store, calls, input } = fixture();
  try {
    const archive = zip({ 'index.html': b64(`<html><link rel="stylesheet" href="css/site.css"><img src="hero.jpg" srcset="retina.jpg 2x"><picture><source srcset="picture.jpg"><img src="hero.jpg"></picture><div style="background:url(inline.jpg)"></div><img src="https://private.invalid/remote.jpg">${form}</html>`), 'hero.jpg': pixel, 'retina.jpg': pixel, 'picture.jpg': pixel, 'inline.jpg': pixel, 'css/site.css': b64('@import "more.css"; body{background:url(../background.jpg)}'), 'css/more.css': b64('.x{background:url(../imported.jpg)}'), 'background.jpg': pixel, 'imported.jpg': pixel, 'unused.jpg': pixel, 'icon.svg': b64('<svg/>') }).toString('base64');
    const result = await store.inspect({ ...input, archive });
    assert.deepEqual(result.images.filter(i => i.used).map(i => i.path).sort(), ['background.jpg', 'hero.jpg', 'imported.jpg', 'inline.jpg', 'picture.jpg', 'retina.jpg']);
    assert.deepEqual(result.images.filter(i => !i.used).map(i => i.path).sort(), ['icon.svg', 'unused.jpg']);
    assert.equal(result.images.filter(i => i.path === 'hero.jpg').length, 1); assert.equal(result.diagnostics.externalImages, 1); assert.equal(calls.length, 0);
    assert.equal(result.images.find(i => i.path === 'icon.svg').supported, false);
  } finally { store.close(); }
});

test('image-only operation edits used and unused files from stripped references, preserving formats, dimensions, HTML and paths', async () => {
  const { store, calls, input } = fixture();
  try {
    const archive = zip({ 'index.html': b64(`<html lang="en"><h1>Original</h1><img src="hero.jpg">${form}</html>`), 'hero.jpg': pixel, 'unused.jpg': pixel }).toString('base64');
    const inspected = await store.inspect({ ...input, archive });
    const job = await store.create(user, { ...input, archive, mode: 'images', images: inspected.images.map(i => i.id) });
    const done = await finish(store, job.id); assert.equal(done.state, 'ready', done.error);
    const files = store.files(user, job.id), html = Buffer.from(files['index.html'], 'base64').toString();
    assert.match(html, /<h1>Original<\/h1>/); assert.match(html, /lang="en"/); assert.match(html, /src="hero.jpg"/);
    assert.equal(calls.filter(c => c.body?.response_format?.json_schema.name === 'landing_translation').length, 0);
    const images = calls.filter(c => c.url.endsWith('/images')); assert.equal(images.length, 2);
    for (const image of images) {
      const bytes = Buffer.from(image.body.input_references[0].image_url.url.split(',')[1], 'base64');
      assert.equal((await sharp(bytes).metadata()).exif, undefined); assert.doesNotMatch(JSON.stringify(image.body), /private-exif-metadata/);
    }
    for (const path of ['hero.jpg', 'unused.jpg']) { const meta = await sharp(Buffer.from(files[path], 'base64')).metadata(); assert.equal(meta.format, 'jpeg'); assert.equal(meta.width, 6); assert.equal(meta.height, 4); assert.notEqual(files[path], pixel); }
  } finally { store.close(); }
});

test('inspection explains the actual oversize cause while still allowing image-only jobs', async () => {
  const { store, calls, input } = fixture();
  try {
    const archive = zip({ 'index.html': b64('<html>' + '<p>Text</p>'.repeat(20001) + form + '</html>'), 'unused.jpg': pixel }).toString('base64');
    const result = await store.inspect({ ...input, archive }); assert.equal(result.diagnostics.canAdaptText, false);
    assert.match(result.diagnostics.issues.join(), /20002.*20000/);
    await assert.rejects(store.create(user, { ...input, archive }), /index.html.*20002.*20000/);
    assert.equal(calls.length, 0);
    const job = await store.create(user, { ...input, archive, mode: 'images', images: result.images.map(i => i.id) }); assert.equal((await finish(store, job.id)).state, 'ready');
  } finally { store.close(); }
});

test('long individual text nodes are split without losing ids, and an ambiguous prompt stops before translation', async () => {
  const fields = [{ id: 't0', text: 'длинное предложение '.repeat(1500) }], plan = textPlan(fields);
  assert.ok(plan.batches.length > 1); assert.ok(plan.groups.get('t0').length > 1);
  for (const batch of plan.batches) assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 10000);
  const { store, calls, input } = fixture({ locale: { country: '', language: '' } });
  try {
    const archive = zip({ 'index.html': b64(`<h1>Welcome</h1>${form}`) }).toString('base64');
    const job = await store.create(user, { ...input, archive }); const done = await finish(store, job.id);
    assert.equal(done.state, 'failed'); assert.match(done.error, /В промпте/); assert.equal(done.costUsd, 0.001); assert.equal(calls.length, 1);
  } finally { store.close(); }
});

test('a vector disguised as JPEG is rejected before any paid request', async () => {
  const { store, calls, input } = fixture();
  try {
    const archive = zip({ 'index.html': b64(`<h1>Welcome</h1><img src="fake.jpg">${form}`), 'fake.jpg': b64('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>') }).toString('base64');
    const inspected = await store.inspect({ ...input, archive }); assert.equal(inspected.images[0].supported, false);
    await assert.rejects(store.create(user, { ...input, archive, mode: 'images', images: [inspected.images[0].id] }), /fake.jpg.*статичный/);
    assert.equal(calls.filter(c => c.body).length, 0);
  } finally { store.close(); }
});

test('image requests combine common instructions and only their own individual note, without requiring a landing prompt', async () => {
  const { store, calls, input } = fixture();
  try {
    const archive = zip({ 'index.html': b64(`<h1>Welcome</h1><img src="hero.jpg">${form}`), 'hero.jpg': pixel, 'unused.jpg': pixel }).toString('base64');
    const inspected = await store.inspect({ ...input, archive }), ids = inspected.images.map(i => i.id);
    const job = await store.create(user, { ...input, archive, prompt: '', mode: 'images', images: ids, imagePrompt: 'Для Турции. Все картинки: теплый свет и единый стиль.', imagePrompts: { [ids[0]]: 'Первый файл: сохранить одежду героя.', [ids[1]]: 'Второй файл: заменить фон на побережье.' } });
    assert.equal((await finish(store, job.id)).state, 'ready');
    const requests = calls.filter(call => call.url.endsWith('/images'));
    assert.equal(requests.length, 2);
    for (const request of requests) assert.match(request.body.prompt, /теплый свет и единый стиль/);
    assert.match(requests[0].body.prompt, /сохранить одежду героя/); assert.doesNotMatch(requests[0].body.prompt, /заменить фон на побережье/);
    assert.match(requests[1].body.prompt, /заменить фон на побережье/); assert.doesNotMatch(requests[1].body.prompt, /сохранить одежду героя/);
    assert.match(requests[0].body.prompt, /take precedence/);
    assert.match(JSON.parse(calls.find(c => c.body?.response_format).body.messages[1].content).request, /Для Турции/);
  } finally { store.close(); }
});

test('image prompt validation rejects secrets, oversized notes and notes for unselected files before any model request', async () => {
  const { store, calls, input } = fixture();
  try {
    const archive = zip({ 'index.html': b64(`<img src="hero.jpg">${form}`), 'hero.jpg': pixel }).toString('base64');
    const id = (await store.inspect({ ...input, archive })).images[0].id;
    const base = { ...input, archive, mode: 'images', images: [id] };
    await assert.rejects(store.create(user, { ...base, imagePrompt: 'api_key=do-not-transmit' }), /Общий промпт.*секреты/);
    await assert.rejects(store.create(user, { ...base, imagePrompts: { [id]: 'x'.repeat(2001) } }), /hero.jpg.*2001.*2000/);
    await assert.rejects(store.create(user, { ...base, imagePrompts: { unrelated: 'Change this' } }), /только для выбранных/);
    assert.equal(calls.length, 0);
  } finally { store.close(); }
});

test('a half-dollar job is allowed by a half-dollar server ceiling while higher user limits are rejected', async () => {
  const { store, input } = fixture({ env: { OPSLANDS_AI_MAX_JOB_USD: '0.50', OPSLANDS_AI_DAILY_USD: '0.50' } });
  try {
    assert.equal(store.config().maxJobUsd, 0.5); assert.equal(store.config().dailyUsd, 0.5);
    const archive = zip({ 'index.html': b64(`<h1>Hello</h1>${form}`) }).toString('base64');
    await assert.rejects(store.create(user, { ...input, archive, budgetUsd: 0.51 }), /максимум сервера \$0.5/);
    const job = await store.create(user, { ...input, archive, budgetUsd: 0.5 }); assert.equal((await finish(store, job.id)).state, 'ready');
  } finally { store.close(); }
});
