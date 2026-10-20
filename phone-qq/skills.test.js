import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import { PhoneSkills, parseSkillMarkdown, parseSkill, SKILLS_REF } from './skills.js';
const input = {name:'daily-report',description:'Write a report from provided facts',content:'Read the supplied notes. Do not invent facts.'};
function fixture(){const data=new Map();const store={get:async key=>data.get(key),set:async(key,value)=>data.set(key,value)};return{data,store,manager:new PhoneSkills(store)};}
test('imports standard SKILL.md and refuses malformed, oversized, or unsafe identifiers',()=>{
 assert.deepEqual(parseSkillMarkdown('---\nname: daily-report\ndescription: Daily summary\n---\nUse supplied notes.'),{name:'daily-report',description:'Daily summary',content:'Use supplied notes.',enabled:true});
 for(const text of ['---\nname: ../outside\ndescription: x\n---\nx','---\nname: okay\ndescription: x\ndisable-model-invocation: true\n---\nx','x'.repeat(65537)])assert.throws(()=>parseSkillMarkdown(text));
 assert.throws(()=>parseSkill({...input,content:'\0'}));
});
test('ordinary Chinese Markdown imports its heading and purpose without changing the instructions',()=>{
 const text='# 中文角色卡攻略\n\n> 用途：撰写和改造角色卡。\n\n## 方法\n保留角色性格与原文。';
 const parsed=parseSkillMarkdown(text,'中文角色卡.md');
 assert.equal(parsed.title,'中文角色卡攻略');assert.match(parsed.name,/^skill-[a-f0-9]{12}$/);
 assert.equal(parsed.description,'撰写和改造角色卡。');assert.equal(parsed.content,text);
 assert.equal(parseSkillMarkdown(text+'\n新的步骤','另存副本.md').name,parsed.name);
 assert.equal(parseSkillMarkdown('plain instructions','team_notes.md').name,'team-notes');
 assert.throws(()=>parseSkillMarkdown('x','../outside.md'));
 assert.throws(()=>parseSkillMarkdown('---\nname: [broken\n---\nx','card.md'));
});
test('Chinese display names receive a stable safe identifier and explicit unsafe identifiers stay rejected',()=>{
 const parsed=parseSkill({title:'角色卡与性格',description:'写角色卡',content:'明确角色背景。'});
 assert.equal(parsed.title,'角色卡与性格');assert.match(parsed.name,/^skill-[a-f0-9]{12}$/);
 assert.equal(parseSkill({...input,name:'中文技能'}).title,'中文技能');
 assert.throws(()=>parseSkill({...input,name:'../中文技能'}));
 assert.throws(()=>parseSkill({...input,title:'x'.repeat(161)}));
 assert.throws(()=>parseSkill({...input,title:'bad\0title'}));
});
test('Chinese titles survive saving, restart and the actual model-visible skill catalog',async()=>{
 const f=fixture();await f.manager.init();const ctx=new Context(),fiber=ctx.plugin(SkillRegistry);await fiber;
 const home='/tmp/phone-card-home';ctx.skills.registerProvider(control=>f.manager.provider(control,home+'/workspaces/qq',home));
 try{
  const item=parseSkillMarkdown('# 角色卡攻略\n> 用途：修改角色性格\n\n保留背景与边界。','角色卡.md');
  await f.manager.update(item,0);const restarted=new PhoneSkills(f.store);await restarted.init();
  assert.equal((await restarted.status()).items[0].title,'角色卡攻略');
  const rows=await ctx.skills.list({cwd:home});assert.match(rows[0].description,/角色卡攻略/);
  assert.equal((await ctx.skills.get(item.name,{cwd:home})).content,item.content);
 }finally{await fiber.dispose();}
});
test('persisted edits and toggles affect the real DSH skill catalog in own phone chats and robot workspace',async()=>{
 const f=fixture();await f.manager.init();const ctx=new Context();const fiber=ctx.plugin(SkillRegistry);await fiber;const home='/tmp/phone-qq-skills-home',workspace=home+'/workspaces/qq';
 ctx.skills.registerProvider(control=>f.manager.provider(control,workspace,home));
 try{
  assert.deepEqual(await ctx.skills.list({cwd:workspace}),[]);await f.manager.update(input,0);
  const rows=await ctx.skills.list({cwd:workspace});assert.equal(rows[0].name,'daily-report');assert.equal(rows[0].invocation.modelInvocable,true);
  assert.equal((await ctx.skills.get('daily-report',{cwd:workspace})).content,input.content);
  assert.equal((await ctx.skills.get('daily-report',{cwd:home})).content,input.content);
  assert.equal((await ctx.skills.list({cwd:'/tmp/ordinary-chat'})).length,0);
  await f.manager.update({...input,content:'New verified workflow'},1);assert.equal((await ctx.skills.get('daily-report',{cwd:workspace})).content,'New verified workflow');
  await f.manager.toggle('daily-report',false,2);assert.deepEqual(await ctx.skills.list({cwd:workspace}),[]);assert.equal(await ctx.skills.get('daily-report',{cwd:workspace}),undefined);
  await f.manager.toggle('daily-report',true,3);assert.equal((await ctx.skills.list({cwd:workspace})).length,1);
  const restarted=new PhoneSkills(f.store);await restarted.init();assert.equal((await restarted.status()).items[0].content,'New verified workflow');
 }finally{await fiber.dispose();}
});
test('stale editor and disk failures preserve the previous published skill',async()=>{
 const f=fixture();await f.manager.init();await f.manager.update(input,0);const saved=f.data.get(SKILLS_REF);
 await assert.rejects(f.manager.update({...input,content:'stale'},0));assert.equal(f.data.get(SKILLS_REF),saved);
 f.store.set=async()=>{throw Error('disk full');};await assert.rejects(f.manager.toggle(input.name,false,1));assert.equal((await f.manager.status()).items[0].enabled,true);
});
