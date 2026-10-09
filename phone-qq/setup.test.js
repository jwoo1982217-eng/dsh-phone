import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { QQSetup } from './setup.js';
import { QQManager } from './manager.js';
function fixture(){const data=new Map();const store={get:async k=>data.get(k),set:async(k,v)=>data.set(k,v)};const manager=new QQManager(store,{start:async()=>({}),stop:async()=>{},connected:()=>false});return{store,manager,setup:new QQSetup(store,manager)};}
test('phone installer prepares a private nonce, validates shell syntax, and never enables an imported bot', async () => {
  const f=fixture();await f.manager.init();await f.setup.init();await assert.rejects(f.setup.prepare());
  await f.manager.import(JSON.stringify({selfId:100000001,admins:[100000002],connection:{mode:'forward',url:'ws://127.0.0.1:3001'}}));
  const p=await f.setup.prepare();assert.match(p.nonce,/^[a-f0-9]{64}$/);assert.equal(f.setup.status().phase,'prepared');assert.ok(!JSON.stringify(f.setup.status()).includes(p.nonce));
  const script=f.setup.script(p.nonce);execFileSync('/bin/bash',['-n'],{input:script});assert.match(script,/127\.0\.0\.1/);assert.match(script,/NapNeko\/NapCat-Installer/);assert.match(script,/onebot11_100000001\.json/);
  assert.throws(()=>f.setup.script('wrong'));await f.setup.complete(p.nonce);const state=await f.manager.status();assert.equal(state.enabled,false);assert.equal(state.hasToken,true);assert.equal(state.config.connection.url,'ws://127.0.0.1:16301');assert.ok(!JSON.stringify(state).includes(f.setup.record.token));assert.equal(f.setup.status().phase,'installed');
  await assert.rejects(f.setup.complete(p.nonce));assert.throws(()=>f.setup.script(p.nonce));
});
test('expired or stale installation callbacks preserve newer robot settings', async () => {
  const f=fixture();await f.manager.init();await f.setup.init();await f.manager.import(JSON.stringify({selfId:100000001,admins:[100000002],connection:{mode:'forward',url:'ws://127.0.0.1:3001'}}));
  let p=await f.setup.prepare();let state=await f.manager.status();await f.manager.save(JSON.stringify({...state.config,persona:{...state.config.persona,description:'new persona'}}),{revision:state.revision});await assert.rejects(f.setup.complete(p.nonce));assert.equal((await f.manager.status()).config.persona.description,'new persona');
  p=await f.setup.prepare();f.setup.record.expires=0;assert.throws(()=>f.setup.script(p.nonce));await assert.rejects(f.setup.complete(p.nonce));assert.equal(f.setup.status().phase,'expired');
});
test('retrying the same installed QQ retains login credentials; changing the QQ account rotates them', async () => {
  const f=fixture();await f.manager.init();await f.setup.init();
  await f.manager.import(JSON.stringify({selfId:100000001,admins:[100000002],connection:{mode:'forward',url:'ws://127.0.0.1:3001'}}));
  const first=await f.setup.prepare(),token=f.setup.record.token,webToken=f.setup.record.webToken;
  await f.setup.complete(first.nonce);
  const retry=await f.setup.prepare();assert.notEqual(retry.nonce,first.nonce);
  assert.equal(f.setup.record.token,token);assert.equal(f.setup.record.webToken,webToken);
  await f.manager.import(JSON.stringify({selfId:100000003,admins:[100000002],connection:{mode:'forward',url:'ws://127.0.0.1:3001'}}));
  await f.setup.prepare();assert.notEqual(f.setup.record.token,token);assert.notEqual(f.setup.record.webToken,webToken);
});
test('installed QQ can restart with current private config without rerunning the downloader', async () => {
  const f=fixture();await f.manager.init();await f.setup.init();assert.throws(()=>f.setup.restartScript());
  await f.manager.import(JSON.stringify({selfId:100000001,admins:[100000002],connection:{mode:'forward',url:'ws://127.0.0.1:3001'}}));
  const p=await f.setup.prepare();await f.setup.complete(p.nonce);
  const script=f.setup.restartScript();execFileSync('/bin/bash',['-n'],{input:script});
  assert.match(script,/containers\/dsh-qq\//);assert.match(script,/case "\$\{first##\*\/\}" in proot/);
  assert.match(script,/kill -QUIT/);assert.ok(!script.includes('kill -TERM'));
  assert.match(script,/onebot11_100000001\.json/);assert.ok(!script.includes('pkg install'));
  assert.ok(!script.includes('qq-download.py'));assert.ok(!script.includes('proot-distro install'));
});
