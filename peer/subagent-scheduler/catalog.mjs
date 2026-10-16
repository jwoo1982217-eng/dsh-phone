import {keyOf} from './scheduler.mjs';

// 读取宿主注册的完整目录，不把旧的子代理允许列表当作供应商目录。
// 单家慢响应不挡住其他家；只返回模型元数据，不读取 API 密钥或发起推理。
export class ModelCatalog{
 constructor(llm,{fallback=()=>[],timeoutMs=10000,ttlMs=60000}={}){Object.assign(this,{llm,fallback,timeoutMs,ttlMs});this.snapshot={routes:[],providers:[]};this.expires=0;}
 async read(refresh=false){
  if(this.loading)return this.loading;if(!refresh&&Date.now()<this.expires)return this.snapshot;
  this.loading=this.load().then(value=>{this.snapshot=value;this.expires=Date.now()+this.ttlMs;return value;}).finally(()=>{this.loading=undefined;});return this.loading;
 }
 async load(){
  const entries=this.llm.listProviders().map(p=>typeof p==='string'?{id:p,name:p}:p),results=new Array(entries.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,entries.length)},async()=>{for(;;){const i=cursor++;if(i>=entries.length)return;const p=entries[i];let timer;
   try{const models=await Promise.race([Promise.resolve().then(()=>this.llm.listModels(p.id)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('目录读取超时')),this.timeoutMs);})]);const seen=new Set();results[i]={provider:p.id,providerName:p.name||p.id,routes:models.flatMap(m=>{const model=m.id||m.model;if(typeof model!=='string'||!model||seen.has(model))return [];seen.add(model);return [{provider:p.id,model,modelName:m.name||model,providerName:p.name||p.id}];})};}
   catch{const known=[...this.snapshot.routes,...this.fallback()].filter(r=>r.provider===p.id),routes=[...new Map(known.map(r=>[keyOf(r),{provider:r.provider,model:r.model,modelName:r.modelName||r.model,providerName:p.name||p.id}])).values()];results[i]={provider:p.id,providerName:p.name||p.id,routes,error:'目录暂不可读，已保留已有线路；请稍后刷新'};}
   finally{clearTimeout(timer);}
  }}));
  return {routes:results.flatMap(r=>r.routes),providers:results.map(({routes,...p})=>({...p,count:routes.length}))};
 }
}

// 用户点击保存才把精确选中的新线路加入原生允许列表；不自动授权整个目录。
export async function authorizeSelected(ctx,routes){
 const owner=ctx.get('subagentModelSelection'),current=owner?.current();if(!owner)throw Error('原生子代理选模服务未就绪');
 const union=[...new Map([...(current?.allowedModels||[]),...routes].map(r=>[keyOf(r),{provider:r.provider,model:r.model}])).values()];
 if(current.enabled&&union.length===current.allowedModels.length)return;
 if(!union.length)return;const settings=ctx.get('settings');
 const entry=settings?.describe().find(r=>r.ns==='subagent-model-selection-settings');if(!entry)throw Error('无法保存原生模型授权，请刷新后重试');
 await settings.update(entry.ns,{enabled:true,allowedModels:union},entry.revision);
}
