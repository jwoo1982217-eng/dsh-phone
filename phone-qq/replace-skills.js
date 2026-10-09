import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {inspectPack} from './packs.js';
export const replacementBundles=['xiuzhen-DSH.zip','reverse-wiki-DSH.zip','packer-DSH.zip'];
export async function replaceSkills(ctx,skills,packs,home){
 const service=ctx.get('sessionController');if(!service)throw Error('聊天服务尚未准备好');
 if((await service.list({})).items.some(s=>s.running))throw Error('请先停止正在运行的任务');
 const noema=ctx.settings.describe().find(s=>s.ns.includes('dsh-noema')&&typeof s.value?.enabled==='boolean');
 if(noema?.value.enabled!==false)throw Error('请先在 Noema 设置中关闭长期记忆引擎，再清空记忆');
 const roots=[path.join(home,'skills'),path.join(home,'.agents/skills'),path.join(home,'.agent-memory'),path.join(home,'experience/verified-improvement')];
 if(typeof noema.value.noemaRoot==='string'&&noema.value.noemaRoot){const custom=path.resolve(noema.value.noemaRoot);if(custom!==home&&!custom.startsWith(home+'/'))throw Error('自定义记忆目录不在应用内，请单独核对');roots.push(custom);}
 const bundles=await Promise.all(replacementBundles.map(name=>readFile(new URL('./bundled-packs/'+name,import.meta.url))));
 const prepared=bundles.map(inspectPack);if(prepared.reduce((n,p)=>n+p.skills.length,0)!==20)throw Error('随包技能不完整');
 // Target only the phone skill references. Persona and account credential records are untouched.
 fs.mkdirSync(path.join(home,'storage'),{recursive:true,mode:0o700});fs.writeFileSync(path.join(home,'storage/phone-selected-skills.json'),JSON.stringify({source:'phone-packs',packages:prepared.map(p=>p.hash)}),{mode:0o600});
 await skills.mutate(()=>skills.commit([]));
 await packs.mutate(async()=>{await packs.commit([]);await fs.promises.rm(packs.root,{recursive:true,force:true});await packs.ensureRoot();for(const pack of prepared)await packs.install(pack);});
 for(const root of new Set(roots)){await fs.promises.rm(root,{recursive:true,force:true});await fs.promises.mkdir(root,{recursive:true,mode:0o700});}
 const incident=path.join(home,'storage/memory-isolation/incidents');if(fs.existsSync(incident))for(const name of fs.readdirSync(incident)){const p=path.join(incident,name);if(fs.lstatSync(p).isFile()&&!JSON.parse(fs.readFileSync(p)).action?.startsWith('persona.'))fs.rmSync(p);}
 await fs.promises.rm(path.join(home,'storage/memory-isolation/source-audit'),{recursive:true,force:true});
 const baseline=path.join(home,'storage/memory-isolation/confirmed-files.json');const rows=fs.existsSync(baseline)?JSON.parse(fs.readFileSync(baseline)).filter(row=>row.category!=='skill'&&fs.existsSync(row.path)):[];for(const row of rows)row.sha256=createHash('sha256').update(fs.readFileSync(row.path)).digest('hex');function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())walk(file);else if(e.isFile())rows.push({path:file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),category:'skill'});}}walk(packs.root);fs.mkdirSync(path.dirname(baseline),{recursive:true});fs.writeFileSync(baseline,JSON.stringify(rows),{mode:0o600});
 await fs.promises.rm(path.join(home,'storage/memory-isolation/source-audit.json'),{force:true});
 return {packages:3,skills:20,memoryCleared:true,personaPreserved:true};
}
