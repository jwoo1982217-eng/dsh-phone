import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {PhoneSkills,SKILLS_REF} from './skills.js';import {PhonePacks,PACKS_REF} from './packs.js';import {replaceSkills} from './replace-skills.js';
test('replace old phone skills and both memories, preserve persona and three valid packages',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-phone-replace-'));
 const records=new Map([['PERSONA','unchanged persona and selection'],['ACCOUNT','unchanged account'],[SKILLS_REF,JSON.stringify({revision:4,items:[{name:'old-skill',description:'old',content:'old instruction',enabled:true}]})],[PACKS_REF,JSON.stringify({records:[],revision:9})]]);
 const store={get:async k=>records.get(k),set:async(k,v)=>records.set(k,v)};const skills=new PhoneSkills(store),packs=new PhonePacks(store,path.join(home,'workspaces/qq/.dsh-skill-packs'),home);await skills.init();await packs.init();
 const ctx={get:k=>k==='sessionController'?{list:async()=>({items:[]})}:undefined,settings:{describe:()=>[{ns:'dsh-noema',value:{enabled:false,noemaRoot:''}}]}};
 try{
  for(const dir of ['skills/old','.agents/skills/old','.agent-memory/cortex','experience/verified-improvement']){await fs.mkdir(path.join(home,dir),{recursive:true});await fs.writeFile(path.join(home,dir,'old.txt'),'old memory or skill');}
  await fs.mkdir(path.join(packs.root,'old-pack'),{recursive:true});await fs.writeFile(path.join(packs.root,'old-pack/old.txt'),'old pack');
  assert.deepEqual(await replaceSkills(ctx,skills,packs,home),{packages:3,skills:20,memoryCleared:true,personaPreserved:true});
  assert.equal(records.get('PERSONA'),'unchanged persona and selection');assert.equal(records.get('ACCOUNT'),'unchanged account');assert.deepEqual((await skills.status()).items,[]);
  const state=await packs.status();assert.equal(state.records.length,3);assert.equal(state.records.reduce((n,r)=>n+r.skills.length,0),20);assert.equal(state.records.flatMap(r=>r.prompts).length,0);assert.equal(state.records.flatMap(r=>r.activePrompts).length,0);
  for(const dir of ['skills','.agents/skills','.agent-memory','experience/verified-improvement'])assert.deepEqual(await fs.readdir(path.join(home,dir)),[]);
  await assert.rejects(fs.access(path.join(packs.root,'old-pack')));assert(JSON.parse(await fs.readFile(path.join(home,'storage/phone-selected-skills.json'))).packages.length===3);
  for(const r of state.records)for(const s of r.skills){const item=await packs.read(r.id,s.name);assert(item.content.length>0);await fs.access(path.join(packs.root,r.id,s.directory,'SKILL.md'));}
  const packer=state.records.find(r=>r.skills.some(s=>s.name==='packer-solutions'));await fs.access(path.join(packs.root,packer.id,'skills/packer-solutions/references/original'));
  // A running task and an enabled or external memory engine reject before any store change.
  const frozen=new Map(records);ctx.get=()=>({list:async()=>({items:[{running:true}]})});await assert.rejects(replaceSkills(ctx,skills,packs,home),/停止/);assert.deepEqual(records,frozen);
  ctx.get=()=>({list:async()=>({items:[]})});ctx.settings.describe=()=>[{ns:'dsh-noema',value:{enabled:true}}];await assert.rejects(replaceSkills(ctx,skills,packs,home),/关闭/);assert.deepEqual(records,frozen);
  ctx.settings.describe=()=>[{ns:'dsh-noema',value:{enabled:false,noemaRoot:'/outside-app-memory'}}];await assert.rejects(replaceSkills(ctx,skills,packs,home),/应用内/);assert.deepEqual(records,frozen);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
