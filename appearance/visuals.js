// Browser-only appearance composition shared by the host client and the settings preview.
export const fontStacks = {
  system:'system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
  serif:'"Iowan Old Style","Songti SC","Noto Serif CJK SC",Georgia,serif',
  rounded:'"SF Pro Rounded","Nunito Sans",system-ui,sans-serif',
  mono:'"SF Mono","Cascadia Code","JetBrains Mono",Consolas,monospace',
  jetbrains:'"JetBrains Mono","SF Mono",Consolas,monospace',fira:'"Fira Code","SF Mono",Consolas,monospace',
};
export function composeTokens(recipe, options) {
  const tokens=structuredClone(recipe.tokens);
  const set=(key,value)=>{tokens[key]={light:value,dark:value};};
  for(const [field,keys] of Object.entries({
    accent:['--dsw-static-deepseek-500','--dsw-alias-button-info-fill','--dsw-alias-button-primary-fill','--dsw-alias-brand-primary','--dsw-focus-ring-color','--color-primary','--brand','--dut-lime','--dut-blue'],
    background:['--dsw-alias-bg-base','--dsw-alias-bg-layer-1','--dsw-specific-sidebar-fill','--dsh-skin-bg'],
    foreground:['--dsw-alias-label-primary','--dsh-skin-text'],
  })) if(options[field]) for(const key of keys)set(key,options[field]);
  for(const [field,keys] of [['uiFont',['--dsw-font-family']],['codeFont',['--dsw-font-mono','--ds-font-family-code']]]) {
    if(!options[field])continue;
    const family=fontStacks[options[field]];
    for(const key of keys)set(key,family);
    for(const [key,modes] of Object.entries(tokens)) {
      if(!key.startsWith('--dsw-font-'))continue;
      const code=/mono|code/.test(key);if((field==='codeFont')!==code)continue;
      if(key.endsWith('-font-family'))set(key,family);
      else if(!/-font-size|-line-height|-weight|-style$/.test(key)&&Object.values(modes).every(v=>/px\s*\/\s*[\d.]+px/.test(v)))
        tokens[key]=Object.fromEntries(Object.entries(modes).map(([m,v])=>[m,v.replace(/(px\s*\/\s*[\d.]+px)\s+.+$/,'$1 '+family)]));
    }
  }
  if(options.codeSize) for(const key of ['--dsw-font-mono-code-font-size','--dsw-font-code-font-size'])set(key,options.codeSize+'px');
  return tokens;
}
export async function recipeFor(state) {
  const response=await fetch('/appearance-center/themes/'+state.selected.file+'.json');
  if(!response.ok)throw Error('主题资源读取失败，当前外观保留');
  const recipe=await response.json();
  if(recipe.id!==state.theme)throw Error('主题资源与选择不一致');
  return recipe;
}
export function createVisuals(doc, {native=false}={}) {
  const body=doc.body,html=doc.documentElement;
  const savedAttributes=new Map(),savedStyles=new Map(); let link=null,recipe=null,options=null,tokens=null,scheme='light',disposed=false;
  const rememberAttr=(node,key)=>{const id=(node===html?'html:':'body:')+key;if(!savedAttributes.has(id))savedAttributes.set(id,{node,key,value:node.getAttribute(key)});};
  const attr=(node,key,value)=>{rememberAttr(node,key);if(value===null){if(node.hasAttribute(key))node.removeAttribute(key);}else if(node.getAttribute(key)!==value)node.setAttribute(key,value);};
  const style=(key,value)=>{if(!savedStyles.has(key))savedStyles.set(key,[body.style.getPropertyValue(key),body.style.getPropertyPriority(key)]);body.style.setProperty(key,value);};
  const resetStyle=()=>{for(const [key,[value,priority]] of savedStyles){if(value)body.style.setProperty(key,value,priority);else body.style.removeProperty(key);}savedStyles.clear();};
  const resetAttrs=()=>{for(const {node,key,value} of savedAttributes.values()){if(value===null)node.removeAttribute(key);else node.setAttribute(key,value);}savedAttributes.clear();};
  const common=doc.createElement('link');common.rel='stylesheet';common.href='/appearance-center/runtime.css';doc.head.append(common);
  const paint=()=>{
    if(!recipe||disposed)return;
    const legacy=recipe.attributes['data-dsh-skin']??null;attr(html,'data-dsh-skin',legacy);
    for(const attribute of body.getAttributeNames()) if(attribute.startsWith('data-dsh-')&&attribute!== 'data-dsh-settings-embed'&&attribute in (recipe.previousAttributes||{}))attr(body,attribute,null);
    for(const [key,value] of Object.entries(recipe.attributes))if(key!=='data-dsh-skin')attr(body,key,value);
    attr(body,'data-appearance-center','');attr(body,'data-ac-motion',options.reduceMotion?'reduce':'normal');
    attr(body,'data-ac-width',options.width);attr(body,'data-ac-glass',options.translucent?'yes':'no');
    attr(body,'data-ac-wallpaper',options.wallpaper?'yes':'no');
    attr(body,'data-ac-code-font',options.codeFont?'yes':'no');attr(body,'data-ac-code-size',options.codeSize?'yes':'no');
    if(!native){attr(body,'data-ds-dark-theme',scheme==='dark'?'':null);style('color-scheme',scheme);for(const [key,modes] of Object.entries(tokens))style(key,modes[scheme]);}
    style('--ac-glow',recipe.glow||'none');style('--ac-wallpaper',options.wallpaper?'url("'+options.wallpaper+'")':'none');
    style('--ac-wallpaper-opacity',String(options.wallpaperOpacity));style('--ac-blur',options.blur+'px');
    style('--ac-code-family',fontStacks[options.codeFont]||'inherit');style('--ac-code-size',options.codeSize?options.codeSize+'px':'inherit');
  };
  const observer=new MutationObserver(()=>{if(recipe && html.getAttribute('data-dsh-skin')!==(recipe.attributes['data-dsh-skin']??null))paint();});
  observer.observe(html,{attributes:true,attributeFilter:['data-dsh-skin']});
  return {
    async prepare(next) {
      const candidate=doc.createElement('link');candidate.rel='stylesheet';candidate.media='not all';candidate.href='/appearance-center/themes/'+next.file+'.css';
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{candidate.remove();reject(Error('主题样式加载超时，当前外观保留'));},15000);
        candidate.onload=()=>{clearTimeout(timer);resolve();};candidate.onerror=()=>{clearTimeout(timer);candidate.remove();reject(Error('主题样式读取失败，当前外观保留'));};doc.head.append(candidate);});
      let used=false;
      return {commit(state,mode,composed){if(used||disposed){candidate.remove();return;}used=true;
        const oldAttributes=recipe?.attributes||{}; resetStyle();resetAttrs();
        recipe={...next,previousAttributes:oldAttributes};options=state.options;tokens=composed;scheme=mode;
        for(const key of Object.keys(oldAttributes))if(key!=='data-dsh-skin')attr(body,key,null);
        paint();const previous=link;link=candidate;candidate.media='all';previous?.remove();
      },cancel(){if(!used){used=true;candidate.remove();}}};
    },
    sync(mode){scheme=mode;paint();},
    dispose(){disposed=true;observer.disconnect();link?.remove();common.remove();resetStyle();resetAttrs();},
  };
}
