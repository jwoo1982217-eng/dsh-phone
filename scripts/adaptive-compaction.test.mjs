import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import Agents, {installModelSelection} from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Llm, {LlmAdapter, LlmError, createUserMessage} from '@deepseek-ai/dsh-llm';
import {estimateMessage} from '@deepseek-ai/dsh-token-meter/estimate';
const {BasicCompactionEngine} = await import(process.env.DSH_PHONE_COMPACTION_SOURCE
  ? pathToFileURL(process.env.DSH_PHONE_COMPACTION_SOURCE)
  : new URL('../runtime/overlays/@deepseek-ai/dsh-compaction-basic/lib/index.js', import.meta.url));
import {transcriptGroups, splitText} from '../runtime/overlays/@deepseek-ai/dsh-compaction-basic/lib/summary-budget.mjs';
import {compactionTarget, pressureHeader, trackAssembledTargets} from '../runtime/overlays/@deepseek-ai/dsh-compaction-basic/lib/summary-target.mjs';
const {installModelSelectionProjection} = await import(process.env.DSH_PHONE_TEST_MODULES
  ? pathToFileURL(path.join(process.env.DSH_PHONE_TEST_MODULES, '@deepseek-ai/dsh-api-session-controller/lib/types/model-selection-projection.js'))
  : new URL('../runtime/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/model-selection-projection.js', import.meta.url));

const message = text => ({role:'user',content:[{type:'text',text}]});
const signal = () => new AbortController().signal;
const answer = '## Primary Request and Intent\n- Implement local audio import.\n## Files and Code\n- LocalAudioBookImporter.kt: check EventBus.\n## Errors and Fixes\n- Verify on disk before resuming.\n## Pending Jobs\n- Compile and test.\n## Next Step\n- Read the current diff; do not repeat an uncertain write.';

function fixture(t, {window=16384, output=1024, stream, persistent=false, config={}}={}) {
  const ctx=new Context(), calls=[];
  ctx.provide('tokenMeter',{estimateMessage});
  ctx.provide('llm',{
    async resolveModelInfo(){return {context:{contextWindow:window},defaultMaxTokens:output};},
    async *stream(options){calls.push(options);if(stream){yield* stream(options,calls.length);return;}
      yield {type:'text-delta',index:0,text:answer};yield {type:'finish',reason:{kind:'stop'}};}
  });
  const engine=new BasicCompactionEngine(ctx,{auto:false,maxTokens:output,...config});
  const agent={options:{provider:'fixture',model:'small'},session:{id:'test-'+Math.random(),requestHeader:()=>({config:{provider:'fixture',model:'small'}}),toolHistory:()=>({tools:[],updates:[]})}};
  if(persistent){const old=process.env.DSH_HOME,home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-summary-'));process.env.DSH_HOME=home;agent.session.header={cwd:home};
    t.after(()=>{if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old;fs.rmSync(home,{recursive:true,force:true});});}
  t.after(()=>ctx.fiber.dispose());
  return {ctx,engine,agent,calls};
}

test('small requests retain cacheable prefix and tools; no main-model or input mutation',async t=>{
  const f=fixture(t),input={messages:[message('original task')],tools:[{name:'read',description:'read',parameters:{}}]},before=structuredClone(input);
  const r=await f.engine.summarize(input,f.agent,signal());
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].messages[0],input.messages[0]);assert.deepEqual(f.calls[0].tools,input.tools);
  assert.deepEqual(input,before);assert.equal(r.model,'small');assert.equal(f.agent.options.model,'small');
});

test('an oversized CJK transcript is split into bounded requests and merged',async t=>{
  const f=fixture(t,{window:262144,output:8192});
  const input={messages:Array.from({length:52},(_,i)=>message(`SOURCE-${i} `+'本地音频导入验证。'.repeat(1400)))};
  const r=await f.engine.summarize(input,f.agent,signal());
  assert(f.calls.length>2);assert.match(r.summary[0].text,/LocalAudioBookImporter/);
  const requests=f.calls.map(c=>JSON.stringify(c.messages));
  for(let i=0;i<52;i++)assert(requests.some(s=>s.includes(`SOURCE-${i} `)),`source ${i} retained`);
  for(const c of f.calls){assert(Buffer.byteLength(JSON.stringify(c.messages))<262144*2);assert.equal(c.purpose,'compaction');assert(!c.tools);assert.equal(c.toolHistory,undefined);}
});

test('provider-confirmed overflow halves the input instead of retrying the same request',async t=>{
  const f=fixture(t,{stream:async function*(o){
    if(JSON.stringify(o.messages).length>14000)throw new LlmError('pi-ai detected context overflow','CONTEXT_WINDOW_EXCEEDED');
    yield {type:'text-delta',index:0,text:answer};yield {type:'finish',reason:{kind:'stop'}};
  }});
  await f.engine.summarize({messages:[message('x'.repeat(45000))]},f.agent,signal());
  assert(f.calls.some(c=>JSON.stringify(c.messages).length>14000));assert(f.calls.some(c=>JSON.stringify(c.messages).length<14000));
  const over=f.calls.filter(c=>JSON.stringify(c.messages).length>14000).map(c=>JSON.stringify(c.messages));
  assert.equal(new Set(over).size,over.length,'no identical rejected requests');
});

test('authentication failure stops without capacity retries',async t=>{
  const f=fixture(t,{stream:async function*(){throw new LlmError('authentication required','AUTH');}});
  await assert.rejects(f.engine.summarize({messages:[message('x'.repeat(70000))]},f.agent,signal()),e=>e.code==='AUTH');assert.equal(f.calls.length,1);
});

test('completed batches survive failure and are reused after a fresh engine starts',async t=>{
  let fail=true;
  const f=fixture(t,{persistent:true,stream:async function*(o,n){if(n===2&&fail)throw new LlmError('local service unavailable','SERVER');yield {type:'text-delta',index:0,text:answer};yield {type:'finish',reason:{kind:'stop'}};}});
  const input={messages:Array.from({length:8},(_,i)=>message(`part ${i} `+'a'.repeat(17000)))};
  await assert.rejects(f.engine.summarize(input,f.agent,signal()),e=>e.code==='SERVER');
  const completed=JSON.stringify(f.calls[0].messages);fail=false;
  const nextCtx=new Context();nextCtx.provide('tokenMeter',f.ctx.tokenMeter);nextCtx.provide('llm',f.ctx.llm);t.after(()=>nextCtx.fiber.dispose());
  const next=new BasicCompactionEngine(nextCtx,{auto:false,maxTokens:1024});await next.summarize(input,f.agent,signal());
  assert.equal(f.calls.filter(c=>JSON.stringify(c.messages)===completed).length,1);
  const p=path.join(process.env.DSH_HOME,'storage/context-recovery');const record=JSON.parse(fs.readFileSync(path.join(p,fs.readdirSync(p)[0])));
  assert(record.reused>0);assert.equal(record.phase,'prepared');assert.match(record.task.originalRequest,/part 0/);
});

test('cancelled and truncated streams never produce a checkpoint summary',async t=>{
  for(const mode of ['cancel','truncated','no-finish']){
    const abort=new AbortController();const f=fixture(t,{stream:async function*(){yield {type:'text-delta',index:0,text:'partial'};if(mode==='cancel')abort.abort();if(mode==='truncated')yield {type:'finish',reason:{kind:'max-tokens'}};}});
    await assert.rejects(f.engine.summarize({messages:[message('task')]},f.agent,abort.signal));
  }
});

test('unknown capacity fails before contacting the provider',async t=>{
  const f=fixture(t);f.ctx.llm.resolveModelInfo=async()=>({});
  await assert.rejects(f.engine.summarize({messages:[message('task')]},f.agent,signal()),e=>e.code==='COMPACTION_CAPACITY_UNKNOWN');assert.equal(f.calls.length,0);
});

test('an explicit summary route is honored without changing the conversation route',async t=>{
  const f=fixture(t,{config:{summarizationProvider:'chosen-summary',summarizationModel:'long-context'}});
  await f.engine.summarize({messages:[message('task')]},f.agent,signal());
  assert.equal(f.calls[0].provider,'chosen-summary');assert.equal(f.calls[0].model,'long-context');assert.equal(f.agent.options.provider,'fixture');
});

test('damaged progress is preserved; changed source never reuses an earlier batch',async t=>{
  const f=fixture(t,{persistent:true}),input={messages:[message('original task')]};
  await f.engine.summarize(input,f.agent,signal());const dir=path.join(process.env.DSH_HOME,'storage/context-recovery'),file=path.join(dir,fs.readdirSync(dir)[0]);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  await f.engine.summarize({messages:[message('different task')]},f.agent,signal());assert.equal(f.calls.length,2);
  fs.writeFileSync(file,'damaged-progress');await f.engine.summarize(input,f.agent,signal());assert.equal(f.calls.length,3);assert.equal(fs.readFileSync(file,'utf8'),'damaged-progress');
});

test('an impossible summary envelope is rejected locally without falsifying capacity',async t=>{
  const f=fixture(t,{window:2048,output:2048});
  await assert.rejects(f.engine.summarize({messages:[message('task')]},f.agent,signal()),e=>e.code==='COMPACTION_ENVELOPE_TOO_LARGE');assert.equal(f.calls.length,0);
});

test('tool pairs stay grouped and oversized Unicode records are losslessly fragmented',()=>{
  const call={role:'assistant',content:[{type:'tool-call',id:'c1',name:'edit',arguments:'{}'}]};
  const result={role:'tool',toolCallId:'c1',content:[{type:'text',text:'observed edit result'}]};
  const groups=transcriptGroups([message('goal'),call,result,message('next')]);assert.equal(groups.length,3);assert(groups[1].includes('observed edit result'));assert(groups[1].includes('"name":"edit"'));
  const text='源码🙂'.repeat(15000),parts=splitText(text,3000);assert.equal(parts.join(''),text);assert(parts.every(p=>!/[\uD800-\uDBFF]$/.test(p)));
});

test('pending user selection wins over the previous header without inheriting old adapter defaults',()=>{
  const ctx=new Context();ctx.provide('sessionProjections',{stateOf:()=>({pending:{provider:'new',model:'small'}})});
  const a={options:{provider:'old',model:'large'},session:{requestHeader:()=>({config:{provider:'old',model:'large',maxTokens:256000},adapterDefaults:{maxTokens:true}})}};
  assert.deepEqual(compactionTarget(ctx,a),{provider:'new',model:'small'});assert.equal(pressureHeader(a,compactionTarget(ctx,a)).config.maxTokens,undefined);
  assert.equal(a.session.requestHeader().config.maxTokens,256000);
});

test('an assembled step keeps its route when the human selects a different model during compaction',async t=>{
  const ctx=new Context(),hooks={};t.after(()=>ctx.fiber.dispose());const on=ctx.on.bind(ctx);ctx.on=(event,fn,...rest)=>{hooks[event]=fn;return on(event,fn,...rest);};
  const targets=trackAssembledTargets(ctx),agent={};
  await hooks['system-prompt/assemble']({}, {agent},async()=>({variables:{provider:'original',model:'current-step'}}));
  assert.deepEqual(targets.get(agent),{provider:'original',model:'current-step'});
  hooks['agent/status']({agent,status:'idle'});assert.equal(targets.get(agent),undefined);
});

test('real model-selection projection triggers compaction before a switch from 1M to 32K',async t=>{
  const ctx=new Context();t.after(()=>ctx.fiber.dispose());const calls=[];
  await ctx.plugin(Llm);class Adapter extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:id==='large'?1000000:32768},defaultMaxTokens:1024};}
    async *stream(o){calls.push(o);yield {type:'text-delta',index:0,text:answer};yield {type:'finish',reason:{kind:'stop'}};}
  }
  ctx.llm.registerAdapter(['fixture'],new Adapter());await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(TokenMeter);installModelSelectionProjection(ctx);
  const session=ctx.sessions.create('switch'),agent={session,options:{provider:'fixture',model:'large'}};
  session.append('request/header',{header:{config:{provider:'fixture',model:'large',maxTokens:256000},adapterDefaults:{maxTokens:true}},reason:'initial'});
  session.append('turn/start',{turn:1});
  for(let i=0;i<12;i++)session.append('user/message',createUserMessage({content:[{type:'text',text:'source '+i+'x'.repeat(12000)}],source:{kind:'user'}}),{surfaceOp:'append'});
  session.append('model/selection',{provider:'fixture',model:'small'});
  const engine=new BasicCompactionEngine(ctx,{auto:false,maxTokens:1024,headroomTokens:2048,retainTokens:2048});
  assert(await engine.compactIfNeeded(agent,'pressure',signal()));assert(calls.length>1);assert(calls.every(c=>c.model==='small'));
  assert.equal(session.requestHeader().config.model,'large','maintenance does not fake a routed request header');
  assert.equal(ctx.sessionProjections.stateOf(session,'modelSelection').pending.model,'small','human selection is preserved');
});

test('real SDK Session transaction leaves history unchanged on failure, then commits and preserves a paired recent tail',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-compaction-native-')),ctx=new Context();t.after(async()=>{await ctx.fiber.dispose();fs.rmSync(home,{recursive:true,force:true});});
  let failing=true;const requests=[];
  await ctx.plugin(Llm);class Adapter extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:32768},defaultMaxTokens:1024};}
    async *stream(o){requests.push(o);if(failing)throw new LlmError('fixture authentication required','AUTH');yield {type:'text-delta',index:0,text:answer};yield {type:'finish',reason:{kind:'stop'}};}
  }
  ctx.llm.registerAdapter(['fixture'],new Adapter());await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(TokenMeter);
  await ctx.plugin(BasicCompactionEngine,{auto:false,maxTokens:1024,headroomTokens:2048,retainTokens:2048});const engine=ctx.compaction;
  const session=ctx.sessions.create('native',{meta:{cwd:home}});
  session.append('system/message',{turn:1,step:1,message:{role:'system',content:[{type:'text',text:'Keep user requirements.'}],id:'sys'}},{surfaceOp:'append'});
  session.append('request/header',{header:{config:{provider:'fixture',model:'small'}},reason:'initial'});
  session.append('turn/start',{turn:1});
  for(let i=0;i<20;i++)session.append('user/message',createUserMessage({content:[{type:'text',text:`task ${i} `+'x'.repeat(6000)}],source:{kind:'user'}}),{surfaceOp:'append'});
  session.append('step/start',{turn:1,step:1});
  session.append('assistant/message',{turn:1,step:1,message:{role:'assistant',id:'read-call',content:[{type:'tool-call',id:'paired-read',name:'read',arguments:'{}'}]},stream:[]},{surfaceOp:'append'});
  session.append('tool/result',{turn:1,step:1,message:{role:'tool',id:'read-result',toolCallId:'paired-read',content:[{type:'text',text:'retained actual result '+'x'.repeat(9000)}],isError:false}},{surfaceOp:'append'});
  session.append('step/end',{turn:1,step:1});
  const a={session,options:{provider:'fixture',model:'small'}};const surface=[...session.surface.nodes];
  await assert.rejects(engine.compactIfNeeded(a,'pressure',signal()),e=>e.code==='AUTH');assert.deepEqual(session.surface.nodes,surface);assert(!session.snapshotEvents().some(e=>e.type==='compaction/summary'));
  failing=false;const result=await engine.compactIfNeeded(a,'pressure',signal());assert(result);assert(session.surface.nodes.length<surface.length);assert.equal(session.surface.nodes[0],surface[0]);assert.equal(session.surface.nodes.at(-1),surface.at(-1));
  assert(session.surface.nodes.includes(surface.at(-2)),'call kept with recent result');assert(ctx.tokenMeter.measure(session).totalTokens<32768);assert(requests.every(r=>r.purpose==='compaction'));
});

test('the real Agent loop compacts for the selected model, then executes one tool and completes',async t=>{
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsh-compaction-loop-'))),ctx=new Context();
  let handle; t.after(async()=>{await handle?.dispose();await ctx.fiber.dispose();fs.rmSync(home,{recursive:true,force:true});});
  const calls=[];let reads=0;const marker='observed_'+Math.random().toString(36).slice(2),file=path.join(home,'actual-read.txt');fs.writeFileSync(file,marker);
  await ctx.plugin(Llm);class Adapter extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:id==='large'?1000000:32768},defaultMaxTokens:1024};}
    async *stream(o){calls.push(o);
      if(o.purpose==='compaction'){yield {type:'text-delta',index:0,text:answer};}
      else if(o.messages.some(m=>m.role==='tool')){assert(o.messages.some(m=>m.role==='tool'&&JSON.stringify(m).includes(marker)),'actual file content returned through the tool protocol');yield {type:'text-delta',index:0,text:'Observed file content: '+marker};}
      else {yield {type:'tool-call-delta',index:0,id:'read-after-compaction',name:'read',argumentsDelta:'{}'};yield {type:'finish',reason:{kind:'tool-calls'}};return;}
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Adapter());await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(TokenMeter);installModelSelectionProjection(ctx);
  await ctx.plugin(Agents);await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(Loop);
  await ctx.plugin(BasicCompactionEngine,{maxTokens:1024,headroomTokens:2048,retainTokens:2048});
  ctx.tools.register({name:'read',description:'Read the local fixture',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:()=>{reads++;return fs.readFileSync(file,'utf8');}});
  const seed=ctx.sessions.create('seed');seed.append('request/header',{header:{config:{provider:'fixture',model:'large',maxTokens:256000},adapterDefaults:{maxTokens:true}},reason:'initial'});
  seed.append('turn/start',{turn:1});
  for(let i=0;i<18;i++)seed.append('user/message',createUserMessage({content:[{type:'text',text:`history ${i} `+'x'.repeat(9000)}],source:{kind:'user'}}),{surfaceOp:'append'});
  seed.append('turn/end',{turn:1,reason:{kind:'completed'}});seed.append('model/selection',{provider:'fixture',model:'small'});
  handle=await ctx.agents.create({sessionId:'compaction-loop',seed:seed.snapshotEvents(),meta:{cwd:home},agentOptions:{provider:'fixture',model:'large'},setup:agentCtx=>{installModelSelection(agentCtx,{current:{provider:'fixture',model:'small'}});}});
  const agent=handle.agent;agent.followup(createUserMessage({content:[{type:'text',text:'Read the local fixture once and report the observed result.'}],source:{kind:'user'}}));await agent.whenIdle();
  const events=agent.session.snapshotEvents(),end=events.filter(e=>e.type==='turn/end').at(-1);
  assert.equal(end.data.reason.kind,'completed',JSON.stringify(end.data));assert.equal(reads,1);
  assert(events.some(e=>e.type==='compaction/summary'),'automatic compaction committed');
  const main=calls.filter(c=>c.purpose!=='compaction');assert.equal(main.length,2);assert(calls.every(c=>c.model==='small'));
  assert(calls.indexOf(main[0])>0,'summaries precede the first main request');
  assert(main.every(c=>c.messages.reduce((n,m)=>n+estimateMessage(m),0)+(c.maxTokens??1024)<32768),'input plus reserved output fits the new window');
  assert(main[0].messages.some(m=>JSON.stringify(m).includes('Read the local fixture once')),'latest user task survives');
  assert.equal(events.filter(e=>e.type==='tool/result').length,1);
  assert(events.filter(e=>e.type==='assistant/message').some(e=>e.data.message.content.some(b=>b.type==='text'&&b.text.includes(marker))),'final answer uses the observed file content');
});
