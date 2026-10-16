import * as React from 'react';
const names={FIVE_HOUR:'5 小时',WEEK:'每周'};
/** 与本地冷却清理分开：此处会核销上游 Coding Plan 的真实重置机会。 */
export function ZcodeResetPanel({account,sources,rpcCall,onChanged,embedded=false}){
 const plans=sources.filter(s=>s.kind==='individual'||s.kind==='team');
 const initial=plans.some(s=>s.id===account.zcodeSource)?account.zcodeSource:embedded?'':plans[0]?.id||'';
 const [source,setSource]=React.useState(initial),[snapshot,setSnapshot]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[notice,setNotice]=React.useState(''),[confirm,setConfirm]=React.useState(null),[nextTry,setNextTry]=React.useState(0);
 const current=React.useRef(source),alive=React.useRef(true),keys=React.useRef(new Map());current.current=source;
 React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[account.id]);
 React.useEffect(()=>{if(nextTry>Date.now()){const timer=setTimeout(()=>setNextTry(0),Math.min(nextTry-Date.now(),2147483647));return()=>clearTimeout(timer);}},[nextTry]);
 const storageKey=(target,action)=>'dsh:zcode-reset:'+account.id+':'+target+':'+action;
 const operationKey=(target,action,done=false)=>{const k=storageKey(target,action);if(done){keys.current.delete(k);try{localStorage.removeItem(k);}catch{}return;}let key=keys.current.get(k);if(!key){try{key=localStorage.getItem(k);}catch{}}if(!key||!/^[A-Za-z0-9_-]{1,64}$/.test(key)){key=crypto.randomUUID();}keys.current.set(k,key);try{localStorage.setItem(k,key);}catch{}return key;};
 const call=(method,target,extra={})=>rpcCall(method,{accountId:account.id,sourceId:target,...extra});
 const load=async()=>{if(busy||!source)return;const target=source;setBusy(true);setError('');try{const status=await call('zcode.resetStatus',target);if(alive.current&&current.current===target){setSnapshot(status);setNotice('重置机会已刷新');}}catch(e){if(alive.current&&current.current===target)setError(e?.message||'重置机会读取失败');}finally{if(alive.current)setBusy(false);}};
 const opportunity=async()=>{if(busy||!source||nextTry>Date.now())return;const target=source;setBusy(true);setError('');try{const result=await call('zcode.resetOpportunity',target,{idempotencyKey:operationKey(target,'opportunity')});operationKey(target,'opportunity',true);if(alive.current&&current.current===target){setNextTry(result.nextTryAt||0);setNotice(result.granted?'已领取重置机会':'本次没有获得重置机会'+(result.nextTryAt?'，可重试时间：'+new Date(result.nextTryAt).toLocaleString():''));}const status=await call('zcode.resetStatus',target);if(alive.current&&current.current===target)setSnapshot(status);}catch(e){if(alive.current&&current.current===target){setError(e?.message||'领取重置机会失败');setNextTry(Date.now()+60000);}}finally{if(alive.current)setBusy(false);}};
 const use=async()=>{if(busy||!confirm)return;const target=source,type=confirm;let completed=false;setBusy(true);setError('');try{await call('zcode.resetUse',target,{idempotencyKey:operationKey(target,type),resetType:type,confirmed:true});completed=true;operationKey(target,type,true);if(alive.current&&current.current===target){setConfirm(null);setSnapshot(null);setNotice(names[type]+'额度已重置，已消耗 1 次机会');}await onChanged?.();const status=await call('zcode.resetStatus',target);if(alive.current&&current.current===target)setSnapshot(status);}catch(e){if(alive.current&&current.current===target)setError(completed?'重置已经完成，刷新额度失败；请点查询重置机会刷新，不要重复重置。':(e?.message||'额度重置未确认')+'；重试将沿用本次操作编号。');}finally{if(alive.current)setBusy(false);}};
 const rows=[['FIVE_HOUR',snapshot?.availableFiveHourResets],['WEEK',snapshot?.availableWeekResets]];
 const selected=plans.find(p=>p.id===source);
 React.useEffect(()=>{if(embedded&&source)void load();},[embedded,source,account.id]);
 return React.createElement(embedded?'div':'details',{className:'dim-jh-zcodeReset',style:{borderTop:'1px solid var(--border-color,#8884)',marginTop:12,paddingTop:10}},
  embedded?null:React.createElement('summary',{style:{cursor:'pointer',padding:'8px 0'}},'重置编程套餐额度'),
  React.createElement('p',{className:'dim-jh-hint'},'使用 ZCode 已有的重置机会恢复套餐额度。仅适用于个人或机构编程套餐，不会增加赠送 Token 或机构充值余额。'),
  React.createElement('label',null,'要重置的套餐 ',React.createElement('select',{'aria-label':'额度重置目标套餐',value:source,disabled:busy||!!confirm,onChange:e=>{setSource(e.target.value);setSnapshot(null);setError('');setNotice('');setNextTry(0);},style:{width:'100%',minHeight:40}},...(embedded?[React.createElement('option',{key:'choose',value:''},'请选择要重置的编程套餐…')]:[]),plans.map(p=>React.createElement('option',{key:p.id,value:p.id},p.label)))),
  React.createElement('button',{type:'button',className:'dim-jh-btn',disabled:busy||!source,onClick:()=>void load()},busy?'处理中…':'查询重置机会'),
  React.createElement('button',{type:'button',className:'dim-jh-btn',disabled:busy||!source||nextTry>Date.now(),onClick:()=>void opportunity()},'领取可用重置机会'),
  snapshot?rows.map(([type,items])=>{const valid=(items||[]).filter(i=>i.expireAt>Date.now());return React.createElement('div',{key:type,style:{display:'flex',flexWrap:'wrap',alignItems:'center',gap:8,marginTop:8}},React.createElement('span',null,names[type]+'重置：'+valid.length+' 次'+(valid.length?'，最早到期 '+new Date(Math.min(...valid.map(i=>i.expireAt))).toLocaleString():'')),React.createElement('button',{type:'button',className:'dim-jh-btn',disabled:busy||!!confirm||!valid.length,onClick:()=>setConfirm(type)},'重置'+names[type]+'额度'));}):null,
  confirm?React.createElement('div',{role:'dialog','aria-label':'确认消耗额度重置机会',style:{border:'1px solid #cf8e4c',borderRadius:8,padding:12,marginTop:10}},
   React.createElement('p',null,'套餐：'+(selected?.label||source)+'。将消耗 1 次'+names[confirm]+'重置机会，把此周期额度恢复至满额；此操作无法撤销。'),
   React.createElement('button',{type:'button',className:'dim-jh-btn',disabled:busy,onClick:()=>void use()},'确认消耗 1 次机会并重置'),
   React.createElement('button',{type:'button',className:'dim-jh-btn',disabled:busy,onClick:()=>setConfirm(null)},'取消')):null,
  notice?React.createElement('p',{role:'status',className:'dim-jh-hint'},notice):null,
  error?React.createElement('p',{role:'alert',className:'dim-jh-hint','data-tone':'error'},error):null);
}
