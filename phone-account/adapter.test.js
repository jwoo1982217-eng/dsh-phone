import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountMessagesAdapter,resolveAdapterOptions} from './messages-adapter.js';
const make=(onAuthError,resolveAttachments)=>new AccountMessagesAdapter({options:()=>resolveAdapterOptions({models:[{id:'deepseek-flash',inputModalities:['text','image']}]},{get:()=>undefined}),resolveApiKey:async()=> 'grant-for-test',resolveUserId:()=> 'test-user',onAuthError,resolveAttachments});
const request={provider:'deepseek-account',model:'deepseek-flash',messages:[{role:'user',content:[{type:'text',text:'hello'}]}],maxTokens:16};
const frames=events=>events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const textEvents=[
 {type:'message_start',message:{usage:{input_tokens:8,output_tokens:0}}},
 {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
 {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello'}},
 {type:'content_block_stop',index:0},
 {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:7}},
 {type:'message_stop'},
];
const mock=events=>new Response(frames(events),{headers:{'content-type':'text/event-stream'}});
async function collect(adapter,options=request){const chunks=[];for await(const chunk of adapter.stream(options))chunks.push(chunk);return chunks;}
test('account uses official Messages endpoint, account header and native SSE framing',async()=>{
 const original=globalThis.fetch;let captured;
 globalThis.fetch=async(url,init)=>{captured={url,init};return mock(textEvents);};
 try{
  const chunks=await collect(make());assert.equal(captured.url,'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(captured.init.headers['x-dsh-auth-token'],'grant-for-test');
  assert.equal(captured.init.headers.authorization,undefined);assert.equal(captured.init.headers['anthropic-version'],'2023-06-01');assert.equal(captured.init.redirect,'error');
  assert.ok(!captured.init.body.includes('grant-for-test'));
  const body=JSON.parse(captured.init.body);assert.equal(body.messages[0].content[0].text,'hello');assert.equal(body.max_tokens,16);assert.equal(body.output_config.effort,'high');
  assert.equal(chunks.find(c=>c.type==='text-delta').text,'Hello');assert.deepEqual(chunks.find(c=>c.type==='usage').usage,{inputTokens:8,outputTokens:7});assert.equal(chunks.at(-1).reason.kind,'stop');
 }finally{globalThis.fetch=original;}
});
test('HTTP 401 removes only captured grant and keeps inference error when storage fails',async()=>{
 const original=globalThis.fetch;let rejected;
 globalThis.fetch=async()=>new Response('{"error":{"message":"expired"}}',{status:401,headers:{'content-type':'application/json'}});
 try{await assert.rejects(()=>collect(make(async token=>{rejected=token;throw Error('storage failure');})),e=>e.code==='ACCOUNT_TOKEN_INVALID');assert.equal(rejected,'grant-for-test');}
 finally{globalThis.fetch=original;}
});
test('rc.8 tool results, system text, tools and thinking signatures survive request projection',async()=>{
 const original=globalThis.fetch;let body;
 globalThis.fetch=async(url,init)=>{body=JSON.parse(init.body);return mock(textEvents);};
 const content=[{type:'reasoning',text:'think'},{type:'tool-call',id:'tool-1',name:'inspect',arguments:'{"path":"test"}'}];
 const source={kind:'model',provider:'deepseek-account',model:'deepseek-flash',replayState:{response:{kind:'deepseek-messages',version:1,model:'deepseek-flash'},blocks:[{type:'reasoning',signature:'signature-for-test'},{type:'tool-call'}]}};
 try{
  await collect(make(),{...request,system:'System instructions',tools:[{name:'inspect',description:'Inspect',parameters:{type:'object'}}],messages:[request.messages[0],{role:'assistant',source,content},{role:'user',content:[{type:'tool-result',toolCallId:'tool-1',isError:true,content:[{type:'text',text:'result'}]}]}]});
  assert.equal(body.system,'System instructions');assert.equal(body.tools[0].input_schema.type,'object');
  assert.equal(body.messages[1].content[0].signature,'signature-for-test');assert.deepEqual(body.messages[1].content[1].input,{path:'test'});
  assert.equal(body.messages[2].content[0].tool_use_id,'tool-1');assert.equal(body.messages[2].content[0].is_error,true);assert.equal(body.messages[2].content[0].content[0].text,'result');
 }finally{globalThis.fetch=original;}
});
test('durable images become native base64 image blocks without mutating history',async()=>{
 const original=globalThis.fetch;let body;
 globalThis.fetch=async(url,init)=>{body=JSON.parse(init.body);return mock(textEvents);};
 const attachment={attachmentId:'image-fixture',mediaType:'image/png',bytes:3,width:1,height:1};
 const options={...request,messages:[{role:'user',content:[{type:'image',attachment}]}]};
 try{
  await collect(make(undefined,()=>({readImage:async()=>({ref:attachment,data:new Uint8Array([1,2,3])})})),options);
  assert.deepEqual(body.messages[0].content[0],{type:'image',source:{type:'base64',media_type:'image/png',data:'AQID'}});assert.equal(options.messages[0].content[0].attachment.attachmentId,'image-fixture');
 }finally{globalThis.fetch=original;}
});
test('truncated stream and malformed tool JSON fail instead of pretending completion',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async()=>mock(textEvents.slice(0,-1));await assert.rejects(()=>collect(make()),e=>e.code==='STREAM_CLOSED');
  globalThis.fetch=async()=>mock([{type:'message_start',message:{usage:{input_tokens:0,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool-1',name:'inspect',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{broken'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'}},{type:'message_stop'}]);
  await assert.rejects(()=>collect(make()),e=>e.code==='MALFORMED_RESPONSE');
 }finally{globalThis.fetch=original;}
});
