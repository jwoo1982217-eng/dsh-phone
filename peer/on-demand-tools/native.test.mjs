import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Skills from '@deepseek-ai/dsh-skill';
import * as SkillTool from '@deepseek-ai/dsh-tool-skill';
import Llm, {LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm';
import * as OnDemandTools from './index.mjs';

test('fixed SDK carries discovery, loading, original callback and lazy skill body through real agent steps',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-on-demand-native-'));
  const previous=process.env.DSH_HOME; process.env.DSH_HOME=home;
  t.after(()=>{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;fs.rmSync(home,{recursive:true,force:true});});
  const ctx=new Context(),forks=[],requests=[];
  t.after(async()=>{for(const fork of forks.reverse())await fork.dispose();});
  const plugin=async(p,c)=>{const fork=ctx.plugin(p,c);forks.push(fork);await fork;};
  await plugin(Llm);
  class Fixture extends LlmAdapter {
    async *stream(options){
      const index=requests.length;requests.push({tools:options.tools.map(t=>t.name),messages:structuredClone(options.messages)});
      const actions=[['tool_search',{query:'glob'}],['tool_load',{names:['glob']}],['glob',{pattern:'*'}],null,['skill',{name:'fixture-skill'}],null];
      const action=actions[index];
      if(action){yield{type:'tool-call-delta',index:0,id:'call-'+index,name:action[0],argumentsDelta:JSON.stringify(action[1])};yield{type:'finish',reason:{kind:'tool-calls'}};}
      else{yield{type:'text-delta',index:0,text:'fixture complete'};yield{type:'finish',reason:{kind:'stop'}};}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Fixture());
  for(const p of [Sessions,Projections,Agents,SystemPrompt,Tools,Loop,Skills])await plugin(p);
  await plugin(SkillTool,{catalogDescriptionMaxLength:160});
  ctx.skills.register({name:'fixture-skill',description:'用在需要 fixture 的任务。'.repeat(80),source:'fixture',content:'FULL_BODY_ONLY_AFTER_SELECTION'});
  fs.writeFileSync(path.join(home,'proof.txt'),'fixture');let executions=0;
  ctx.tools.register({name:'glob',description:'List fixture files',parameters:{type:'object',properties:{pattern:{type:'string'}},required:['pattern']},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:()=>{executions++;return fs.readdirSync(home).join('\n');}});
  await plugin(OnDemandTools);
  const handle=await ctx.agents.create({sessionId:'on-demand-native',meta:{cwd:home},agentOptions:{provider:'fixture',model:'test'}});t.after(()=>handle.dispose());
  const agent=handle.agent;
  agent.followup(createUserMessage({content:[{type:'text',text:'Find the fixture file'}],source:{kind:'user'}}));await agent.whenIdle();
  assert.equal(requests.length,4,JSON.stringify(agent.session.snapshotEvents().slice(-3)));
  assert.ok(!requests[0].tools.includes('glob'));
  assert.ok(!requests[1].tools.includes('glob'));
  assert.ok(requests[2].tools.includes('glob'));
  assert.equal(executions,1);
  assert.ok(!JSON.stringify(requests).includes('FULL_BODY_ONLY_AFTER_SELECTION'));
  assert.ok(!ctx.get('dshOnDemandTools').snapshot(agent).names.includes('glob'),'idle resets selections');
  agent.followup(createUserMessage({content:[{type:'text',text:'Use the fixture skill'}],source:{kind:'user'}}));await agent.whenIdle();
  assert.equal(requests.length,6);
  assert.ok(!requests[4].tools.includes('glob'));
  assert.ok(JSON.stringify(requests[5].messages).includes('FULL_BODY_ONLY_AFTER_SELECTION'));
  const catalogs=agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.source.kind==='skill-catalog');
  assert.equal(catalogs.length,1,'catalog is persisted once, not appended every step');
  assert.ok(catalogs[0].data.source.entries[0].description.length<=160);
});
