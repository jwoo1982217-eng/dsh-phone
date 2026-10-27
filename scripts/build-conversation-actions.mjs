import {readFile,writeFile,realpath} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
const root=fileURLToPath(new URL('../',import.meta.url));
/** Refresh helpers only inside reviewed SDK/client boundaries; never transplant an old client bundle. */
export async function buildConversationActions({runtimeRoot=path.join(root,'runtime'),overlayRoot=path.join(root,'runtime/overlays')}={}) {
 let version;
 for(const name of ['dsh-session','dsh-client-ui-chat','dsh-client-ui-conversation']) {
  const pkg=JSON.parse(await readFile(path.join(runtimeRoot,'node_modules/@deepseek-ai',name,'package.json'),'utf8'));
  if(pkg.name!=='@deepseek-ai/'+name||!['0.2.1-alpha.1','0.2.1-rc.2'].includes(pkg.version)||version&&pkg.version!==version)throw Error('Conversation actions require one consistent reviewed SDK alpha.1 or rc.2: '+name);
  version=pkg.version;
 }
 const plans=[];
 for(const [input,output,name,exports,boot]of [
  [path.join(root,'peer/conversation-actions/client.js'),'@deepseek-ai/dsh-client-ui-chat/lib/client.js','DSHConversationActions',['installConversationActions'],true],
  [path.join(overlayRoot,'@deepseek-ai/dsh-session/lib/conversation-edit.js'),'@deepseek-ai/dsh-client-ui-conversation/lib/client.js','DSHConversationEdits',['projectConversationEntries'],false]
 ]){
  const source=await readFile(input,'utf8');if(/^import\s/m.test(source))throw Error('Browser helper must remain self contained');
  const bundle=`var ${name}=(()=>{\n${source.replace(/^export (?=(?:function|const|class) )/gm,'')}\nreturn {${exports.join(',')}};})();\n`;
  new vm.Script(bundle);const file=path.join(overlayRoot,output);let code=await readFile(file,'utf8');
  const marker=`/* ${name} maintained begin */`,end=`/* ${name} maintained end */`;
  const injected=marker+'\n'+bundle+(boot?name+'.installConversationActions();\n':'')+end;
  if(code.includes(marker)){
   const a=code.indexOf(marker),b=code.indexOf(end,a);
   if(b<0||code.split(marker).length!==2||code.split(end).length!==2)throw Error('Malformed maintained boundary');
   code=code.slice(0,a)+injected+code.slice(b+end.length);
  }else{
   const anchor='var module = { exports: {} };';if(code.split(anchor).length!==2)throw Error('Unsupported reviewed client bundle');
   code=code.replace(anchor,anchor+'\n'+injected);
  }
  new vm.Script(code);plans.push({file,code});
 }
 for(const {file,code} of plans)await writeFile(file,code);
 return plans.map(x=>x.file);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(process.argv[1])).href)await buildConversationActions();
