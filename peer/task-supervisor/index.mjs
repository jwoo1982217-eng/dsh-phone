import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {TaskSupervisor} from './service.mjs';
import {enhancementTools} from './enhancement-tools.mjs';
export function applyTaskSupervisor(ctx){const service=new TaskSupervisor(ctx,process.env.DSH_HOME||path.join(os.homedir(),'.dsh'));ctx.provide('dshTaskSupervisor',service);enhancementTools(ctx,service);
 ctx.on('agent/pre-step',(payload,next)=>service.before(payload,next));
 ctx.on('agent/turn-stopping',payload=>service.stop(payload));
 ctx.on('session/event',(session,event)=>{try{service.observe(session,event);}catch(e){service.faulted(e);}});
 ctx.on('agent/status',({agent,status})=>{if(status==='idle')void service.recover(agent).catch(e=>service.faulted(e));});
 ctx.on('agent/created',({agent})=>{if(agent.status==='idle')queueMicrotask(()=>{void service.recover(agent).catch(e=>service.faulted(e));});});
 ctx.on('dispose',()=>service.close());
 ctx.systemPrompt.variable('dsh_task_supervisor_context',context=>service.context(context.agent));
 ctx.systemPrompt.context({name:'dsh:task-supervisor',order:23,text:'{{dsh_task_supervisor_context}}'});
 ctx.tools.register(defineTool({name:'task_report',description:'Report the actual outcome and acceptance evidence for the current supervised task. Optional project-method candidate and actual normal/boundary/failure evidence are reviewed by the host after this turn; submitting a report does not approve learning.',parameters:{report:{type:'string',required:true,description:'JSON object: outcome completed|partial|failed, result, acceptance, takeoverCompleted boolean, optional method {key,trigger,action,exclusions,change} and cases [{name,kind: normal|boundary|failure,evidence: absolute existing file path,checks: [{type: json-equals|text-includes|sha256,pointer: JSON pointer when applicable,expected: actual value}]}]. Descriptions are not evidence paths; missing actual cases stay pending verification'}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute(args,exec){return JSON.stringify(service.report(exec.agent,JSON.parse(args.report)));}}));
 ctx.connection.rpc.handle('/task-supervisor',async(method,payload)=>{try{if(method!=='manage')throw Error('请求无效');return {ok:true,value:await service.manage(payload)};}catch(e){return {ok:false,error:{code:'supervisor/failed',message:e.message,details:{}}};}},{authority:'loopback'});
 for(const [route,file,type]of [['/task-supervisor','page.html','text/html'],['/task-supervisor/page.js','page.js','text/javascript']]){const content=fs.readFileSync(new URL('./'+file,import.meta.url));ctx.effect(()=>ctx.webServer.register({kind:'exact',path:route,handler(req,res){if(req.method!=='GET'){res.writeHead(405).end();return;}res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'"});res.end(content);}}));}
 ctx.effect(()=>{for(const agent of ctx.get('agents')?.list?.()||[])if(agent.status==='idle')void service.recover(agent).catch(e=>service.faulted(e));});return service;
}
