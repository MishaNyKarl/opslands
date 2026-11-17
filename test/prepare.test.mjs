import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPreparation, prepareLanding } from '../lib/prepare.mjs';
import { zip } from '../lib/archive.mjs';

const b64 = s => Buffer.from(s).toString('base64');
const text = (files, path) => Buffer.from(files[path], 'base64').toString();
const form = '<form class="lead" action="lemon.php" method="get"><input name="name"><input name="phone"><input type="hidden" name="offer" value="old"><input type="hidden" name="utm_source" value="<?= $_GET[\'utm_source\'];?>"><button>Send</button></form>';
const archive = zip({ 'one/index.php': b64(form), 'one/cash.php': b64('old-secret'), 'one/lemon.php': b64('old-secret'), 'one/log_1.log': b64('private'), 'one/images/p.png': b64('binary'), 'two/index.html': b64(form), '__MACOSX/._file': b64('metadata') }).toString('base64');
const input = { archive, entry: 'one/index.php', partner: 'cashfactorie', values: { token: "test'\\token", offer: '123', flow: '456' } };
test('preparation finds multiple lands, switches every lead form and excludes old handlers/logs', () => {
  assert.deepEqual(inspectPreparation(archive).candidates.map(c => c.entry), ['one/index.php', 'two/index.html']);
  for (const partner of ['cashfactorie', 'lemonad']) {
    const prepared = prepareLanding({ ...input, partner });
    assert.equal(prepared.forms, 1);
    const html = text(prepared.files, 'index.html');
    assert.match(html, /action="ops-submit.php" method="post"/);
    assert.doesNotMatch(html, /<\?|old|name="utm_source"/);
    assert.equal(text(prepared.files, 'images/p.png'), 'binary');
    assert.ok(!Object.keys(prepared.files).some(p => /cash.php|lemon.php|two\/|\.log|MACOSX/.test(p)));
    assert.doesNotMatch(html, /test.*token/);
    const config = text(prepared.files, 'ops-config.php').match(/base64_decode\('([^']+)'/)[1];
    assert.equal(JSON.parse(Buffer.from(config, 'base64')).token, input.values.token);
  }
});
test('preparation rejects invalid routing, unsupported PHP and missing lead forms', () => {
  assert.throws(() => prepareLanding({ ...input, values: { ...input.values, flow: 'invalid' } }), /числами/);
  assert.throws(() => prepareLanding({ ...input, partner: 'unknown' }), /Выберите/);
  assert.throws(() => prepareLanding({ ...input, entry: '../index.php' }), /путь/);
  for (const html of ['<p>No form</p>', '<?php require "secret.php"; ?>' + form, form.replace('class="lead"', 'onsubmit="send()"')]) {
    assert.throws(() => prepareLanding({ ...input, entry: 'index.html', archive: zip({ 'index.html': b64(html) }).toString('base64') }));
  }
});
test('multiple forms preserve layout markup and route to the same handler', () => {
  const prepared = prepareLanding({ ...input, entry: 'index.html', archive: zip({ 'index.html': b64(form + form) }).toString('base64') });
  assert.equal(prepared.forms, 2);
  assert.equal(text(prepared.files, 'index.html').match(/action="ops-submit.php"/g).length, 2);
});
