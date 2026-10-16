import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {check,hash,read,save,redact} from './storage.mjs';
import {routeOf} from './model.mjs';

export class Continuity {
 constructor(store,ctx){this.store=store;this.ctx=ctx;}
 file(job,key){return path.join(this.store.base,'projects',hash(job.cwd),'continuity',key+'.json');}
 profile(job){check(job.continuity?.key,'本任务尚未建立人格接续记录');const p=read(this.file(job,job.continuity.key));check(p?.version===1&&p.id===job.continuity.id&&Array.isArray(p.notes)&&Array.isArray(p.transitions),'人格接续记录损坏，请保留检查');return p;}
 async capture(job,agent){const cards=await this.ctx.get('dshAgentCards')?.status();const selection=cards?.selection||{mainId:null,subIds:[]};const key=hash(selection.mainId||'default-assistant');const chosen=[selection.mainId,...selection.subIds].filter(Boolean).map(id=>cards.cards.find(c=>c.id===id));const persona={mainId:selection.mainId,subIds:selection.subIds,revision:cards?.revision||0,cards:chosen.map(c=>({id:c.id,name:c.name,sha256:hash(c.content)}))};const fingerprint=hash(JSON.stringify(persona.cards));let model;try{model=routeOf(agent);}catch{model={provider:'unknown',model:'unknown'};}
  const p=read(this.file(job,key),{version:1,id:randomUUID(),key,notes:[],transitions:[]});check(p.version===1&&p.key===key&&Array.isArray(p.notes)&&Array.isArray(p.transitions),'人格记录格式无效');const prior=p.transitions.at(-1),event={at:new Date().toISOString(),sessionId:job.sessionId,taskId:job.id,model,persona,fingerprint};if(!prior||prior.sessionId!==job.sessionId||prior.model.provider!==model.provider||prior.model.model!==model.model||prior.fingerprint!==fingerprint){p.transitions.push(event);p.transitions=p.transitions.slice(-100);save(this.file(job,key),p);}job.continuity={key,id:p.id,fingerprint,model,mainId:selection.mainId,transitionCount:p.transitions.length};this.store.put(job);return this.audit(job);
 }
 note(job,{key,kind,quote}){check(/^[a-z][a-z0-9-]{0,63}$/.test(key)&&['identity','preference','relationship'].includes(kind),'记录名称或类型无效');check(typeof quote==='string'&&quote.trim().length>=2&&quote.length<=1200&&redact(quote,1200)===quote&&job.task.includes(quote),'只记录当前用户原话，不能推测共同经历');const p=this.profile(job);const old=p.notes.find(n=>n.key===key&&n.kind===kind&&n.status==='active');if(old?.quote===quote)return old;check(p.notes.length<128,'人格事件已达128条，请先导出归档');if(old)old.status='superseded';const n={id:randomUUID(),key,kind,quote,status:'active',at:new Date().toISOString(),source:{taskId:job.id,sessionId:job.sessionId,taskHash:job.taskHash}};p.notes.push(n);save(this.file(job,p.key),p);return n;}
 forget(job,id){const p=this.profile(job),n=p.notes.find(x=>x.id===id);check(n,'当前角色没有此记录');n.status='forgotten';n.quote='';save(this.file(job,p.key),p);return {forgotten:true,id};}
 audit(job){const p=this.profile(job);const notes=p.notes.filter(n=>n.status==='active'&&!this.store.frozen({cwd:job.cwd,sessionId:n.source.sessionId}));return {id:p.id,scope:'当前设备与项目，按所选主卡隔离',mainId:job.continuity.mainId,transitionCount:p.transitions.length,transitions:p.transitions.slice(-16),notes,storageContinuity:true,behaviorContinuity:'待实际跨模型场景验收；存储保持不等于模型必然遵守'};}
 context(job){const a=this.audit(job);return {id:a.id,mainId:a.mainId,model:job.continuity.model,notes:a.notes.slice(-8).map(n=>({kind:n.kind,quote:n.quote,source:n.source})),meaning:'用户原话有来源；未记录的关系史保持未知。当前用户改设定优先。'};}
}
