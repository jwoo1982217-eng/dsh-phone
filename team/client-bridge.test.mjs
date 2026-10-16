import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./client-bridge.js',import.meta.url),'utf8');
function fixture(){
 const listeners=new Set(),timers=new Map(),cleanup=[],opened=[];let mode='bot',next=0,rows={};
 const document={head:{append(){}},documentElement:{dataset:{}},createElement:()=>({dataset:{},remove(){}})};
 const window={addEventListener(){},removeEventListener(){}};
 const ctx={slots:{inject(_name,fn){fn();},register(){}},effect(fn){cleanup.push(fn());},provide(name,value){ctx[name]=value;},sessions:{list:{getSnapshot:()=>({byId:rows}),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}}},uiWorkspace:{openSession(id){assert(rows[id],'Navigation attempted before session hydration');opened.push(id);}}};
 const install=vm.runInNewContext(source+'\ninstallTeamBridge',{document,window,Symbol,setTimeout(fn){timers.set(++next,fn);return next;},clearTimeout(id){timers.delete(id);}});
 const actions={setSurface(value){mode=value;}};
 install(ctx,actions,{getSnapshot:()=>({byId:{},roomsById:{},bots:[]})},{getSnapshot:()=>({mode})},async()=>{});
 return {ctx,actions,opened,listeners,timers,setRows(value){rows=value;for(const fn of [...listeners])fn();},dispose(){for(const fn of cleanup.reverse())fn?.();}};
}
test('team navigation waits for the real session list before opening a roster identity',async()=>{
 const f=fixture();const pending=f.ctx.dshTeamUi.navigate('chief');assert.equal(f.opened.length,0);assert.equal(f.listeners.size,1);
 f.setRows({chief:{id:'chief'}});assert.equal(await pending,true);assert.deepEqual(f.opened,['chief']);assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);f.dispose();
});
test('returning to ordinary chat cancels stale team navigation',async()=>{
 const f=fixture(),pending=f.ctx.dshTeamUi.navigate('chief');f.actions.setSurface('agent');assert.equal(await pending,false);f.setRows({chief:{id:'chief'}});assert.equal(f.opened.length,0);assert.equal(f.listeners.size,0);f.dispose();
});
test('newer selection replaces pending navigation and teardown releases timers',async()=>{
 const f=fixture(),old=f.ctx.dshTeamUi.navigate('old');f.setRows({new:{id:'new'}});assert.equal(await f.ctx.dshTeamUi.navigate('new'),true);assert.equal(await old,false);assert.deepEqual(f.opened,['new']);
 const pending=f.ctx.dshTeamUi.navigate('missing');f.dispose();assert.equal(await pending,false);assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);
});
test('completed turns stay clear while failed compaction gets one explicit status',()=>{
 const outcome=vm.runInNewContext(source+'\nDshTurnOutcome',{Symbol});
 assert.equal(outcome({turn:{end:{data:{reason:{kind:'completed'}}}}}),null);
 const node=outcome({turn:{end:{data:{reason:{kind:'error',error:{code:'COMPACTION_FAILED'}}}}}});
 assert.match(node.props.children,/停止重复尝试/);assert.equal(node.props.role,'status');
});
