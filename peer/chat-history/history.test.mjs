import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChatHistory,applyChatHistory} from './index.mjs';

function fixture() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-delete-'));
  const state={headers:[{id:'a',cwd:home},{id:'b',cwd:home}],running:new Set(),deleted:new Set(),revisions:new Map([['a',1],['b',1]]),live:new Map(),failDecode:false,failLease:false};
  const log=(id,text)=>{const file=path.join(home,'sessions/project',id,'session.v3.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
  const object=h=>{const file=path.join(home,'attachments/v1/objects',h);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'disposable');return file;};
  const ctx={
    sessionController:{markPermanentlyDeleted:ids=>ids.forEach(id=>state.deleted.add(id)),list:async()=>({items:state.headers.filter(h=>!state.deleted.has(h.id)).map(h=>({sessionId:h.id,cwd:h.cwd,running:state.running.has(h.id)}))}),deletionLease:async ids=>{if(state.failLease||ids.some(id=>state.running.has(id)))throw Error('lease target running');return ()=>{};}},
    sessionPersistence:{list:async()=>state.headers.map(header=>({header})),stat:async id=>({revision:state.revisions.get(id)}),preparePermanentDeletion:async()=>{},decodeDeletionLog:buffer=>{if(state.failDecode&&buffer.toString().includes('broken'))throw Error('retained log incomplete');return buffer.toString();},removePermanently:async header=>{fs.rmSync(path.join(home,'sessions/project',header.id),{recursive:true,force:true});state.headers=state.headers.filter(h=>h.id!==header.id);state.live.delete(header.id);}},
    sessionProjectionCache:{removePermanently:async()=>{}},sessionQuery:{forgetPermanently:async()=>{}},workspaceRegistry:{forgetPermanently:async()=>{}},sessions:{list:()=>[...state.live].map(([id,events])=>({id,snapshotEvents:()=>events}))},emit:()=>{}
  };
  const manager=new ChatHistory(ctx,home);
  return {home,state,ctx,manager,log,object,done:()=>fs.rmSync(home,{recursive:true,force:true})};
}
const scoped=(name,run)=>test(name,async()=>{const f=fixture();try{await run(f);}finally{f.done();}});
const erase=async(f,id='a')=>{const preview=await f.manager.preview({scope:'session',sessionId:id});return f.manager.remove({token:preview.token});};

scoped('idle target deletes during another task; attachment GC waits and survives restart',async f=>{
  const exclusive='a'.repeat(64),shared='b'.repeat(64);f.log('a',exclusive+' '+shared);f.log('b',shared);const x=f.object(exclusive),s=f.object(shared);f.state.running.add('b');
  const result=await erase(f);assert.equal(result.deleted,1);assert.equal(result.cleanupPending,true);assert.ok(!f.state.headers.some(h=>h.id==='a'));assert.ok(fs.existsSync(x));assert.ok(fs.existsSync(s));
  f.manager=new ChatHistory(f.ctx,f.home);assert.equal((await f.manager.status()).pending,1);await f.manager.retry();assert.ok(fs.existsSync(x));f.state.running.clear();await f.manager.retry();assert.ok(!fs.existsSync(x));assert.ok(fs.existsSync(s));assert.equal((await f.manager.status()).pending,0);
});
scoped('running target or selected descendant is rejected before deletion',async f=>{
  f.state.headers[1].parentSession='a';f.state.running.add('b');await assert.rejects(()=>erase(f),/关联子聊天正在运行/);assert.equal(f.state.deleted.size,0);assert.equal(f.state.headers.length,2);
});
scoped('unrelated partially written log is not decoded while its task is running',async f=>{
  const h='c'.repeat(64);f.log('a',h);f.log('b','broken');f.state.failDecode=true;f.state.running.add('b');f.object(h);assert.equal((await erase(f)).cleanupPending,true);
});
scoped('unchanged child selection tolerates different persistence listing order',async f=>{
  f.state.headers[1].parentSession='a';f.log('a','a');f.log('b','b');const p=await f.manager.preview({scope:'session',sessionId:'a'});f.state.headers.reverse();assert.equal((await f.manager.remove({token:p.token})).deleted,2);
});
scoped('real content revision change requires new confirmation',async f=>{
  const p=await f.manager.preview({scope:'session',sessionId:'a'});f.state.revisions.set('a',2);await assert.rejects(()=>f.manager.remove({token:p.token}),/已变化/);assert.equal(f.state.deleted.size,0);
});
scoped('target becoming busy after preview is rejected by lease',async f=>{
  const p=await f.manager.preview({scope:'session',sessionId:'a'});f.state.failLease=true;await assert.rejects(()=>f.manager.remove({token:p.token}),/lease target running/);assert.equal(f.state.deleted.size,0);
});
scoped('failed retained-log scan keeps durable GC candidates after target logs are gone',async f=>{
  const h='d'.repeat(64);f.log('a',h);f.log('b','broken');f.state.failDecode=true;const file=f.object(h);await assert.rejects(()=>erase(f),/retained log incomplete/);assert.ok(fs.existsSync(file));assert.ok(!fs.existsSync(path.join(f.home,'sessions/project/a')));
  f.state.failDecode=false;f.manager=new ChatHistory(f.ctx,f.home);await f.manager.retry();assert.ok(!fs.existsSync(file));assert.equal((await f.manager.status()).pending,0);
});
scoped('unflushed live events and QQ historical generations protect shared attachments',async f=>{
  const live='e'.repeat(64),qq='f'.repeat(64);f.log('a',live+' '+qq);const l=f.object(live),q=f.object(qq);f.state.live.set('b',[{data:live}]);const backup=path.join(f.home,'sessions-backup-old-account/project/qq-preserved/session.v2.jsonl');fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,qq);await erase(f);assert.ok(fs.existsSync(l));assert.ok(fs.existsSync(q));
});
scoped('idle event drains durable deferred cleanup through the registered service',async f=>{
  const h='9'.repeat(64);f.log('a',h);const file=f.object(h);f.state.running.add('b');await erase(f);assert.ok(fs.existsSync(file));
  let listener;const env=process.env.DSH_HOME;process.env.DSH_HOME=f.home;
  try{const c={...f.ctx,on:(_event,handler)=>listener=handler,effect:fn=>fn(),connection:{rpc:{handle:()=>{}}},webServer:{register:()=>()=>{}}};applyChatHistory({inject:(_deps,fn)=>fn(c)});listener({status:'running'});await new Promise(resolve=>setImmediate(resolve));assert.ok(fs.existsSync(file));f.state.running.clear();listener({status:'idle'});await new Promise(resolve=>setImmediate(resolve));assert.ok(!fs.existsSync(file));}
  finally{if(env===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=env;}
});
