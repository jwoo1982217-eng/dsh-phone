import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {installHttp1Only} from './transport.mjs';
const require=createRequire(new URL('../desktop-runtime/package.json',import.meta.url));
const {Agent,Dispatcher,fetch}=require('undici');
test('protocol adaptation keeps existing proxy dispatch, exact request and cancellation; no replay',()=>{
  let current,calls=0,captured;
  class Route extends Dispatcher {dispatch(options,handler){calls++;captured={options,handler};return false;}}
  const original=new Route();current=original;
  const release=installHttp1Only({getGlobalDispatcher:()=>current,setGlobalDispatcher:d=>current=d});
  const controller=new AbortController(),body=Buffer.from('signed request'),headers=['authorization','fixture'];
  const options={origin:'https://fixture.invalid',path:'/signed',method:'POST',body,headers,signal:controller.signal},handler={onResponseError(){}};
  assert.equal(current.dispatch(options,handler),false);assert.equal(calls,1);assert.equal(captured.options.allowH2,false);
  for(const key of Object.keys(options))assert.equal(captured.options[key],options[key]);assert.equal(captured.handler,handler);
  assert.equal(options.allowH2,undefined);release();assert.equal(current,original);release();
});
test('disposal preserves a newer dispatcher and never destroys the previous owner',()=>{
  const original=new Agent();let current=original;let closed=0;
  original.close=()=>closed++;original.destroy=()=>closed++;
  const release=installHttp1Only({getGlobalDispatcher:()=>current,setGlobalDispatcher:d=>current=d});
  const next={dispatch(){}};current=next;release();assert.equal(current,next);assert.equal(closed,0);
});
test('broken socket rejects once, next request reconnects; request body and abort remain intact',async()=>{
  let calls=0;
  const server=http.createServer(async(req,res)=>{calls++;if(calls===1){req.socket.destroy();return;}let body='';for await(const b of req)body+=b;res.end(body);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const original=new Agent();let current=original;
  const release=installHttp1Only({getGlobalDispatcher:()=>current,setGlobalDispatcher:d=>current=d});
  const url='http://127.0.0.1:'+server.address().port;
  try{await assert.rejects(fetch(url,{method:'POST',body:'first',dispatcher:current}));assert.equal(calls,1);
    assert.equal(await(await fetch(url,{method:'POST',body:'第二次',dispatcher:current})).text(),'第二次');
    const abort=new AbortController();abort.abort();await assert.rejects(fetch(url,{signal:abort.signal,dispatcher:current}));assert.equal(calls,2);
  }finally{release();await original.close();await new Promise(r=>server.close(r));}
});
