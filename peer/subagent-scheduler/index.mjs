import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {Scheduler,TASKS,keyOf} from './scheduler.mjs';
import {installNativeSelection} from './native.mjs';
import {ModelCatalog,authorizeSelected} from './catalog.mjs';
export const name='dsh-subagent-scheduler';
export const inject=['webServer','connection','llm','tools','systemPrompt','subagents','sessionProjections','subagentModelSelection'];
export function apply(ctx){
 const allowed=()=>{const p=ctx.get('subagentModelSelection')?.current();return p?.enabled?p.allowedModels:[];};
 const scheduler=new Scheduler(process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),{allowed});
 const directory=new ModelCatalog(ctx.llm,{fallback:allowed});let saving=false;
 ctx.provide('dshSubagentScheduler',scheduler);const restore=installNativeSelection(ctx,scheduler);
 ctx.on('dispose',()=>{restore();scheduler.close();});
 ctx.on('llm/stream',(options,next)=>scheduler.stream(options,next));
 const forAgent=agent=>{const policy=agent?.session&&ctx.get('sessionProjections').stateOf(agent.session,'subagentModelSelectionPolicy');return scheduler.config.routes.filter(r=>allowed().some(x=>keyOf(x)===keyOf(r))&&(!policy||policy.some(x=>keyOf(x)===keyOf(r))));};
 const instructions=agent=>{if(!scheduler.config.delegationEnabled)return '用户已关闭子代理协作。请由主模型独立完成工作，不再新建或自动派出子代理。已接收的子代理任务可自然完成，并允许子代理向父代理回报；不要向其派发后续工作。';const routes=forAgent(agent);return '子代理由你这个主模型按实际工作内容选择模型/API，不按固定轮询，也不要全部继承当前主模型。简单任务自行完成；可独立分工时先明确子任务与验收条件，再从下列已配置线路判断适配性，调用 subagent、subagent_fork 或团队 spawn_teammate 时必须同时给出 provider、model；spawn/fork 是执行方式，不能当作模型供应商。旧失败成员名不可重用，修正参数后使用新名字。工作类型是用户的偏好，不是能力实测保证；必要时用 list_subagent_models 查询准确能力。不要为了选择模型额外发收费探针。相关后续任务用 send_message 复用原代理。DSH统一处理并发排队、额度组和限流冷却，不得用大量新建子代理绕过队列；限流后勿重复提交相同任务。可用 subagent_model_routes 查询实时状态。候选：'+JSON.stringify(routes.map(r=>({provider:r.provider,model:r.model,suggestedTasks:r.tasks,quotaGroup:r.quotaGroup})))+(routes.length?'':'。尚无可用候选，请使用原有允许线路；固定路由的旧聊天可新建聊天以启用原生选择。');};
 ctx.systemPrompt.context({name:'dsh:subagent-scheduler',order:114,text:c=>instructions(c.agent)});
 ctx.tools.register(defineTool({name:'subagent_model_routes',description:'查看已配置的子代理模型/API候选、工作类型偏好、排队和冷却状态；不调用模型。主代理理解任务后自行选择精确provider/model，再用原生subagent工具派单。',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute(_a,exec){const state=scheduler.status();return JSON.stringify({delegationEnabled:state.config.delegationEnabled,routes:state.config.delegationEnabled?forAgent(exec.agent):[],taskTypes:TASKS,limits:{total:state.config.maxConcurrent,quotaGroup:state.config.providerConcurrency,model:state.config.modelConcurrency},queued:state.queued.length,cooldowns:state.cooldowns,nativeSelection:!!ctx.get('sessionProjections').stateOf(exec.agent.session,'subagentModelSelectionPolicy'),notice:'模型/API不会自行分工，由你按任务选路；同额度组共享并发限制。线路和模型能力需以实际结果验收，费用未知不能说免费。'});}}));
 ctx.connection.rpc.handle('/subagent-scheduler',async(method,p)=>{try{
  if(method!=='manage')throw Error('无效请求');
  if(p.action==='status')return {ok:true,value:{...scheduler.status(),tasks:TASKS}};
  if(p.action==='catalog')return {ok:true,value:await directory.read(p.refresh===true)};
  if(p.action==='save'){
   if(saving)throw Error('正在保存，请稍候');saving=true;const previous=scheduler.status();let saved;
   try{
    const snapshot=await directory.read();
    // 先用完整目录验证并持久化，再经宿主设置 API 授权用户选中的精确线路。
    const original=scheduler.allowed;scheduler.allowed=()=>snapshot.routes;
    try{saved=scheduler.save(p.config,p.revision);}finally{scheduler.allowed=original;}
    try{await authorizeSelected(ctx,saved.config.routes);}catch(error){scheduler.save(previous.config,saved.revision);throw error;}
    return {ok:true,value:{...scheduler.status(),tasks:TASKS}};
   }finally{saving=false;}
  }
  throw Error('无效操作');
 }catch(e){return {ok:false,error:{code:'scheduler/failed',message:e.message,details:{}}};}},{authority:'loopback'});
 for(const [url,file,type]of [['/subagent-scheduler','page.html','text/html'],['/subagent-scheduler/page.js','page.js','text/javascript'],['/subagent-scheduler/page.css','page.css','text/css']]){const bytes=fs.readFileSync(new URL(file,import.meta.url));ctx.effect(()=>ctx.webServer.register({kind:'exact',path:url,handler(req,res){if(req.method!=='GET'){res.writeHead(405).end();return;}const rejection=ctx.connection.requestRejection(req);if(rejection!==undefined){res.writeHead(rejection).end();return;}res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'"});res.end(bytes);}}));}
 return scheduler;
}
