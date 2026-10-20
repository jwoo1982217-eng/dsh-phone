import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneAccount, GRANT_REF, ORIGIN } from './account.js';
import { browserUrl } from './vendor/protocol.js';

function setup(extra={}) {
  const data=new Map();const calls=[];
  const store={get:async k=>data.get(k),set:async(k,v)=>data.set(k,v),remove:async k=>data.delete(k)};
  const account=new PhoneAccount(store,{request:async(origin,method,body)=>{
    calls.push({origin,method,body});
    if(method==='auth_init')return{authorize_url:ORIGIN+'/dsh/authorize?id=test',authorize_id:'test',expires_in:600};
    if(method==='auth_exchange')return{token:'account-test-grant',authorized_url:ORIGIN+'/dsh/authorized',user:{id_profile:{name:'测试账号'},mobile:'13812345678'}};
    if(method==='auth_cancel')return{};
  },revoke:async()=>{},...extra});
  return {account,data,calls};
}
function callback(account, state=account.attempt.state) {
  const url=new URL('http://127.0.0.1:3080/oauth/callback');url.searchParams.set('state',state);url.searchParams.set('code','test-code');return url;
}
test('PKCE login stores an account grant and returns token-free masked status',async()=>{
  const {account,data,calls}=setup();
  await account.login();
  assert.equal(calls[0].body.redirect_uri,'http://127.0.0.1:3080/oauth/callback');
  assert.equal(calls[0].body.code_challenge_method,'S256');
  const result=await account.callback(callback(account));
  assert.equal(result.status,303);assert.equal((await account.status()).signedIn,true);
  assert.equal((await account.status()).profile.contact,'138****5678');
  assert.ok(!JSON.stringify(await account.status()).includes('account-test-grant'));
  assert.ok(data.has(GRANT_REF));account.dispose();
});
test('wrong state, duplicated query and replay never exchange credentials',async()=>{
  const {account,calls}=setup();await account.login();
  assert.equal((await account.callback(callback(account,'wrong'))).status,400);
  const url=callback(account);url.searchParams.append('state',account.attempt.state);
  assert.equal((await account.callback(url)).status,400);
  assert.equal(calls.filter(c=>c.method==='auth_exchange').length,0);
  const accepted=callback(account);assert.equal((await account.callback(accepted)).status,303);
  assert.equal((await account.callback(accepted)).status,410);account.dispose();
});
test('local cancellation refuses a late exchange without saving a grant',async()=>{
  let resolve;const exchange=new Promise(r=>resolve=r);
  const {account,data}=setup({request:async(_,method)=>method==='auth_init'?{authorize_url:ORIGIN+'/dsh/authorize',authorize_id:'test',expires_in:600}:method==='auth_cancel'?{}:exchange});
  await account.login();const pending=account.callback(callback(account));
  await new Promise(r=>setImmediate(r));account.cancel();
  resolve({token:'late-token',authorized_url:ORIGIN+'/dsh/authorized',user:{}});
  assert.equal((await pending).status,410);assert.equal(data.has(GRANT_REF),false);
});
test('cancel during persistence rolls back the grant',async()=>{
  const {account,data}=setup();const original=account.store.set;
  account.store.set=async(k,v)=>{if(k===GRANT_REF)account.cancel();return original(k,v);};
  await account.login();assert.equal((await account.callback(callback(account))).status,410);
  assert.equal(data.has(GRANT_REF),false);
});
test('late HTTP 401 cannot clear a replacement login',async()=>{
  const {account,data}=setup();data.set(GRANT_REF,JSON.stringify({version:1,issuer:ORIGIN,token:'replacement'}));
  await account.rejectToken('older');assert.equal((await account.grant()).token,'replacement');
  await account.rejectToken('replacement');assert.equal(await account.grant(),null);
});
test('account tokens resolve only for the official inference origin',async()=>{
  const {account,data}=setup();data.set(GRANT_REF,JSON.stringify({version:1,issuer:ORIGIN,token:'grant'}));
  assert.equal(await account.token('https://api.deepseek.com'),'grant');
  assert.equal(await account.token('https://attacker.invalid'),null);
  assert.equal(await account.token('https://user@api.deepseek.com'),null);
  data.set(GRANT_REF,JSON.stringify({version:1,issuer:'https://attacker.invalid',token:'grant'}));
  assert.equal(await account.grant(),null);
});
test('browser destinations require the official origin and exact authorization path',()=>{
  assert.throws(()=>browserUrl('https://attacker.invalid/dsh/authorize',ORIGIN,'/dsh/authorize'));
  assert.throws(()=>browserUrl(ORIGIN+'/other',ORIGIN,'/dsh/authorize'));
  assert.throws(()=>browserUrl(ORIGIN+'/dsh/authorize#bad',ORIGIN,'/dsh/authorize'));
});
test('logout clears local account even when remote logout fails',async()=>{
  const {account,data}=setup({revoke:async()=>{throw Error('offline');}});
  data.set(GRANT_REF,JSON.stringify({version:1,issuer:ORIGIN,token:'grant'}));
  assert.equal((await account.logout()).signedIn,false);
});
