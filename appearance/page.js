function appearanceRequestId(){
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}
import {createVisuals,composeTokens,recipeFor} from './visuals.js';
let state,recipe,pending=false,wallpaper='',sequence=0,requestedRevision=-1;
const visual=createVisuals(document),channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('dsh:appearance-center'):null;
const byId=id=>document.getElementById(id),form=byId('options');
const acknowledgements=new Map();
const announce=(message,error=false)=>{byId('notice').textContent=message;byId('notice').toggleAttribute('data-error',error);};
const loaded=()=>announce(state.compatibility?.warning||'已加载 '+state.providers.length+' 个来源，共 '+state.providers.reduce((n,p)=>n+p.themes.length,0)+' 套主题。',!!state.compatibility?.warning);
async function manage(payload){
  const response=await fetch('/appearance-center/manage',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:appearanceRequestId(),method:'manage',payload})});
  const result=(await response.json()).result;if(!response.ok||!result?.ok)throw Error(result?.error?.message||'外观未保存');return result.value;
}
const mode=()=>recipe.mode==='dual'?(state.options.mode==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):state.options.mode):recipe.mode;
async function preview(next){if(next.revision<requestedRevision)return;requestedRevision=next.revision;const id=++sequence,nextRecipe=await recipeFor(next),prepared=await visual.prepare(nextRecipe);if(id!==sequence){prepared.cancel();return;}recipe=nextRecipe;state=next;prepared.commit(state,mode(),composeTokens(recipe,state.options));}
function fields(){for(const [key,value] of Object.entries(state.options)){const element=form.elements.namedItem(key);if(!element)continue;if(element.type==='checkbox')element.checked=value;else element.value=value??'';}
  wallpaper=state.options.wallpaper;byId('wallpaper-info').textContent=wallpaper?'本机图片已保存':'未设置壁纸';
  form.elements.mode.disabled=recipe.mode!=='dual';byId('mode-hint').textContent=recipe.mode==='dual'?'':recipe.mode==='dark'?'这套主题采用独立深色配色':'这套主题采用独立浅色配色';
}
function render(){
  byId('current-name').textContent=state.selected.name;byId('current-source').textContent=state.providers.find(p=>p.id===state.selected.provider).name;
  byId('custom').hidden=false;fields();renderProviders();
}
const openProviders=new Set();let limits={};
function renderProviders(){
  const search=byId('search').value.trim().toLowerCase();const container=byId('providers');
  for(const details of container.querySelectorAll('details[open]'))openProviders.add(details.dataset.provider);
  container.replaceChildren();let found=0;
  for(const provider of state.providers){
    const matches=provider.themes.filter(t=>(t.name+' '+t.id+' '+provider.name+' '+(t.tags||[]).join(' ')).toLowerCase().includes(search));if(!matches.length)continue;found+=matches.length;
    const details=document.createElement('details');details.dataset.provider=provider.id;details.open=search!==''||openProviders.has(provider.id)||provider.id===state.selected.provider;
    const summary=document.createElement('summary'),title=document.createElement('span'),description=document.createElement('span'),count=document.createElement('span');
    title.className='source-title';title.textContent=provider.name;description.className='source-description';description.textContent=provider.description;title.append(description);
    count.className='source-count';count.textContent=matches.length+' 套'+(provider.id===state.selected.provider?' · 当前':'');summary.append(title,count);details.append(summary);
    details.addEventListener('toggle',()=>{if(details.open)openProviders.add(provider.id);else openProviders.delete(provider.id);});
    const grid=document.createElement('div');grid.className='theme-grid';const limit=limits[provider.id]||24;
    for(const theme of matches.slice(0,limit)){
      const button=document.createElement('button');button.type='button';button.className='theme-card';button.dataset.theme=theme.id;button.setAttribute('aria-pressed',String(theme.id===state.theme));button.disabled=pending;
      const swatches=document.createElement('span');swatches.className='swatches';swatches.setAttribute('aria-hidden','true');for(const color of theme.swatches){const chip=document.createElement('i');chip.style.background=color;swatches.append(chip);}
      const name=document.createElement('span');name.className='theme-name';name.textContent=theme.name;const caption=document.createElement('span');caption.className='theme-mode';caption.textContent=theme.mode==='dual'?'深浅色':'独立'+(theme.mode==='dark'?'深色':'浅色');
      button.append(swatches,name,caption);button.addEventListener('click',()=>save({action:'select',theme:theme.id}));grid.append(button);
    } details.append(grid);
    const footer=document.createElement('div');footer.className='provider-footer';if(provider.url){const link=document.createElement('a');link.href=provider.url;link.textContent='项目来源 · '+provider.license;link.target='_blank';link.rel='noopener noreferrer';footer.append(link);}
    if(matches.length>limit){const more=document.createElement('button');more.type='button';more.textContent='再展开 '+Math.min(24,matches.length-limit)+' 套';more.addEventListener('click',()=>{limits[provider.id]=limit+24;renderProviders();});footer.append(more);}details.append(footer);container.append(details);
  }
  if(!found){const empty=document.createElement('p');empty.textContent='没有匹配的主题，试试其他名称或风格。';container.append(empty);}
}
async function save(payload){if(pending)return;pending=true;renderProviders();announce('正在保存…');
  try{
    // Read and stage the selected asset before persisting its choice.
    if(payload.theme){const theme=state.providers.flatMap(p=>p.themes).find(t=>t.id===payload.theme);const r=await recipeFor({theme:theme.id,selected:theme}),p=await visual.prepare(r);p.cancel();}
    const next=await manage({...payload,revision:state.revision});await preview(next);render();
    if(parent!==window){const requestId=appearanceRequestId();await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{acknowledgements.delete(requestId);reject(Error('外观已保存，主界面尚未确认应用，请重新打开设置'));},17000);
      acknowledgements.set(requestId,{resolve,reject,timer});parent.postMessage({type:'dsh:appearance-center',state,requestId},location.origin);
    });}
    channel?.postMessage({revision:state.revision});announce('外观已应用并保存。');
  }catch(error){announce(error.message,true);if(error.message.includes('另一页面')){try{await preview(await manage({action:'status'}));render();}catch{}}}
  finally{pending=false;renderProviders();}
}
form.addEventListener('submit',event=>{event.preventDefault();const options={};for(const key of Object.keys(state.options)){const e=form.elements.namedItem(key);if(!e)continue;options[key]=e.type==='checkbox'?e.checked:['uiSize','codeSize','blur','wallpaperOpacity'].includes(key)?(e.value===''?null:Number(e.value)):e.value;}options.wallpaper=wallpaper;save({action:'configure',options});});
byId('restore').addEventListener('click',()=>save({action:'reset',theme:'local:original'}));
byId('reset-options').addEventListener('click',()=>save({action:'configure',options:{mode:'system',uiFont:'',codeFont:'',uiSize:null,codeSize:null,accent:'',background:'',foreground:'',wallpaper:'',wallpaperOpacity:.16,blur:0,translucent:false,reduceMotion:true,width:'default'}}));
byId('search').addEventListener('input',()=>renderProviders());
byId('remove-wallpaper').addEventListener('click',()=>{wallpaper='';byId('wallpaper-info').textContent='待保存：移除壁纸';});
byId('wallpaper-file').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;if(!/^image\/(png|jpeg|webp)$/.test(file.type)||file.size>20*1024*1024){announce('请选择 20MB 以内的 PNG、JPEG 或 WebP 图片。',true);return;}
  try{const image=await createImageBitmap(file);const scale=Math.min(1,1600/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);image.close();wallpaper=canvas.toDataURL('image/webp',.75);if(wallpaper.length>3_000_000)throw Error('图片过大，请选择尺寸较小的壁纸');byId('wallpaper-info').textContent='待保存：'+file.name;announce('点击“保存调整”应用壁纸。');}catch(error){announce(error.message,true);}});
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent)return;if(event.data?.type==='dsh:appearance-mode')visual.sync(event.data.mode);
  if(event.data?.type==='dsh:appearance-state'&&!pending&&(!state||event.data.state.revision>state.revision))preview(event.data.state).then(()=>{if(state){render();loaded();}}).catch(error=>announce(error.message,true));
  if(['dsh:appearance-applied','dsh:appearance-error'].includes(event.data?.type)){const pending=acknowledgements.get(event.data.requestId);if(pending){clearTimeout(pending.timer);acknowledgements.delete(event.data.requestId);event.data.type==='dsh:appearance-applied'?pending.resolve():pending.reject(Error(event.data.message));}else if(event.data.type==='dsh:appearance-error')announce(event.data.message,true);}});
const media=matchMedia('(prefers-color-scheme:dark)');media.addEventListener('change',()=>{if(state)visual.sync(mode());});
channel&&(channel.onmessage=async()=>{if(!pending){try{await preview(await manage({action:'status'}));render();announce('已同步另一页面的外观调整。');}catch(error){announce(error.message,true);}}});
window.addEventListener('pagehide',()=>{visual.dispose();channel?.close();});
manage({action:'status'}).then(preview).then(()=>{if(!state)return;render();loaded();}).catch(error=>announce(error.message,true));
