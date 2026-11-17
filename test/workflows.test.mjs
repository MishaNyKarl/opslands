import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { workflowStore } from '../lib/workflows.mjs';
import { adaptationStore } from '../lib/adapt.mjs';
import { prepareLanding } from '../lib/prepare.mjs';
import { zip, unzip } from '../lib/archive.mjs';

const user = { id: 'owner', name: 'Owner' }, b64 = s => Buffer.from(s).toString('base64');
const input = { name: 'История.zip', archive: zip({ 'index.php': b64('<html lang="ru"><h1>Анна дома</h1><form action="old.php"><input name="name"><input name="phone"><input type="hidden" name="token" value="old-secret"><button>Отправить</button></form></html>'), 'old.php': b64('old-secret'), 'logs/one.log': b64('private-log'), 'image.png': b64('asset') }).toString('base64'), partner: 'lemonad', entry: 'index.php', values: { token: 'live-secret', offer: '1' } };
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE records (kind TEXT, id TEXT, payload TEXT, PRIMARY KEY(kind,id))');
  const storage = {
    db,
    all: kind => db.prepare('SELECT payload FROM records WHERE kind=?').all(kind).map(r => JSON.parse(r.payload)),
    get: (kind, id) => { const row = db.prepare('SELECT payload FROM records WHERE kind=? AND id=?').get(kind, id); if (!row) throw new Error('Запись не найдена'); return JSON.parse(row.payload); },
    save: (kind, record) => db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(kind, record.id, JSON.stringify(record)),
    remove: (kind, id) => db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id)
  };
  storage.save('user', user); return storage;
}
test('preparation saves a private original and linked result without credentials; repeated downloads do not duplicate versions', () => {
  const storage = fixture(), workflows = workflowStore(storage);
  try {
    const prepared = prepareLanding(input), saved = workflows.prepared(user, prepared, input), source = storage.get('landing', saved.parentId);
    assert.equal(source.workflow.kind, 'source'); assert.equal(saved.workflow.kind, 'prepared'); assert.equal(saved.workflow.sourceId, source.id);
    assert.equal(source.isGlobal, false); assert.equal(saved.isGlobal, false);
    assert.equal(source.files['image.png'], b64('asset')); assert.ok(!source.files['old.php']);
    assert.doesNotMatch(Buffer.from(source.files['index.html'], 'base64').toString(), /old-secret/);
    assert.match(Buffer.from(source.files['index.html'], 'base64').toString(), /action="old.php"/);
    assert.match(Buffer.from(saved.files['index.html'], 'base64').toString(), /action="ops-submit.php"/);
    assert.ok(!saved.files['ops-config.php']); assert.ok(!source.files['ops-config.php']);
    const repeat = workflows.prepared(user, prepareLanding({ ...input, values: { token: 'another-secret', offer: '2' } }), input);
    assert.equal(saved.id, repeat.id); assert.equal(repeat.downloads, 2); assert.equal(storage.all('landing').length, 2);
    const downloaded = unzip(workflows.download(saved, input.values)); assert.ok(downloaded['ops-config.php']);
    assert.ok(!JSON.stringify(storage.all('landing')).includes(b64('live-secret')));
  } finally { storage.db.close(); }
});

test('AI publishes original and adapted versions before download; library survives temporary result expiry', async () => {
  const storage = fixture(), workflows = workflowStore(storage);
  const store = adaptationStore({ ...storage, env: { OPENROUTER_API_KEY: 'mock' }, onSource: workflows.source, onResult: workflows.adapted, fetcher: async (url, options) => {
    const payload = JSON.parse(options.body), data = JSON.parse(payload.messages[1].content);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ texts: data.texts.map(t => ({ id: t.id, text: 'ES ' + t.text })) }) } }], usage: { cost: 0.001 } });
  } });
  try {
    const job = await store.create(user, { ...input, country: 'Испания', language: 'es', prompt: 'Переведи на испанский', budgetUsd: 0.3 });
    assert.ok(job.sourceLandingId);
    let status;
    for (let i = 0; i < 100; i++) { status = store.status(user, job.id); if (status.state === 'ready') break; await delay(10); }
    assert.equal(status.state, 'ready'); assert.ok(status.resultLandingId);
    assert.equal(storage.all('landing').length, 2);
    const adapted = storage.get('landing', status.resultLandingId);
    assert.equal(adapted.parentId, job.sourceLandingId); assert.equal(adapted.workflow.kind, 'adapted');
    assert.match(Buffer.from(adapted.files['index.html'], 'base64').toString(), /ES Анна/);
    assert.doesNotMatch(Buffer.from(storage.get('landing', job.sourceLandingId).files['index.html'], 'base64').toString(), /ES Анна/);
    const record = storage.get('adaptation', job.id); record.expiresAt = new Date(Date.now() - 1000).toISOString(); storage.save('adaptation', record);
    store.list(user); assert.throws(() => store.files(user, job.id), /не готов/);
    assert.ok(unzip(workflows.download(adapted, input.values))['ops-config.php']);
    assert.equal(storage.all('landing').length, 2);
  } finally { store.close(); storage.db.close(); }
});

test('previous ready jobs are imported once without inventing a missing original', () => {
  const storage = fixture(), workflows = workflowStore(storage);
  try {
    storage.save('adaptation', { id: 'legacy', ownerId: user.id, state: 'ready', partner: 'lemonad', country: 'Spain', language: 'es', files: { 'index.html': b64('<h1>Hola</h1><form><input name="name"><input name="phone"></form>') } });
    workflows.recover(); workflows.recover();
    assert.equal(storage.all('landing').length, 1);
    assert.equal(storage.all('landing')[0].workflow.originalMissing, true);
    assert.ok(storage.get('adaptation', 'legacy').resultLandingId);
  } finally { storage.db.close(); }
});
