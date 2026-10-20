import test from'node:test';import assert from'node:assert/strict';import{withSharedRecall}from'./shared-recall.mjs';
test('共享记忆故障保留本机历史；仅当前项目不访问共享库，未建索引仍可查已接受共享记忆',async()=>{
 let count=0;const local={status:()=>({index:{indexed:true}}),search:async()=>[{text:'local'}],update(){}};
 const wrapped=withSharedRecall(local,()=>({recall:async()=>{count++;throw Error('engine unavailable');}}));
 assert.deepEqual(await wrapped.search('q',true,{mode:'related',shared:{enabled:true,sources:['zcode']}}),[{text:'local'}]);assert.equal(count,1);
 assert.deepEqual(await wrapped.search('q',true,{mode:'project'}),[{text:'local'}]);assert.equal(count,1);
 const isolated=withSharedRecall({...local,home:'/dsh',search:async()=>[{file:'/shared/MEMORY.md',text:'other agent'},{sid:'dsh-old',file:'/dsh/history',text:'dsh own history'}]},()=>undefined);assert.deepEqual(await isolated.search('q',true,{mode:'related'}),[{sid:'dsh-old',file:'/dsh/history',text:'dsh own history'}]);
 local.status=()=>({index:{indexed:false}});const onlyShared=withSharedRecall(local,()=>({recall:async()=>[{text:'accepted'}]}));assert.deepEqual(await onlyShared.search('q',true,{mode:'related',shared:{enabled:true,sources:['zcode']}}),[{text:'accepted'}]);
 const stuck=withSharedRecall(local,()=>({recall:()=>new Promise(()=>{})}));const keepAlive=setTimeout(()=>{},1000);try{await assert.rejects(stuck.search('q',true,{mode:'related',shared:{enabled:true,sources:['zcode']},signal:AbortSignal.timeout(20)}),/timeout/i);}finally{clearTimeout(keepAlive);}
 const controller=new AbortController();controller.abort(Error('cancel'));await assert.rejects(wrapped.search('q',true,{mode:'related',shared:{enabled:true,sources:['zcode']},signal:controller.signal}),/cancel/);
});
