import test from 'node:test';
import assert from 'node:assert/strict';
import {teamService} from './index.mjs';
import {adaptClient} from './build-client.mjs';
import {readFileSync} from 'node:fs';

function fixture() {
  const bot = {id: 'bot', name: '成员', workDir: '/tmp/team-project'}, room = {id: 'room', name: '项目群', workDir: '/tmp/group-project'};
  const snapshot = {revision: 7, cards: [{id: 'card', kind: 'sub', name: '工程师', content: '原文职责'}], selection: {mainId: 'old-main', subIds: ['old-sub']}};
  let saves = 0, creates = 0;
  const rt = {ctx: {}, config: {workspace: '/tmp/team-default'}, state: {bots: {bot}, rooms: {room}}, botOf: id => rt.state.bots[id], roomOf: id => rt.state.rooms[id], selfOf: id => id === 'hidden' ? 'bot' : id, isMain: id => id === 'chief', chatOf: id => id, load: async () => {}, readOnly: () => undefined, save: async () => {saves++;}, createBot: async spec => {creates++; const value = {...spec, id: 'new'}; rt.state.bots.new = value; return value;}};
  const service = teamService(rt, () => ({status: async () => structuredClone(snapshot)}));
  return {service, rt, snapshot, counts: () => ({creates, saves})};
}
test('Bot private/group identity is separated from ordinary root and child sessions', () => {
  const f = fixture();
  for (const id of ['bot', 'hidden', 'room']) assert.equal(f.service.isSession({id}), true);
  for (const id of ['ordinary', 'child', 'qq-1']) assert.equal(f.service.isSession({id}), false);
  assert.deepEqual(f.service.coordinationTools({session: {id: 'room'}}), ['group_relay']);
  assert(f.service.coordinationTools({session: {id: 'bot'}}).includes('message_bot'));
  assert(!f.service.coordinationTools({session: {id: 'bot'}}).includes('create_bot'));
});
test('only registered working folders are added to imported skill visibility', () => {
  const f = fixture();
  for (const cwd of ['/tmp/team-default', '/tmp/team-project', '/tmp/group-project']) assert(f.service.ownsWorkingDirectory(cwd));
  for (const cwd of ['/tmp', '/tmp/team-project-extra', '/unrelated', undefined]) assert.equal(f.service.ownsWorkingDirectory(cwd), false);
});
test('card copy preserves exact instructions and current selection; repeat recovers same member', async () => {
  const f = fixture(), before = structuredClone(f.snapshot);
  const first = await f.service.fromCard({id: 'card', revision: 7}), second = await f.service.fromCard({id: 'card', revision: 7});
  assert.equal(first.existing, false); assert.equal(second.existing, true); assert.equal(first.id, second.id);
  assert.equal(f.rt.state.bots.new.instructions, '原文职责'); assert.equal(f.rt.state.bots.new.main, false);
  assert.deepEqual(f.snapshot, before); assert.deepEqual(f.counts(), {creates: 1, saves: 1});
});
test('stale, missing and read-only creation refuses before a new member is started', async () => {
  const f = fixture();
  await assert.rejects(f.service.fromCard({id: 'card', revision: 6}), /变化/);
  await assert.rejects(f.service.fromCard({id: 'missing', revision: 7}), /不存在/);
  f.rt.readOnly = () => 'another host'; await assert.rejects(f.service.fromCard({id: 'card', revision: 7}), /another host/);
  assert.equal(f.counts().creates, 0);
});
test('client adaptation refuses changed upstream and keeps ordinary mode as first-use default', () => {
  const source = readFileSync(new URL('./vendor/ds-bot/client.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const output = adaptClient(source, readFileSync(new URL('./client-bridge.js', import.meta.url), 'utf8'));
  assert(output.includes("id: 'dsh-team'")); assert(output.includes('data-dsh-team-switch')); assert(output.includes('dsh-team:surface:v1'));
  assert.throws(() => adaptClient(source.replace("id: 'ds-bot',", "id: 'changed',"), ''), /基线变化/);
  assert.equal(output, readFileSync(new URL('./client.js', import.meta.url), 'utf8'));
});
