import path from 'node:path';
import {IncomingStorage,validId,leaf,MAX_FILES,MAX_FILE_BYTES} from './storage.mjs';
import {protectedBatch,incomingServices} from './protection.mjs';
export {incomingServices};
export const SEVEN_DAYS=7*24*60*60*1000;
const TYPE='dsh.incoming-workspace/v1';
const states=new Set(['copying','prepared','creating-session','session-created','cancelled','expired']);
function validate(m,id){if(!m||m.type!==TYPE||m.batchId!==id||!states.has(m.state)||m.sessionId!=='session-incoming-'+id||!Number.isSafeInteger(m.createdAt)||m.createdAt<0||!Array.isArray(m.sourcePaths)||m.sourcePaths.length<1||m.sourcePaths.length>MAX_FILES||!m.sourcePaths.every(x=>typeof x==='string'&&path.isAbsolute(x))||!Array.isArray(m.files)||m.files.length>MAX_FILES||!m.files.every(f=>leaf(f.name)&&typeof f.label==='string'&&Number.isSafeInteger(f.size)&&f.size>=0&&f.size<=MAX_FILE_BYTES&&/^[a-f0-9]{64}$/.test(f.sha256)))throw Error('来件清单无效');return m;}
function sourcePaths(input){if(!validId(input?.batchId)||!Array.isArray(input.files)||input.files.length<1||input.files.length>MAX_FILES||new Set(input.files).size!==input.files.length||!input.files.every(x=>typeof x==='string'&&path.isAbsolute(x)&&x.length<=4096))throw Error('来件批次或文件数量无效（独立临时工作区每批最多 16 个文件）');return [...input.files];}
export class IncomingWorkspaceBroker {
 constructor({home,files,services,now=Date.now}){this.storage=new IncomingStorage(home);this.files=files;this.services=services;this.now=now;this.tails=new Map();this.active=new Map();this.operations=0;this.sweeping=null;}
 async run(id,fn){if(!validId(id))throw Error('来件批次 ID 无效');this.operations++;const previous=this.tails.get(id)??Promise.resolve();const next=previous.catch(()=>{}).then(async()=>{await this.sweeping;const control=new AbortController();this.active.set(id,control);try{return await fn(control.signal);}finally{if(this.active.get(id)===control)this.active.delete(id);}});this.tails.set(id,next);try{return await next;}finally{this.operations--;if(this.tails.get(id)===next)this.tails.delete(id);}}
 async read(id){const value=await this.storage.manifest(id);if(value.owner!==this.storage.owner)throw Error('来件清单不属于此模块，未接管或清理');return validate(value,id);}
 async receipt(m){const workspacePath=await this.storage.content(m.batchId);return {mode:'temporary-workspace',batchId:m.batchId,state:m.state,workspacePath,workspaceId:m.workspaceId??null,sessionId:m.state==='session-created'?m.sessionId:null,files:m.state==='expired'?[]:m.files.map(f=>({...f,path:path.join(workspacePath,f.name)})),retention:'七天后仅清理无会话、无工作区登记、无引用的遗留批次；已有会话不自动删除'};}
 async open(input){if(input?.mode==='attach-current')return {mode:'attach-current',useExistingComposer:true};if(input?.mode!=='temporary-workspace')throw Error('请明确选择来件模式');await this.prepare(input);return this.commit(input.batchId);}
 async prepare(input){const sources=sourcePaths(input);return this.run(input.batchId,async signal=>{
  let m;try{m=await this.read(input.batchId);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(m){if(JSON.stringify(m.sourcePaths)!==JSON.stringify(sources))throw Error('同一来件批次的文件已变化，请重新分享');if(m.state==='cancelled'||m.state==='expired')throw Error('此来件批次已取消或过期，请重新分享');if(m.state==='session-created')return this.receipt(m);}
  else{signal.throwIfAborted();await this.storage.batch(input.batchId,true);await this.storage.content(input.batchId,true);m={type:TYPE,owner:this.storage.owner,batchId:input.batchId,createdAt:this.now(),state:'copying',sourcePaths:sources,sessionId:'session-incoming-'+input.batchId,files:[]};await this.storage.save(input.batchId,m);}
  for(let index=0;index<sources.length;index++){
   signal.throwIfAborted();const opened=await this.files.openFile(sources[index]);try{const {meta,stat,handle}=opened;if(!leaf(meta.name)||!Number.isSafeInteger(meta.size)||meta.size<0||meta.size>MAX_FILE_BYTES||meta.size!==stat.size||!/^[a-f0-9]{64}$/.test(meta.sha256))throw Error('来件源文件校验失败');
    const previous=m.files[index],name=previous?.name??(String(index+1).padStart(2,'0')+'-'+meta.name),entry={name,label:meta.name,size:meta.size,sha256:meta.sha256};
    // Existing upload names are bounded to 220 UTF-8 bytes; a three-byte ordinal preserves them.
    if(!leaf(name))throw Error('来件文件名过长，请先重命名后分享');if(previous&&JSON.stringify(previous)!==JSON.stringify(entry))throw Error('来件源文件已变化');
    await this.storage.copy(input.batchId,index,{...entry,handle},signal);m.files[index]=entry;await this.storage.save(input.batchId,m);
   }finally{await opened.handle.close();}
  }
  signal.throwIfAborted();m.state='prepared';await this.storage.save(input.batchId,m);return this.receipt(m);
 });}
 async commit(id){return this.run(id,async signal=>{const m=await this.read(id);if(m.state==='cancelled'||m.state==='expired')throw Error('此来件批次已取消或过期');if(m.state==='session-created')return this.receipt(m);if(m.files.length!==m.sourcePaths.length||!['prepared','creating-session'].includes(m.state))throw Error('来件尚未完整复制，请重试');
  const directory=await this.storage.content(id),existing=await this.services.findSession(m.sessionId);if(existing&&existing.cwd!==directory)throw Error('来件会话路径冲突，未修改已有会话');if(!existing)for(const file of m.files)await this.storage.verify(id,file);
  signal.throwIfAborted();m.state='creating-session';await this.storage.save(id,m);const workspace=await this.services.ensureWorkspace(directory,'临时来件 '+id.slice(0,8));if(!workspace?.id||workspace.path!==directory)throw Error('临时工作区登记未完成');m.workspaceId=String(workspace.id);await this.storage.save(id,m);signal.throwIfAborted();
  const result=await this.services.createSession({workspaceId:m.workspaceId,sessionId:m.sessionId});if(result?.sessionId!==m.sessionId)throw Error('未得到预期的独立会话');m.state='session-created';await this.storage.save(id,m);return this.receipt(m);
 });}
 async cancel(id){this.active.get(id)?.abort(Error('来件操作已取消'));return this.run(id,async()=>{const m=await this.read(id);if(m.state!=='session-created'&&m.state!=='expired'){m.state='cancelled';await this.storage.save(id,m);}return this.receipt(m);});}
 async status(id){return this.run(id,async()=>this.receipt(await this.read(id)));}
 async sweep(){if(this.sweeping||this.operations)return {removed:0,skipped:'incoming-in-flight'};const task=this.sweepOnce();this.sweeping=task;try{return await task;}finally{if(this.sweeping===task)this.sweeping=null;}}
 async sweepOnce(){const result={removed:0,retained:[]};
  let entries;try{entries=(await this.storage.entries()).filter(validId);}catch{return {...result,skipped:'storage-unavailable'};}
  if(!entries.length)return result;
  let snapshot;try{snapshot=await this.services.protection();}catch{return {...result,skipped:'protection-unavailable'};}if(snapshot.active)return {...result,skipped:'active-work'};
  for(const id of entries){
   if(!validId(id))continue;
   try{const m=await this.read(id);if(m.state==='expired'||this.now()-m.createdAt<SEVEN_DAYS)continue;const dir=await this.storage.content(id),protection=protectedBatch(m,dir,snapshot);if(protection){result.retained.push({batchId:id,reason:protection});continue;}if(!await this.storage.removable(id,m)){result.retained.push({batchId:id,reason:'user-changes'});continue;}
    // Recheck after slow hashes/log reads; a new incoming operation also stops this sweep.
    snapshot=await this.services.protection();const refreshed=protectedBatch(m,dir,snapshot);if(this.operations||refreshed){result.retained.push({batchId:id,reason:refreshed??'incoming-in-flight'});continue;}
    await this.storage.removeFiles(id,m);m.state='expired';await this.storage.save(id,m);result.removed++;
   }catch{result.retained.push({batchId:id,reason:'unreadable-or-changed'});}
  }return result;
 }
}
