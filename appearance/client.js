window.__ModuleLoader__.load({id:'dsh-appearance-center',factory:()=>{
const inject=['slots','theme'];
function appearanceRequestId(){
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}
async function apply(ctx) {
  const {createVisuals,composeTokens,recipeFor}=await import('/appearance-center/visuals.js');
  const original=ctx.theme.getTheme();let current=null,recipe=null,layer=null,generation=0,closed=false;
  let palette,releasePalette,claiming=false,paletteQueued=false;
  const claimPalette=()=>{
    if(closed||claiming)return;const next=window.__opencodePalette;
    if(next===palette)return;
    if(next && typeof next.suspendAppearance!=='function')return;
    claiming=true;try{releasePalette?.();palette=next;releasePalette=next?.suspendAppearance();}finally{claiming=false;}
  };
  claimPalette();
  ctx.on('slots/changed',key=>{if(!['settings.section','settings.plugins.tab'].includes(key)||paletteQueued)return;paletteQueued=true;queueMicrotask(()=>{paletteQueued=false;claimPalette();});});
  const documents=new Map([[document,createVisuals(document,{native:true})]]);
  const mode=()=>ctx.theme.getTheme().active.colorScheme;
  const refreshFrames=()=>{
    for(const frame of document.querySelectorAll('iframe'))attach(frame);
    for(const [doc,visual] of documents)if(doc!==document && !doc.defaultView?.frameElement?.isConnected){visual.dispose();documents.delete(doc);}
  };
  async function attach(frame){
    try{if(new URL(frame.src,location.href).pathname==='/appearance-center'){if(current)frame.contentWindow?.postMessage({type:'dsh:appearance-state',state:current},location.origin);return;}const doc=frame.contentDocument;if(!doc?.body||documents.has(doc)||!current)return;
      const visual=createVisuals(doc);documents.set(doc,visual);const sequence=generation;
      const prepared=await visual.prepare(recipe);if(sequence!==generation||closed){prepared.cancel();return;}
      prepared.commit(current,mode(),composeTokens(recipe,current.options));
    }catch{} // Cross-origin embedded apps keep their own appearance.
  }
  async function adopt(state){
    if(closed||current && state.revision<current.revision)return false;
    if(current && state.revision===current.revision)return true;
    const sequence=++generation;const next=await recipeFor(state),prepared=await documents.get(document).prepare(next);
    if(sequence!==generation||closed){prepared.cancel();return false;}
    const tokens=composeTokens(next,state.options);
    const nextLayer=ctx.theme.overrideTokens('dsh-appearance-center',tokens);layer?.();layer=nextLayer;
    current=state;recipe=next;
    // Fixed palettes use the native day/night owner; dual palettes retain the user's chosen mode.
    if(next.mode!=='dual'||state.revision>0)ctx.theme.setTheme(next.mode==='dual'?state.options.mode:next.mode);
    if(state.options.uiSize!==null)ctx.theme.setFontSize(state.options.uiSize);
    prepared.commit(state,mode(),tokens);
    refreshFrames();
    for(const [doc,visual] of documents)if(doc!==document){try{const p=await visual.prepare(next);if(sequence===generation&&!closed)p.commit(state,mode(),tokens);else p.cancel();}catch{}}
    for(const frame of document.querySelectorAll('iframe')){try{if(new URL(frame.src,location.href).pathname==='/appearance-center')frame.contentWindow?.postMessage({type:'dsh:appearance-state',state},location.origin);}catch{}}
    return sequence===generation&&!closed;
  }
  const message=event=>{
    if(event.origin!==location.origin||event.data?.type!=='dsh:appearance-center')return;
    const trusted=[...document.querySelectorAll('iframe')].some(frame=>frame.contentWindow===event.source && new URL(frame.src,location.href).pathname==='/appearance-center');
    if(!trusted)return;
    adopt(event.data.state).then(applied=>event.source.postMessage({type:applied?'dsh:appearance-applied':'dsh:appearance-error',requestId:event.data.requestId,message:applied?'':'外观已被另一页面更新，请刷新后再试'},location.origin)).catch(error=>event.source.postMessage({type:'dsh:appearance-error',requestId:event.data.requestId,message:error.message},location.origin));
  };
  const onLoad=event=>{if(event.target?.tagName==='IFRAME')attach(event.target);};
  const sync=()=>{for(const visual of documents.values())visual.sync(mode());for(const frame of document.querySelectorAll('iframe')){try{if(new URL(frame.src,location.href).pathname==='/appearance-center')frame.contentWindow?.postMessage({type:'dsh:appearance-mode',mode:mode()},location.origin);}catch{}}};
  ctx.on('theme/change',sync);
  ctx.effect(()=>{window.addEventListener('message',message);document.addEventListener('load',onLoad,true);
    return()=>{closed=true;generation++;window.removeEventListener('message',message);document.removeEventListener('load',onLoad,true);for(const visual of documents.values())visual.dispose();layer?.();ctx.theme.setTheme(original.preference);ctx.theme.setFontSize(original.fontSize);releasePalette?.();};});
  function AppearanceSection(){return {$$typeof:Symbol.for('react.element'),type:'iframe',key:null,ref:null,_owner:null,
    props:{title:'统一外观设置',src:'/appearance-center','data-dsh-settings-embed':'',style:{width:'100%',height:'min(78dvh,880px)',minHeight:360,border:0,display:'block'}}};}
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'appearance',priority:-100,order:20,label:'外观'},AppearanceSection));
  for(const id of ['appearance','font-size'])ctx.slots.inject('settings.general.item',()=>ctx.slots.register({name:'settings.general.item',id,priority:-100,order:id==='appearance'?10:11},()=>null));
  const response=await fetch('/appearance-center/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:appearanceRequestId(),method:'manage',payload:{action:'status'}})});
  const envelope=await response.json();if(!response.ok||!envelope.result?.ok)throw Error('外观设置读取失败');
  let initial=envelope.result.value;
  // Only a first migration may adopt the old browser-local OpenCode choice.
  const oldPalette=palette?.getState?.();
  if(initial.revision===0 && oldPalette?.enabled && initial.providers.find(p=>p.id==='opencode')?.themes.some(t=>t.id==='opencode:'+oldPalette.theme)){
    const migration=await fetch('/appearance-center/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:appearanceRequestId(),method:'manage',payload:{action:'select',revision:0,theme:'opencode:'+oldPalette.theme}})}).then(r=>r.json());
    if(migration.result?.ok)initial=migration.result.value;
    else initial=await fetch('/appearance-center/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:appearanceRequestId(),method:'manage',payload:{action:'status'}})}).then(r=>r.json()).then(e=>e.result.value);
  }
  await adopt(initial);
  if(typeof BroadcastChannel!=='undefined')ctx.effect(()=>{const channel=new BroadcastChannel('dsh:appearance-center');channel.onmessage=()=>{
    fetch('/appearance-center/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:appearanceRequestId(),method:'manage',payload:{action:'status'}})}).then(r=>r.json()).then(e=>e.result?.ok&&adopt(e.result.value)).catch(()=>{});
  };return()=>channel.close();});
}
return {inject,apply};
}});
