const enabled=document.getElementById('enabled'),save=document.getElementById('save'),status=document.getElementById('status');let current;
async function rpc(payload){const r=await fetch('/lingxi-recall/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'manage',payload})});const result=(await r.json()).result;if(!r.ok||!result?.ok)throw Error(result?.error?.message||'操作未完成');return result.value}
function render(s){current=s;enabled.checked=s.config.enabled;enabled.disabled=!!s.fault;save.disabled=!!s.fault;status.textContent=s.fault||((s.config.enabled?'已启用':'已关闭')+' · '+s.scope+'\n'+(s.recent?.at(-1)?.status||'尚未进行新的对话召回'))}
async function load(){try{render(await rpc({action:'status'}))}catch(e){status.textContent=e.message}}
save.onclick=async()=>{save.disabled=true;try{render(await rpc({action:'configure',revision:current.config.revision,enabled:enabled.checked}))}catch(e){status.textContent=e.message+'；请刷新后重试';save.disabled=false}};
void load();
