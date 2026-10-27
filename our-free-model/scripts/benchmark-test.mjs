import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {runBenchmark} from '../src/benchmark.js';
import {createApiRoutes} from '../index.js';
const entry={id:'test-model',efforts:['disabled','low','high']};
const snapshot={catalog:[entry],settings:{defaultMaxTokens:32768,streamRecovery:{enabled:true,totalTimeoutMs:1800000}}};
const working={async *stream(options,model,state){assert.equal(options.maxTokens,1024);assert.equal(options.reasoningEffort,'disabled');assert.equal(state.settings.streamRecovery.enabled,false);yield {type:'text-delta',text:'OK'};yield {type:'usage',usage:{inputTokens:5,outputTokens:1,reasoningTokens:0}};yield {type:'finish',reason:{kind:'stop'}}}};
test('short benchmark uses declared off and leaves normal chat settings untouched',async()=>{
 const old=JSON.stringify(snapshot);const r=await runBenchmark({adapter:working,entry,snapshot});assert.equal(r.sample,'OK');assert.equal(r.preset,'quick');assert.equal(r.effort,'disabled');assert.equal(JSON.stringify(snapshot),old);
});
test('thinking-only models select their declared low level; anonymous models use light',async()=>{
 for(const [model,expected]of [[{id:'thinking',efforts:['low','high']},'low'],[{id:'anonymous'},'light']]){let selected;await runBenchmark({entry:model,snapshot,adapter:{async *stream(o){selected=o.reasoningEffort;yield{type:'text-delta',text:'OK'};yield{type:'finish',reason:{kind:'stop'}}}}});assert.equal(selected,expected)}
});
test('deadline aborts the actual stream signal once, with an actionable error',async()=>{
 let calls=0,aborted=false;const adapter={async *stream(o){calls++;await new Promise((_r,reject)=>o.signal.addEventListener('abort',()=>{aborted=true;reject(o.signal.reason)},{once:true}));}};
 await assert.rejects(runBenchmark({entry,snapshot,adapter,timeoutMs:15}),/已取消上游请求/);assert.equal(calls,1);assert.equal(aborted,true);
});
test('caller cancellation starts no request; failure and subsequent retry preserve old settings',async()=>{
 const c=new AbortController();c.abort();let calls=0;await assert.rejects(runBenchmark({entry,snapshot,signal:c.signal,adapter:{async *stream(){calls++}}}),/测速已取消/);assert.equal(calls,0);
 await assert.rejects(runBenchmark({entry,snapshot,adapter:{async *stream(){throw Error('actual fixture upstream rejection')}}}),/upstream rejection/);assert.equal((await runBenchmark({entry,snapshot,adapter:working})).sample,'OK');assert.equal(snapshot.settings.streamRecovery.enabled,true);
});
test('real HTTP browser disconnect cancels only its benchmark, then next call succeeds',async()=>{
 let started,cancelled;const start=new Promise(r=>started=r),stop=new Promise(r=>cancelled=r);let count=0;
 const route=createApiRoutes({testModel:async(_id,_effort,{signal})=>{count++;if(count===1){started();await new Promise((_r,reject)=>signal.addEventListener('abort',()=>{cancelled();reject(Error('caller cancelled'))},{once:true}));}return {ok:true,sample:'OK'};}});
 const server=http.createServer((req,res)=>{void route(req,res)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port+'/api/our-free-model/bench';
 try{const controller=new AbortController();const request=fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture'}),signal:controller.signal});await start;controller.abort();await assert.rejects(request);await stop;const valid=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture'})});assert.equal(valid.status,200);assert.equal((await valid.json()).sample,'OK');assert.equal(count,2);}finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
});
