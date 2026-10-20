// Narrow adapter for the pinned 0.2.1-alpha.1 service. No SDK files are edited.
// Model selection happens before creation; prepared LLM requests are immutable.
export function installNativeSelection(ctx,scheduler){
 const service=ctx.get('subagents'),restore=[];
 const starts=typeof service.startActivation==='function'?['startActivation']:['start','startContinuable'];
 try { for(const method of [...starts,'sendMessage']){
  const original=service[method],descriptor=Object.getOwnPropertyDescriptor(service,method);
  if(method==='sendMessage'&&typeof original!=='function')continue;
  if(typeof original!=='function')throw Error('当前SDK缺少原生子代理入口：'+method);
  const wrapped=function(...args){
   if(method==='sendMessage'){
    // 关闭后拒绝向子代理派发后续工作，仍允许已运行的子代理向父代理回报。
    const [sender,target]=args;if(!scheduler.config.delegationEnabled&&!(typeof target==='string'&&sender?.session?.header?.parentSession===target))scheduler.assertDelegation();
    return original.apply(this,args);
   }
   const request=method==='start'?args[1]:args[0]?.request;
   scheduler.assertDelegation();
   const policy=request?.parent?.session&&ctx.get('sessionProjections')?.stateOf(request.parent.session,'subagentModelSelectionPolicy');
   const route=request?.agentOptions;
   if(route?.provider!==undefined||route?.model!==undefined){
    if(typeof route.provider!=='string'||!route.provider.length||typeof route.model!=='string'||!route.model.length)throw Error('子模型 provider 和 model 必须同时提供且非空。');
    if(Array.isArray(policy)&&!policy.some(p=>p.provider===route.provider&&p.model===route.model))throw Error('子模型线路不在本会话授权列表：'+route.provider+'/'+route.model);
   }
   if(scheduler.config.routes.length&&Array.isArray(policy)&&!request?.agentOptions?.provider&&!request?.agentOptions?.model){
    const routes=scheduler.config.routes.filter(r=>policy.some(p=>p.provider===r.provider&&p.model===r.model));
    if(routes.length)throw Error('请根据子任务内容选择模型，不能默认并发继承主模型。调用 subagent_model_routes 查看候选，然后在 subagent、subagent_fork 或 spawn_teammate 中同时传 provider 和 model。可用线路：'+routes.map(r=>r.provider+'/'+r.model+'（'+r.tasks.join(',')+'）').join('；'));
   }
   return original.apply(this,args);
  };
  if(!Reflect.defineProperty(service,method,{value:wrapped,writable:true,configurable:true}))throw Error('当前SDK不能安装子代理路由适配');
  restore.push(()=>{if(service[method]===wrapped){if(descriptor)Object.defineProperty(service,method,descriptor);else delete service[method];}});
 }} catch(error) {for(const fn of restore.reverse())fn();throw error;}
 return ()=>{for(const fn of restore.reverse())fn();};
}
