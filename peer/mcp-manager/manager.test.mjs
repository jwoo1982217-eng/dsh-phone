import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { ModelRouter } from './router.mjs';
import { McpManager } from './manager.mjs';
import { LocalMcpTransport, browserCall, BROWSER_TOOLS } from './builtins.mjs';
import { localCaller, toolName } from './common.mjs';

function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-mcp-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const defs=new Map(), secrets=new Map(), listeners=new Map(), routes=[{provider:'fixture',model:'fast'},{provider:'fixture',model:'slow'}];
  const ctx={on:(e,f)=>listeners.set(e,f),get:name=>ctx[name],
    credentials:{resolve:async ref=>secrets.has(String(ref))?{value:secrets.get(String(ref))}:undefined,set:async(ref,v)=>secrets.set(String(ref),v)},
    sandboxPolicy:{resolve:()=>({mode:'read-only'})},subagentModelSelection:{current:()=>({enabled:true,allowedModels:routes})},
    tools:{register:def=>{assert.ok(!defs.has(def.name));defs.set(def.name,def);return()=>defs.delete(def.name);},guard:f=>listeners.set('tools/guard',f),schemas:scope=>[...[...defs.values()].map(d=>({name:d.name})),...(scope?[{name:'subagent'}]:[])]},
    llm:{listProviders:()=>[{id:'fixture'}],listModels:async()=>routes.map(r=>({id:r.model})),resolveModelInfo:async(p,m)=>({id:m}),
      stream:async function* (options){const prompt=options.messages[0].content[0].text;let text=prompt.includes('MCP_READY_73')?'MCP_READY_73':prompt.includes('SOURCE_BOUNDARY_19')?'SOURCE_BOUNDARY_19':'TASK_DONE';if(options.model==='slow')text='WRONG';yield{type:'text-delta',text};yield{type:'usage',usage:{inputTokens:10,outputTokens:2,totalTokens:12}};yield{type:'finish',reason:{kind:'stop'}};}}};
  const exec={agent:{session:{id:'session-fixture',header:{cwd:home}}},signal:new AbortController().signal};
  return {home,ctx,exec,defs,listeners,secrets};
}
test('namespace is stable and collision resistant',()=>{assert.equal(toolName('mt','mt_file_list'),'mcp__mt__mt_file_list');assert.notEqual(toolName('x','a.b'),toolName('x','a_b'));assert.ok(toolName('x','a'.repeat(100)).length<=64);});
test('QQ and child identity cannot borrow local scope',t=>{const f=fixture(t);assert.throws(()=>localCaller({...f.exec,agent:{session:{id:'qq-1',header:{cwd:f.home}}}}));assert.throws(()=>localCaller({...f.exec,agent:{session:{id:'child',header:{cwd:f.home,origin:'subagent'}}}}));});
test('real MCP client handshake requires bridge-issued execution ticket',async t=>{
  const f=fixture(t),transport=new LocalMcpTransport([{name:'test',inputSchema:{type:'object',properties:{}}}],async()=>({ok:true}));
  const c=new Client({name:'fixture',version:'1'},{capabilities:{},versionNegotiation:{mode:'legacy'}});await c.connect(transport);t.after(()=>c.close());
  assert.equal((await c.listTools()).tools.length,1);await assert.rejects(c.callTool({name:'test',arguments:{},_meta:{dshExecutionTicket:'forged'}}));
  const ticket=transport.ticket(f.exec);assert.match((await c.callTool({name:'test',arguments:{},_meta:{dshExecutionTicket:ticket}})).content[0].text,/"ok":true/);transport.release(ticket);
});
test('probe, choose, dispatch, isolation and pause have real state transitions',async t=>{
  const f=fixture(t),r=new ModelRouter(f.ctx,f.home);
  const result=await r.call('dispatch',{capability:'text',prompt:'actual small task',mode:'answer',maxTokens:128},f.exec);
  assert.equal(result.route,'fixture/fast');assert.equal(result.text,'TASK_DONE');assert.equal(result.cost.known,false);
  assert.equal(r.load(localCaller(f.exec)).calls,5);
  const other={...f.exec,agent:{session:{id:'session-other',header:{cwd:f.home}}}};assert.equal((await r.call('evidence',{},other)).profiles.length,0);
  const w=r.windows()[0];assert.equal(w.projectPath,fs.realpathSync(f.home));r.quarantine(w.project,w.window,true);
  await assert.rejects(r.call('dispatch',{prompt:'x',maxTokens:128},f.exec),/隔离/);
  r.quarantine(w.project,w.window,false);fs.mkdirSync(path.join(f.home,'experience/verified-improvement'),{recursive:true});fs.writeFileSync(path.join(f.home,'experience/verified-improvement/.frozen.json'),'{}');
  await assert.rejects(r.call('probe',{},f.exec),/暂停/);
});
test('quota enforced before inference and usage without price stays unknown',async t=>{
  const f=fixture(t),r=new ModelRouter(f.ctx,f.home),owner=localCaller(f.exec),s=r.load(owner);s.calls=40;r.store(owner,s);
  await assert.rejects(r.infer(owner,{provider:'fixture',model:'fast'},'x'),/40次/);assert.equal(r.load(owner).calls,40);
  assert.equal(r.cost({provider:'fixture',model:'fast'},{inputTokens:1,outputTokens:1}).known,false);
});
test('failed connection replacement leaves old live tools and durable revision',async t=>{
  const f=fixture(t),m=new McpManager(f.ctx,f.home);await m.init();t.after(()=>m.close());
  assert.equal(m.status().servers.filter(s=>s.status==='connected').length,2);const rev=m.config.revision,tool=f.defs.get('mcp__router__models');
  await assert.rejects(m.manage({action:'save',server:{id:'bad',transport:'streamable-http',url:'http://127.0.0.1:1/mcp'}}),/原配置/);
  assert.equal(m.config.revision,rev);assert.equal(f.defs.get('mcp__router__models'),tool);
  await assert.rejects(m.manage({action:'save',server:{id:'router',transport:'stdio',command:'node'}}),/不能替换/);
});
test('builtin MCP tools really invoke router through the SDK bridge',async t=>{
  const f=fixture(t),m=new McpManager(f.ctx,f.home);await m.init();t.after(()=>m.close());
  const tool=f.defs.get('mcp__router__probe'),result=await tool.execute({capability:'text',routes:[{provider:'fixture',model:'fast'}]},f.exec);
  assert.match(result.content[0].text,/"passed":true/);const rendered=tool.output.render({},result);assert.match(rendered[0].text,/不可修改人设/);
  assert.equal(m.router.load(localCaller(f.exec)).calls,2);
});
test('child reservation covers first inference and reuse is bounded',async t=>{
  const f=fixture(t);let childId;
  f.ctx.subagents={startContinuable:async spec=>{childId=spec.childId;assert.ok(spec.request.toolFilter.deny.every(n=>!n.includes('*')&&n!=='subagent'));return{childId,messageId:'inbox-1'};},sendMessage:async (parent,id)=>{assert.equal(parent,f.exec.agent);assert.equal(id,childId);return'inbox-2';}};
  const r=new ModelRouter(f.ctx,f.home);const dispatched=await r.call('dispatch',{prompt:'child task',capability:'text',mode:'agent',maxTokens:128},f.exec);
  assert.equal(dispatched.childId,childId);
  assert.match(f.listeners.get('tools/guard')({agent:{session:{id:childId}},name:'subagent'}),/不能再派单/);
  assert.equal(f.listeners.get('tools/guard')({agent:f.exec.agent,name:'subagent'}),undefined);
  assert.equal(f.listeners.get('tools/guard')({agent:{session:{id:childId}},name:'send_message',arguments:{agent_id:f.exec.agent.session.id}}),undefined);
  assert.match(f.listeners.get('tools/guard')({agent:{session:{id:childId}},name:'send_message',arguments:{agent_id:'foreign'}}),/自己的主代理/);
  assert.equal((await r.call('reuse',{childId,prompt:'related follow-up'},f.exec)).contextReused,true);
  const other={...f.exec,agent:{session:{id:'session-other',header:{cwd:f.home}}}};
  await assert.rejects(r.call('reuse',{childId,prompt:'x'},other),/不属于/);
  const hook=f.listeners.get('llm/stream');async function* next(){yield{type:'usage',usage:{inputTokens:1,outputTokens:1}};}
  for(let i=0;i<8;i++)for await(const c of hook({sessionId:childId},next)){}
  await assert.rejects(async()=>{for await(const c of hook({sessionId:childId},next)){}},/8次/);
  const recovered=new ModelRouter(f.ctx,f.home);assert.equal(recovered.children.get(childId).calls,8);
});
test('failed task feedback quarantines only its own window and success cannot approve it',async t=>{
  const f=fixture(t),r=new ModelRouter(f.ctx,f.home);
  await r.call('probe',{capability:'text',routes:[{provider:'fixture',model:'fast'}]},f.exec);
  await r.call('feedback',{capability:'text',route:'fixture/fast',passed:false,reason:'实际任务校验未通过'},f.exec);
  assert.equal(r.load(localCaller(f.exec)).profiles[0].quarantined,true);
  await r.call('feedback',{capability:'text',route:'fixture/fast',passed:true},f.exec);
  assert.equal(r.load(localCaller(f.exec)).profiles[0].quarantined,true);
  const before=r.load(localCaller(f.exec)).calls;
  const result=await r.call('probe',{capability:'text',routes:[{provider:'fixture',model:'fast'}],force:true},f.exec);
  assert.equal(result[0].quarantined,true);assert.equal(r.load(localCaller(f.exec)).calls,before);
  const w=r.windows()[0];r.resumeProfile(w.project,w.window,'fixture/fast','text');
  assert.equal(r.load(localCaller(f.exec)).profiles[0].passed,false);
  assert.equal((await r.call('probe',{capability:'text',routes:[{provider:'fixture',model:'fast'}]},f.exec))[0].passed,true);
});
test('browser cannot click or read a different window tab',async t=>{
  const f=fixture(t);f.ctx.desktopBrowser={getService:async()=>({call:async()=>({tabs:[{id:'own'}],active:'own'})})};
  await assert.rejects(browserCall(f.ctx,'read',{tabId:'foreign'},f.exec),/不属于/);
  f.ctx.desktopBrowser={getService:async()=>({call:async()=>({tabs:[{id:'own'}],active:'own'}),browser:{tab:()=>({})}})};
  await assert.rejects(browserCall(f.ctx,'click',{selector:'button'},f.exec),/完全权限/);
  assert.equal(BROWSER_TOOLS.length,12);
});
test('stdio server annotation cannot grant itself read-only permission',async t=>{
  const f=fixture(t),m=new McpManager(f.ctx,f.home);await m.init();t.after(()=>m.close());
  await m.manage({action:'save',server:{id:'stdio',transport:'stdio',command:process.execPath,args:[fileURLToPath(new URL('./stdio-fixture.mjs',import.meta.url))]},secrets:{env:{FIXTURE_SECRET:'not-echoed'},headers:{}}});
  const tool=f.defs.get('mcp__stdio__echo');await assert.rejects(tool.execute({value:'ok'},f.exec),/完全权限/);
  await m.manage({action:'save',server:{...m.config.servers.find(s=>s.id==='stdio'),readOnlyTools:['echo']}});
  assert.equal((await f.defs.get('mcp__stdio__echo').execute({value:'ok'},f.exec)).content[0].text,'ok');
  assert.ok(!JSON.stringify(m.status()).includes('not-echoed'));await m.manage({action:'remove',id:'stdio'});assert.ok(!f.defs.has('mcp__stdio__echo'));
});
test('Streamable HTTP and legacy SSE discover real tools',async t=>{
  const f=fixture(t),m=new McpManager(f.ctx,f.home);await m.init();t.after(()=>m.close());
  const streams=new Map();const reply=q=>{
    let result,error;
    if(q.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else if(q.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object',properties:{value:{type:'string'}}}}]};
    else if(q.method==='tools/call')result={content:[{type:'text',text:q.params.arguments.value}]};
    else if(q.method==='ping')result={};else error={code:-32601,message:'Method not found'};
    return {jsonrpc:'2.0',id:q.id,...(error?{error}:{result})};
  };
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/sse'){res.writeHead(200,{'content-type':'text/event-stream'});streams.set('fixture',res);res.write('event: endpoint\ndata: /messages?session=fixture\n\n');return;}
    if(req.method!=='POST'){res.writeHead(405).end();return;}
    let raw='';for await(const b of req)raw+=b;const q=JSON.parse(raw);
    if(url.pathname==='/messages'){res.writeHead(202).end();if(q.id!==undefined)streams.get('fixture').write('event: message\ndata: '+JSON.stringify(reply(q))+'\n\n');}
    else if(q.id===undefined)res.writeHead(202).end();else {res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(reply(q)));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{for(const s of streams.values())s.end();server.closeAllConnections();server.close();});
  for(const [id,transport,route]of [['http','streamable-http','mcp'],['sse','sse','sse']]) {
    await m.manage({action:'save',server:{id,transport,url:'http://127.0.0.1:'+server.address().port+'/'+route,readOnlyTools:['echo']}});
    const result=await f.defs.get('mcp__'+id+'__echo').execute({value:'wire-pass'},f.exec);assert.equal(result.content[0].text,'wire-pass');
    await m.manage({action:'remove',id});
  }
});
