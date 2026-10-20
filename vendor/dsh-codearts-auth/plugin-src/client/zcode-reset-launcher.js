import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {ZcodeResetPanel} from './zcode-reset.js';

export function ZcodeComposerResetDialog({rpcCall,onClose,onChanged,model}){
 const [accounts,setAccounts]=React.useState([]),[accountId,setAccountId]=React.useState(''),[sources,setSources]=React.useState(null),[error,setError]=React.useState(''),[loading,setLoading]=React.useState(true);
 const closeRef=React.useRef(null);
 React.useEffect(()=>{let alive=true;closeRef.current?.focus();rpcCall('account.list',{provider:'zcode'}).then(value=>{if(!alive)return;const rows=(value.accounts||[]).filter(a=>a.enabled);setAccounts(rows);if(rows.length===1)setAccountId(rows[0].id);if(!rows.length)setError('没有启用的 ZCode 账号，请先在 Jet Hub 登录并启用。');}).catch(e=>{if(alive)setError(e?.message||'账号读取失败');}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[rpcCall]);
 React.useEffect(()=>{setSources(null);setError('');if(!accountId)return;let alive=true;setLoading(true);rpcCall('zcode.sources',{accountId}).then(value=>{if(alive)setSources(value);}).catch(e=>{if(alive)setError(e?.message||'套餐读取失败');}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[accountId,rpcCall]);
 const account=accounts.find(a=>a.id===accountId),selected=sources?.sources.find(s=>s.id===sources.selected);
 return React.createElement('div',{className:'dim-jh-modalOverlay',style:{zIndex:4000},onClick:e=>{if(e.target===e.currentTarget)onClose();},onKeyDown:e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onClose();}if(e.key==='Tab'){const items=[...e.currentTarget.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]')].filter(n=>n.getClientRects().length);if(items.length&&e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items.at(-1).focus();}else if(items.length&&!e.shiftKey&&document.activeElement===items.at(-1)){e.preventDefault();items[0].focus();}}}},
  React.createElement('section',{role:'dialog','aria-modal':true,'aria-label':'ZCode 套餐额度重置',className:'dim-jh-modal'},
   React.createElement('header',{className:'dim-jh-modalHead'},React.createElement('strong',null,'ZCode · 重置额度'),React.createElement('button',{ref:closeRef,type:'button',className:'dim-jh-btn',onClick:onClose,'aria-label':'关闭额度重置'},'关闭')),
   React.createElement('div',{className:'dim-jh-modalBody'},
    model?React.createElement('p',{className:'dim-jh-hint'},'当前模型：'+model):null,
    React.createElement('label',null,'ZCode 账号',React.createElement('select',{'aria-label':'重置额度的 ZCode 账号',value:accountId,onChange:e=>setAccountId(e.target.value),style:{width:'100%',minHeight:40}},React.createElement('option',{value:''},'请选择账号…'),accounts.map(a=>React.createElement('option',{key:a.id,value:a.id},a.nickname||a.accountName||'ZCode 账号')))),
    loading?React.createElement('p',{role:'status'},'正在读取账号和套餐…'):null,
    error?React.createElement('p',{role:'alert'},error):null,
    selected&&selected.kind!=='individual'&&selected.kind!=='team'?React.createElement('p',{className:'dim-jh-hint'},'当前调用来源为“'+selected.label+'”。此重置不会增加该来源余额，请在下面明确选择要重置的编程套餐。'):null,
    account&&sources?React.createElement(ZcodeResetPanel,{key:accountId,account:{...account,zcodeSource:sources.selected},sources:sources.sources,rpcCall,embedded:true,onChanged}):null)));
}

// 模型选择器只负责入口；账号、套餐及真实 API 继续由 Jet Hub 自己管理。
export function installZcodeComposerReset({rpcCall}){
 let root,node,previousFocus;
 const close=()=>{root?.unmount();root=undefined;node?.remove();node=undefined;if(previousFocus?.isConnected)previousFocus.focus();};
 const launch=({model,onChanged,returnFocus}={})=>{close();previousFocus=returnFocus||document.activeElement;node=document.createElement('div');node.dataset.dshZcodeReset='';document.body.appendChild(node);root=createRoot(node);root.render(React.createElement(ZcodeComposerResetDialog,{rpcCall,onClose:close,onChanged,model}));};
 globalThis.__dshOpenZcodeReset=launch;
 return()=>{if(globalThis.__dshOpenZcodeReset===launch)delete globalThis.__dshOpenZcodeReset;close();};
}
