import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import {ToolRuntime} from '@deepseek-ai/dsh-tools';
import {applyChatFiles,MAX_FILE_BYTES} from './index.mjs';

test('authenticated upload exposes the original JSON through the actual SDK tool runtime',async()=>{
  const home=await mkdtemp(tmpdir()+'/dsh-chat-http-'),ctx=new Context();let handler;
  ctx.provide('systemPrompt');ctx.set('systemPrompt',{tools(){}});
  ctx.provide('webServer');ctx.set('webServer',{register(route){handler=route.handler;return ()=>{};}});
  ctx.provide('connection');ctx.set('connection',{requestRejection(req){return req.headers.cookie==='fixture-session'?undefined:401;}});
  await ctx.plugin(ToolRuntime);applyChatFiles(ctx,{home});
  const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const authority='127.0.0.1:'+server.address().port;
  const upload=(body,headers={})=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/phone-chat-files/upload',method:'POST',agent:false,headers:{cookie:'fixture-session',origin:'http://'+authority,'content-type':'application/octet-stream','x-dsh-file-name':encodeURIComponent('普通分析.json'),...headers}},res=>{
      const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(Buffer.concat(chunks))}));
    });req.on('error',reject);req.end(body);
  });
  try{
    const bytes=Buffer.from(JSON.stringify({items:Array.from({length:100000},(_,i)=>({i,text:'中文😀数据'}))}));
    const uploaded=await upload(bytes);assert.equal(uploaded.status,200);assert.deepEqual(await readFile(uploaded.json.file.path),bytes);
    assert.equal(uploaded.json.file.preview,undefined);
    const continuation=await ctx.tools.execute({name:'chat_file_read',arguments:{filePath:uploaded.json.file.path,offset:0},callId:'qa-continuation',signal:new AbortController().signal});
    assert.equal(continuation.isError,false);
    assert.ok(bytes.toString('utf8').startsWith(JSON.parse(continuation.value).text));
    let offset=0,text='';
    for(;;){
      const result=await ctx.tools.execute({name:'chat_file_read',arguments:{filePath:uploaded.json.file.path,offset},callId:'qa-'+offset,signal:new AbortController().signal});
      assert.equal(result.isError,false);const part=JSON.parse(result.value);text+=part.text;if(part.eof)break;assert.ok(part.nextOffset>offset);offset=part.nextOffset;
    }
    assert.equal(createHash('sha256').update(text).digest('hex'),uploaded.json.file.sha256);
    assert.equal((await upload('{}',{cookie:''})).status,401);
    assert.equal((await upload('{}',{origin:'https://other.invalid'})).status,403);
    assert.equal((await upload('{}',{'content-type':'application/json'})).status,403);
    assert.equal((await upload('',{'content-length':String(MAX_FILE_BYTES+1)})).status,413);
    const invalid=await upload(Buffer.from([65,255]));
    assert.equal(invalid.status,200);assert.equal(invalid.json.file.preview,undefined);
    assert.deepEqual(await readFile(invalid.json.file.path),Buffer.from([65,255]));
    const zip=await upload(Buffer.from([80,75,0,0]),{'x-dsh-file-name':'archive.zip'});
    assert.equal(zip.status,200);assert.equal(zip.json.file.preview,undefined);
    const retry=await upload('{"retry":true}');assert.equal(retry.status,200);
    assert.equal(retry.json.file.preview,undefined);assert.equal((await readFile(retry.json.file.path)).toString(),'{"retry":true}');
  }finally{
    server.closeAllConnections();await new Promise(r=>server.close(r));await ctx.fiber.dispose();await rm(home,{recursive:true,force:true});
  }
});
