import {memberRef} from './groups.js'
export function estimateTokens({text='',system='',tools=[]}={}){
 const source=text+system+(tools.length?JSON.stringify(tools):'');let count=0
 for(const char of source)count+=/[^\u0000-\u00ff]/.test(char)?1:0.28
 return Math.ceil(count)
}
const contentText=m=>typeof m?.content==='string'?m.content:(m?.content||[]).map(p=>p?.text||'').join('\n')
export function requestFeatures(options={}){
 const messages=options.messages||[],recent=messages.filter(m=>m.role==='user').slice(-2),text=recent.map(contentText).join('\n'),all=messages.map(contentText).join('\n')
 const hasImage=messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>['image','image_url','input_image'].includes(p?.type)))
 return {text,estTokens:estimateTokens({text:all,system:options.system||'',tools:options.tools||[]})+(hasImage?2048:0),taskTokens:estimateTokens({text}),hasImage,toolCount:options.tools?.length||0,messageCount:messages.filter(m=>m.role==='user').length}
}
export function scoreRequest(f,smart={}){
 let score=0;const rules=[]
 const add=(yes,n,label)=>{if(yes){score+=n;rules.push(label)}}
 add((f.taskTokens??f.estTokens)>smart.longContextTokens,0.35,'本次任务内容较长')
 add(/```|\b(?:traceback|exception|segfault|stack trace)\b|\.(?:tsx?|jsx?|py|rs|go|java|cpp)\b/i.test(f.text),0.3,'包含代码或故障信息')
 add(/架构|重构|证明|根因|多步骤|深入|审计|设计|推导|architecture|refactor|root cause|prove/i.test(f.text),0.3,'需要深入分析或设计')
 add(f.messageCount>=8,0.15,'任务经过多轮讨论')
 return {score:Math.min(1,Math.round(score*100)/100),rules}
}
export const tierOf=(g,i)=>g.members[i]?.tier==='strong'||g.members[i]?.tier==='cheap'?g.members[i].tier:i<Math.ceil(g.members.length/2)?'strong':'cheap'
export function quotaRemaining(member,stats={},now=Date.now()){
 const q=member.quota||{};if(q.remaining==null||q.resetAt==null)return null
 let reset=q.resetAt,base=q.remaining
 if(reset<=now){if(!(q.periodHours>0))return null;const period=q.periodHours*3600000;reset+=Math.floor((now-reset)/period+1)*period;base=q.limit??q.remaining}
 const used=stats.quotaResetAt===reset?(stats.quotaUsed||0):0
 return {remaining:Math.max(0,base-used),resetAt:reset,urgency:Math.max(0,base-used)/Math.max(1/3600,(reset-now)/3600000)}
}
export function chooseMember({group,features,capability,cooldownUntil=()=>0,now=Date.now(),exclude=new Set(),runtime={},preferred,smartTarget}){
 const info=group.strategy==='smart'?scoreRequest(features,group.smart):{score:0,rules:[]},target=smartTarget||(info.score>=group.smart.strongThreshold?'strong':'cheap'),skipped=[],eligible=[]
 for(let index=0;index<group.members.length;index++){
  const member=group.members[index],ref=memberRef(member),caps=capability(member)||{}
  let reason
  if(member.enabled===false)reason='已停用'
  else if(exclude.has(ref))reason='本轮已尝试'
  else if(features.estTokens>(caps.contextWindow??Infinity))reason='上下文容量不足'
  else if(features.hasImage&&caps.vision!==true)reason='不支持本次图片输入'
  else if(features.toolCount&&caps.tools===false)reason='不支持工具调用'
  else if(cooldownUntil(ref)>now)reason='冷却中'
  if(reason){skipped.push({ref,reason,until:cooldownUntil(ref)});continue}
  eligible.push({member,ref,index,stats:runtime.members?.[ref]||{},tier:tierOf(group,index)})
 }
 if(!eligible.length)return {member:null,reason:'暂无可用成员',skipped,...info,target}
 let candidates=eligible
 if(group.strategy==='manual')candidates=eligible.filter(e=>e.ref===group.manual)
 if(!candidates.length)return {member:null,reason:'指定模型当前不可用',skipped,...info,target}
 const pinned=candidates.find(e=>e.ref===preferred)
 let picked=pinned,reason=pinned?'沿用本轮或会话选择':''
 if(!picked)switch(group.strategy){
  case 'smart':picked=candidates.find(e=>e.tier===target)||candidates[0];reason=smartTarget?'分类模型判断为'+(target==='strong'?'复杂任务':'简单任务'):'本地规则判断为'+(target==='strong'?'复杂任务':'简单任务');break
  case 'rotate':picked=candidates.find(e=>e.index>=(runtime.cursor||0))||candidates[0];reason='依次轮换';break
  case 'usage':picked=[...candidates].sort((a,b)=>(a.stats.calls||0)-(b.stats.calls||0)||a.index-b.index)[0];reason='优先使用次数较少的模型';break
  case 'weight':picked=[...candidates].sort((a,b)=>((b.stats.credit||0)+(b.member.weight||1))-((a.stats.credit||0)+(a.member.weight||1))||a.index-b.index)[0];reason='按配置权重分配';break
  case 'pace':picked=candidates.map(e=>({...e,quota:quotaRemaining(e.member,e.stats,now)})).filter(e=>e.quota&&e.quota.remaining>0).sort((a,b)=>b.quota.urgency-a.quota.urgency||a.index-b.index)[0];reason='优先使用临近重置且剩余次数较多的模型';break
  case 'manual':picked=candidates[0];reason='使用手动指定模型';break
  default:picked=[...candidates].sort((a,b)=>group.rateLimitAction==='last'?((a.stats.demotedAt||0)-(b.stats.demotedAt||0)||a.index-b.index):a.index-b.index)[0];reason='按成员顺序选择'
 }
 return {member:picked?.member||null,reason:picked?reason:'请更新额度次数和重置时间',skipped,...info,target,eligible:eligible.map(e=>e.ref)}
}
