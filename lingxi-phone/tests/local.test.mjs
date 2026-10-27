import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {Knowledge} from '../../knowledge-workbench/src/service.js';
import {LingxiPhone} from '../service.mjs';
import {LocalDsh} from '../rpc.mjs';
import {TOOLS,READ_ONLY} from '../tools.mjs';
import {active,digest,storeAsset} from '../storage.mjs';

async function fixture(t){
  const home=fs.realpathSync(fs.mkdtempSync(path.join(process.env.DSH_LINGXI_TEST_ROOT||os.tmpdir(),'灵犀 phone ')));
  const secret=Buffer.from('fixture-local-session-secret').toString('base64url'),calls=[];
  const memory={status:()=>({index:{indexed:false},job:null}),update:()=>({status:'running'})};
  const kb=new Knowledge(home,{get:k=>k==='dshKnowledgeLink'?{memory}:undefined});
  const server=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;try{
    const cookie=req.headers.cookie||'',parts=cookie.slice(cookie.indexOf('=')+1).split('.');
    assert.equal(parts[0],'v1');assert.equal(parts[2],createHmac('sha256',Buffer.from(secret,'base64url')).update(parts[1]).digest('base64url'));
    const c=JSON.parse(Buffer.from(parts[1],'base64url'));assert.equal(c.authority,req.headers.host);assert(c.expiresAt>Date.now());
    const p=JSON.parse(body).payload;calls.push({route:req.url,action:p.action});
    const value=req.url==='/knowledge-link/manage'?{memory:memory.status()}:await kb.manage(p);
    res.end(JSON.stringify({result:{ok:true,value}}));
  }catch(e){res.end(JSON.stringify({result:{ok:false,error:{message:e.message}}}))}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const rpc=new LocalDsh(home,{port:server.address().port,secret}),svc=new LingxiPhone(home,rpc);
  t.after(()=>{kb.close();server.closeAllConnections();server.close();fs.rmSync(home,{recursive:true,force:true})});
  return {home,kb,svc,rpc,calls,secret,port:server.address().port};
}
const create=(svc,title,content='本地知识库资料：手机独立工作、电脑可以关机。',extra={})=>svc.call('kb_create',{title,content,quality_check:false,...extra});

test('writes use the real DSH note service, survive cold read and share the original index mirror',async t=>{
  const f=await fixture(t),n=await create(f.svc,'手机独立运行');assert.equal(active(f.home).length,1);
  assert.equal(new LingxiPhone(f.home,f.rpc).call instanceof Function,true);
  const r=await new LingxiPhone(f.home,f.rpc).call('kb_read',{path:n.path});assert.match(r.content,/电脑可以关机/);
  assert.match(fs.readFileSync(path.join(f.kb.notes.mirror,n.id+'.md'),'utf8'),/手机独立运行/);
  assert.deepEqual(fs.readdirSync(path.join(f.home,'knowledge')).sort(),['notes','workbench']);
  assert.deepEqual(f.calls,[{route:'/knowledge-base/manage',action:'save'}]);
});
test('Chinese keyword search, hybrid fallback and source paths are real',async t=>{
  const f=await fixture(t),n=await create(f.svc,'独立运行灵犀');
  const r=await f.svc.call('kb_search',{query:'灵犀',mode:'keyword'});assert.equal(r.count,1);assert.equal(r.items[0].path,n.path);
  const h=await f.svc.call('kb_search',{query:'灵犀'});assert.equal(h.items.length,1);assert.match(h.warnings[0],/关键词/);
  assert.equal((await f.svc.call('kb_search',{query:'未存在的特殊词'})).count,0);
});
test('same-title updates require an explicit current revision; UI edits cannot be overwritten',async t=>{
  const f=await fixture(t),n=await create(f.svc,'并发测试');
  assert.equal((await create(f.svc,'并发测试')).unchanged,true);
  await assert.rejects(create(f.svc,'并发测试','另一正文'),/同名/);
  await create(f.svc,'并发测试','修改的正文',{path:n.path,revision:n.revision});
  const old=fs.readFileSync(f.kb.notes.store.file);
  await assert.rejects(create(f.svc,'并发测试','过时的写入',{path:n.path,revision:n.revision}),/已变化/);
  assert.equal(digest(old),digest(fs.readFileSync(f.kb.notes.store.file)));
});
test('quality gate, tag type, unsupported kind and pagination reject before writing',async t=>{
  const f=await fixture(t);
  for(const a of [{title:'短',content:'过短'},{title:'标签',content:'短',quality_check:false,tags:['a']},{title:'梦境',content:'短',quality_check:false,note_type:'dream'}])await assert.rejects(f.svc.call('kb_create',a));
  await assert.rejects(f.svc.call('kb_list',{limit:0}));await assert.rejects(f.svc.call('kb_list',{directory:'../'}));assert.equal(active(f.home).length,0);
});
test('body updates preserve omitted existing classification, tags, project and status',async t=>{
  const f=await fixture(t),n=await create(f.svc,'元数据保护','原正文',{note_type:'project',subdir:'手机工程',tags:'保留,原标签',status:'active'});
  await create(f.svc,'元数据保护','新正文',{path:n.path,revision:n.revision});
  const saved=f.kb.notes.read(n.id);assert.equal(saved.kind,'project');assert.equal(saved.project,'手机工程');assert.equal(saved.status,'doing');assert.deepEqual(saved.tags,['保留','原标签']);
});
test('exact mentions covers every note and line, paginates and excludes trash',async t=>{
  const f=await fixture(t),a=await create(f.svc,'甲','needle\nneedle'),b=await create(f.svc,'乙','needle');
  const r=await f.svc.call('kb_mentions',{needle:'needle',limit:1});assert.equal(r.total,2);assert.equal(r.total_lines,3);assert.equal(r.items.length,1);assert.equal(r.complete,true);
  assert.equal((await f.svc.call('kb_mentions',{needle:'needle',offset:1})).items[0].path,b.path);
  await f.kb.manage({action:'trash',id:a.id,revision:1});assert.equal((await f.svc.call('kb_mentions',{needle:'needle'})).total,1);
  await assert.rejects(f.svc.call('kb_read',{path:a.path}),/不存在/);
});
test('uploaded UTF-8 text is immediately visible in the original UI, binary uploads deduplicate',async t=>{
  const f=await fixture(t);const n=await f.svc.call('kb_upload',{filename:'文档.md',content:'# 灵犀\n\n真实中文文档'});
  assert.equal(f.kb.notes.read(n.id).title,'灵犀');
  const a={filename:'小图片.png',content_base64:Buffer.from([1,2,3]).toString('base64')};
  const one=await f.svc.call('kb_upload',a),two=await f.svc.call('kb_upload',a);assert.equal(one.path,two.path);assert.equal(one.indexed,false);assert.deepEqual(fs.readFileSync(one.path),Buffer.from([1,2,3]));
  await assert.rejects(f.svc.call('kb_upload',{filename:'bad.md',content_base64:'/w=='}));
  await assert.rejects(f.svc.call('kb_upload',{filename:'bad.png',content_base64:'!not-base64'}));
});
test('asset traversal and symlink targets are refused without touching the destination',async t=>{
  const f=await fixture(t),outside=path.join(f.home,'outside');fs.mkdirSync(outside);
  assert.throws(()=>storeAsset(f.home,{filename:'a.png',content:'x',target_dir:'../outside'}));
  fs.mkdirSync(path.join(f.home,'storage/lingxi-phone'),{recursive:true});fs.symlinkSync(outside,path.join(f.home,'storage/lingxi-phone/_assets'));
  assert.throws(()=>storeAsset(f.home,{filename:'a.png',content:'x'}),/链接/);assert.deepEqual(fs.readdirSync(outside),[]);
  await assert.rejects(f.svc.call('kb_read',{path:'../../.credentials.yaml'}));
});
test('memory remains explicitly unconfigured; dual search never leaks chat or Noema',async t=>{
  const f=await fixture(t);await create(f.svc,'记忆边界');const r=await f.svc.call('kb_dual_search',{query:'边界'});
  assert.equal(r.memory.configured,false);assert.equal(r.memory.items.length,0);assert.equal(r.knowledge.count,1);
  assert(!f.calls.some(c=>c.route.includes('knowledge-link')));
});
test('ask returns evidence without requesting a model; hygiene and boundary checks never mutate',async t=>{
  const f=await fixture(t);await create(f.svc,'问答证据');const before=fs.readFileSync(f.kb.notes.store.file);
  const r=await f.svc.call('kb_ask',{question:'问答'});assert.equal(r.modelCalled,false);assert.equal(r.sources[0].citation,1);
  assert.equal((await f.svc.call('kb_note_hygiene')).modified,false);
  const b=await f.svc.call('kb_memory_boundary_check',{summary:'以后每次都请优先保留我的原有功能和个人资料，这是长期使用手机时的偏好约定。'});assert.equal(b.suggest_memory_update,true);assert.equal(b.automatic_memory_write,false);
  assert.equal(digest(before),digest(fs.readFileSync(f.kb.notes.store.file)));
});
test('index rebuild reports running and reuses the original DSH service',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.svc.call('kb_index_status'),{index:{indexed:false},job:null});
  assert.equal((await f.svc.call('kb_index_rebuild')).status,'running');assert(f.calls.some(x=>x.action==='index'));
});
test('failed save preserves old data and a subsequent request recovers',async t=>{
  const f=await fixture(t);await create(f.svc,'原笔记');const before=digest(fs.readFileSync(f.kb.notes.store.file));
  const good=f.svc.rpc;f.svc.rpc={manage:async()=>{throw Error('模拟本机服务离线')}};
  await assert.rejects(create(f.svc,'新笔记'),/离线/);assert.equal(digest(fs.readFileSync(f.kb.notes.store.file)),before);
  f.svc.rpc=good;await create(f.svc,'新笔记');assert.equal(active(f.home).length,2);
});
test('corrupt directory, stale revision and cancelled calls fail without rewriting originals',async t=>{
  const f=await fixture(t);const ctrl=new AbortController();ctrl.abort(Error('已取消'));await assert.rejects(f.svc.call('kb_create',{title:'x',content:'y'},ctrl.signal),/取消/);
  await create(f.svc,'损坏前原有笔记');
  fs.writeFileSync(f.kb.notes.store.file,'{broken');await assert.rejects(f.svc.call('kb_list'));assert.equal(fs.readFileSync(f.kb.notes.store.file,'utf8'),'{broken');
});
test('stdio discovery, rejected input and recovery use the actual process',async t=>{
  const f=await fixture(t),child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url)),'--home',f.home],{stdio:['pipe','pipe','pipe']});
  t.after(()=>child.kill());const lines=readline.createInterface({input:child.stdout}),waiting=new Map();let id=0,stderr='';child.stderr.on('data',b=>stderr+=b);
  lines.on('line',line=>{const r=JSON.parse(line);waiting.get(r.id)?.(r);waiting.delete(r.id)});
  const call=(method,params)=>new Promise(resolve=>{const i=++id;waiting.set(i,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:i,method,params})+'\n')});
  const init=await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.result.serverInfo.name,'dsh-lingxi-phone');
  const list=await call('tools/list');assert.equal(list.result.tools.length,15);assert.equal(READ_ONLY.length,11);
  assert.equal((await call('tools/call',{name:'kb_list',arguments:{unknown:true}})).error.code,-32602);
  assert.equal((await call('tools/call',{name:'kb_read',arguments:{path:'../secret'}})).result.isError,true);
  assert.equal((await call('tools/call',{name:'kb_list',arguments:{}})).result.isError,false);assert.equal(stderr,'');
  child.stdin.end();await new Promise(r=>child.once('exit',r));
});
