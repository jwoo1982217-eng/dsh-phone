import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {deviceOptions,adb,phoneNode,connect} from './lingxi-phone-device.mjs';
const d=deviceOptions(),args=process.argv.slice(2),out=args.includes('--receipt-dir')?args[args.indexOf('--receipt-dir')+1]:undefined;
if(!out||!path.isAbsolute(out))throw Error('必须指定绝对回执目录 --receipt-dir');
fs.mkdirSync(out,{recursive:true,mode:0o700});
const persist=(name,v)=>fs.writeFileSync(path.join(out,name),JSON.stringify(v,null,2),{mode:0o600});
const hash=b=>createHash('sha256').update(b).digest('hex');
const source=fileURLToPath(new URL('../',import.meta.url));
const files=['package.json','index.mjs','transport.mjs','README.md'].map(name=>{const bytes=fs.readFileSync(source+'phone-network-stability/'+name);return {name,sha:hash(bytes),base64:bytes.toString('base64')};});
const adapter=fs.readFileSync(source+'phone-account/vendor/adapter.js');
const originalAdapter='4cb7baeff841b81de085f71fe2bd010b1a38311f9df635ad48207a13cf760655';
const block='\n# DSH Android HTTP connection stability\n- insert:\n    - id: dsh-phone-network-stability\n      name: '+JSON.stringify('file://'+d.home+'/extensions/phone-network-stability/index.mjs')+'\n';
const snap=()=>JSON.parse(phoneNode(d,`
 import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';const h=process.env.DSH_HOME,hash=b=>createHash('sha256').update(b).digest('hex'),require=createRequire(h+'/profiles/phone/package.json'),{parse}=require('yaml'),credentials=parse(fs.readFileSync(h+'/.credentials.yaml','utf8'));const refs=Object.fromEntries(Object.entries(credentials.refs||{}).map(([k,v])=>[k,hash(JSON.stringify(v))]));const notes={};const walk=p=>{if(!fs.existsSync(p))return;for(const f of fs.readdirSync(p,{withFileTypes:true})){const full=path.join(p,f.name);if(f.isDirectory())walk(full);else if(f.isFile())notes[path.relative(h,full)]=hash(fs.readFileSync(full));}};walk(h+'/knowledge');console.log(JSON.stringify({refs,browserSecret:hash(JSON.stringify(credentials.records?.['client-connection/browser-session'])),notes,adapter:hash(fs.readFileSync(h+'/profiles/phone/node_modules/dsh-phone-account/vendor/adapter.js')),profile:hash(fs.readFileSync(h+'/profiles/phone/cordis.patch.yml'))}));
`));
let c=await connect(d),deployment;
try{
 const sessions=(await c.manage('chat-history','status')).items;if(sessions.some(s=>s.running))throw Error('存在运行中任务，未部署或重启');
 const mcp=(await c.manage('mcp-manager','status')).servers,recall=await c.manage('lingxi-recall','status');
 const before=snap();persist('deployment-before.private.json',{device:d,sessions:sessions.map(s=>s.sessionId),mcp,recall,before});
 deployment=JSON.parse(phoneNode(d,`
 import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {createRequire} from 'node:module';const h=process.env.DSH_HOME,hash=b=>createHash('sha256').update(b).digest('hex'),require=createRequire(h+'/profiles/phone/package.json'),{parse}=require('yaml');
 const f=h+'/profiles/phone/node_modules/dsh-phone-account/vendor/adapter.js',patch=h+'/profiles/phone/cordis.patch.yml',old=fs.readFileSync(f),p=fs.readFileSync(patch,'utf8'),next=Buffer.from(${JSON.stringify(adapter.toString('base64'))},'base64'),block=${JSON.stringify(block)},input=${JSON.stringify(files)};
 if(hash(old)!==${JSON.stringify(originalAdapter)}&&hash(old)!==hash(next))throw Error('账号适配源码指纹不符，不覆盖');if(hash(p)!==${JSON.stringify(before.profile)})throw Error('配置并发变化');
 const rows=parse(p).flatMap(r=>r.insert||[r]).filter(r=>r.id==='dsh-phone-network-stability');if(rows.length&&(!p.includes(block)||rows.length!==1))throw Error('同名网络插件配置冲突');
 const after=rows.length?p:p+block;if(!Array.isArray(parse(after)))throw Error('无效配置');
 const target=h+'/extensions/phone-network-stability',backup=h+'/storage/phone-network-stability/recovery/'+hash(old);fs.mkdirSync(backup,{recursive:true,mode:0o700});
 const save=(name,b)=>{const file=backup+'/'+name;if(fs.existsSync(file)){if(hash(fs.readFileSync(file))!==hash(b))throw Error('恢复点冲突');}else fs.writeFileSync(file,b,{flag:'wx',mode:0o600});};save('adapter.js',old);save('profile-before.yml',Buffer.from(p));
 if(fs.existsSync(target)){for(const item of input)if(hash(fs.readFileSync(target+'/'+item.name))!==item.sha)throw Error('已有不同网络插件，拒绝覆盖');}else{const stage=target+'.stage-'+randomUUID();fs.mkdirSync(stage,{recursive:true,mode:0o700});try{for(const item of input){const b=Buffer.from(item.base64,'base64');if(hash(b)!==item.sha)throw Error('源码SHA不符');fs.writeFileSync(stage+'/'+item.name,b,{flag:'wx',mode:0o600});}if(fs.existsSync(target))throw Error('目标并发变化');fs.renameSync(stage,target);}finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true});}}
 const atomic=(file,bytes)=>{const temp=file+'.network-'+randomUUID();fs.writeFileSync(temp,bytes,{flag:'wx',mode:fs.statSync(file).mode&511});fs.renameSync(temp,file);};
 if(hash(fs.readFileSync(f))!==hash(old)||hash(fs.readFileSync(patch))!==hash(p))throw Error('文件并发变化，未激活');atomic(f,next);atomic(patch,after);
 console.log(JSON.stringify({backup,adapterBefore:hash(old),adapterAfter:hash(next),profileBefore:hash(p),profileAfter:hash(after),files:input.map(({name,sha})=>({name,sha}))}));
 `));persist('deployment.json',deployment);
 // Recheck immediately before activation; do not cancel a newly started turn.
 if((await c.manage('chat-history','status')).items.some(s=>s.running))throw Error('部署后有新运行任务，补丁待空闲激活');
 c.close();c=undefined;
 adb(d,['shell','run-as',d.package,'/system/bin/am','startservice','--user','0','-n',d.package+'/.DshService','-a','com.dshphone.STOP']);
 const closed=JSON.parse(phoneNode(d,`import net from 'node:net';let closed=false;for(let i=0;i<50;i++){const alive=await new Promise(r=>{const s=net.connect({host:'127.0.0.1',port:3080});s.on('connect',()=>{s.destroy();r(true)});s.on('error',()=>r(false));s.setTimeout(200,()=>{s.destroy();r(true)})});if(!alive){closed=true;break;}await new Promise(r=>setTimeout(r,100));}console.log(JSON.stringify({closed}));`,10000));if(!closed.closed)throw Error('正式服务未停止，不重复启动');
 adb(d,['shell','run-as',d.package,'/system/bin/am','start-foreground-service','--user','0','-n',d.package+'/.DshService']);
 let after,plugins;
 for(let i=0;i<40;i++){try{c=await connect(d);after=(await c.manage('chat-history','status')).items;await c.manage('lingxi-recall','status');break;}catch{c?.close();c=undefined;await new Promise(r=>setTimeout(r,500));}}
 if(!c||!after)throw Error('服务启动未就绪，必须检查恢复点');
 let currentMcp;const warmup=[];
 for(let i=0;i<40;i++){
   currentMcp=(await c.manage('mcp-manager','status')).servers;
   const missing=mcp.filter(s=>{const a=currentMcp.find(a=>a.id===s.id);return !a||s.tools.some(t=>!a.tools.some(x=>x.name===t.name));});
   if(!missing.length)break;warmup.push({at:new Date().toISOString(),ids:missing.map(s=>s.id)});await new Promise(r=>setTimeout(r,500));
 }
 persist('mcp-warmup.json',warmup);
 const state=snap();for(const [key,sha]of Object.entries(before.refs))if(state.refs[key]!==sha)throw Error('凭据引用发生变化，请核对而不覆盖');
 if(before.browserSecret!==state.browserSecret)throw Error('本机认证发生变化');
 for(const [name,sha]of Object.entries(before.notes))if(state.notes[name]!==sha)throw Error('知识库文件并发变化，请核对');
 if(sessions.some(s=>!after.some(a=>a.sessionId===s.sessionId)))throw Error('原会话缺失');
 for(const s of mcp){const a=currentMcp.find(a=>a.id===s.id);if(!a||s.tools.some(t=>!a.tools.some(x=>x.name===t.name)))throw Error('原MCP工具缺失');}
 const result={device:d.serial,installed:true,activated:true,sessionsBefore:sessions.length,sessionsAfter:after.length,originalSessionIdsPreserved:true,credentialsPreserved:true,browserSecretPreserved:true,knowledgeFilesPreserved:true,mcpToolsPreserved:true,adapterSha:state.adapter,networkEntry:'dsh-phone-network-stability',noInference:true};persist('activation.json',result);console.log(JSON.stringify(result));
}catch(e){persist('deployment-error.json',{error:e.message,deployment});throw e;}finally{c?.close();}
