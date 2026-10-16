import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {check,save} from './files.mjs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{redact}=require('./kb/lib/redact.cjs');
const bundled=fileURLToPath(new URL('./kb/kb.cjs',import.meta.url));
export class MemorySearch{
 constructor(home){this.home=home;this.closed=false;this.job=null;this.children=new Set();this.configFile=path.join(home,'knowledge/kb-config.json');
 const old=path.join(os.homedir(),'Downloads/KB_Lite-修订版/config.local.json');this.cli=process.platform==='darwin'&&fs.existsSync(old)?path.join(path.dirname(old),'kb.cjs'):bundled;
 const existing=this.cli!==bundled?JSON.parse(fs.readFileSync(old,'utf8')):{};
 const notes=path.join(home,'knowledge/notes'),imports=path.join(home,'knowledge/imports');for(const d of [notes,imports])fs.mkdirSync(d,{recursive:true,mode:0o700});
 const sources=existing.sources||[{name:'本机记忆',path:notes},...(fs.existsSync(path.join(home,'memory'))?[{name:'memory',path:path.join(home,'memory')}]:[])];if(!sources.some(s=>s.path===imports))sources.push({name:'跨设备经验候选',path:imports});
 this.config={...existing,sources,sessionsRoots:existing.sessionsRoots||[home],dataDir:existing.dataDir||path.join(home,'knowledge/kb-index'),cacheDir:existing.cacheDir||path.join(home,'knowledge/models'),model:'Xenova/bge-small-zh-v1.5',revision:'75c43b069aac4d136ba6bc1122f995fedcfd2781',pooling:'cls',shardSize:2000,chunkSize:420,overlap:70,maxFileBytes:64*1024*1024};save(this.configFile,this.config);save(path.join(home,'knowledge/runtime.json'),{version:1,cli:this.cli,config:this.configFile});}
 status(){let index={indexed:false};try{const id=fs.readFileSync(path.join(this.config.dataDir,'CURRENT'),'utf8').trim();check(/^[a-zA-Z0-9-]+$/.test(id),'索引指针无效');const m=JSON.parse(fs.readFileSync(path.join(this.config.dataDir,'generations',id,'manifest.json'),'utf8'));index={indexed:true,createdAt:m.createdAt,files:m.sources.length,chunks:m.count};}catch{}
 return {index,job:this.job,engine:this.cli===bundled?'本机离线 BGE · WASM':'本机离线 BGE',sources:this.config.sources.map(s=>s.path),sessionsRoots:this.config.sessionsRoots,config:this.configFile,cli:this.cli};}
 run(args,onLine){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[this.cli,...args,'--config',this.configFile],{env:process.env,stdio:['ignore','pipe','pipe']});this.children.add(child);try{os.setPriority(child.pid,10);}catch{}let out='',error='';child.stdout.on('data',b=>{out+=b; if(out.length>8e6)child.kill();});child.stderr.on('data',b=>{error=(error+b).slice(-6000);onLine?.(redact(error.split('\n').filter(Boolean).at(-1)||''));});child.once('error',reject);child.once('close',code=>{this.children.delete(child);if(code!==0){reject(Error(redact(error.slice(-2000)||'本地检索进程未完成')));return;}try{resolve(JSON.parse(out));}catch{reject(Error('本地检索返回内容无效'));}});});}
 update(dirty=false){check(!this.closed,'检索模块已关闭');if(this.job?.status==='running'){if(dirty)this.pendingUpdate=true;return this.job;}this.job={status:'running',startedAt:new Date().toISOString(),progress:'正在读取本机资料…'};const job=this.job;void this.run(['index'],line=>job.progress=line).then(result=>{job.status='completed';job.result=result;job.progress='索引更新完成';},e=>{job.status='failed';job.error=e.message;}).finally(()=>{job.finishedAt=new Date().toISOString();if(this.pendingUpdate&&!this.closed){this.pendingUpdate=false;this.update();}});return job;}
 async search(query,lexical=false){check(typeof query==='string'&&query.trim()&&query.length<=2000,'请输入2000字以内的问题');return this.run(['presearch',query,'--top','6',...(lexical?['--lexical']:[])]);}
 close(){this.closed=true;this.pendingUpdate=false;for(const child of this.children)child.kill();}
}
