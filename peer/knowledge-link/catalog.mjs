import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {credentialRef} from '@deepseek-ai/dsh-credentials';
import {methodDigest,episodeDigest} from '../memory-isolation/isolation.mjs';
import {check,hash,read,regular,walk,safeName,secretFree,noLinks} from './files.mjs';
const fields=['key','trigger','action','exclusions','change'];
export class Catalog{
 constructor(home,ctx,{codexHome=process.platform==='darwin'?path.join(os.homedir(),'.codex'):null}={}){this.home=home;this.ctx=ctx;this.codexHome=codexHome;}
 async list(){const rows=[];
 const add=(root,bank)=>{if(!fs.existsSync(root))return;noLinks(root);for(const e of fs.readdirSync(root,{withFileTypes:true})){if(e.name.startsWith('.')||!e.isDirectory()||!safeName(e.name))continue;const dir=path.join(root,e.name),file=path.join(dir,'SKILL.md');if(!fs.existsSync(file))continue;const text=regular(file,512*1024).toString('utf8');rows.push({id:hash(bank+':'+dir),type:'skill',name:e.name,description:(text.match(/^description:\s*(.+)$/m)?.[1]||'').slice(0,300),bank,dir});}};
 add(path.join(this.home,'skills'),'DSH 技能');if(this.codexHome)add(path.join(this.codexHome,'skills'),'Codex 技能');
 const credential=async key=>{try{return JSON.parse((await this.ctx?.credentials?.resolve(credentialRef(key)))?.value||'null');}catch{return null;}};
 const packs=await credential('DSH_PHONE_SKILL_PACKS');for(const r of packs?.records||[])for(const s of r.skills||[]){const dir=path.join(this.home,'workspaces/qq/.dsh-skill-packs',r.id,s.directory);if(fs.existsSync(path.join(dir,'SKILL.md')))rows.push({id:hash('pack:'+r.id+':'+s.name),type:'skill',name:s.name,description:s.description?.slice(0,300)||'',bank:'已导入技能包',dir});}
 const singles=await credential('DSH_PHONE_SKILLS');for(const s of singles?.items||[]){if(!safeName(s.name))continue;rows.push({id:hash('shared:'+s.name),type:'skill',name:s.name,bank:'共享单技能',description:s.description?.slice(0,300)||'',document:`---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description||s.name)}\n---\n\n${s.content||''}\n`});}
 for(const [base,bank] of [[path.join(this.home,'experience/verified-improvement'),'DSH 经验'],...(this.codexHome?[[path.join(this.codexHome,'experience/verified-improvement'),'Codex 经验']]:[])]){
  if(!fs.existsSync(base))continue;if(fs.existsSync(path.join(base,'.frozen.json')))continue;
  const states=walk(base,f=>path.basename(f)==='state.json'&&!f.includes('/checkpoints/'),5000);
  for(const file of states){if(fs.existsSync(path.join(path.dirname(file),'.quarantine.json')))continue;let state;try{state=read(file);}catch{continue;}
   for(const c of state.candidates||[]){if(!fields.every(k=>typeof c[k]==='string')||['quarantined','revoked'].includes(c.status)||c.revokedAt)continue;const episode=state.episodes?.find(e=>e.id===c.episodeId);let approved=state.current?.[c.key]===c.id&&c.status==='approved'&&!!c.approvedAt&&c.validation?.passed===true;
    if(approved&&state.version===3)approved=c.approvalDigest===methodDigest(c)&&episode&&c.episodeDigest===episodeDigest(episode);
    rows.push({id:hash(file+':'+c.id),type:'experience',name:c.key,description:c.trigger.slice(0,300),bank,sourceStatus:approved?'approved':'candidate',method:Object.fromEntries(fields.map(k=>[k,c[k]])),provenance:{project:state.scope?.directory||null,window:state.scope?.window?.id||null,candidate:c.id,approvedAt:approved?c.approvedAt:null,evidence:(c.validation?.cases||[]).map(x=>({kind:x.kind,name:x.name,sha256:x.sha256||null,transferred:false}))}});
   }
  }
 }
 const imports=path.join(this.home,'knowledge/imports');for(const file of walk(imports,f=>path.basename(f)==='candidate.json',2000)){let p;try{p=read(file);}catch{continue;}if(p.type==='imported-experience'&&fields.every(k=>typeof p.method?.[k]==='string'))rows.push({id:hash('import:'+file),type:'experience',name:p.method.key,description:p.method.trigger.slice(0,300),bank:'收到的经验候选',sourceStatus:'candidate',method:p.method,provenance:{...p.provenance,previousOrigin:p.origin,previousSourceStatus:p.sourceStatus,localStatus:'candidate'}});}
 return rows;
 }
 public(rows){return rows.map(({dir,document,method,provenance,...r})=>r);}
 async export(ids,origin){check(Array.isArray(ids)&&ids.length>0&&ids.length<=50&&new Set(ids).size===ids.length,'请选择 1 至 50 项');const all=await this.list();let total=0;const items=[];
 for(const id of ids){const r=all.find(x=>x.id===id);check(r,'选择已发生变化，请刷新');if(r.type==='experience'){const item={type:r.type,name:r.name,sourceStatus:r.sourceStatus,method:r.method,provenance:r.provenance};secretFree(Buffer.from(JSON.stringify(item)));items.push(item);continue;}
  check(safeName(r.name),'技能名称无效');const files=[];for(const f of r.document?['SKILL.md']:walk(r.dir)){const relative=r.document?f:path.relative(r.dir,f).split(path.sep).join('/');const bytes=r.document?Buffer.from(r.document):regular(f);secretFree(bytes,relative);total+=bytes.length;check(total<=128*1024*1024,'选择总量超过128MB，请分批发送');files.push({path:relative,mode:!r.document&&(fs.statSync(f).mode&0o111)?0o700:0o600,sha256:hash(bytes),data:bytes.toString('base64')});}
  check(files.some(f=>f.path==='SKILL.md'),'技能正文缺失');items.push({type:'skill',name:r.name,bank:r.bank,files});
 }
 return {version:1,id:crypto.randomUUID(),createdAt:new Date().toISOString(),origin,items};
 }
}
