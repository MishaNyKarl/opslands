import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import * as oidc from 'openid-client';
import { authStore } from '../lib/auth.mjs';
import { ssoStore } from '../lib/sso.mjs';
const issuer = 'https://portalwiki.world/sso';
const response = () => ({ headers: new Map(), setHeader(k,v){this.headers.set(k,v);},getHeader(k){return this.headers.get(k);} });
function cookie(res,name){ return [].concat(res.getHeader('Set-Cookie')).find(v=>v.startsWith(name+'=')).split(';')[0]; }
async function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE records(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id))');
  const all = k => db.prepare('SELECT payload FROM records WHERE kind=?').all(k).map(r=>JSON.parse(r.payload));
  const get = (k,id) => { const r=db.prepare('SELECT payload FROM records WHERE kind=? AND id=?').get(k,id);if(!r)throw Error('missing');return JSON.parse(r.payload); };
  const save=(k,v)=>db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(k,v.id,JSON.stringify(v));
  const remove=(k,id)=>db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(k,id);
  const auth=authStore({all,get,save,remove,db});
  const user=await auth.createUser({name:'Existing',login:'existing',password:'original-password',role:'admin'});save('user',user);
  const localRes=response();auth.begin(localRes,user,{mode:'local'});
  const req={headers:{cookie:cookie(localRes,'opslands_session')}};auth.current(req,response());
  save('landing',{id:'owned',ownerId:user.id});
  const env={SSO_CLIENT_ID:'test-client',SSO_CLIENT_SECRET:'test-secret',SSO_ENCRYPTION_KEY:randomBytes(32).toString('base64url'),SSO_ENABLED:'1',SSO_LINK_USERS:user.id,SSO_EMERGENCY_USERS:user.id,SSO_REDIRECT_URI:'https://app.example/auth/opsvault/callback'};
  const {publicKey,privateKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey);jwk.kid='test-key';jwk.alg='RS256';
  const subject=randomUUID(), api={nonce:null,badNonce:false,publishFailure:false,published:null,sidMismatch:false,role:'user',credentialCalls:0};
  const config=new oidc.Configuration({issuer,authorization_endpoint:issuer+'/authorize/',token_endpoint:issuer+'/token/',jwks_uri:issuer+'/jwks',authorization_response_iss_parameter_supported:true},env.SSO_CLIENT_ID,{id_token_signed_response_alg:'RS256'},oidc.ClientSecretBasic(env.SSO_CLIENT_SECRET));
  config[oidc.customFetch]=async url=> {
    if(String(url).endsWith('/jwks')) return Response.json({keys:[jwk]});
    const signingKey=api.badSignature?(await generateKeyPair('RS256')).privateKey:privateKey;
    const token=await new SignJWT({nonce:api.badNonce?'wrong':api.nonce,sid:'sid1',name:'Central User',...(api.badAtHash?{at_hash:'wrong'}:{})}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setSubject(subject).setAudience(api.badAudience?'another-client':env.SSO_CLIENT_ID).setIssuedAt().setExpirationTime('5m').sign(signingKey);
    return Response.json({access_token:'access',token_type:'Bearer',expires_in:300,id_token:token});
  };
  oidc.enableNonRepudiationChecks(config);
  const fetcher=async(url,options)=> {
    const body=JSON.parse(options.body);
    if(url.endsWith('/session/'))return Response.json({issuer,subject,sid:api.sidMismatch?'wrong':'sid1',lease_token:'lease-secret',role:api.role,expires_at:Date.now()/1000+3600});
    if(url.endsWith('/access/')||url.endsWith('/local-access/'))return Response.json({role:api.role,valid_for:60});
    if(url.endsWith('/credentials/')){api.credentialCalls++; if(api.publishFailure)return new Response('',{status:500});api.published=body;return Response.json({saved:true,credential_id:1,credential_url:'/vault/accounts/1/'});}
    if(url.endsWith('/credentials/read/'))return Response.json(api.published?{found:true,local_user_id:api.published.local_user_id,username:api.published.username,password:api.published.password}:{found:false});
    throw Error('unknown endpoint');
  };
  const sso=ssoStore({all,get,save,remove,db,auth,env,fetcher,configure:async()=>config});
  async function begin(link=true){const res=response();const redirect=await sso.begin(req,res,link?user:null,link?{password:'original-password',consent:true}:undefined);const url=new URL(redirect);api.nonce=url.searchParams.get('nonce');req.headers.cookie=cookie(localRes,'opslands_session')+'; '+cookie(res,'opslands_oidc');return new URL(env.SSO_REDIRECT_URI+'?code=code&state='+url.searchParams.get('state')+'&iss='+encodeURIComponent(issuer));}
  return {db,all,get,save,remove,auth,sso,env,user,req,api,begin,subject};
}
test('explicit link verifies OIDC, preserves owner/hash, publishes before commit and reuses identity',async()=>{
  const f=await fixture();try{
    const url=await f.begin();assert.equal(await f.sso.callback(f.req,response(),url,f.user),'/?opsvault=pending');
    assert.equal(f.get('user',f.user.id).sso,undefined);
    await assert.rejects(f.sso.callback(f.req,response(),url,f.user));
    const pending=await f.sso.pending(f.req,f.user);assert.equal(pending.opsvaultName,'Central User');assert.equal(pending.password,undefined);
    const res=response();await f.sso.confirm(f.req,res,f.user);
    const linked=f.get('user',f.user.id);assert.equal(linked.id,f.user.id);assert.equal(linked.hash,f.user.hash);assert.equal(f.get('landing','owned').ownerId,f.user.id);
    assert.equal(f.api.published.password,'original-password');assert.equal(f.api.published.local_user_id,f.user.id);
    assert.equal(f.all('session').length,1);assert.equal(f.all('session')[0].mode,'oidc');assert.ok(!JSON.stringify(f.all('session')).includes('lease-secret'));
    assert.equal(f.all('sso-pending').length,0);
    const second=await f.begin(false);await f.sso.callback(f.req,response(),second,null);assert.equal(f.all('user').length,1);assert.equal(f.api.credentialCalls,1);
  }finally{f.db.close();}
});
test('wrong nonce/sid/state and failed publication never link the existing account',async()=>{
  for(const condition of ['badNonce','badSignature','badAudience','badAtHash','sidMismatch','state','publishFailure']){
    const f=await fixture();try{
      let url=await f.begin();if(condition==='state')url.searchParams.set('state','wrong');else f.api[condition]=true;
      if(condition==='publishFailure'){await f.sso.callback(f.req,response(),url,f.user);await assert.rejects(f.sso.confirm(f.req,response(),f.user));}
      else await assert.rejects(f.sso.callback(f.req,response(),url,f.user));
      assert.equal(f.get('user',f.user.id).sso,undefined);assert.equal(f.get('user',f.user.id).hash,f.user.hash);
    }finally{f.db.close();}
  }
});
test('JIT recovery reuses canonical ID/login/password and never merges a username collision',async()=>{
  const f=await fixture();try{
    f.env.SSO_JIT='1';
    await f.sso.callback(f.req,response(),await f.begin(false),null);
    const id=f.api.published.local_user_id, username=f.api.published.username,password=f.api.published.password;
    f.remove('user',id); // Simulate a local DB rollback after successful publication.
    await f.sso.callback(f.req,response(),await f.begin(false),null);
    const recovered=f.get('user',id);assert.equal(recovered.login,username);assert.ok(await f.auth.checkPassword(recovered,password));
    assert.equal(f.api.published.local_user_id,id);assert.equal(f.api.published.password,password);
    f.remove('user',id);const unrelated={...recovered,id:randomUUID(),sso:undefined};f.save('user',unrelated);
    await assert.rejects(f.sso.callback(f.req,response(),await f.begin(false),null));
    assert.equal(f.get('user',unrelated.id).sso,undefined);
  }finally{f.db.close();}
});
test('JIT is closed for an existing-data pilot; bad local password and absent consent fail',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.sso.begin(f.req,response(),f.user,{password:'wrong',consent:true}));
    await assert.rejects(f.sso.begin(f.req,response(),f.user,{password:'original-password',consent:false}));
    const url=await f.begin(false);await assert.rejects(f.sso.callback(f.req,response(),url,null));assert.equal(f.all('user').length,1);
  }finally{f.db.close();}
});
