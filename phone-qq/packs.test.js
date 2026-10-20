import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Skills from '@deepseek-ai/dsh-skill';
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt';
import { PhonePacks, inspectPack, installPromptCards } from './packs.js';
import { crc32, readZip } from './zip.js';
function zip(entries) {
 const parts=[],central=[];let offset=0;
 for(const [name,value]of Object.entries(entries)){const file=Buffer.from(name),data=Buffer.from(value),crc=crc32(data),local=Buffer.alloc(30),header=Buffer.alloc(46);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(file.length,26);header.writeUInt32LE(0x02014b50);header.writeUInt16LE(20,4);header.writeUInt16LE(20,6);header.writeUInt16LE(0x800,8);header.writeUInt32LE(crc,16);header.writeUInt32LE(data.length,20);header.writeUInt32LE(data.length,24);header.writeUInt16LE(file.length,28);header.writeUInt32LE(offset,42);parts.push(local,file,data);central.push(header,file);offset+=local.length+file.length+data.length;}
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,directory,end]);
}
const fixtureBytes=()=>zip({'pack/materials/skills/code-work/SKILL.md':'---\nname: code-work\ndescription: Edit supplied code\n---\nRead references/check.md before edits.','pack/materials/skills/code-work/references/check.md':'Verify expected behavior.','pack/materials/skills/code-work/scripts/test.mjs':'throw Error("Never execute during import")','pack/prompts/work-card.md':'Use {{literal}} as prose.','pack/install.ps1':'throw "Never execute"'});
async function fixture(){const home=await mkdtemp(path.join(os.tmpdir(),'phone-packs-')),data=new Map(),store={get:async key=>data.get(key),set:async(key,value)=>data.set(key,value)},manager=new PhonePacks(store,path.join(home,'workspaces/qq/.dsh-skill-packs'),home);await manager.init();return{home,data,store,manager};}
test('ZIP rejects traversal, CRC damage, truncated records and duplicate paths without running installers',()=>{
 const good=fixtureBytes();assert.equal(readZip(good).size,5);const parsed=inspectPack(good);assert.equal(parsed.skills.length,1);assert.equal(parsed.prompts.length,1);assert.equal(parsed.assets.size,5);assert.ok(![...parsed.assets.keys()].some(n=>n.endsWith('.ps1')));
 assert.throws(()=>readZip(zip({'../escape':'x'})));assert.throws(()=>readZip(zip({'safe//alias':'x'})));const damaged=Buffer.from(good);damaged[100]^=1;assert.throws(()=>readZip(damaged));assert.throws(()=>readZip(good.subarray(0,good.length-1)));
});
test('import publishes real registry skills with preserved resource files and prompt cards update the next assembly',async()=>{
 const f=await fixture(),ctx=new Context(),skills=ctx.plugin(Skills),prompt=ctx.plugin(SystemPrompt,{});await skills;await prompt;
 ctx.skills.registerProvider(control=>f.manager.provider(control));installPromptCards(ctx,f.manager,{handle:null});
 try{let state=await f.manager.import(fixtureBytes(),0);const record=state.records[0];const rows=await ctx.skills.list({cwd:f.home});assert.equal(rows[0].name,'code-work');assert.equal(rows[0].resourceBase.kind,'directory');assert.equal(await readFile(path.join(rows[0].resourceBase.path,'references/check.md'),'utf8'),'Verify expected behavior.');assert.match((await ctx.skills.get('code-work',{cwd:f.home})).content,/references\/check/);assert.equal((await ctx.skills.list({cwd:'/unrelated'})).length,0);
 const context={agent:{cwd:f.home,session:{id:'phone-local'}}};assert.doesNotMatch(renderContextSnapshot(await ctx.systemPrompt.assemble(context)),/Use \{\{literal\}\}/);
 state=await f.manager.prompt(record.id,'work-card','New {{literal}} instruction.',true,state.revision);assert.match(renderContextSnapshot(await ctx.systemPrompt.assemble(context)),/New \{\{literal\}\} instruction\./);assert.doesNotMatch(renderContextSnapshot(await ctx.systemPrompt.assemble({agent:{cwd:'/unrelated',session:{id:'elsewhere'}}})),/New/);
 state=await f.manager.toggle(record.id,'code-work',false,state.revision);assert.equal((await ctx.skills.list({cwd:f.home})).length,0);const resumed=new PhonePacks(f.store,f.manager.root,f.home);await resumed.init();assert.match(resumed.promptText(),/New/);assert.equal((await resumed.status()).records[0].disabled[0],'code-work');
 }finally{await prompt.dispose();await skills.dispose();await rm(f.home,{recursive:true,force:true});}
});
test('stale changes and failed credential saves do not publish new skills or prompt content',async()=>{
 const f=await fixture();try{const state=await f.manager.import(fixtureBytes(),0),record=state.records[0];await assert.rejects(f.manager.toggle(record.id,'code-work',false,0));f.store.set=async()=>{throw Error('disk full');};await assert.rejects(f.manager.prompt(record.id,'work-card','unpublished',true,state.revision));assert.equal(f.manager.promptText(),'');assert.equal((await f.manager.status()).revision,state.revision);}finally{await rm(f.home,{recursive:true,force:true});}
});
test('phone storage chats load managed packages and their switches invalidate the real catalog',async()=>{
 const f=await fixture(),ctx=new Context(),skills=ctx.plugin(Skills);await skills;
 const managed=new PhonePacks(f.store,f.manager.root,f.home,{sharedStorage:'/storage/emulated/0'});await managed.init();ctx.skills.registerProvider(control=>managed.provider(control));
 try{let state=await managed.import(fixtureBytes(),0);const record=state.records[0];
 for(const cwd of ['/storage/emulated/0','/storage/emulated/0/Download']){assert.equal((await ctx.skills.list({cwd}))[0].name,'code-work');assert.match((await ctx.skills.get('code-work',{cwd})).content,/references\/check/);}
 assert.equal((await ctx.skills.list({cwd:'/storage/emulated/01'})).length,0);assert.equal((await ctx.skills.list({cwd:'/unrelated'})).length,0);
 state=await managed.toggle(record.id,'code-work',false,state.revision);assert.equal((await ctx.skills.list({cwd:'/storage/emulated/0'})).length,0);
 state=await managed.toggle(record.id,'code-work',true,state.revision);assert.equal((await ctx.skills.list({cwd:'/storage/emulated/0'})).length,1);
 f.store.set=async()=>{throw Error('disk full');};await assert.rejects(managed.toggle(record.id,'code-work',false,state.revision));assert.equal((await ctx.skills.list({cwd:'/storage/emulated/0'})).length,1);
 }finally{await skills.dispose();await rm(f.home,{recursive:true,force:true});}
});
test('managed Agent cards stop duplicate legacy injection while QQ keeps its own prompt cards',async()=>{
 const f=await fixture(),ctx=new Context(),prompt=ctx.plugin(SystemPrompt,{});await prompt;
 try{let state=await f.manager.import(fixtureBytes(),0);state=await f.manager.prompt(state.records[0].id,'work-card','Legacy QQ instructions',true,state.revision);
 installPromptCards(ctx,f.manager,{handle:{}},{agentCardsManaged:true});
 assert.doesNotMatch(renderContextSnapshot(await ctx.systemPrompt.assemble({agent:{cwd:f.home,session:{id:'normal-agent'}}})),/Legacy QQ instructions/);
 assert.match(renderContextSnapshot(await ctx.systemPrompt.assemble({agent:{cwd:f.home,session:{id:'qq-dm-123'}}})),/Legacy QQ instructions/);
 }finally{await prompt.dispose();await rm(f.home,{recursive:true,force:true});}
});
test('app projects and Android home aliases load the same package without admitting adjacent directories',async()=>{
 const f=await fixture(),alias=f.home+'-alias',ctx=new Context(),skills=ctx.plugin(Skills);await skills;
 try{
  await mkdir(path.join(f.home,'projects','project'),{recursive:true});await symlink(f.home,alias);
  ctx.skills.registerProvider(control=>f.manager.provider(control));const state=await f.manager.import(fixtureBytes(),0);
  for(const cwd of [path.join(f.home,'projects','project'),path.join(alias,'projects','project'),path.join(alias,'workspaces','project')]){
   assert.deepEqual((await ctx.skills.list({cwd})).map(s=>s.name),['code-work']);assert.match((await ctx.skills.get('code-work',{cwd})).content,/references\/check/);
  }
  for(const cwd of [f.home+'-other/projects/project',path.join(f.home,'outside'),'/unrelated'])assert.deepEqual(await ctx.skills.list({cwd}),[]);
  await f.manager.toggle(state.records[0].id,'code-work',false,state.revision);assert.deepEqual(await ctx.skills.list({cwd:path.join(alias,'projects','project')}),[]);
 }finally{await skills.dispose();await rm(alias,{force:true});await rm(f.home,{recursive:true,force:true});}
});
test('owner supplied bundled archive contains all skills and prompt resources when locally available',async t=>{
 let bytes;try{bytes=await readFile(process.env.DSH_TEST_SKILL_ZIP || new URL('./private-skill-pack.zip',import.meta.url));}catch(e){if(e.code==='ENOENT'){t.skip('Owner-supplied archive not in public source');return;}throw e;}
 const pack=inspectPack(bytes);assert.equal(pack.skills.length,151);assert.equal(pack.prompts.length,12);assert.equal(new Set(pack.skills.map(s=>s.name)).size,151);assert.ok(pack.assets.size>2000);
});
