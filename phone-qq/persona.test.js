import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt';
import { installPersona } from './persona.js';
import { installCodeAccess } from './code-access.js';
import { parseConfig } from './config.js';
test('actual prompt assembly applies latest persona only to QQ and leaves editable braces literal', async () => {
  const ctx = new Context(); const fiber = ctx.plugin(SystemPrompt, {}); await fiber;
  const config = parseConfig(JSON.stringify({ selfId:100000001,admins:[100000002],connection:{mode:'forward',url:'ws://127.0.0.1:3001'},persona:{description:'Keep {{custom}} literal',style:'calm'} }));
  const manager = {handle:{},record:{config}}; installPersona(ctx, manager);
  const qq = {agent:{session:{id:'qq-dm-100000002'}}};
  try {
    const first = renderContextSnapshot(await ctx.systemPrompt.assemble(qq)); assert.match(first,/沉稳理性/); assert.match(first,/\{\{custom\}\}/);
    manager.record.config.persona.description = 'New character'; assert.match(renderContextSnapshot(await ctx.systemPrompt.assemble(qq)),/New character/);
    assert.doesNotMatch(renderContextSnapshot(await ctx.systemPrompt.assemble({agent:{session:{id:'ordinary'}}})),/New character/);
    manager.handle = null; assert.doesNotMatch(renderContextSnapshot(await ctx.systemPrompt.assemble(qq)),/New character/);
  } finally { await fiber.dispose(); }
});
test('code execution opt-in affects administrator DMs only, including resumed sessions', async () => {
  const applied = []; const session = {}; const bridge = { async ensureConversation(){return {handle:{agent:{session}}};} };
  const config = {codeExecution:true,admins:[100000002]}; installCodeAccess({bridge},{set:(s,p)=>applied.push(p)},config);
  await bridge.ensureConversation('dm',{message_type:'private',user_id:100000002});
  await bridge.ensureConversation('dm',{message_type:'private',user_id:100000003});
  await bridge.ensureConversation('group',{message_type:'group',user_id:100000002});
  config.codeExecution=false;await bridge.ensureConversation('dm',{message_type:'private',user_id:100000002});
  assert.deepEqual(applied,['danger-full-access','workspace-write','workspace-write','workspace-write']);
});
