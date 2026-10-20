import path from 'node:path'
import {JsonStore,emptyState,resolveDshHome} from './src/store.js'
import {MAX_GROUPS,normalizeGroup,normalizeState,publicGroup,findGroup} from './src/groups.js'
import {RoutingAdapter,ROUTING_PROVIDER} from './src/adapter.js'
import {rejectionFor} from './src/trust.js'
export const name='dsh-model-routing',inject=['llm']
export async function apply(ctx){
 const home=resolveDshHome(),store=new JsonStore(path.join(home,'model-routing/settings.json'),emptyState()),runtime=new JsonStore(path.join(home,'model-routing/runtime.json'),{groups:{}})
 const normalized=normalizeState(store.get());if((store.get().groups||[]).length!==normalized.groups.length)throw Error('有无法识别的路由组，已保留原配置，停止自动迁移')
 store.value=normalized
 const diagnostics=[],record=e=>{diagnostics.push(e);if(diagnostics.length>50)diagnostics.shift()}
 const adapter=new RoutingAdapter({llm:ctx.llm,state:()=>store.get(),record,runtime:runtime.get(),saveRuntime:s=>runtime.set(s),log:m=>ctx.logger.warn(m)})
 ctx.llm.registerAdapter([ROUTING_PROVIDER],adapter)
 ctx.provide('modelRouting',adapter)
 ctx.inject(['webServer'],scoped=>scoped.effect(()=>scoped.webServer.register({kind:'prefix',path:'/api/model-routing',handler:handler(ctx,store,diagnostics,adapter)})))
}
function announce(ctx){ctx.emit('llm/adapters-updated')}
function handler(ctx,store,diagnostics,adapter){return async(req,res)=>{
 const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
 const rejected=rejectionFor(req,ctx.get('connection'));if(rejected!==undefined)return send(rejected,{error:'请从 DSH 正常入口重新打开'})
 const route=new URL(req.url,'http://localhost').pathname.replace(/^\/api\/model-routing/,'').replace(/\/+$/,'')||'/',method=req.method
 const value=()=>({...store.get(),groups:store.get().groups.map(publicGroup)})
 try{
  if(method==='GET'&&route==='/groups')return send(200,value())
  if(method==='GET'&&route==='/catalog')return send(200,{providers:await catalog(ctx)})
  if(method==='GET'&&route==='/diagnostics')return send(200,{entries:diagnostics.slice().reverse()})
  if(method==='POST'&&['/groups','/groups/delete','/groups/toggle'].includes(route)){
   const body=await readJson(req);if(body.revision!==undefined&&body.revision!==store.get().revision)return send(409,{error:'配置已在另一处更新，请刷新后再保存，当前草稿仍保留'})
   const old=store.get();let list
   if(route==='/groups'){if(!Array.isArray(body.groups))return send(400,{error:'路由组列表格式不正确'});list=body.groups}
   else{if(!findGroup(old,body.id))return send(404,{error:'路由组已不存在'});list=route.endsWith('delete')?old.groups.filter(g=>g.id!==body.id):old.groups.map(g=>g.id===body.id?{...g,enabled:body.enabled!==false}:g)}
   if(list.length>MAX_GROUPS)return send(400,{error:`最多创建 ${MAX_GROUPS} 个路由组`})
   const groups=[],taken=new Set()
   for(const raw of list){const {group,error}=normalizeGroup(raw,{id:raw.id||undefined,taken});if(error)return send(400,{error});if(taken.has(group.id))return send(400,{error:'路由组 ID 重复'});taken.add(group.id);groups.push(group)}
   const next={version:2,revision:old.revision+1,preferences:{showProvider:body.preferences?.showProvider??old.preferences.showProvider},groups}
   store.set(next);adapter.caps.clear();announce(ctx);return send(200,value())
  }
  return send(404,{error:'未找到此功能'})
 }catch(e){return send(e.status||500,{error:e.message})}
}}
async function catalog(ctx){const providers=ctx.llm.listProviders().filter(p=>p.id!==ROUTING_PROVIDER);return Promise.all(providers.map(async p=>{let timer;try{const models=await Promise.race([ctx.llm.listModels(p.id),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('模型目录暂未就绪，可稍后刷新')),5000)})]);return {provider:p.id,name:p.name||p.id,models:models.map(m=>({id:m.id,name:m.name||m.id,inputModalities:m.inputModalities,contextWindow:m.context?.contextWindow||m.contextWindow}))}}catch(e){return {provider:p.id,name:p.name||p.id,models:[],error:e.message}}finally{clearTimeout(timer)}}))}
async function readJson(req){let bytes=0,chunks=[];for await(const c of req){bytes+=c.length;if(bytes>1000000)throw Object.assign(Error('配置过大'),{status:413});chunks.push(c)}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{throw Object.assign(Error('配置格式错误'),{status:400})}}
