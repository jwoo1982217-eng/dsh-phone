import {randomUUID} from 'node:crypto'
export const STRATEGIES=['smart','order','rotate','usage','pace','weight','manual']
export const STRATEGY_LABELS={smart:'智能',order:'按顺序',rotate:'轮流',usage:'最少使用',pace:'重置前用完',weight:'按权重',manual:'手动'}
export const MAX_MEMBERS=32,MAX_GROUPS=48
export const memberRef=m=>`${m.provider}/${m.model}`
const text=(v,max=200)=>typeof v==='string'?v.trim().slice(0,max):''
const num=(v,f,min,max)=>Number.isFinite(Number(v))&&v!==null&&v!==''?Math.min(max,Math.max(min,Number(v))):f
export const isGroupId=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v)
export function newGroupId(taken=new Set()){let id;do{id='grp-'+randomUUID().slice(0,8)}while(taken.has(id));return id}
export function normalizeMember(raw){
 if(!raw||typeof raw!=='object')return null
 const provider=text(raw.provider,120),model=text(raw.model,240)
 if(!provider||!model||provider==='model-routing')return null
 const q=raw.quota||{}
 return {provider,model,name:text(raw.name)||model,providerName:text(raw.providerName)||provider,enabled:raw.enabled!==false,tier:['strong','cheap'].includes(raw.tier)?raw.tier:'auto',weight:num(raw.weight,1,1,1000),quota:{remaining:num(q.remaining,null,0,1e9),limit:num(q.limit,q.remaining==null?null:Number(q.remaining),0,1e9),resetAt:num(q.resetAt,null,0,1e15),periodHours:num(q.periodHours,0,0,8760)}}
}
export function normalizeGroup(raw,options={}){
 if(!raw||typeof raw!=='object')return {error:'路由组格式不正确'}
 const name=text(raw.name,80);if(!name)return {error:'请填写路由组名称'}
 const strategy=raw.strategy||'order';if(!STRATEGIES.includes(strategy))return {error:'请选择有效的路由策略'}
 const input=Array.isArray(raw.members)?raw.members:[]
 const patterns=(Array.isArray(raw.patterns)?raw.patterns:[]).map(x=>text(x,240)).filter(Boolean).slice(0,12)
 if(!input.length&&!patterns.length)return {error:'请至少添加一个模型'}
 if(input.length>MAX_MEMBERS)return {error:`每组最多 ${MAX_MEMBERS} 个模型`}
 const members=input.map(normalizeMember);if(members.some(x=>!x))return {error:'成员必须来自有效的供应商和模型，不能嵌套本路由组'}
 const refs=members.map(memberRef);if(new Set(refs).size!==refs.length)return {error:'同一个模型不能重复添加'}
 const id=options.id??(isGroupId(raw.id)?raw.id:newGroupId(options.taken));if(!isGroupId(id))return {error:'ID 只能包含字母、数字、短横线和下划线'}
 const s=raw.smart||{},r=raw.retry||{},c=raw.context||{}
 const classifier=s.classifier&&text(s.classifier.provider)&&text(s.classifier.model)?{provider:text(s.classifier.provider),model:text(s.classifier.model)}:null
 if(classifier?.provider==='model-routing')return {error:'分类模型不能使用路由组自身'}
 const manual=refs.includes(raw.manual)?raw.manual:refs[0]||''
 const group={id,name,enabled:raw.enabled!==false,strategy,members,patterns,manual,smart:{mode:s.mode==='classifier'?'classifier':'rules',classifier,strongThreshold:num(s.strongThreshold,0.55,0.05,0.95),longContextTokens:num(s.longContextTokens,12000,1000,2e6),timeoutMs:num(s.timeoutMs,5000,100,30000)},retry:{maxSwitches:Math.floor(num(r.maxSwitches,Math.max(2,members.length-1),0,64)),maxWaitMs:num(r.maxWaitMs,raw.busyWaitMs??60000,0,240000)},firstTokenMs:num(raw.firstTokenMs,30000,0,600000),busyWaitMs:num(raw.busyWaitMs,r.maxWaitMs??60000,0,240000),rateLimitAction:raw.rateLimitAction==='last'?'last':'keep',context:{mode:['max','min','custom'].includes(c.mode)?c.mode:'max',tokens:num(c.tokens,128000,1024,2e7)},stays:['auto','session','turn','off'].includes(raw.stays)?raw.stays:'auto',listMembers:raw.listMembers===true}
 if(strategy==='smart'&&group.smart.mode==='classifier'&&!classifier)return {error:'请为智能路由选择分类模型'}
 if(strategy==='pace'&&!members.some(m=>m.enabled&&m.quota.remaining!==null&&m.quota.resetAt!==null))return {error:'“重置前用完”至少需要一个成员的剩余次数和重置时间'}
 return {group}
}
export function normalizeState(raw){
 const groups=[],taken=new Set()
 for(const item of raw?.groups||[]){if(groups.length>=MAX_GROUPS)break;const {group}=normalizeGroup(item,{id:item?.id,taken});if(group&&!taken.has(group.id)){groups.push(group);taken.add(group.id)}}
 return {version:2,revision:Math.floor(num(raw?.revision,0,0,1e12)),preferences:{showProvider:raw?.preferences?.showProvider===true},groups}
}
export const findGroup=(state,id)=>(state.groups||[]).find(g=>g.id===id)||null
export const publicGroup=group=>structuredClone(group)
export function globMatch(pattern,value){const expression=pattern.split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');return new RegExp('^'+expression+'$','i').test(value)}
