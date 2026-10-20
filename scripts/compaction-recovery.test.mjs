import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
const {BasicCompactionEngine} = await import(process.env.DSH_PHONE_COMPACTION_SOURCE
  ? pathToFileURL(process.env.DSH_PHONE_COMPACTION_SOURCE)
  : new URL('../runtime/overlays/@deepseek-ai/dsh-compaction-basic/lib/index.js', import.meta.url));
import {estimateMessage} from '@deepseek-ai/dsh-token-meter/estimate';

const agent = () => ({options:{provider:'fixture',model:'local'},session:{id:'fixture-session',requestHeader:()=>({config:{provider:'fixture',model:'local'}}),toolHistory:()=>[]}});
function fixture(config={}) {
  const ctx=new Context(), hooks={};
  ctx.provide('tokenMeter',{estimateMessage});
  const on=ctx.on.bind(ctx);ctx.on=(name, fn)=>{hooks[name]=fn;return on(name,fn);};
  const engine=new BasicCompactionEngine(ctx,config);
  return {ctx,engine,hooks};
}

test('default summary is bounded while explicit output budget is preserved',()=>{
  assert.equal(fixture({auto:false}).engine.config.maxTokens,8192);
  assert.equal(fixture({auto:false,maxTokens:20000}).engine.config.maxTokens,20000);
});

test('summary uses declared output capacity and low effort without changing main selection',async()=>{
  const {ctx,engine}=fixture({auto:false});let call;
  ctx.provide('llm',{
    resolveModelInfo:async()=>({context:{contextWindow:32768},defaultMaxTokens:1024,reasoning:{efforts:[{id:'high'},{id:'low'}]}}),
    async *stream(options){call=options;yield {type:'text-delta',index:0,text:'本地摘要：保留目标、结果、路径和待办。'};yield {type:'finish',reason:{kind:'stop'}};}
  });
  const a=agent(),before=structuredClone(a.options);
  const result=await engine.summarize({messages:[{role:'user',content:[{type:'text',text:'本地压缩测试'}]}]},a,new AbortController().signal);
  assert.equal(call.maxTokens,1024);assert.equal(call.reasoningEffort,'low');assert.equal(call.purpose,'compaction');
  assert.equal(result.maxTokens,1024);assert(result.summary[0].text.includes('本地摘要'));assert.deepEqual(a.options,before);
});

test('two failed automatic compactions stop the turn and do not issue a third attempt',async()=>{
  const {engine,hooks}=fixture();let calls=0,next=0;const a=agent(),signal=new AbortController().signal;
  engine.compactIfNeeded=async()=>{calls++;throw Error('Local summary unavailable');};
  await hooks['agent/pre-step']({agent:a,signal},()=>next++);
  await assert.rejects(hooks['agent/pre-step']({agent:a,signal},()=>next++),e=>e.code==='COMPACTION_FAILED');
  await assert.rejects(hooks['agent/pre-step']({agent:a,signal},()=>next++),e=>e.code==='COMPACTION_FAILED');
  assert.equal(calls,2);assert.equal(next,1);
  hooks['agent/status']({agent:a,status:'idle'});assert.equal(engine.pressureFailures.has(a),false);
});

test('successful pressure reduction resets the failure budget',async()=>{
  const {engine,hooks}=fixture();const a=agent(),signal=new AbortController().signal;let fail=true;
  engine.compactIfNeeded=async()=>{if(fail)throw Error('Local failure');return null;};
  await hooks['agent/pre-step']({agent:a,signal},()=>{});assert.equal(engine.pressureFailures.get(a),1);
  fail=false;await hooks['agent/pre-step']({agent:a,signal},()=>{});assert.equal(engine.pressureFailures.has(a),false);
  fail=true;await hooks['agent/pre-step']({agent:a,signal},()=>{});assert.equal(engine.pressureFailures.get(a),1);
});

test('cancelled summary preserves interruption and makes no provider call',async()=>{
  const {ctx,engine,hooks}=fixture();let providerCalls=0;const a=agent(),abort=new AbortController();
  ctx.provide('llm',{resolveModelInfo:async()=>{providerCalls++;throw Error('must not execute');}});
  abort.abort();await assert.rejects(engine.summarize({messages:[]},a,abort.signal),e=>e.name==='AbortError');
  await hooks['agent/pre-step']({agent:a,signal:abort.signal},()=>{});
  assert.equal(providerCalls,0);assert.equal(engine.pressureFailures.has(a),false);
});
