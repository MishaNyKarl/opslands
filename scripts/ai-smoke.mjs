// Opt-in paid smoke check with synthetic data only. Never loads a key from disk.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { adaptationStore } from '../lib/adapt.mjs';
import { zip, unzip } from '../lib/archive.mjs';

if (!process.env.OPENROUTER_API_KEY) throw new Error('Set OPENROUTER_API_KEY in the server process environment');
const records = new Map(), user = { id: 'synthetic-smoke-user' };
records.set('user:' + user.id, user);
const store = adaptationStore({
  all: kind => [...records.entries()].filter(([key]) => key.startsWith(kind + ':')).map(([, value]) => structuredClone(value)),
  get: (kind, id) => { const record = records.get(kind + ':' + id); if (!record) throw new Error('Missing smoke record'); return structuredClone(record); },
  save: (kind, record) => records.set(kind + ':' + record.id, structuredClone(record)),
  remove: (kind, id) => records.delete(kind + ':' + id),
  env: { ...process.env, OPSLANDS_AI_MAX_JOB_USD: '0.15', OPSLANDS_AI_DAILY_USD: '0.15' }
});
try {
  const html = '<!doctype html><html lang="en"><title>Welcome</title><body><h1>Anna at home</h1><img src="hero.png" alt="A friendly woman at home"><form><input name="name" placeholder="Name"><input name="phone" placeholder="Phone"><button>Contact me</button></form></body></html>';
  const job = await store.create(user, { archive: zip({ 'index.html': Buffer.from(html).toString('base64') }).toString('base64'), entry: 'index.html', partner: 'lemonad', country: 'Spain', language: 'es', prompt: 'Translate into Spanish. Rename Anna to Maria. If generating an illustration, show a fictional friendly adult woman at home.', budgetUsd: 0.15, images: process.env.AI_SMOKE_IMAGES === '1' ? ['i0'] : [] });
  console.log(JSON.stringify({ state: job.state, reservedUsd: job.reservedUsd, textModel: job.textModel, imageModel: job.imageModel }));
  for (let attempt = 0; attempt < 245; attempt++) {
    const result = store.status(user, job.id);
    if (!['queued', 'running'].includes(result.state)) {
      console.log(JSON.stringify({ state: result.state, costUsd: result.costUsd, error: result.error }));
      assert.equal(result.state, 'ready', result.error);
      const files = unzip(store.download(user, job.id, { values: { token: 'synthetic-not-a-real-token', offer: '1' } }));
      assert.match(Buffer.from(files['index.html'], 'base64').toString(), /lang="es"/);
      assert.ok(files['ops-submit.php']);
      if (process.env.AI_SMOKE_IMAGES === '1') assert.ok(Object.keys(files).some(p => /^ops-ai-.*\.(png|jpg|webp)$/.test(p)));
      console.log('Live AI smoke passed; synthetic ZIP, form handler and image references verified.');
      break;
    }
    if (attempt === 244) throw new Error('Smoke timeout; no automatic retry');
    await delay(1000);
  }
} finally { store.close(); }
