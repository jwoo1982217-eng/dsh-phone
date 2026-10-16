import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';

export const TASKS = {general:'通用协作',extract:'检索与提取',text:'整理与写作','code-reading':'代码与排错',planning:'复杂分析与规划','tool-schema':'工具操作'};
export const keyOf = r => r.provider+'\0'+r.model;
const check=(ok,message)=>{if(!ok)throw Error(message);};
const bounded=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
export function validateConfig(input,allowed){
 check(input&&typeof input==='object'&&typeof input.enabled==='boolean','调度设置无效');
 check(input.delegationEnabled===undefined||typeof input.delegationEnabled==='boolean','子代理开关无效');
 for(const [k,min,max] of [['maxConcurrent',1,8],['providerConcurrency',1,8],['modelConcurrency',1,8],['minIntervalMs',0,60000],['cooldownMs',1000,300000]])check(bounded(input[k],min,max),'无效设置：'+k);
 check(Array.isArray(input.routes)&&input.routes.length<=24,'模型池最多24条线路');const seen=new Set();
 const providerGroups=new Map();
 const routes=input.routes.map(r=>{check(r&&typeof r.provider==='string'&&r.provider.length>0&&r.provider.length<=200&&typeof r.model==='string'&&r.model.length>0&&r.model.length<=512,'模型线路无效');const key=keyOf(r);check(!seen.has(key),'模型线路重复');seen.add(key);if(allowed)check(allowed.some(x=>keyOf(x)===key),'线路不在已授权目录：'+r.provider+'/'+r.model);
 check(Array.isArray(r.tasks)&&r.tasks.length>0&&r.tasks.length<=6&&r.tasks.every(t=>Object.hasOwn(TASKS,t)),'请选择工作类型');const quotaGroup=(r.quotaGroup||r.provider).trim();check(/^[\p{L}\p{N}_.:/ -]{1,100}$/u.test(quotaGroup),'额度组名称无效');check(!providerGroups.has(r.provider)||providerGroups.get(r.provider)===quotaGroup,'同一 API 来源的模型需使用相同额度组');providerGroups.set(r.provider,quotaGroup);return {provider:r.provider,model:r.model,tasks:[...new Set(r.tasks)],quotaGroup};});
 return {enabled:input.enabled,delegationEnabled:input.delegationEnabled??true,maxConcurrent:input.maxConcurrent,providerConcurrency:input.providerConcurrency,modelConcurrency:input.modelConcurrency,minIntervalMs:input.minIntervalMs,cooldownMs:input.cooldownMs,routes};
}
export class Scheduler{
 constructor(home,{allowed=()=>[],clock=()=>Date.now()}={}){
  this.allowed=allowed;this.clock=clock;this.file=path.join(home,'storage/subagent-scheduler/config.json');this.revision=0;this.active=new Map();this.pending=[];this.groups=new Map();this.models=new Map();this.total=0;this.events=[];this.closed=false;this.local=new AsyncLocalStorage();
  const defaults={enabled:true,delegationEnabled:true,maxConcurrent:2,providerConcurrency:1,modelConcurrency:1,minIntervalMs:1000,cooldownMs:30000,routes:[]};
  // A starter pool uses only the two already-authorized first-party routes.
  // It never adds arbitrary catalog entries or calls a model to test it.
  for(const [model,tasks]of [['deepseek-flash',['general','extract','text']],['deepseek-v4-pro',['planning','code-reading','tool-schema']]])if(allowed().some(r=>r.provider==='deepseek-official'&&r.model===model))defaults.routes.push({provider:'deepseek-official',model,tasks,quotaGroup:'deepseek-official'});
  try{const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));this.config=validateConfig(saved.config);check(bounded(saved.revision,0,Number.MAX_SAFE_INTEGER),'设置版本损坏');this.revision=saved.revision;}catch(e){if(e.code!=='ENOENT')throw Error('子代理调度设置损坏，请保留原文件后修复');this.config=defaults;}
 }
 save(input,revision){check(revision===this.revision,'设置已变化，请刷新后重试');const config=validateConfig(input,this.allowed());check(!(this.active.size||this.pending.length)||JSON.stringify(config.routes)===JSON.stringify(this.config.routes),'有请求正在执行或排队，请等待完成后修改模型池和额度组');fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});const tmp=this.file+'.'+randomUUID();try{fs.writeFileSync(tmp,JSON.stringify({revision:this.revision+1,config},null,2)+'\n',{mode:0o600});fs.renameSync(tmp,this.file);}finally{fs.rmSync(tmp,{force:true});}this.config=config;this.revision++;this.pump();return this.status();}
 assertDelegation(){check(this.config.delegationEnabled,'子代理已关闭，请由主模型完成任务；可在设置→子代理调度重新开启。');}
 group(route){return this.config.routes.find(r=>r.provider===route.provider)?.quotaGroup||route.provider;}
 bucket(group){if(!this.groups.has(group))this.groups.set(group,{active:0,lastStart:0,cooldownUntil:0});return this.groups.get(group);}
 candidates(task='general',allowed=this.allowed()){
  if(!this.config.delegationEnabled)return [];const valid=this.config.routes.filter(r=>allowed.some(x=>keyOf(r)===keyOf(x)));const exact=valid.filter(r=>r.tasks.includes(task));return exact.length?exact:valid.filter(r=>r.tasks.includes('general'));
 }
 rank(routes){return [...routes].sort((a,b)=>{const load=r=>{const g=this.bucket(this.group(r));return (g.cooldownUntil>this.clock()?10000:0)+g.active*10+(this.models.get(keyOf(r))||0);};return load(a)-load(b);});}
 choose(task,allowed){return this.rank(this.candidates(task,allowed))[0];}
 note(kind,data={}){this.events.push({at:new Date(this.clock()).toISOString(),kind,...data});this.events=this.events.slice(-60);}
 rateLimit(route,failure){if(failure?.code!=='RATE_LIMIT'&&failure?.status!==429)return;const group=this.group(route),b=this.bucket(group);const retry=Number(failure.retryAfterMs);b.cooldownUntil=Math.max(b.cooldownUntil,this.clock()+Math.max(this.config.cooldownMs,Number.isFinite(retry)?Math.min(Math.max(retry,0),300000):0));this.note('rate-limit',{provider:route.provider,model:route.model,group,cooldownUntil:b.cooldownUntil});this.pump();}
 acquire(route,signal){
  signal?.throwIfAborted();if(this.closed)return Promise.reject(Error('子代理调度已卸载'));if(!this.config.enabled)return Promise.resolve({release(){},token:this.local.getStore()});
  const parent=this.local.getStore(),group=this.group(route),key=keyOf(route);
  // Aggregate adapters may call llm.stream again. The physical request keeps
  // the outer permit, avoiding a recursive acquisition of the same quota.
  if(parent?.groups.has(group))return Promise.resolve({release(){},token:parent});
  return new Promise((resolve,reject)=>{const job={route,signal,group,key,parent,resolve,reject,at:this.clock()};job.abort=()=>{const i=this.pending.indexOf(job);if(i<0)return;this.pending.splice(i,1);signal?.removeEventListener('abort',job.abort);reject(signal.reason||Error('请求已取消'));this.pump();};signal?.addEventListener('abort',job.abort,{once:true});this.pending.push(job);this.pump();});
 }
 pump(){
  clearTimeout(this.timer);if(this.closed)return;const now=this.clock();let delay=Infinity;
  for(let i=0;i<this.pending.length;){const j=this.pending[i];if(!this.config.enabled){this.pending.splice(i,1);j.signal?.removeEventListener('abort',j.abort);j.resolve({release(){},token:j.parent});continue;}const b=this.bucket(j.group),wait=Math.max(b.cooldownUntil,b.lastStart+this.config.minIntervalMs)-now;
   if(wait>0){delay=Math.min(delay,wait);i++;continue;}if((!j.parent&&this.total>=this.config.maxConcurrent)||b.active>=this.config.providerConcurrency||(this.models.get(j.key)||0)>=this.config.modelConcurrency){i++;continue;}
   this.pending.splice(i,1);j.signal?.removeEventListener('abort',j.abort);b.active++;b.lastStart=now;this.models.set(j.key,(this.models.get(j.key)||0)+1);if(!j.parent)this.total++;const id=randomUUID();this.active.set(id,{provider:j.route.provider,model:j.route.model,group:j.group,startedAt:now});let released=false;const token={groups:new Set([...(j.parent?.groups||[]),j.group])};
   j.resolve({token,release:()=>{if(released)return;released=true;b.active--;const n=(this.models.get(j.key)||1)-1;n?this.models.set(j.key,n):this.models.delete(j.key);if(!j.parent)this.total--;this.active.delete(id);this.pump();}});
  }if(Number.isFinite(delay)&&this.pending.length)this.timer=setTimeout(()=>this.pump(),Math.max(1,delay));
 }
 async *stream(options,next){const route={provider:options.provider||'default',model:options.model||'default'},lease=await this.acquire(route,options.signal);let iterator,done=false;
  try{iterator=next()[Symbol.asyncIterator]();for(;;){const item=await this.local.run(lease.token,()=>iterator.next());if(item.done){done=true;break;}const chunk=item.value;if(chunk.type==='finish')this.rateLimit(route,chunk.reason?.failure);yield chunk;}}catch(e){this.rateLimit(route,e);throw e;}finally{try{if(iterator&&!done)await this.local.run(lease.token,()=>iterator.return?.());}finally{lease.release();}}
 }
 status(){return {revision:this.revision,config:structuredClone(this.config),active:[...this.active.values()],queued:this.pending.map(j=>({provider:j.route.provider,model:j.route.model,group:j.group,queuedAt:j.at})),cooldowns:[...this.groups].filter(([,b])=>b.cooldownUntil>this.clock()).map(([group,b])=>({group,until:b.cooldownUntil})),events:this.events.slice(-20)};}
 close(){this.closed=true;clearTimeout(this.timer);for(const j of this.pending.splice(0)){j.signal?.removeEventListener('abort',j.abort);j.reject(Error('子代理调度已卸载，请重试'));}}
}
