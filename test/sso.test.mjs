import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ssoStore } from '../lib/sso.mjs';

function fixture(fetcher, enabled = true) {
  const records = new Map([['session:s1', { id: 's1', userId: 'u1' }]]);
  const user = { id: 'u1', role: 'admin', sso: { issuer: 'https://portalwiki.world/sso', subject: 'subject1' } };
  const store = ssoStore({ all: () => [], get: (k, id) => { const value = records.get(`${k}:${id}`); if (!value) throw Error('missing'); return value; }, save: (k,v) => records.set(`${k}:${v.id}`,v), remove: (k,id) => records.delete(`${k}:${id}`), db: {}, auth: {}, env: { SSO_CLIENT_ID:'test', SSO_CLIENT_SECRET:'test-only-secret', SSO_ENCRYPTION_KEY:randomBytes(32).toString('base64url'), SSO_ENABLED: enabled ? '1' : '0' }, fetcher });
  return { store, user, records, req: { opsSession: { id:'s1', mode:'local-linked' } } };
}
test('central role replaces stale local admin, fresh writes bypass cache', async () => {
  let calls = 0, role = 'user';
  const f = fixture(async () => { calls++; return Response.json({ role, valid_for:60 }); });
  assert.equal((await f.store.authorize(f.user,f.req)).role,'member');
  role = 'admin'; await f.store.authorize(f.user,f.req); assert.equal(calls,1);
  assert.equal((await f.store.authorize(f.user,f.req,true)).role,'admin'); assert.equal(calls,2);
});
test('central denial revokes the session and gateoff blocks linked accounts', async () => {
  const f = fixture(async () => new Response('', { status:403 }));
  await assert.rejects(f.store.authorize(f.user,f.req), { status:403 }); assert.equal(f.records.has('session:s1'),false);
  const off = fixture(async () => { throw Error('must not run'); },false);
  await assert.rejects(off.store.authorize(off.user,off.req), { status:403 });
});
test('outage and malformed policy do not authorize, an ended session cannot revive', async () => {
  for (const result of [new Response('',{status:500}), Response.json({role:'OWNER',valid_for:60}), Response.json({role:'admin',valid_for:600})]) {
    const f = fixture(async () => result); await assert.rejects(f.store.authorize(f.user,f.req), { status:503 });
  }
  const f = fixture(async () => Response.json({role:'admin',valid_for:60}));
  f.records.delete('session:s1'); await assert.rejects(f.store.authorize(f.user,f.req), {status:401});
});
