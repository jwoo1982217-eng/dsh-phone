import {readFile,writeFile,rename,mkdir,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
export const marker='DSH appearance center lease v1';
export function patchOpenCode(source){
 if(source.includes(marker))return source;
 if(createHash('sha256').update(source).digest('hex')!=='b80103955ff96e6e0b80987fa2a0e8085df821424534ead7e4a60bd4b32ff67b')throw Error('OpenCode 源码与已验证 2.0.26 快照不同，保留原状');
 const replace=(before,after)=>{if(source.split(before).length!==2)throw Error('OpenCode 2.0.26 兼容边界不匹配');source=source.replace(before,after);};
 replace('let tokenDispose = null',`let tokenDispose = null
    // ${marker}: suspend rendering without changing any saved palette state.
    let appearanceLeases = 0, appearanceClosed = false`);
 replace('function applyStyle() {','function applyStyle() {\n      if (appearanceLeases > 0 || appearanceClosed) return');
 replace('function syncAppearanceForTheme(name) {','function syncAppearanceForTheme(name) {\n      if (appearanceLeases > 0 || appearanceClosed) return');
 replace('globalThis.__opencodePalette = {',`globalThis.__opencodePalette = {
        suspendAppearance: function () {
          if (appearanceClosed) return function () {}
          appearanceLeases++
          if (appearanceLeases === 1) { clearStyle(); restoreOfficialOnStop(); releaseAppearance(); if (reregisterEntries) reregisterEntries() }
          let released = false
          return function () {
            if (released) return
            released = true; appearanceLeases--
            if (appearanceLeases === 0 && !appearanceClosed) {
              if (state.enabled) { applyStyle(); syncAppearanceForTheme(state.theme) }
              if (reregisterEntries) reregisterEntries()
            }
          }
        },`);
 replace('function registerEntries() {',`function registerEntries() {
        if (appearanceLeases > 0) {
          if (disposePanel) disposePanel(); disposePanel = null
          if (disposeSection) disposeSection(); disposeSection = null
          return
        }`);
 replace("return function () {\n        try { clearStyle() }", "return function () {\n        appearanceClosed = true\n        try { clearStyle() }");
 return source;
}
/** Exact version, atomic write, saved original, graph refresh; other plugins/configs untouched. */
export async function installOpenCodeCompatibility(registry,home){
 const file=registry.clientPath('dsh-opencode-palette');if(!file)return {present:false};
 const manifest=JSON.parse(await readFile(path.join(path.dirname(file),'../package.json'),'utf8'));
 if(manifest.name!=='dsh-opencode-palette'||manifest.version!=='2.0.26')throw Error('OpenCode 兼容适配仅验证了 2.0.26，当前插件保留原状');
 const original=await readFile(file,'utf8'),next=patchOpenCode(original);
 if(next===original)return {present:true,version:manifest.version,adapted:true};
 const digest=createHash('sha256').update(original).digest('hex');
 const backup=path.join(home,'appearance/compatibility','opencode-'+manifest.version+'-'+digest+'.js');
 await mkdir(path.dirname(backup),{recursive:true,mode:0o700});await writeFile(backup,original,{mode:0o600,flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
 if(await readFile(file,'utf8')!==original)throw Error('OpenCode 同时被其他窗口更新，请重试');
 const temporary=file+'.appearance-'+randomUUID(),mode=(await stat(file)).mode;
 await writeFile(temporary,next,{mode});await rename(temporary,file);registry.rebuilt('dsh-opencode-palette');
 return {present:true,version:manifest.version,adapted:true,originalSha256:digest};
}
