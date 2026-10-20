import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError, LIMIT, runtimeConfig } from './config.js';
import { QQManager, REF } from './manager.js';
const base = () => ({ connection:{mode:'forward',url:'ws://127.0.0.1:3001'}, selfId:100000001, admins:[100000002], accessToken:'test-only-token' });
const json = value => JSON.stringify(value);
function fixture() {
  const data = new Map(); let starts = 0, stops = 0;
  const store = { get: async key => data.get(key), set: async (key, value) => data.set(key, value) };
  const runtime = { start: async config => { starts++; return { config }; }, stop: async () => { stops++; }, connected: () => true };
  return { data, store, runtime, manager: new QQManager(store, runtime), counts: () => ({starts,stops}) };
}
test('blank shareable profile does not instantiate or connect a bot', async () => {
  const f=fixture();await f.manager.init();assert.equal((await f.manager.status()).configured,false);assert.deepEqual(f.counts(),{starts:0,stops:0});
});
test('import validates, stays disabled, and never returns the OneBot token', async () => {
  const f=fixture();await f.manager.init();const state=await f.manager.import(json({format:'dsh-phone-qq',version:1,config:base()}));
  assert.equal(state.enabled,false);assert.equal(state.hasToken,true);assert.equal(state.config.selfId,100000001);
  assert.ok(!json(state).includes('test-only-token'));assert.equal(f.counts().starts,0);
  const exported=await f.manager.export();assert.equal(exported.config.accessToken,'');assert.ok(!json(exported).includes('test-only-token'));
});
test('bad imports preserve both stored configuration and an active connection', async () => {
  const f=fixture();await f.manager.init();await f.manager.import(json(base()));await f.manager.start();const before=f.data.get(REF);
  assert.throws(()=>f.manager.import('{bad'),ConfigError);
  assert.throws(()=>f.manager.import(json({...base(),workspacePath:'/Users/private'})),ConfigError);
  assert.equal(f.data.get(REF),before);assert.equal((await f.manager.status()).running,true);assert.equal(f.counts().stops,0);
});
test('replacement import stops previous bot; start persists and stop survives restart', async () => {
  const f=fixture();await f.manager.init();await f.manager.import(json(base()));await f.manager.start();
  const g=new QQManager(f.store,f.runtime);await f.manager.dispose();await g.init();assert.equal((await g.status()).running,true);
  await g.import(json({...base(),selfId:100000003}));assert.equal((await g.status()).enabled,false);assert.equal((await g.status()).running,false);
  await g.start();await g.stop();await g.dispose();const h=new QQManager(f.store,f.runtime);await h.init();assert.equal((await h.status()).running,false);
});
test('failed persistence cannot replace or stop the working bot', async () => {
  const f=fixture();await f.manager.init();await f.manager.import(json(base()));await f.manager.start();
  f.store.set=async()=>{throw Error('disk failure');};await assert.rejects(f.manager.import(json({...base(),selfId:100000003})));
  assert.equal((await f.manager.status()).config.selfId,100000001);assert.equal(f.counts().stops,0);
});
test('bounds, endpoint credentials, unsupported version, and remote reverse bindings are rejected', () => {
  assert.throws(()=>parseConfig(' '.repeat(LIMIT+1)),ConfigError);
  for(const url of ['https://127.0.0.1:3001','ws://user:secret@example.test:3001','ws://127.0.0.1:3080','ws://127.0.0.1:3001?token=secret']) {
    assert.throws(()=>parseConfig(json({...base(),connection:{mode:'forward',url}})),ConfigError);
  }
  assert.throws(()=>parseConfig(json({format:'dsh-phone-qq',version:2,config:base()})),ConfigError);
  assert.throws(()=>parseConfig(json({...base(),connection:{mode:'reverse',url:'ws://remote.test:8082'}})),ConfigError);
  assert.throws(()=>parseConfig(json({...base(),accessToken:'',connection:{mode:'reverse',url:'ws://0.0.0.0:8082'}})),ConfigError);
  assert.throws(()=>parseConfig(json({...base(),admins:[]})),ConfigError);
});
test('imported settings cannot enable proactive schedules or use a Mac filesystem path', () => {
  const config=runtimeConfig(parseConfig(json(base())),'/data/user/0/app/files/dsh-home');
  assert.equal(config.scheduler.enabled,false);assert.equal(config.stt.enabled,false);assert.equal(config.workspacePath,'/data/user/0/app/files/dsh-home/workspaces/qq');
  assert.throws(()=>parseConfig(json({...base(),scheduler:{enabled:true}})),ConfigError);
});
test('startup errors are sanitized; retry and dispose unload cleanly', async () => {
  const f=fixture();await f.manager.init();await f.manager.import(json(base()));
  f.runtime.start=async()=>{throw Error('test-only-token transport failure');};const state=await f.manager.start();
  assert.equal(state.running,false);assert.ok(!json(state).includes('test-only-token'));
  f.runtime.start=async()=>({});assert.equal((await f.manager.start()).running,true);await f.manager.dispose();
  await assert.rejects(f.manager.start(),ConfigError);assert.equal(f.counts().stops,1);
});
test('visual edit preserves saved token and applies current personality to a running bot',async()=>{
 const f=fixture();await f.manager.init();await f.manager.import(json(base()));await f.manager.start();
 const previous=await f.manager.status();const edited={...previous.config,persona:{...previous.config.persona,style:'calm',description:'Answer calmly. {{literal braces}}'}};
 const result=await f.manager.save(json(edited),{revision:previous.revision});
 assert.equal(result.running,true);assert.deepEqual(f.counts(),{starts:2,stops:1});assert.equal(f.manager.handle.config.accessToken,'test-only-token');assert.equal(f.manager.handle.config.persona.description,edited.persona.description);assert.ok(!json(result).includes('test-only-token'));
 await assert.rejects(f.manager.save(json(edited),{revision:previous.revision}));assert.deepEqual(f.counts(),{starts:2,stops:1});
 await f.manager.stop();const stopped=await f.manager.status();const cleared=await f.manager.save(json(stopped.config),{revision:stopped.revision,clearToken:true});assert.equal(cleared.hasToken,false);assert.equal(cleared.running,false);
});
test('token-preserving reverse edits work; unsafe clear is rejected before stopping the bot',async()=>{
 const f=fixture();await f.manager.init();await f.manager.import(json({...base(),connection:{mode:'reverse',url:'ws://0.0.0.0:8082'}}));await f.manager.start();
 const state=await f.manager.status();await f.manager.save(json(state.config),{revision:state.revision});
 const saved=await f.manager.status();await assert.rejects(f.manager.save(json(saved.config),{revision:saved.revision,clearToken:true}));assert.equal((await f.manager.status()).running,true);assert.deepEqual(f.counts(),{starts:2,stops:1});
});
test('failed edit persistence leaves the old live connection and personality intact',async()=>{
 const f=fixture();await f.manager.init();await f.manager.import(json(base()));await f.manager.start();const state=await f.manager.status();
 f.store.set=async()=>{throw Error('disk failure');};await assert.rejects(f.manager.save(json({...state.config,persona:{...state.config.persona,style:'lively'}}),{revision:state.revision}));
 assert.equal(f.manager.handle.config.persona.style,'friendly');assert.equal(f.counts().stops,0);
});
