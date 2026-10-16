/** Rebuild reviewed appearance assets from the pinned, extracted upstream snapshots. */
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import {engine as openCode,names as openCodeNames} from './compat/opencode-engine.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const sources = process.argv[2];
if (!sources) throw Error('Usage: node appearance/build-catalog.mjs <pinned upstream directory>');
const require = createRequire(path.join(root, '../vendor/dsh-codearts-auth/package.json'));
const { transform } = require('esbuild');
const pins = [
  ['dream','梦幻皮肤','RevolutionLA/dsh-dream-skin','8fd400696ed542217490a9aa5f4d74fd574ff1de','玻璃质感与渐变 · 8 套独立配色'],
  ['beizi','主题调色','BeiZi6/dsh-theme-plugin','b3e7e143532c4b6df71da753d2336bb018949d2a','经典配色 · 深浅色成对'],
  ['oil','Theme Studio','oil-oil/dsh-theme','38c3cf09f1ece363283d29224c61ac369b0ffabc','15 套配色与字体方案'],
  ['gallery','主题画廊','whyihaveyou/dsh-themes','e5bc0d953fe38ee26ee749618a3d7ee3b17464da','纹理、装饰与主题合集'],
  ['tweaks','UI Tweaks','wlj521/dsh-ui-tweaks','e0186824ff1f45ee62c9d3ab37ad5ef06264e1e2','极简、海报与规格书外观'],
];
await mkdir(path.join(root,'assets/themes'),{recursive:true});
await mkdir(path.join(root,'licenses'),{recursive:true});
const providers = [{id:'local',name:'现有皮肤',description:'保留桃云、薄荷手记和原版',themes:[]}];
providers.push({id:'opencode',name:'现有插件 · OpenCode',description:'38 套经典配色，纳入统一外观管理',url:'https://github.com/FeatherHunter/dsh-opencode-palette',version:'2.0.26',license:'MIT',themes:[]});
for (const [id,name,repo,commit,description] of pins) {
  const directory = path.join(sources,repo.replace('/','--'));
  const proof = JSON.parse(await readFile(path.join(directory,'source-manifest.json')));
  if (proof.commit !== commit) throw Error('Upstream commit changed: '+repo);
  providers.push({id,name,description,url:'https://github.com/'+repo,commit,license:id==='gallery'?'Apache-2.0':'MIT',themes:[]});
  if(id==='gallery') await writeFile(path.join(root,'licenses',id+'.txt'),'dsh-themes by whyihaveyou. README declares Apache-2.0.\nSource: https://github.com/'+repo+'/tree/'+commit+'\nhttps://www.apache.org/licenses/LICENSE-2.0\n');
  else await copyFile(path.join(directory,'LICENSE'),path.join(root,'licenses',id+'.txt'));
}
const get = (repo,file)=>readFile(path.join(sources,repo.replace('/','--'),file),'utf8');
function expression(source,marker,open,close) {
  const start=source.indexOf(open,source.indexOf(marker)); let depth=0, quote='',escape=false;
  for(let i=start;i<source.length;i++) {
    const c=source[i]; if(quote) {if(escape)escape=false;else if(c==='\\')escape=true;else if(c===quote)quote='';continue;}
    if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
    if(c===open)depth++;if(c===close&&!--depth)return source.slice(start,i+1);
  } throw Error('Missing source literal: '+marker);
}
function pairs(light,dark=light) {return Object.fromEntries([...new Set([...Object.keys(light),...Object.keys(dark)])].map(k=>[k,{light:light[k]??dark[k],dark:dark[k]??light[k]}]));}
async function add(provider,id,name,recipe,css='',extra={}) {
  const file=provider+'--'+id;
  const metadata={id:provider+':'+id,provider,file,name,mode:recipe.mode||'dual',swatches:recipe.swatches||['#f4f5f7','#6e82be','#232734'],...extra};
  providers.find(p=>p.id===provider).themes.push(metadata);
  await writeFile(path.join(root,'assets/themes',file+'.json'),JSON.stringify({...recipe,...metadata,tokens:recipe.tokens||{},attributes:recipe.attributes||{}})+'\n');
  await writeFile(path.join(root,'assets/themes',file+'.css'),css);
}
const localCss=await readFile(path.join(root,'../peer/workflow-hub/theme.css'),'utf8');
for(const [id,name,swatches] of [['peach','小甜桃 · 桃云',['#fff8fa','#b74670','#201720']],['mint','薄荷手记',['#f3fbf8','#267660','#101e1c']],['original','原版',['#ffffff','#537cef','#151517']]])
  await add('local',id,name,{attributes:id==='original'?{}:{'data-dsh-skin':id},swatches},id==='original'?'':localCss);
for(const id of openCode.themeNames()) {
  const result=openCode.renderTheme(id,{mode:'mono',size:13,fontKey:'JetBrains Mono'}),preview=openCode.previewColors(id);
  await add('opencode',id,openCodeNames.THEME_ZH[id]||id,{tokens:result.tokens,mode:id==='system'||openCode.delegatesBackground(id)?'dual':'dark',swatches:preview?[preview.background,preview.primary,preview.accent].filter(Boolean):undefined},result.css);
}
const dream=await get(pins[0][2],'lib/client.js');
const skins=vm.runInNewContext('('+expression(dream,'const SKINS =','[',']')+')',{}, {timeout:1000});
for(const skin of skins) {
  const label=dream.match(new RegExp('"skin\\.'+skin.id+'": "([^"]+)"'))?.[1]||skin.id;
  await add('dream',skin.id,label,{tokens:pairs(skin.tokens),mode:skin.colorScheme,glow:skin.glow,swatches:[skin.tokens['--dsw-alias-bg-base']||skin.tokens['--dsw-alias-bg-layer-1'],skin.tokens['--dsw-static-deepseek-500'],skin.tokens['--dsw-alias-label-primary']].filter(Boolean)});
}
const beizi=await get(pins[1][2],'index.js');
const beiziPure=beizi.slice(beizi.indexOf('function parseColor'),beizi.indexOf('const ModeSchema')).replace('export const presets','const presets')+beizi.slice(beizi.indexOf('function deriveMode'),beizi.indexOf('function resolveMode'))+'\n({presets,deriveMode})';
const bz=vm.runInNewContext(beiziPure,{}, {timeout:1000});
for(const preset of Object.values(bz.presets)) {
  const mode=m=>preset.name==='stock'?{}:{...bz.deriveMode(m,preset[m]).colors,...bz.deriveMode(m,preset[m]).fonts};
  await add('beizi',preset.name,preset.label,{tokens:pairs(mode('light'),mode('dark')),swatches:preset.name==='stock'?undefined:[preset.light.background,preset.light.accent,preset.dark.background]});
}
const compile=async(file)=>{const code=(await transform(await get(pins[2][2],file),{loader:'ts',format:'cjs'})).code; const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports},{timeout:1000});return module.exports;};
const oilPresets=(await compile('src/client/presets.ts')).THEME_PRESETS;
const oilTokens=(await compile('src/client/theme-tokens.ts')).buildThemeTokenOverrides;
for(const p of oilPresets) await add('oil',p.id,p.id==='rosePine'?'Rosé Pine':p.id[0].toUpperCase()+p.id.slice(1),{tokens:oilTokens({...p.palette,...p.typography}),swatches:[p.palette.lightBackground,p.palette.lightAccent,p.palette.darkBackground]});
function bodyTokens(css,attr) {
  const light={},dark={};
  for(const match of css.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors=match[1].split(',').map(s=>s.trim());
    for(const selector of selectors) {
      if(!new RegExp('^body\\['+attr+'\\](?:\\[data-ds-dark-theme\\])?$').test(selector))continue;
      const target=selector.includes('data-ds-dark-theme')?dark:light;
      for(const declaration of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))target[declaration[1]]=declaration[2].trim().replace(/\s*!important$/,'');
    }
  } return pairs(light,{...light,...dark});
}
for(const id of (await readdir(path.join(sources,pins[3][2].replace('/','--'),'skins'))).sort()) {
  const skin=JSON.parse(await get(pins[3][2],'skins/'+id+'/skin.json'));
  const css=await get(pins[3][2],'skins/'+id+'/src/client/'+id+'.module.css');
  if(/url\s*\(/i.test(css))throw Error('Unbundled gallery resource: '+id);
  await add('gallery',id,skin.name,{tokens:bodyTokens(css,skin.bodyAttr),attributes:{[skin.bodyAttr]:''},swatches:['#f5f1eb',skin.accent,'#242635']},css,{description:skin.tagline,tags:skin.tags||[]});
}
const tweaks=await get(pins[4][2],'src/client/index.tsx');
function cssLiteral(name) {const marker='const '+name+' = `',start=tweaks.indexOf(marker)+marker.length;let end=start;while(end<tweaks.length && (tweaks[end]!=='`'||tweaks[end-1]==='\\'))end++;if(start<marker.length||end===tweaks.length)throw Error('Missing CSS '+name);return tweaks.slice(start,end);}
const tint=cssLiteral('EFFORT_TINT_CSS');
for(const [id,name,constant,swatches] of [['default','默认','',''],['minimal','极简','MINIMAL_CSS',['#ffffff','#c15f3c','#151517']],['neon-lime','荧光海报','NEON_LIME_CSS',['#f5f6ec','#cdff00','#e64b38']],['spec-sheet','规格书','SPEC_SHEET_CSS',['#f7f8f2','#002fa7','#172230']]]) {
  const css=constant?cssLiteral(constant).replace('${EFFORT_TINT_CSS}',tint):'';
  if(css.includes('${'))throw Error('Unresolved UI CSS interpolation');
  await add('tweaks',id,name,{tokens:bodyTokens(css,'data-ds-dark-theme'),swatches:swatches||undefined},css);
}
await writeFile(path.join(root,'assets/catalog.json'),JSON.stringify({version:1,providers},null,2)+'\n');
await writeFile(path.join(root,'assets/provenance.json'),JSON.stringify({sources:pins.map(([provider,name,repo,commit])=>({provider,repo,commit})),scope:'Appearance presets, CSS and typography only; functional/account/session plugins are not replaced.'},null,2)+'\n');
console.log(JSON.stringify(providers.map(p=>({id:p.id,count:p.themes.length}))));
