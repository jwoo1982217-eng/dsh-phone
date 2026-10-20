import {readFile,writeFile} from 'node:fs/promises';import vm from 'node:vm';
const root=new URL('../',import.meta.url);
for (const name of ['dsh-session','dsh-client-ui-chat','dsh-client-ui-conversation']) { const pkg=JSON.parse(await readFile(new URL('runtime/node_modules/@deepseek-ai/'+name+'/package.json',root))); if(pkg.version!=='0.2.1-alpha.1')throw Error('Conversation actions require pinned SDK 0.2.1-alpha.1: '+name); }
for(const [input,output,name,exports,boot]of [
 ['peer/conversation-actions/client.js','runtime/overlays/@deepseek-ai/dsh-client-ui-chat/lib/client.js','DSHConversationActions',['installConversationActions'],true],
 ['runtime/overlays/@deepseek-ai/dsh-session/lib/conversation-edit.js','runtime/overlays/@deepseek-ai/dsh-client-ui-conversation/lib/client.js','DSHConversationEdits',['projectConversationEntries'],false]
]){
 const source=await readFile(new URL(input,root),'utf8');if(/^import\s/m.test(source))throw Error('Browser helper must remain self contained');
 const bundle=`var ${name}=(()=>{\n${source.replace(/^export (?=(?:function|const|class) )/gm,'')}\nreturn {${exports.join(',')}};})();\n`;
 new vm.Script(bundle);const url=new URL(output,root);let code=await readFile(url,'utf8');const marker=`/* ${name} maintained begin */`,end=`/* ${name} maintained end */`;
 const injected=marker+'\n'+bundle+(boot?name+'.installConversationActions();\n':'')+end;
 if(code.includes(marker)){const a=code.indexOf(marker),b=code.indexOf(end,a);if(b<0)throw Error('Malformed maintained boundary');code=code.slice(0,a)+injected+code.slice(b+end.length);}else{const anchor='var module = { exports: {} };';if(!code.includes(anchor))throw Error('Unsupported pinned client bundle');code=code.replace(anchor,anchor+'\n'+injected);}
 new vm.Script(code);await writeFile(url,code);
}
