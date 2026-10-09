import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { createRelay } from './relay.mjs';
import { ToolTunnel } from './tunnel.mjs';
import { newPair } from './protocol.mjs';
import { PhoneToolHub } from './hub.mjs';

test('actual desktop DSH MCP plugin calls the phone hub: consent, real script result, revocation and recovery', async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-phone-toolbox-')));
  const relay = createRelay(); const ctx = new Context(); let phone;
  t.after(async () => { await ctx.fiber.dispose(); phone?.stop(); relay.close(); await rm(home, { recursive:true, force:true }); });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  await cp(new URL('../sample-tools/', import.meta.url), path.join(home, 'cloud-tool-hub/tools'), { recursive:true });
  const pair = newPair('ws://127.0.0.1:' + relay.server.address().port + '/relay'), file = path.join(home, 'pair.json');
  await writeFile(file, JSON.stringify(pair), { mode:0o600 });
  const hub = new PhoneToolHub({ home, bridge:{call:async()=>({apps:[],grant:null})} });
  hub.config = { enabled:true, toolIds:['note-normalize'], skillIds:[] };
  phone = new ToolTunnel(pair, 'phone'); phone.handler = (name,args) => hub.call(name,args);
  phone.on('online',()=>{hub.online=true;}); phone.on('offline',()=>hub.disconnect()); phone.start();
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime);
  await ctx.plugin(McpClient, { serverName:'phone_tools', transport:'stdio', command:process.execPath,
    args:[fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url)), '--pair-file', file],
    toolCallTimeoutMs:5000, failOnStartupError:true, reconnect:{enabled:false} });
  const agent = {id:'desktop-fixture',session:{id:'desktop-fixture',header:{}}}; let sequence=0;
  const raw = (name,args={}) => ctx.tools.execute({name:'mcp__phone_tools__'+name,arguments:args,callId:'toolbox-'+(++sequence),agent,signal:new AbortController().signal});
  const call = async(name,args={}) => { const result = await raw(name,args); assert.equal(result.isError,false,JSON.stringify(result)); return JSON.parse(result.value.content[0].text); };
  // MCP tool discovery can finish before both encrypted peers are ready.
  // Only retry this read-only readiness check, never a task or operation.
  let status; const deadline = Date.now() + 5000;
  do {
    status = await raw('phone_status');
    if (!status.isError) break;
    await new Promise(resolve=>setTimeout(resolve,50));
  } while (Date.now() < deadline);
  assert.equal(status.isError,false,JSON.stringify(status));
  assert.equal(JSON.parse(status.value.content[0].text).enabled,true);
  const task = await call('phone_task_request',{requestId:'dsh-task-1',title:'桌面 DSH 整理手机笔记'}); assert.equal(task.status,'pending');
  assert.equal((await raw('phone_local_tools',{taskId:task.taskId})).isError,true);
  await hub.approveTask(task.taskId,true);
  assert.equal((await call('phone_local_tools',{taskId:task.taskId})).tools[0].id,'note-normalize');
  const op = await call('phone_local_run',{taskId:task.taskId,requestId:'dsh-run-1',toolId:'note-normalize',args:{text:'hello  \nworld  '}});
  assert.equal(op.status,'pending'); assert.equal((await raw('phone_operation_execute',{taskId:task.taskId,operationId:op.operationId})).isError,true);
  hub.approveOperation(op.operationId,true);
  const result = await call('phone_operation_execute',{taskId:task.taskId,operationId:op.operationId}); assert.equal(result.status,'done');
  const artifact = path.join(hub.tasks.get(task.taskId).workspace,'note.txt'); assert.equal(await readFile(artifact,'utf8'),'hello\nworld\n');
  await writeFile(artifact,'new local edit'); assert.deepEqual(await call('phone_operation_execute',{taskId:task.taskId,operationId:op.operationId}),result); assert.equal(await readFile(artifact,'utf8'),'new local edit');
  await call('phone_task_stop',{taskId:task.taskId}); assert.equal((await raw('phone_workspace_list',{taskId:task.taskId})).isError,true);
  const next = await call('phone_task_request',{requestId:'dsh-task-2',title:'撤销后的新任务'}); await hub.approveTask(next.taskId,true);
  assert.deepEqual((await call('phone_workspace_list',{taskId:next.taskId})).files,[]);
  if(process.env.DSH_TOOLBOX_EVIDENCE) await writeFile(process.env.DSH_TOOLBOX_EVIDENCE,JSON.stringify({runtime:'actual pinned DSH MCP plugin and ToolRuntime, isolated phone hub and relay',dshCalled:true,localConsentRequired:true,actualScriptProducedFile:true,repeatDidNotExecute:true,revokedTaskDenied:true,newTaskRecovered:true,modelCalled:false},null,2),{mode:0o600});
});
