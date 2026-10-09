const $=id=>document.getElementById(id);let state,busy=false;
async function rpc(payload){const r=await fetch('/mcp-manager/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'manage',payload})});const d=await r.json();if(!r.ok||!d.result?.ok)throw Error(d.result?.error?.message||'操作未完成');return d.result.value;}
function node(tag,text,parent){const e=document.createElement(tag);e.textContent=text;parent.append(e);return e;}
async function work(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);$('message').textContent='处理中…';try{await fn();$('message').textContent='已完成';}catch(e){$('message').textContent=e.message;}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
function render(){
  $('notice').textContent=state.notice;$('pricing').value=JSON.stringify(state.pricing,null,2);$('servers').replaceChildren();
  for(const row of state.servers){const box=node('section','',$('servers'));node('h2',row.label,box);const s=node('p',row.status+' · '+row.transport+' · '+row.tools.length+' 个工具',box);s.className=row.status==='connected'?'ok':'bad';node('small','范围：'+row.scope+(row.error?' · '+row.error:''),box);
    const toggle=node('button',row.enabled?'停用':'启用',box);toggle.onclick=()=>work(async()=>{state=await rpc({action:'toggle',id:row.id,enabled:!row.enabled,revision:state.revision});render();});
    const reconnect=node('button','重新连接',box);reconnect.onclick=()=>work(async()=>{state=await rpc({action:'reconnect',id:row.id,revision:state.revision});render();});
    if(!row.transport.startsWith('builtin-')){const edit=node('button','编辑',box);edit.onclick=()=>editRow(row);const remove=node('button','移除',box);remove.onclick=()=>work(async()=>{state=await rpc({action:'remove',id:row.id,revision:state.revision});render();});}
    const d=node('details','',box);node('summary','查看工具与名称',d);for(const tool of row.tools)node('p',tool.publicName+' — '+tool.description,d);
  }
  $('limits').textContent='每次最多3条候选 × 2个小样例；每窗口最多40次推理；每个自动派出的子代理最多8次推理。真实任务须主代理验收。';
  $('windows').replaceChildren();
  if(!state.windows.length)node('p','尚无探针记录；在新的 DSH 聊天窗口让主代理探测并派单。',$('windows'));
  for(const window of state.windows){const box=node('section','',$('windows'));node('p',window.projectPath+' · '+window.sessionId,box);node('small',(window.quarantined?'已隔离':'可用')+' · '+window.calls+'/40 次推理',box);const b=node('button',window.quarantined?'解除隔离':'隔离此窗口',box);b.onclick=()=>work(async()=>{state=await rpc({action:window.quarantined?'window.resume':'window.quarantine',project:window.project,window:window.window});render();});
    const reset=node('button','重置窗口预算',box);reset.onclick=()=>work(async()=>{state=await rpc({action:'window.reset-budget',project:window.project,window:window.window});render();});
    for(const profile of window.profiles.filter(p=>p.quarantined)){node('p','已隔离：'+profile.route+' · '+profile.capability,box);const resume=node('button','恢复探针资格',box);resume.onclick=()=>work(async()=>{state=await rpc({action:'profile.resume',project:window.project,window:window.window,route:profile.route,capability:profile.capability});render();});}
    const d=node('details','',box);node('summary','查看结果、用量与失败',d);node('pre',JSON.stringify({profiles:window.profiles,events:window.events},null,2),d);
  }
}
function editRow(row={}){$('editor').hidden=false;for(const id of ['id','label','scope','url','command','cwd','serial'])$(id).value=row[id]|| (id==='scope'?'*':'');$('id').readOnly=!!row.id;$('transport').value=row.transport||'streamable-http';$('args').value=JSON.stringify(row.args||[]);$('readOnlyTools').value=JSON.stringify(row.readOnlyTools||[]);$('secrets').value='';$('editor').scrollIntoView({behavior:'smooth'});}
$('refresh').onclick=()=>work(async()=>{state=await rpc({action:'status'});render();});$('add').onclick=()=>editRow();$('cancel').onclick=()=>{$('editor').hidden=true;$('secrets').value='';};
$('editor').onsubmit=e=>{e.preventDefault();work(async()=>{const server={enabled:true};for(const id of ['id','label','transport','scope','url','command','cwd','serial'])server[id]=$(id).value.trim();server.args=JSON.parse($('args').value||'[]');server.readOnlyTools=JSON.parse($('readOnlyTools').value||'[]');const payload={action:'save',server,revision:state.revision};if($('secrets').value.trim())payload.secrets=JSON.parse($('secrets').value);state=await rpc(payload);$('secrets').value='';$('editor').hidden=true;render();});};
$('savePricing').onclick=()=>work(async()=>{state=await rpc({action:'pricing',pricing:JSON.parse($('pricing').value||'{}'),revision:state.revision});render();});
$('export').onclick=()=>work(async()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='dsh-mcp-audit-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
work(async()=>{state=await rpc({action:'status'});render();});
