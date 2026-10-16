import fs from 'node:fs';
import path from 'node:path';
import {parse} from 'yaml';
import {regular,safeName} from './files.mjs';

// Curated phone profiles deliberately suppress the general filesystem provider.
// Register only this requested skill and skills explicitly imported here.
export function registerKnowledgeSkills(ctx,home,inbox){
 if(process.env.DSH_PHONE_ANDROID!=='1'||!fs.existsSync(path.join(home,'storage/phone-selected-skills.json')))return ()=>{};
 let invalidate=()=>{};
 const load=name=>{try{if(!safeName(name))return;const dir=path.join(home,'skills',name),file=path.join(dir,'SKILL.md'),source=regular(file,512*1024).toString('utf8'),match=source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);if(!match)return;const meta=parse(match[1],{maxAliasCount:0});if(typeof meta?.description!=='string')return;return {name,description:meta.description,content:match[2],invocation:{modelInvocable:meta['disable-model-invocation']!==true,userInvocable:meta['user-invocable']!==false},resourceBase:{kind:'directory',path:dir}};}catch{return;}};
 ctx.skills.registerProvider(control=>{invalidate=()=>{if(!control.signal.aborted)control.invalidate();};return {name:'knowledge-imports',async list(){const names=new Set(['kb-lite-memory-search']);for(const r of inbox.list().filter(r=>r.status==='imported'))for(const item of r.items)if(item.type==='skill'&&r.result?.imported?.includes(item.name))names.add(item.name);return [...names].flatMap(name=>{const row=load(name);if(!row)return [];const {content,...summary}=row;return [{...summary,source:'user-dsh',provider:'knowledge-imports',rank:450,locator:{name}}];});},async get(candidate){const row=load(candidate.locator.name);if(row)return {...row,source:'user-dsh',provider:'knowledge-imports'};}};});
 return ()=>invalidate();
}
