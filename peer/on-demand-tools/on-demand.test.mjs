import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Context} from '@deepseek-ai/cordis';
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt';
import {ToolRuntime, defineTool} from '@deepseek-ai/dsh-tools';
import {createScope} from '@deepseek-ai/dsh-scope';
import * as OnDemandTools from './index.mjs';

const output = {schema: {type: 'string'}, render: (_args, value) => [{type: 'text', text: value}]};
async function fixture(t, mode = 'native', recorded = null, language = 'typescript') {
  const ctx = new Context();
  if (mode !== 'native') ctx.provide('ptcRuntime', {language});
  const promptFork = ctx.plugin(SystemPrompt); await promptFork;
  const toolsFork = ctx.plugin(ToolRuntime, {mode}); await toolsFork;
  let service, hostContext, executions = 0;
  const hostFork = ctx.plugin({name: 'on-demand-test', inject: ['systemPrompt', 'tools'], apply(host) {
    hostContext = host;
    if (recorded) for (const schema of recorded) host.tools.register({...schema, output, execute: () => { executions++; return 'actual callback'; }});
    else for (const name of ['read', 'skill', 'ask_user_question', 'bash', 'write', 'mcp__mt__mt_file_list']) host.tools.register(defineTool({name, description: `Use ${name}`, parameters: {value: {type: 'string'}}, output, execute: () => { executions++; return 'actual callback'; }}));
  }});
  await hostFork;
  const demandFork = ctx.plugin(OnDemandTools); await demandFork;
  service = ctx.get('dshOnDemandTools');
  t.after(async () => { await demandFork.dispose(); await hostFork.dispose(); await toolsFork.dispose(); await promptFork.dispose(); });
  function agent(id, parent) {
    const a = {session: {id, header: {cwd: '/fixture'}}};
    const scope = createScope(hostContext, a, parent ? {parent} : undefined);
    a.ctx = scope.ctx;
    t.after(() => scope.dispose());
    return a;
  }
  const a = agent('one');
  const assemble = a => ctx.systemPrompt.assemble({scope: a, agent: a});
  const invoke = (name, args, a = a1) => ctx.tools.execute({agent: a, name, arguments: args, callId: `fixture-${name}`, signal: new AbortController().signal});
  const a1 = a;
  return {ctx, a, service, agent, assemble, invoke, remove: () => demandFork.dispose(), get executions() { return executions; }};
}
const names = assembly => assembly.tools.map(tool => tool.name);
const body = result => JSON.parse(result.content[0].text);

test('real SDK assembles a small initial surface, loads definitions, and executes the original callback', async t => {
  const f = await fixture(t);
  assert.deepEqual(names(await f.assemble(f.a)).sort(), ['ask_user_question', 'read', 'skill', 'tool_load', 'tool_search']);
  assert.equal(f.ctx.tools.get('bash', f.a).name, 'bash', 'presentation must preserve execution registry');
  const found = body(await f.invoke('tool_search', {query: 'bash'}));
  assert.equal(found.tools[0].name, 'bash');
  assert.equal(f.executions, 0, 'discovery and loading never invoke target callbacks');
  assert.equal(body(await f.invoke('tool_load', {names: ['bash']})).loaded[0], 'bash');
  assert.ok(names(await f.assemble(f.a)).includes('bash'));
  assert.equal((await f.invoke('bash', {value: 'fixture'})).content[0].text, 'actual callback');
  assert.equal(f.executions, 1);
});

test('real scope restrictions and monotonic execution guards remain authoritative', async t => {
  const f = await fixture(t);
  f.a.ctx.tools.restrict({deny: ['write']});
  assert.equal(body(await f.invoke('tool_search', {query: 'write'})).total, 0);
  assert.equal((await f.invoke('tool_load', {names: ['write']})).isError, true);
  assert.ok(!names(await f.assemble(f.a)).includes('write'));
  f.ctx.tools.guard(exec => exec.name === 'bash' ? 'fixture permission denied' : undefined);
  await f.invoke('tool_load', {names: ['bash']});
  assert.equal((await f.invoke('bash', {})).isError, true);
  assert.equal(f.executions, 0);
});

test('definitions stay with one task and one agent; parent presentation does not restrict a child', async t => {
  const f = await fixture(t), other = f.agent('other'), child = f.agent('child', f.a);
  await f.invoke('tool_load', {names: ['mcp__mt__mt_file_list']});
  assert.ok(!names(await f.assemble(other)).includes('mcp__mt__mt_file_list'));
  await f.invoke('tool_load', {names: ['bash']}, child);
  assert.ok(names(await f.assemble(child)).includes('bash'));
  assert.ok(!names(await f.assemble(f.a)).includes('bash'));
  f.ctx.emit('agent/status', {agent: f.a, status: 'idle'});
  assert.ok(!names(await f.assemble(f.a)).includes('mcp__mt__mt_file_list'));
});

test('failed loads preserve active definitions, removed tools disappear, and scoped output remains present', async t => {
  const f = await fixture(t);
  await f.invoke('tool_load', {names: ['bash']});
  assert.equal((await f.invoke('tool_load', {names: ['write', 'missing']})).isError, true);
  assert.ok(names(await f.assemble(f.a)).includes('bash'));
  assert.ok(!names(await f.assemble(f.a)).includes('write'));
  const off = f.ctx.tools.register(defineTool({name: 'temporary', description: 'temporary', parameters: {}, output, execute: () => ''}));
  await f.invoke('tool_load', {names: ['temporary']});
  off();
  assert.ok(!names(await f.assemble(f.a)).includes('temporary'));
  f.a.ctx.tools.register(defineTool({name: 'structured_output', description: 'SDK scoped final output', parameters: {}, output, execute: () => ''}));
  f.a.ctx.tools.register(defineTool({name: 'spawn_teammate', description: 'scoped team tool', parameters: {}, output, execute: () => ''}));
  assert.ok(names(await f.assemble(f.a)).includes('structured_output'));
  assert.ok(!names(await f.assemble(f.a)).includes('spawn_teammate'));
  await f.invoke('tool_load',{names:['spawn_teammate']});
  assert.ok(names(await f.assemble(f.a)).includes('spawn_teammate'));
});

test('PTC-only and both modes expose selected SDK bindings without restoring the full catalog', async t => {
  for (const mode of ['ptc', 'both']) {
    const f = await fixture(t, mode);
    let assembly = await f.assemble(f.a), sdk = assembly.sections.find(s => s.name === 'tools:sdk').text;
    assert.ok(sdk.includes('tool_load:'));
    assert.ok(!sdk.includes('mcp__mt__mt_file_list:'));
    assert.ok(names(assembly).includes('run_code'));
    if (mode === 'ptc') assert.deepEqual(names(assembly), ['run_code']);
    // The load callback is reached by a PTC sub-dispatch; native direct calls stay forbidden.
    const load = f.ctx.tools.get('tool_load', f.a);
    await load.execute({names: ['mcp__mt__mt_file_list']}, {agent: f.a, signal: new AbortController().signal});
    assembly = await f.assemble(f.a); sdk = assembly.sections.find(s => s.name === 'tools:sdk').text;
    assert.ok(sdk.includes('mcp__mt__mt_file_list:'));
    assert.ok(!sdk.includes('bash:'));
  }
});

test('actual recorded 127-tool request shrinks while every recorded capability remains discoverable', {skip: !process.env.PRIVATE_DSH_TOOL_SCHEMAS}, async t => {
  const schemas = JSON.parse(fs.readFileSync(process.env.PRIVATE_DSH_TOOL_SCHEMAS, 'utf8'));
  const f = await fixture(t, 'native', schemas);
  const before = JSON.stringify(f.ctx.tools.schemas(f.a)).length;
  const assembly = await f.assemble(f.a), after = JSON.stringify(assembly.tools).length;
  assert.ok(after < before * 0.05, `${before} -> ${after}`);
  const found = body(await f.invoke('tool_search', {group: 'mt', query: 'apk', limit: 12}));
  assert.ok(found.total > 0);
  const chosen = found.tools[0].name;
  await f.invoke('tool_load', {names: [chosen]});
  assert.ok(names(await f.assemble(f.a)).includes(chosen));
  assert.equal(f.ctx.tools.schemas(f.a).filter(s => s.name.startsWith('mcp__mt__')).length, 57);
  console.log(JSON.stringify({actualSchemaReplay: {beforeCharacters: before, afterCharacters: after, initialTools: assembly.tools.length, mtRetained: 57, loaded: chosen}}));
});

test('definition budget evicts older selections atomically; cancellation and oversized loads preserve state', async t => {
  const f = await fixture(t);
  for (const name of ['large_a', 'large_b', 'large_c']) f.ctx.tools.register(defineTool({name, description: 'x'.repeat(14000), parameters: {}, output, execute: () => ''}));
  await f.invoke('tool_load', {names: ['large_a']});
  assert.equal((await f.invoke('tool_load', {names: ['large_b', 'large_c']})).isError, true);
  assert.ok(names(await f.assemble(f.a)).includes('large_a'));
  const loaded = body(await f.invoke('tool_load', {names: ['large_b']}));
  assert.deepEqual(loaded.evicted, ['large_a']);
  assert.ok(!names(await f.assemble(f.a)).includes('large_a'));
  const controller = new AbortController(); controller.abort();
  const load = f.ctx.tools.get('tool_load', f.a);
  await assert.rejects(() => load.execute({names: ['bash']}, {agent: f.a, signal: controller.signal}));
  assert.ok(!names(await f.assemble(f.a)).includes('bash'));
  assert.equal(body(await f.invoke('tool_search', {limit: 1})).nextOffset, 1);
});

test('Python PTC catalog is filtered and discovers loaded definitions', async t => {
  const f = await fixture(t, 'ptc', null, 'python');
  let sdk = (await f.assemble(f.a)).sections.find(s => s.name === 'tools:sdk').text;
  assert.ok(sdk.includes('tool_load'));
  assert.ok(!sdk.includes('mt_file_list'));
  await f.ctx.tools.get('tool_load', f.a).execute({names: ['mcp__mt__mt_file_list']}, {agent: f.a, signal: new AbortController().signal});
  sdk = (await f.assemble(f.a)).sections.find(s => s.name === 'tools:sdk').text;
  assert.ok(sdk.includes('mt_file_list'));
});

test('unloading the standalone plugin restores the prior request surface and keeps existing tools', async t => {
  const f = await fixture(t);
  await f.invoke('tool_load', {names: ['bash']});
  await f.remove();
  assert.deepEqual(names(await f.assemble(f.a)).sort(), ['ask_user_question','bash','mcp__mt__mt_file_list','read','skill','write']);
  assert.equal(f.ctx.tools.get('tool_load',f.a),undefined);
  assert.equal((await f.invoke('bash', {value: 'fixture'})).content[0].text,'actual callback');
});

test('an explicit child whitelist without discovery keeps its permitted tools and never broadens permissions', async t => {
  for (const mode of ['native','ptc']) {
    const f = await fixture(t,mode), child=f.agent('restricted-child',f.a);
    child.ctx.tools.restrict({allow:['read','bash']});
    const assembly=await f.assemble(child);
    if(mode==='native')assert.deepEqual(names(assembly).sort(),['bash','read']);
    else {
      const sdk=assembly.sections.find(s=>s.name==='tools:sdk').text;
      assert.ok(sdk.includes('bash:'));
      assert.ok(!sdk.includes('write:'));
    }
    assert.equal(f.ctx.tools.get('tool_load',child),undefined);
    assert.equal((await f.invoke('write',{},child)).isError,true);
    assert.ok(!assembly.contexts.find(c=>c.name==='dsh:on-demand-tools').text.includes('先用 tool_search'));
  }
});
