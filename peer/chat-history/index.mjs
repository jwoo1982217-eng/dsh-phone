import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
const qq=id=>String(id).startsWith('qq-');
const logFile=p=>/\/session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(p);
function files(root){if(!fs.existsSync(root))return [];return fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(root,e.name)):e.isFile()?[path.join(root,e.name)]:[]);}
const hashes=value=>value.match(/\b[a-f0-9]{64}\b/g)||[];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ChatHistory {
 constructor(ctx,home){this.ctx=ctx;this.home=home;this.pending=new Map();this.queue=Promise.resolve();this.ledgerFile=path.join(home,'storage/chat-history/deleted.json');this.ledger=fs.existsSync(this.ledgerFile)?JSON.parse(fs.readFileSync(this.ledgerFile)):{deleted:[],pending:[]};ctx.sessionController.markPermanentlyDeleted(this.ledger.deleted);}
 save(){fs.mkdirSync(path.dirname(this.ledgerFile),{recursive:true,mode:0o700});const tmp=this.ledgerFile+'.'+randomUUID();fs.writeFileSync(tmp,JSON.stringify(this.ledger),{mode:0o600});fs.renameSync(tmp,this.ledgerFile);}
 async status(){const {items}=await this.ctx.sessionController.list({});return {items:items.filter(s=>!qq(s.sessionId)),pending:this.ledger.pending.length};}
 async selected(payload){const headers=(await this.ctx.sessionPersistence.list()).map(s=>s.header);const rows=(await this.ctx.sessionController.list({})).items;let selected;
  if(payload.scope==='session')selected=headers.filter(h=>h.id===payload.sessionId&&!qq(h.id));
  else if(payload.scope==='workspace')selected=headers.filter(h=>h.cwd===payload.cwd&&!qq(h.id));
  else if(payload.scope==='all')selected=headers.filter(h=>!qq(h.id));
  else throw Error('删除范围无效');
  const ids=new Set(selected.map(h=>h.id));let changed=true;while(changed){changed=false;for(const h of headers)if(h.parentSession&&ids.has(h.parentSession)&&!ids.has(h.id)&&!qq(h.id)){selected.push(h);ids.add(h.id);changed=true;}}
  if(!selected.length)throw Error('所选范围没有聊天记录');
  if(rows.some(s=>s.running))throw Error('请先停止正在运行的任务，再删除记录');
  const revisions=[];for(const h of selected){const state=await this.ctx.sessionPersistence.stat(h.id);revisions.push([h.id,state.revision]);}
  return {headers:selected,stamp:hash(revisions),scope:payload.scope,sessionId:payload.sessionId,cwd:payload.cwd};
 }
 async preview(payload){const selected=await this.selected(payload),token=randomUUID();this.pending.clear();this.pending.set(token,{...selected,expires:Date.now()+120000});return {token,count:selected.headers.length,description:'永久删除所选聊天的消息、投影和专属附件，以及关联子聊天。项目文件和人设保留。此操作无法撤销。'};}
 async remove(payload){const operation=this.queue.then(async()=>{const preview=this.pending.get(payload.token);this.pending.delete(payload.token);if(!preview||preview.expires<Date.now())throw Error('确认已过期，请重新选择');const current=await this.selected(preview);if(current.stamp!==preview.stamp)throw Error('聊天记录已变化，请重新确认');const release=await this.ctx.sessionController.deletionLease(current.headers.map(h=>h.id));try{
   this.ledger.deleted=[...new Set([...this.ledger.deleted,...current.headers.map(h=>h.id)])];this.ledger.pending.push(...current.headers);this.save();this.ctx.sessionController.markPermanentlyDeleted(this.ledger.deleted);await this.cleanup(current.headers);return {deleted:current.headers.length};
  }finally{release();}});this.queue=operation.catch(()=>{});return operation;}
 async cleanup(headers){const ids=new Set(headers.map(h=>h.id)),deletedHashes=new Set(),retainedHashes=new Set();
  await this.ctx.sessionPersistence.preparePermanentDeletion([...ids]);
  // Inspect every supported generation before removal. Remaining and QQ backup references protect shared objects.
  for(const root of [path.join(this.home,'sessions'),path.join(this.home,'sessions-backup-old-account')])for(const file of files(root).filter(logFile)){const id=path.basename(path.dirname(file));for(const h of hashes(this.ctx.sessionPersistence.decodeDeletionLog(fs.readFileSync(file),file.endsWith('.zstd'))))(ids.has(id)?deletedHashes:retainedHashes).add(h);}
  for(const header of headers){await this.ctx.sessionProjectionCache.removePermanently(header.id);try{await this.ctx.sessionPersistence.removePermanently(header);}catch(e){if(e.code!=='ENOENT')throw e;}await this.ctx.workspaceRegistry.forgetPermanently(header.id);}
  await this.ctx.sessionQuery.forgetPermanently([...ids]);
  // Remove predecessor cache rows too; the current cache's table owns its normal write chain.
  const old=path.join(this.home,'storages/session_projcache.json');if(fs.existsSync(old)){const data=JSON.parse(fs.readFileSync(old));for(const id of ids)delete data.tables?.sessions?.[id];const tmp=old+'.'+randomUUID();fs.writeFileSync(tmp,JSON.stringify(data),{mode:0o600});fs.renameSync(tmp,old);}
  for(const root of ['attachments','cache/attachments'])for(const file of files(path.join(this.home,root))){const refs=hashes(file);if(refs.some(h=>deletedHashes.has(h))&&!refs.some(h=>retainedHashes.has(h)))fs.rmSync(file);}
  for(const file of files(path.join(this.home,'storage/model-router/projects')).filter(p=>p.endsWith('/state.json'))){const state=JSON.parse(fs.readFileSync(file));if(ids.has(state.sessionId))fs.rmSync(path.dirname(file),{recursive:true,force:true});}
  this.ledger.pending=this.ledger.pending.filter(h=>!ids.has(h.id));this.save();for(const id of ids)this.ctx.emit('api-session/removed',id);
 }
 async manage(payload){if(payload.action==='status')return this.status();if(payload.action==='preview')return this.preview(payload);if(payload.action==='delete')return this.remove(payload);if(payload.action==='retry'){await this.cleanup(this.ledger.pending);return this.status();}throw Error('操作无效');}
}
export function applyChatHistory(ctx){ctx.inject(['sessionController','sessionPersistence','sessionProjectionCache','sessionQuery','workspaceRegistry'],c=>{
 const manager=new ChatHistory(c,process.env.DSH_HOME||path.join(os.homedir(),'.dsh'));
 c.connection.rpc.handle('/chat-history',async(method,payload)=>{try{if(method!=='manage')throw Error('请求无效');return {ok:true,value:await manager.manage(payload)}}catch(e){return {ok:false,error:{code:'chat-history/failed',message:e.message,details:{}}}}},{authority:'loopback'});
 for(const [route,file,type]of [['/chat-history','page.html','text/html'],['/chat-history/page.js','page.js','text/javascript']]){const content=fs.readFileSync(new URL('./'+file,import.meta.url));c.effect(()=>c.webServer.register({kind:'exact',path:route,handler:(req,res)=>{if(req.method!=='GET'){res.writeHead(405).end();return}res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; object-src 'none'"});res.end(content)}}));}
 });}
