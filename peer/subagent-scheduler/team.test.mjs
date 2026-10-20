import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Context} from '@deepseek-ai/cordis';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionQuery from '@deepseek-ai/dsh-session-query';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Subagents from '@deepseek-ai/dsh-subagent';
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process';
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process';
import * as NativeTool from '@deepseek-ai/dsh-tool-subagent';
import Settings from '@deepseek-ai/dsh-tool-subagent/model-selection-settings';
import Teams from '@deepseek-ai/dsh-experimental-agent-team';
import * as TeamTools from '@deepseek-ai/dsh-experimental-tool-agent-team';
import LocalFs from '@deepseek-ai/dsh-fs-local';
import Llm, {LlmAdapter, createUserMessage} from '@deepseek-ai/dsh-llm';
import {apply} from './index.mjs';

test('real Team tools preserve explicit model routes, authority, quota and reuse', async t => {
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsh-team-model-')));
  const previous=process.env.DSH_HOME;process.env.DSH_HOME=home;
  const ctx=new Context(), handles=[];
  t.after(async()=>{for(const h of [...handles].reverse())await h.dispose();await ctx.fiber.dispose();if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;fs.rmSync(home,{recursive:true,force:true});});
  ctx.provide('connection',{rpc:{handle(){}},requestRejection(){}});
  ctx.provide('webServer',{register(){return()=>{};}});
  for(const plugin of [Llm,Sessions,Projections])await ctx.plugin(plugin);
  await ctx.plugin(Persistence.default??Persistence,{root:path.join(home,'sessions')});
  for(const plugin of [SessionQuery,Agents,SystemPrompt,LocalFs])await ctx.plugin(plugin);
  try {const {default:WorkingDirectory}=await import('@deepseek-ai/dsh-working-directory');await ctx.plugin(WorkingDirectory,{defaultDirectory:home});} catch(e) {if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
  for(const plugin of [Tools,Loop,Subagents,Spawn,Fork])await ctx.plugin(plugin);
  const routes=[{provider:'fixture',model:'light'},{provider:'fixture',model:'strong'},{provider:'fixture',model:'unknown'}];
  await ctx.plugin(Settings,{enabled:true,allowedModels:routes});
  await ctx.plugin(Teams);
  TeamTools.apply(ctx);
  const calls=[];let active=0,maxActive=0;
  class Fixture extends LlmAdapter {
    async resolveModel(provider,id){if(id==='unknown')throw Error('unknown fixture model');return {provider,id,name:id,contextWindow:32768,maxTokens:2048,inputModalities:['text'],...(id==='strong'?{reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}}:{})};}
    async *stream(o){calls.push({id:o.sessionId,provider:o.provider,model:o.model,effort:o.reasoningEffort});active++;maxActive=Math.max(maxActive,active);try{await delay(20);yield {type:'text-delta',index:0,text:'LOCAL_'+o.model};yield {type:'finish',reason:{kind:'stop'}};}finally{active--;}}
  }
  ctx.llm.registerAdapter(['fixture'],new Fixture());
  const h=await ctx.agents.create({sessionId:'team-main',meta:{cwd:home},agentOptions:{provider:'fixture',model:'parent'}});handles.push(h);
  const parent=h.agent;
  NativeTool.apply(ctx,{provider:'spawn',modelSelectionSettings:true,toolName:'subagent'},parent.session);
  const scheduler=apply(ctx);
  scheduler.save({...scheduler.config,minIntervalMs:0,routes:routes.map(r=>({...r,tasks:['general'],quotaGroup:'one-account'}))},0);
  let callNumber=0;
  const invoke=(name,args,agent=parent,signal=AbortSignal.timeout(10000))=>ctx.tools.execute({callId:'fixture-'+(++callNumber),name,arguments:args,agent,signal});
  const text=r=>r.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n')??JSON.stringify(r);
  const spawn=(name,route={},context='fresh')=>invoke('spawn_teammate',{name,description:'local task',prompt:'local result only',context,...route});
  const members=()=>ctx.agentTeams.listMembers(parent);
  const wait=async()=>{
    if(typeof ctx.subagents.waitForChildren==='function')await ctx.subagents.waitForChildren(parent);
    else {let settled=false;for(let n=0;n<200;n++){
      await delay(10);settled=true;
      for(const m of members().filter(m=>m.role==='teammate')){
        const observation=await ctx.get('sessionQuery').observeSession(m.id);
        try {const events=observation.events.slice(observation.inheritedEventCount),start=events.findLastIndex(e=>e.type==='turn/start'),end=events.findLastIndex(e=>e.type==='turn/end');if(start<0||end<start)settled=false;}finally{observation[Symbol.dispose]();}
      }
      if(settled)break;
    }assert(settled,'Team children must finish their turns');}
    await parent.whenIdle();
  };

  let casesPassed=0;const check=async(name,run)=>t.test(name,async st=>{await run(st);casesPassed++;});

  await check('schema exposes model fields and missing/partial/unauthorized selection creates no member',async()=>{
    const schema=ctx.tools.schemas(parent).find(s=>s.name==='spawn_teammate');
    assert(schema.parameters.properties.provider);assert(schema.parameters.properties.model);assert(schema.parameters.properties.reasoning_effort);
    for(const route of [{},{provider:'fixture'},{model:'light'},{provider:'fixture',model:'outside'},{provider:'not-authorized',model:'light'}]){
      const r=await spawn('retryable-name',route);assert(r.isError,text(r));
      assert.equal(members().length,1);assert.equal(calls.length,0);
    }
  });
  await check('metadata and effort errors are rejected before a roster name is reserved',async()=>{
    for(const route of [routes[2],{...routes[1],reasoning_effort:'unsupported'}]){const r=await spawn('retryable-name',route);assert(r.isError,text(r));assert.equal(members().length,1);assert.equal(calls.length,0);}
  });
  await check('fresh and fork teammates use distinct selected models with shared-account serialization',async()=>{
    const results=await Promise.all([spawn('magpie-re',{...routes[1],reasoning_effort:'high'}),spawn('dsh-inventory',routes[0],'fork')]);
    for(const r of results)assert(!r.isError,text(r));
    await wait();
    assert.deepEqual(calls.filter(c=>c.id!=='team-main').map(c=>c.model).sort(),['light','strong']);
    assert.equal(maxActive,1);assert(calls.some(c=>c.model==='strong'&&c.effort==='high'));assert(calls.filter(c=>c.model==='light').every(c=>c.effort===undefined));
    assert.equal(members().filter(m=>m.role==='teammate').length,2);
    assert(members().filter(m=>m.role==='teammate').every(m=>m.status==='inactive'));
  });
  await check('reuse and child report keep the selected route',async()=>{
    const member=members().find(m=>m.name==='magpie-re');
    const before=calls.filter(c=>c.id===member.id).length;
    const r=await invoke('send_message',{target:'magpie-re',message:'local follow up'});assert(!r.isError,text(r));await wait();
    assert.equal(calls.filter(c=>c.id===member.id).length,before+1);
    assert(calls.filter(c=>c.id===member.id).every(c=>c.model==='strong'));
  });
  await check('master switch blocks Team creation and follow-up while allowing child reports',async st=>{
    scheduler.save({...scheduler.config,delegationEnabled:false},scheduler.revision);
    st.after(()=>{if(!scheduler.config.delegationEnabled)scheduler.save({...scheduler.config,delegationEnabled:true},scheduler.revision);});
    const count=members().length,before=calls.length;
    assert((await spawn('disabled-child',routes[0])).isError);
    assert((await invoke('send_message',{target:'magpie-re',message:'must not run'})).isError);
    assert.equal(members().length,count);assert.equal(calls.length,before);
    const member=members().find(m=>m.name==='magpie-re');
    let child=ctx.agents.get(member.id);if(!child){const childHandle=await ctx.agents.resume({resumeSessionId:member.id,parentAgent:parent,agentOptions:routes[1]});handles.push(childHandle);child=childHandle.agent;}
    const report=await invoke('send_message',{target:'lead',message:'accepted task finished'},child);assert(!report.isError,text(report));await parent.whenIdle();
    scheduler.save({...scheduler.config,delegationEnabled:true},scheduler.revision);
  });
  await check('cancelled creation and malformed direct route are denied, then a corrected name succeeds',async()=>{
    const abort=new AbortController();abort.abort();const count=members().length;
    const cancelled=await invoke('spawn_teammate',{name:'cancelled-child',description:'local',prompt:'local',...routes[0]},parent,abort.signal);assert(cancelled.isError);assert.equal(members().length,count);
    const start=route=>typeof ctx.subagents.startActivation==='function'?ctx.subagents.startActivation({provider:'spawn',request:{parent,prompt:[],agentOptions:route},delivery:'caller',signal:AbortSignal.timeout(10000)}):ctx.subagents.startContinuable({provider:'spawn',request:{parent,prompt:[],agentOptions:route},signal:AbortSignal.timeout(10000)});
    for(const route of [{provider:'fixture'},{provider:'fixture',model:'outside'}])await assert.rejects(async()=>start(route),/必须同时|授权列表/);
    const recovered=await spawn('retryable-name',routes[0]);assert(!recovered.isError,text(recovered));await wait();
    assert(members().some(m=>m.name==='retryable-name'&&m.status==='inactive'));
    assert.equal(scheduler.status().queued.length,0);assert.equal(scheduler.status().active.length,0);
  });
  assert.equal(casesPassed,6,'all Team integration cases must pass before writing a receipt');
  if(process.env.DSH_TEAM_TEST_REPORT)fs.writeFileSync(process.env.DSH_TEAM_TEST_REPORT,JSON.stringify({passed:true,routeCalls:calls,maxActive,memberCount:members().length-1,missingSelectionNoMember:true,unauthorizedNoInference:true,reuseKeepsModel:true,masterSwitchBlocksTeamMessages:true,childReportsAllowed:true,cancelThenRecovery:true,cloudRequests:0},null,2)+'\n');
});
