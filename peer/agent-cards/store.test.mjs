import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { AgentCards, REF, limits } from './store.mjs';
import { applyAgentCards } from './index.mjs';
const fixture = async () => { const values = new Map(), store = { get: async key => values.get(key), set: async (key, value) => values.set(key, value) }, cards = new AgentCards(store); await cards.init(); return { cards, values, store }; };
const save = async (cards, name, kind, content = 'Keep working with verified evidence.') => { const state = await cards.status(); return cards.change('card.save', { card: { name, kind, content }, revision: state.revision }); };
const apply = async (cards, selection) => cards.change('selection.apply', { selection, revision: (await cards.status()).revision });

test('one main and several subs persist, switching restores the selected combination only', async () => {
  const { cards, store } = await fixture(); let state = await save(cards, 'Engineer', 'main', 'Engineer identity');
  state = await save(cards, 'Reviewer', 'main', 'Reviewer identity');
  state = await save(cards, 'Coding', 'sub', 'Coding rules'); state = await save(cards, 'Writing', 'sub', 'Writing rules');
  const [engineer, reviewer, coding, writing] = state.cards;
  assert.equal(cards.promptText(), '', 'saving a new card never enables it');
  state = await apply(cards, { mainId: engineer.id, subIds: [coding.id] });
  state = await cards.change('combo.save', { combo: { name: 'Code', ...state.selection }, revision: state.revision });
  const comboId = state.combos[0].id;
  await apply(cards, { mainId: reviewer.id, subIds: [writing.id] });
  assert.match(cards.promptText(), /Reviewer identity/); assert.doesNotMatch(cards.promptText(), /Engineer identity|Coding rules/);
  state = await cards.change('combo.apply', { id: comboId, revision: (await cards.status()).revision });
  assert.match(cards.promptText(), /Engineer identity/); assert.match(cards.promptText(), /Coding rules/); assert.doesNotMatch(cards.promptText(), /Writing rules/);
  const resumed = new AgentCards(store); await resumed.init(); assert.deepEqual((await resumed.status()).selection, state.selection);
});

test('wrong kinds, repeated subs, excessive subs, stale and concurrent writes are rejected', async () => {
  const { cards } = await fixture(); let state = await save(cards, 'Main', 'main');
  for (let i = 0; i < 9; i++) state = await save(cards, 'Sub ' + i, 'sub');
  const main = state.cards[0].id, ids = state.cards.slice(1).map(c => c.id);
  for (const selected of [{ mainId: ids[0], subIds: [] }, { mainId: main, subIds: [main] }, { mainId: main, subIds: [ids[0], ids[0]] }, { mainId: main, subIds: ids }]) await assert.rejects(apply(cards, selected));
  const revision = (await cards.status()).revision;
  const changes = await Promise.allSettled(['First', 'Second'].map(name => cards.change('card.save', { card: { name, kind: 'sub', content: 'Some instructions' }, revision })));
  assert.equal(changes.filter(c => c.status === 'fulfilled').length, 1);
  await assert.rejects(cards.change('selection.apply', { revision, selection: { mainId: main, subIds: [] } }), /刷新/);
});

test('deletion repairs saved and current selections; type changes never corrupt active combinations', async () => {
  const { cards } = await fixture(); await save(cards, 'Main', 'main'); let state = await save(cards, 'Sub', 'sub');
  const [main, sub] = state.cards; state = await apply(cards, { mainId: main.id, subIds: [sub.id] });
  state = await cards.change('combo.save', { combo: { name: 'Both', ...state.selection }, revision: state.revision });
  await assert.rejects(cards.change('card.save', { card: { ...main, kind: 'sub' }, revision: state.revision }), /取消选择/);
  state = await cards.change('card.delete', { id: sub.id, revision: state.revision });
  assert.deepEqual(state.selection.subIds, []); assert.deepEqual(state.combos[0].subIds, []);
  state = await cards.change('card.delete', { id: main.id, revision: state.revision }); assert.equal(state.selection.mainId, null); assert.equal(state.combos[0].mainId, null); assert.equal(cards.promptText(), '');
});

test('failed persistence and invalid or oversized imports never change the active instructions', async () => {
  const { cards, store } = await fixture(); let state = await save(cards, 'Main', 'main', 'Existing role');
  state = await apply(cards, { mainId: state.cards[0].id, subIds: [] }); const before = await cards.status();
  for (const data of [{ filename: 'bad.json', text: '{' }, { filename: 'unknown.json', text: '{"role":"secret"}' }, { filename: 'too-large.md', text: 'x'.repeat(limits.fileBytes + 1), kind: 'sub' }, { filename: 'invalid.md', text: 'x'.repeat(limits.cardBytes + 1), kind: 'sub' }]) await assert.rejects(cards.change('import', { ...data, revision: before.revision }));
  assert.deepEqual(await cards.status(), before);
  store.set = async () => { throw Error('disk full'); }; await assert.rejects(save(cards, 'Unpublished', 'sub'), /disk full/);
  assert.deepEqual(await cards.status(), before); assert.match(cards.promptText(), /Existing role/);
});

test('export/import preserves card text and combos, remaps conflicts and never enables imported roles', async () => {
  const { cards } = await fixture(); await save(cards, 'Main', 'main', 'Literal {{model}} <script> role'); let state = await save(cards, 'Sub', 'sub');
  state = await apply(cards, { mainId: state.cards[0].id, subIds: [state.cards[1].id] });
  state = await cards.change('combo.save', { combo: { name: 'Saved', ...state.selection }, revision: state.revision });
  const exported = cards.export(), selection = state.selection;
  state = await cards.change('import', { filename: 'cards.json', text: JSON.stringify(exported), revision: state.revision });
  assert.deepEqual(state.selection, selection); assert.equal(state.cards.length, 4); assert.equal(new Set(state.cards.map(c => c.id)).size, 4);
  assert.equal(state.cards[2].content, exported.cards[0].content); assert.notEqual(state.combos[1].mainId, state.combos[0].mainId);
  const fresh = (await fixture()).cards; state = await fresh.change('import', { filename: 'cards.json', text: JSON.stringify(exported), revision: 0 });
  assert.equal(fresh.promptText(), ''); assert.equal(state.combos.length, 1);
  state = await fresh.change('import', { filename: '角色.md', kind: 'main', text: '完整角色正文', revision: state.revision }); assert.equal(state.cards.at(-1).name, '角色');
  state = await fresh.change('import', { filename: '规则.txt', kind: 'sub', text: '{保留为普通正文}', revision: state.revision }); assert.equal(state.cards.at(-1).content, '{保留为普通正文}');
});

test('legacy phone prompts retain edits and activation once, deleted cards are never re-imported', async () => {
  const { cards } = await fixture(); const rows = [{ key: 'pack:one', name: 'One', content: 'Edited old card', enabled: true }, { key: 'pack:two', name: 'Two', content: 'Disabled old card', enabled: false }];
  let state = await cards.importLegacy(rows); assert.equal(state.cards.length, 2); assert.equal(state.selection.subIds.length, 1); assert.match(cards.promptText(), /Edited old card/); assert.doesNotMatch(cards.promptText(), /Disabled old card/);
  state = await cards.change('card.delete', { id: state.cards[0].id, revision: state.revision });
  state = await cards.importLegacy(rows); assert.equal(state.cards.length, 1); assert.equal(cards.promptText(), '');
  await cards.importLegacy([...rows, { key: 'pack:three', name: 'Three', content: 'New prompt', enabled: true }]); assert.equal(cards.promptText(), '');
  await cards.importLegacy([{ key: 'pack:empty', name: 'Empty', content: '   ', enabled: false }]); assert.equal((await cards.status()).cards.length, 2);
});

test('real DSH prompt assembly updates next request, preserves literal braces and official guidance, excludes QQ and children', async t => {
  const ctx = new Context(), values = new Map(), routes = new Map(), handlers = new Map();
  ctx.provide('credentials', { resolve: async key => values.has(key) ? { value: values.get(key) } : undefined, set: async (key, value) => values.set(key, value) });
  ctx.provide('connection', { rpc: { handle(path, handler, guard) { assert.equal(guard.authority, 'loopback'); handlers.set(path, handler); } } });
  ctx.provide('webServer', { register(row) { routes.set(row.path, row); return () => routes.delete(row.path); } });
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Official agent identity' });
  t.after(() => ctx.fiber.dispose()); const cards = await applyAgentCards(ctx);
  ctx.systemPrompt.context({ name: 'test:tools', order: 100, text: 'Existing tool and permission guidance' });
  let state = await save(cards, 'User persona', 'main', 'My literal {{unregistered}} instructions <script>');
  const context = { agent: { session: { id: 'local-session', header: {} } } };
  assert.doesNotMatch(renderContextSnapshot(await ctx.systemPrompt.assemble(context)), /My literal/);
  await apply(cards, { mainId: state.cards[0].id, subIds: [] });
  const assembly = await ctx.systemPrompt.assemble(context);
  let assembled = renderContextSnapshot(assembly); assert.match(assembled, /My literal \{\{unregistered\}\}/); assert.match(renderPrompt(assembly), /Official agent identity/); assert.match(assembled, /Existing tool and permission guidance/);
  for (const session of [{ id: 'qq-dm-123' }, { id: 'child', header: { origin: 'subagent', delegationDepth: 1 } }]) assert.doesNotMatch(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: { session } })), /My literal/);
  await apply(cards, { mainId: null, subIds: [] }); assert.doesNotMatch(renderContextSnapshot(await ctx.systemPrompt.assemble(context)), /My literal/);
  const response = await handlers.get('/agent-cards')('manage', { action: 'status' }); assert.equal(response.ok, true); assert.ok(routes.has('/agent-cards/page.js'));
});
