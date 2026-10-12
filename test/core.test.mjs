import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zip, unzip, safePath, crc32 } from '../lib/archive.mjs';
import { buildLanding, validatePartner } from '../lib/build.mjs';
import { seeds } from '../lib/seeds.mjs';

test('ZIP preserves nested assets, Unicode filenames and binary bytes', () => {
  const files = { 'index.html': Buffer.from('<h1>Привет</h1>').toString('base64'), 'images/картинка.png': Buffer.from([0, 255, 7, 16]).toString('base64') };
  assert.deepEqual({ ...unzip(zip(files)) }, files);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});
test('ZIP rejects corrupted data, traversal and duplicate paths', () => {
  assert.throws(() => unzip(Buffer.from('not a zip')));
  for (const name of ['../escape', '/absolute', 'x/../../escape', 'C:/x', 'x\\y', 'x//y']) assert.throws(() => safePath(name));
  const archive = zip({ 'index.html': Buffer.from('abc').toString('base64') });
  archive[42] ^= 127;
  assert.throws(() => unzip(archive));
});
test('wrapped archives flatten exactly one common root', () => {
  const files = { 'folder/index.html': Buffer.from('hello').toString('base64'), 'folder/assets/a.css': Buffer.from('css').toString('base64') };
  assert.deepEqual(Object.keys(unzip(zip(files))), ['index.html', 'assets/a.css']);
});
test('partner configuration validates unique keys and allows custom form mappings', () => {
  const p = validatePartner({ name: 'Partner', method: 'POST', fields: [{ key: 'offer', label: 'Offer ID', target: 'campaign_id', type: 'text', required: true }] });
  assert.equal(p.fields[0].target, 'campaign_id');
  assert.throws(() => validatePartner({ ...p, fields: [...p.fields, ...p.fields] }));
  assert.throws(() => validatePartner({ ...p, method: 'PUT' }));
});
test('build injects custom fields, escapes values, preserves assets and leaves source intact', () => {
  const l = seeds()[0], original = JSON.stringify(l.files);
  l.files['asset.png'] = Buffer.from([0, 1, 2]).toString('base64');
  const p = { method: 'POST', fields: [{ key: 'offer', target: 'campaign_id', label: 'Offer', type: 'text', required: true }] };
  const built = buildLanding(l, p, { offer: '\"><script>x</script>' }, 'https://example.com/submit?a=1&b=2');
  const html = Buffer.from(built['index.html'], 'base64').toString();
  assert.ok(html.includes('name="campaign_id"'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
  assert.ok(html.includes('https://example.com/submit?a=1&amp;b=2'));
  assert.ok(!html.includes('{{form_'));
  assert.equal(built['asset.png'], l.files['asset.png']);
  assert.equal(l.files['index.html'], JSON.parse(original)['index.html']);
  assert.throws(() => buildLanding(l, p, {}, 'https://example.com'), /Offer/);
  assert.throws(() => buildLanding(l, p, { offer: '1' }, 'javascript:alert(1)'));
});
test('unprepared imports cannot silently produce a broken integration', () => {
  const l = { entry: 'index.html', files: { 'index.html': Buffer.from('<form></form>').toString('base64') } };
  assert.throws(() => buildLanding(l, { fields: [], method: 'POST' }, {}, 'https://example.com'), /не подготовлен/);
});
