import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
const lib = new URL('../vendor/dsh-codearts-auth/lib/',import.meta.url);
const { createDirectFetch, attachDirectFetch, directFetch } = await import(new URL('direct-fetch.js',lib));
const { signRequestHuawei } = await import(new URL('sign.js',lib));
const { CodeArtsAdapter } = await import(new URL('llm-adapter.js',lib));
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = await import(new URL('../node_modules/undici/index.js',lib));
const server = handler => new Promise(resolve => { const s=http.createServer(handler);s.listen(0,'127.0.0.1',()=>resolve(s)); });
test('actual signed bytes survive poisoned global fetch and global dispatcher, Request body/abort/disposal remain scoped',async()=>{
 let calls=0, requests=0;const original=globalThis.fetch;
 const previousDispatcher=getGlobalDispatcher(),poisoned=new MockAgent();poisoned.disableNetConnect();setGlobalDispatcher(poisoned);
 const network=createDirectFetch({environment:{}});
 const s=await server(async(req,res)=>{ requests++;let body='';for await(const c of req)body+=c;const a=req.headers.authorization;const keys=/SignedHeaders=([^,]+)/.exec(a)[1].split(';');const payload=createHash('sha256').update(body).digest('hex');const lines=keys.map(k=>`${k}:${req.headers[k]}`);const canonical=[req.method,'/fixture/','',lines.join('\n'),' ',keys.join(';'),payload];canonical[4]='';const h=createHash('sha256').update(canonical.join('\n')).digest('hex');const expected=createHmac('sha256','FIXTURE-SK').update(`SDK-HMAC-SHA256\n${req.headers['x-sdk-date']}\n${h}`).digest('hex');assert.equal(/Signature=(.+)$/.exec(a)[1],expected);res.end(body); });
 try{
  globalThis.fetch=()=>{calls++;throw Error('poisoned global fetch');};
  const url=`http://127.0.0.1:${s.address().port}/fixture`,body='中文签名 hello';
  const headers=await signRequestHuawei('FIXTURE-AK','FIXTURE-SK','FIXTURE-TOKEN','POST',url,new TextEncoder().encode(body));
  const request=new Request(url,{method:'POST',headers:Object.fromEntries(headers),body});
  const adapter=new CodeArtsAdapter({credentialRef:'FIXTURE',resolveCredential:async()=>undefined,refresh:async()=>{}});
  const release=attachDirectFetch(network.fetch);
  try { assert.equal(await(await adapter.fetchImpl(request.clone())).text(),body); } finally {release();}
  assert.equal(requests,1);
  assert.equal(await(await network.fetch(request)).text(),body);assert.equal(calls,0);assert.equal(requests,2);
  const abort=new AbortController();abort.abort();await assert.rejects(network.fetch(url,{signal:abort.signal}));assert.equal(requests,2);
  await network.close();await network.close();await assert.rejects(network.fetch(url));assert.equal(calls,0);
 }finally{globalThis.fetch=original;setGlobalDispatcher(previousDispatcher);await poisoned.close();await network.close();await new Promise(r=>s.close(r));}
});
test('binding ownership does not let late disposal remove the newer transport',async()=>{
 const a=attachDirectFetch(async()=>new Response('old'));const b=attachDirectFetch(async()=>new Response('new'));a();assert.equal(await(await directFetch('http://fixture.invalid')).text(),'new');b();
});
test('old unsigned outlet is rejected rather than silently bypassed; signed outlet receives the owned sender',async()=>{
 let unsigned=0,signed=0;const old=createDirectFetch({environment:{},outlet:{active:()=>true,fetch:async()=>{unsigned++;return new Response('wrong');}}});
 try{await assert.rejects(old.fetch('https://fixture.invalid'),/渠道网络请求失败/);assert.equal(unsigned,0);}finally{await old.close();}
 const network=createDirectFetch({environment:{},fetchImpl:async()=>new Response('fixture'),outlet:{active:()=>true,fetch:async()=>{throw Error('unsigned');},fetchSigned:async(input,init,send)=>{signed++;assert.equal(init.redirect,'error');return send(input,init);}}});
 try{assert.equal(await(await network.fetch('https://fixture.invalid')).text(),'fixture');assert.equal(signed,1);}finally{await network.close();}
});
