import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {pathToFileURL} from 'node:url';
import Sessions from '@deepseek-ai/dsh-session';
import Llm, {LlmAdapter, LlmError} from '@deepseek-ai/dsh-llm';
import {estimateMessage} from '@deepseek-ai/dsh-token-meter/estimate';
const {BasicCompactionEngine} = await import(process.env.DSH_PHONE_COMPACTION_SOURCE
  ? pathToFileURL(process.env.DSH_PHONE_COMPACTION_SOURCE)
  : new URL('../runtime/overlays/@deepseek-ai/dsh-compaction-basic/lib/index.js', import.meta.url));

const answer = 'Summary: preserve the user goal, observed results and unfinished verification; inspect current files before continuing.';
const message = text => ({role:'user',content:[{type:'text',text}]});

async function fixture(t, toolUpdate, stream) {
  const ctx = new Context(), calls = [];
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Llm);
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return {provider, id, name:id, context:{contextWindow:16384}, defaultMaxTokens:1024,
        ...(toolUpdate === undefined ? {} : {toolUpdate})};
    }
    async *stream(options) {
      calls.push(options);
      if (stream) { yield* stream(options, calls.length); return; }
      yield {type:'text-delta',index:0,text:answer};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter());
  await ctx.plugin(Sessions);
  ctx.provide('tokenMeter', {estimateMessage});
  const session = ctx.sessions.create('toolhistory-regression');
  session.append('request/header', {header:{config:{provider:'fixture',model:'summary'}},reason:'initial'});
  const agent = {session,options:{provider:'fixture',model:'summary'}};
  const engine = new BasicCompactionEngine(ctx, {auto:false,maxTokens:1024});
  return {ctx,agent,engine,calls};
}

for (const mode of ['addition-only','in-history',undefined]) {
  test(`segmented summaries reach the real SDK adapter with tool updates ${mode ?? 'unsupported'}`, async t => {
    const f = await fixture(t, mode);
    const input = {messages:Array.from({length:8}, (_,i) => message(`SOURCE-${i} `+'x'.repeat(15000)))};
    const before = structuredClone(input), history = f.agent.session.toolHistory();
    const result = await f.engine.summarize(input, f.agent, new AbortController().signal);
    assert.equal(result.summary[0].text, answer);
    assert(f.calls.length > 2, 'both fragments and merge reach adapter dispatch');
    assert.deepEqual(input, before);
    assert.deepEqual(f.agent.session.toolHistory(), history);
    for (const call of f.calls) {
      assert.equal(call.tools, undefined);
      assert.equal(call.toolHistory, undefined, 'serialized transcript has no live tool update history');
      assert.equal(call.purpose, 'compaction');
    }
  });
}

test('the direct path preserves the actual Session tool history and declarations', async t => {
  const f = await fixture(t, 'addition-only');
  const tools = [{name:'read',description:'Read a file',parameters:{type:'object',properties:{}}}];
  f.agent.session.append('request/header', {header:{config:{provider:'fixture',model:'summary'},tools},reason:'initial'});
  const input = {messages:[message('Preserve this task')],tools};
  const result = await f.engine.summarize(input, f.agent, new AbortController().signal);
  assert.equal(result.summary[0].text, answer);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].toolHistory, f.agent.session.toolHistory());
  assert.deepEqual(f.calls[0].tools, tools);
});

test('provider-confirmed overflow switches from direct history to transcript-only fragments', async t => {
  const f = await fixture(t, 'addition-only', async function* (options) {
    if (JSON.stringify(options.messages).length > 6000) throw new LlmError('context window exceeded', 'CONTEXT_WINDOW_EXCEEDED');
    yield {type:'text-delta',index:0,text:answer};
    yield {type:'finish',reason:{kind:'stop'}};
  });
  const result = await f.engine.summarize({messages:[message('x'.repeat(20000))]}, f.agent, new AbortController().signal);
  assert.equal(result.summary[0].text, answer);
  assert.deepEqual(f.calls[0].toolHistory, f.agent.session.toolHistory());
  assert(f.calls.slice(1).length > 1);
  assert(f.calls.slice(1).every(c => c.toolHistory === undefined && c.tools === undefined));
});

test('an adapter failure after successful projection preserves the original history', async t => {
  const f = await fixture(t, 'addition-only', async function* () {throw new LlmError('fixture auth failure','AUTH');});
  const input = {messages:[message('x'.repeat(50000))]}, before = structuredClone(input);
  const events = f.agent.session.snapshotEvents();
  await assert.rejects(f.engine.summarize(input, f.agent, new AbortController().signal), e => e.code === 'AUTH');
  assert.equal(f.calls.length, 1, 'request passed SDK tool projection and reached the adapter');
  assert.deepEqual(input, before);
  assert.deepEqual(f.agent.session.snapshotEvents(), events);
});
