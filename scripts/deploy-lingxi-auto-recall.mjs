import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {deviceOptions,adb,phoneNode,connect} from './lingxi-phone-device.mjs';
const require=createRequire(fileURLToPath(new URL('../desktop-runtime/package.json',import.meta.url))),{parse}=require('yaml');
const d=deviceOptions(),args=process.argv.slice(2),output=args.includes('--receipt-dir')?args[args.indexOf('--receipt-dir')+1]:undefined;
if(output&&!path.isAbsolute(output))throw Error('回执目录须为绝对路径');
const label=d.serial.startsWith('192.')?'tablet':'samsung',hash=b=>createHash('sha256').update(b).digest('hex'),source=fileURLToPath(new URL('../lingxi-auto-recall/',import.meta.url));
const files=['package.json','index.mjs','recall.mjs','page.html','page.js','README.md'].map(name=>{const b=fs.readFileSync(path.join(source,name));return {name,base64:b.toString('base64'),sha256:hash(b)}}),manifest=Object.fromEntries(files.map(f=>[f.name,f.sha256]));
const entry={id:'dsh-lingxi-auto-recall',name:pathToUrl(d.home+'/extensions/lingxi-auto-recall/index.mjs')};
function pathToUrl(p){return 'file://'+p}
const block='\n# DSH lingxi automatic knowledge recall\n- insert:\n    - id: '+entry.id+'\n      name: '+JSON.stringify(entry.name)+'\n';
let c,profileBefore,expectedAfter,changed=false,restarted=false;
const persist=(name,value)=>{if(!output)return;fs.mkdirSync(output,{recursive:true,mode:0o700});fs.writeFileSync(path.join(output,label+'-'+name),typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600})};
const start=()=>adb(d,['shell','run-as',d.package,'/system/bin/am','start-foreground-service','--user','0','-n',d.package+'/.DshService']);
const stop=()=>adb(d,['shell','run-as',d.package,'/system/bin/am','startservice','--user','0','-n',d.package+'/.DshService','-a','com.dshphone.STOP']);
async function waitClosed(){const r=JSON.parse(phoneNode(d,`import net from 'node:net';const live=()=>new Promise(r=>{const s=net.connect({host:'127.0.0.1',port:3080});s.once('connect',()=>{s.destroy();r(true)});s.once('error',()=>{s.destroy();r(false)});s.setTimeout(300,()=>{s.destroy();r(false)})});let closed=false;for(let n=0;n<40;n++){if(!await live()){closed=true;break}await new Promise(r=>setTimeout(r,250))}console.log(JSON.stringify({closed}));`,15000));if(!r.closed)throw Error('后端未退出，未继续变更')}
async function ready(){let error;for(let n=0;n<30;n++){try{c=await connect(d);const state=await c.manage('lingxi-recall','status');if(state.knowledgeReady)return state;throw Error('笔记服务尚未就绪')}catch(e){error=e;c?.close();c=undefined;await new Promise(r=>setTimeout(r,500))}}throw error}
try{
  c=await connect(d);const before={sessions:(await c.manage('chat-history','status')).items,mcp:(await c.manage('mcp-manager','status')).servers,historyRecall:await c.manage('knowledge-link','recall.status')};
  if(before.sessions.some(s=>s.running))throw Error('当前有运行中对话，请待其完成后重新部署');
  const profile=adb(d,['exec-out','run-as',d.package,'cat','files/dsh-home/profiles/phone/cordis.patch.yml']);profileBefore=profile.toString();persist('profile-before.private.yml',profileBefore);persist('before.private.json',{sessions:before.sessions.map(s=>({id:s.sessionId,running:s.running})),mcp:before.mcp,historyRecall:before.historyRecall.config});
  const doc=parse(profileBefore);if(!Array.isArray(doc))throw Error('profile patch 格式无效');
  const matches=doc.flatMap(p=>[...(p.insert||[]),...(p.id===entry.id?[p]:[])]).filter(e=>e.id===entry.id);
  if(matches.length&&(matches.length!==1||matches[0].name!==entry.name||matches[0].disabled))throw Error('存在不同的同名插件配置，拒绝覆盖');
  expectedAfter=matches.length?profileBefore:profileBefore+block;
  if(!Array.isArray(parse(expectedAfter)))throw Error('生成的 profile patch 无效');
  const installed=JSON.parse(phoneNode(d,`
    import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';const home=process.env.DSH_HOME,files=${JSON.stringify(files)},manifest=${JSON.stringify(manifest)},hash=b=>createHash('sha256').update(b).digest('hex'),target=path.join(home,'extensions/lingxi-auto-recall');
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});if(fs.lstatSync(path.dirname(target)).isSymbolicLink())throw Error('扩展父目录不能是链接');
    let reused=false;if(fs.existsSync(target)){if(fs.lstatSync(target).isSymbolicLink())throw Error('扩展不能是链接');const old=JSON.parse(fs.readFileSync(target+'/manifest.json'));if(JSON.stringify(old)!==JSON.stringify(manifest))throw Error('已有不同版本源码，不覆盖');for(const [p,h]of Object.entries(manifest))if(fs.lstatSync(target+'/'+p).isSymbolicLink()||hash(fs.readFileSync(target+'/'+p))!==h)throw Error('原代码被修改，不覆盖');reused=true}
    else {const stage=target+'.stage-'+randomUUID();fs.mkdirSync(stage,{mode:0o700});try{for(const f of files){const raw=Buffer.from(f.base64,'base64');if(hash(raw)!==f.sha256)throw Error('输入SHA不符');fs.writeFileSync(stage+'/'+f.name,raw,{flag:'wx',mode:0o600});if(hash(fs.readFileSync(stage+'/'+f.name))!==f.sha256)throw Error('落盘SHA不符')}fs.writeFileSync(stage+'/manifest.json',JSON.stringify(manifest),{flag:'wx',mode:0o600});if(fs.existsSync(target))throw Error('目录并发变化');fs.renameSync(stage,target)}finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true})}}
    const cfg=path.join(home,'knowledge/lingxi-auto-recall.json');if(!fs.existsSync(cfg)){fs.mkdirSync(path.dirname(cfg),{recursive:true,mode:0o700});fs.writeFileSync(cfg,JSON.stringify({version:1,revision:0,enabled:true},null,2)+'\\n',{flag:'wx',mode:0o600})}else {const v=JSON.parse(fs.readFileSync(cfg));if(v.version!==1||typeof v.enabled!=='boolean')throw Error('已有设置无效，不覆盖')}
    const profile=path.join(home,'profiles/phone/cordis.patch.yml'),old=fs.readFileSync(profile);if(fs.lstatSync(profile).isSymbolicLink()||hash(old)!==${JSON.stringify(hash(profile))})throw Error('profile并发变化，不覆盖');
    const next=Buffer.from(${JSON.stringify(Buffer.from(expectedAfter).toString('base64'))},'base64');const changed=hash(next)!==hash(old);if(changed){const backup=path.join(home,'storage/lingxi-auto-recall/deployments',hash(old));fs.mkdirSync(backup,{recursive:true,mode:0o700});const b=backup+'/cordis.patch.yml';if(fs.existsSync(b)){if(hash(fs.readFileSync(b))!==hash(old))throw Error('恢复点冲突')}else fs.writeFileSync(b,old,{flag:'wx',mode:0o600});const temp=profile+'.lingxi-'+randomUUID();try{fs.writeFileSync(temp,next,{flag:'wx',mode:0o600});if(hash(fs.readFileSync(profile))!==hash(old))throw Error('profile并发变化');fs.renameSync(temp,profile)}finally{if(fs.existsSync(temp))fs.unlinkSync(temp)}}console.log(JSON.stringify({reused,changed,profileBefore:hash(old),profileAfter:hash(next),manifest}));
  `));changed=installed.changed;persist('deployment.json',installed);
  let state;try{state=await c.manage('lingxi-recall','status')}catch{}
  if(!state?.knowledgeReady){
    const h=await c.manage('chat-history','status');if(h.items.some(s=>s.running))throw Error('保存配置后出现运行任务，未重启；完成后重试部署');
    c.close();c=undefined;stop();await waitClosed();start();restarted=true;state=await ready();
  }
  let after;const warming=[],deadline=Date.now()+30000;
  do {
    try{after={sessions:(await c.manage('chat-history','status')).items,mcp:(await c.manage('mcp-manager','status')).servers,historyRecall:await c.manage('knowledge-link','recall.status')}}
    catch(error){warming.push({at:new Date().toISOString(),pendingManagementRoute:error.message});if(Date.now()>=deadline){persist('warming.json',warming);throw error}await new Promise(r=>setTimeout(r,500));continue}
    const missing=before.mcp.flatMap(s=>{const a=after.mcp.find(a=>a.id===s.id);return !a||s.tools.some(t=>!a.tools.some(x=>x.name===t.name))||s.status==='connected'&&a.status!=='connected'?[{id:s.id,status:a?.status||'not-ready',tools:a?.tools.length||0}]:[]});
    if(!missing.length)break;warming.push({at:new Date().toISOString(),missing});if(Date.now()>=deadline)break;await new Promise(r=>setTimeout(r,500));
  }while(true);
  persist('warming.json',warming);
  persist('after.private.json',{sessions:after.sessions.map(s=>({id:s.sessionId,running:s.running})),mcp:after.mcp,historyRecall:after.historyRecall.config});
  for(const s of before.sessions)if(!after.sessions.some(a=>a.sessionId===s.sessionId))throw Error('原会话缺失');
  for(const s of before.mcp){const a=after.mcp.find(a=>a.id===s.id);if(!a||s.tools.some(t=>!a.tools.some(x=>x.name===t.name))||s.status==='connected'&&a.status!=='connected')throw Error('原MCP工具未恢复')}
  if(JSON.stringify(after.historyRecall.config)!==JSON.stringify(before.historyRecall.config))throw Error('原历史召回设置发生变化');
  const result={device:d.serial,installed:true,restarted,enabled:state.config.enabled,knowledgeReady:state.knowledgeReady,scope:state.scope,historyRecallUnchanged:true,originalSessionIdsPreserved:true,sessions:after.sessions.length,originalMcpToolsPreserved:true,statusPage:'/lingxi-recall'};persist('verification.json',result);console.log(JSON.stringify(result));
}catch(error){
  // An appended block is the only profile edit. Remove only that exact block;
  // never restore a stale whole profile over unrelated concurrent additions.
  if(changed){try{const rollback=JSON.parse(phoneNode(d,`import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';const f=path.join(process.env.DSH_HOME,'profiles/phone/cordis.patch.yml'),before=fs.readFileSync(f,'utf8'),block=${JSON.stringify(block)},hash=s=>createHash('sha256').update(s).digest('hex');if(before.split(block).length!==2)throw Error('恢复块已变化，拒绝覆盖');const after=before.replace(block,''),tmp=f+'.restore-'+randomUUID();try{fs.writeFileSync(tmp,after,{flag:'wx',mode:0o600});if(hash(fs.readFileSync(f))!==hash(before))throw Error('并发配置变化');fs.renameSync(tmp,f)}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp)}console.log(JSON.stringify({ownProfileBlockRemoved:true,otherBytesPreserved:true}));`));persist('rollback.json',rollback);
    if(restarted){let check;try{check=c||await connect(d);const h=await check.manage('chat-history','status');if(h.items.some(s=>s.running))throw Error('有新运行任务，未自动重启回退后的后端');check.close();check=undefined;c=undefined;stop();await waitClosed();start();persist('rollback-restart.json',{restarted:true})}finally{if(check&&check!==c)check.close()}}
  }catch(rollbackError){persist('rollback-error.json',{error:rollbackError.message})}}
  throw error;
}finally{c?.close()}
