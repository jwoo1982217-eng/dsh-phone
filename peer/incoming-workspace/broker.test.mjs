import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm,mkdir,symlink,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {ChatFiles} from '../chat-files/index.mjs';
import {IncomingWorkspaceBroker,SEVEN_DAYS} from './index.mjs';
const batch = n => n.toString(16).padStart(32,'0');
async function fixture(t){
 const home=await mkdtemp(path.join(tmpdir(),'dsh-incoming-workspace-')),files=new ChatFiles(home),state={now:1000000,headers:[],rows:[],workspaces:[],events:[],creates:[],failCreate:false,failFlush:false,protectionFailure:false};
 const services={
  async ensureWorkspace(directory,title){let value=state.workspaces.find(x=>x.path===directory);if(!value){value={id:'workspace-'+state.workspaces.length,path:directory,title,sessionIds:[]};state.workspaces.push(value);}return value;},
  async createSession(input){state.creates.push(input);if(state.failCreate)throw Error('fixture create failed');if(!state.headers.some(h=>h.id===input.sessionId)){state.headers.push({id:input.sessionId,cwd:state.workspaces.find(w=>w.id===input.workspaceId).path});}if(state.failFlush)throw Error('fixture flush failed');return {sessionId:input.sessionId};},
  async findSession(id){return state.headers.find(x=>x.id===id);},
  async protection(){if(state.protectionFailure)throw Error('fixture unreadable log');return {headers:state.headers,pinnedIds:[],active:state.rows.some(x=>x.running),workspaces:state.workspaces,events:state.events};}
 };
 const broker=new IncomingWorkspaceBroker({home,files,services,now:()=>state.now});
 t.after(()=>rm(home,{recursive:true,force:true}));
 const upload=(name='文档 空格.txt',value='synthetic file bytes')=>files.upload(Readable.from([Buffer.from(value)]),name);
 return {home,files,broker,state,services,upload};
}
test('explicit temporary handoff copies verified originals and creates a distinct blank idempotent session without submitting a prompt',async t=>{
 const f=await fixture(t),a=await f.upload(),b=await f.upload('文档 空格.txt','second');
 const result=await f.broker.open({batchId:batch(1),mode:'temporary-workspace',files:[a.path,b.path]});
 assert.equal(result.state,'session-created');assert.equal(result.sessionId,'session-incoming-'+batch(1));assert.equal(result.files.length,2);
 assert.notEqual(result.files[0].path,result.files[1].path);assert.equal(await readFile(result.files[0].path,'utf8'),'synthetic file bytes');assert.equal(await readFile(a.path,'utf8'),'synthetic file bytes');
 const again=await f.broker.open({batchId:batch(1),mode:'temporary-workspace',files:[a.path,b.path]});assert.deepEqual(again,result);assert.equal(f.state.headers.length,1);assert.equal(f.state.creates.length,1);
});
test('attach-current remains an explicit no-copy compatibility result and unknown mode never silently creates sessions',async t=>{
 const f=await fixture(t),a=await f.upload();const result=await f.broker.open({batchId:batch(2),mode:'attach-current',files:[a.path]});assert.equal(result.mode,'attach-current');assert.equal(f.state.headers.length,0);
 await assert.rejects(f.broker.open({batchId:batch(2),files:[a.path]}),/模式|mode/);assert.equal(f.state.workspaces.length,0);
});
test('same ticket cannot adopt changed files and concurrent retries share one copy and session',async t=>{
 const f=await fixture(t),a=await f.upload(),b=await f.upload('other.txt');const input={batchId:batch(3),mode:'temporary-workspace',files:[a.path]};
 const results=await Promise.all([f.broker.open(input),f.broker.open(input)]);assert.deepEqual(results[0],results[1]);assert.equal(f.state.headers.length,1);
 await assert.rejects(f.broker.open({...input,files:[b.path]}),/变化|不同/);
});
test('failed session creation or durability barrier retries the same identity without copying or sending again',async t=>{
 const f=await fixture(t),a=await f.upload(),input={batchId:batch(4),mode:'temporary-workspace',files:[a.path]};f.state.failCreate=true;await assert.rejects(f.broker.open(input),/create failed/);
 f.state.failCreate=false;f.state.failFlush=true;await assert.rejects(f.broker.open(input),/flush failed/);assert.equal(f.state.headers.length,1);
 f.state.failFlush=false;const result=await f.broker.open(input);assert.equal(f.state.headers.length,1);assert.equal(new Set(f.state.creates.map(x=>x.sessionId)).size,1);assert.equal(result.state,'session-created');
});
test('source mutation, symlink and arbitrary paths are rejected without touching original files',async t=>{
 const f=await fixture(t),a=await f.upload();await writeFile(a.path,'changed');await assert.rejects(f.broker.prepare({batchId:batch(5),files:[a.path]}),/校验|变化/);
 const b=await f.upload('linked.txt');await unlink(b.path);const outside=path.join(f.home,'outside');await writeFile(outside,'untouched');await symlink(outside,b.path);await assert.rejects(f.broker.prepare({batchId:batch(6),files:[b.path]}));
 await assert.rejects(f.broker.prepare({batchId:batch(7),files:[outside]}));assert.equal(await readFile(outside,'utf8'),'untouched');assert.equal(f.state.headers.length,0);
});
test('cancelled prepared batches never create sessions and expire only after seven days',async t=>{
 const f=await fixture(t),a=await f.upload(),ready=await f.broker.prepare({batchId:batch(8),files:[a.path]});assert.equal(ready.state,'prepared');await f.broker.cancel(batch(8));
 await assert.rejects(f.broker.commit(batch(8)),/取消/);assert.equal((await f.broker.sweep()).removed,0);f.state.now+=SEVEN_DAYS+1;assert.equal((await f.broker.sweep()).removed,1);
 await assert.rejects(readFile(ready.files[0].path),/ENOENT/);assert.equal(await readFile(a.path,'utf8'),'synthetic file bytes');assert.equal(f.state.headers.length,0);
});
test('durable, pinned, active, referenced and unknown user material are retained; original workspaces are never swept',async t=>{
 const f=await fixture(t),a=await f.upload(),committed=await f.broker.open({batchId:batch(9),mode:'temporary-workspace',files:[a.path]});
 const pending=await f.broker.prepare({batchId:batch(10),files:[a.path]});await f.broker.cancel(batch(10));f.state.events=[{content:'@'+pending.files[0].path}];f.state.now+=SEVEN_DAYS+1;
 assert.equal((await f.broker.sweep()).removed,0);assert.equal(await readFile(committed.files[0].path,'utf8'),'synthetic file bytes');
 f.state.events=[];await writeFile(path.join(pending.workspacePath,'user-added.txt'),'USER MATERIAL');assert.equal((await f.broker.sweep()).removed,0);assert.equal(await readFile(path.join(pending.workspacePath,'user-added.txt'),'utf8'),'USER MATERIAL');
 const ordinary=path.join(f.home,'my-project');await mkdir(ordinary);await writeFile(path.join(ordinary,'file'),'ORIGINAL');await f.broker.sweep();assert.equal(await readFile(path.join(ordinary,'file'),'utf8'),'ORIGINAL');
});
test('cleanup skips any active work or unreadable protection source and resumes safely after failure',async t=>{
 const f=await fixture(t),a=await f.upload(),ready=await f.broker.prepare({batchId:batch(11),files:[a.path]});f.state.now+=SEVEN_DAYS+1;
 f.state.rows=[{running:true}];assert.equal((await f.broker.sweep()).removed,0);f.state.rows=[];f.state.protectionFailure=true;assert.equal((await f.broker.sweep()).removed,0);
 f.state.protectionFailure=false;assert.equal((await f.broker.sweep()).removed,1);await assert.rejects(readFile(ready.files[0].path));
});
test('workspace destination symlink cannot redirect prepare, commit or cleanup outside owned root',async t=>{
 const f=await fixture(t),a=await f.upload(),ready=await f.broker.prepare({batchId:batch(12),files:[a.path]});const outside=path.join(f.home,'outside');await mkdir(outside);await writeFile(path.join(outside,'keep'),'ORIGINAL');
 await rm(ready.workspacePath,{recursive:true});await symlink(outside,ready.workspacePath);await assert.rejects(f.broker.commit(batch(12)),/目录|链接|path/);f.state.now+=SEVEN_DAYS+1;assert.equal((await f.broker.sweep()).removed,0);assert.equal(await readFile(path.join(outside,'keep'),'utf8'),'ORIGINAL');
});
test('cancellation after session creation preserves the session and all copied files',async t=>{
 const f=await fixture(t),a=await f.upload(),result=await f.broker.open({batchId:batch(13),mode:'temporary-workspace',files:[a.path]});
 const cancelled=await f.broker.cancel(batch(13));assert.equal(cancelled.state,'session-created');f.state.now+=SEVEN_DAYS+1;assert.equal((await f.broker.sweep()).removed,0);assert.equal(await readFile(result.files[0].path,'utf8'),'synthetic file bytes');
});
test('long original UTF-8 filename remains attachable in isolated workspace and expiry status stays idempotent',async t=>{
 const f=await fixture(t),a=await f.upload('长'.repeat(72)+'.txt'),prepared=await f.broker.prepare({batchId:batch(14),files:[a.path]});assert.equal(await readFile(prepared.files[0].path,'utf8'),'synthetic file bytes');
 await f.broker.cancel(batch(14));f.state.now+=SEVEN_DAYS+1;assert.equal((await f.broker.sweep()).removed,1);assert.equal((await f.broker.status(batch(14))).state,'expired');assert.equal((await f.broker.cancel(batch(14))).state,'expired');
});
test('in-flight copy cancellation never creates a session and retrying cancelled ticket cannot send later',async t=>{
 const f=await fixture(t),a=await f.upload();let resume,opened;const gate=new Promise(resolve=>opened=resolve),wait=new Promise(resolve=>resume=resolve);const original=f.files.openFile.bind(f.files);
 f.files.openFile=async p=>{const value=await original(p);opened();await wait;return value;};
 const copying=f.broker.prepare({batchId:batch(15),files:[a.path]}),failed=assert.rejects(copying,/取消|abort/i);await gate;const cancelling=f.broker.cancel(batch(15));resume();await failed;assert.equal((await cancelling).state,'cancelled');assert.equal(f.state.headers.length,0);assert.equal(await readFile(a.path,'utf8'),'synthetic file bytes');
});
test('destination appearing during copy is never overwritten by atomic publication',async t=>{
 const f=await fixture(t),a=await f.upload();let resume,started;const copying=new Promise(resolve=>started=resolve),wait=new Promise(resolve=>resume=resolve),original=f.files.openFile.bind(f.files);
 f.files.openFile=async p=>{const value=await original(p);return {...value,handle:{close:()=>value.handle.close(),createReadStream:()=>Readable.from((async function*(){yield Buffer.from('synthetic ');started();await wait;yield Buffer.from('file bytes');})())}};};
 const outcome=f.broker.prepare({batchId:batch(16),files:[a.path]}).then(value=>({ok:true,value}),error=>({ok:false,error}));await copying;const destination=path.join(await f.broker.storage.content(batch(16)),'01-'+a.name);await writeFile(destination,'USER-CREATED-DURING-COPY');resume();const result=await outcome;
 assert.equal(result.ok,false,'a destination collision must fail without replacing it');assert.equal(await readFile(destination,'utf8'),'USER-CREATED-DURING-COPY');
});
test('pre-existing unowned lookalike manifests are never adopted into automatic cleanup',async t=>{
 const f=await fixture(t),id=batch(17),dir=path.join(f.home,'storage/incoming-workspaces',id),content=path.join(dir,'files');await mkdir(content,{recursive:true});const body='PRE-EXISTING USER CONTENT';await writeFile(path.join(content,'original.txt'),body);
 const {createHash}=await import('node:crypto');await writeFile(path.join(dir,'manifest.json'),JSON.stringify({type:'dsh.incoming-workspace/v1',batchId:id,createdAt:0,state:'cancelled',sourcePaths:['/not-an-incoming-upload'],sessionId:'session-incoming-'+id,files:[{name:'original.txt',label:'original.txt',size:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}]}));f.state.now+=SEVEN_DAYS+1;
 assert.equal((await f.broker.sweep()).removed,0);assert.equal(await readFile(path.join(content,'original.txt'),'utf8'),body);
});
