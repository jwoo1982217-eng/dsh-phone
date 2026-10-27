import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {deviceOptions,connect,phoneNode} from './lingxi-phone-device.mjs';
import {READ_ONLY} from '../lingxi-phone/tools.mjs';
const device=deviceOptions(),source=fileURLToPath(new URL('../lingxi-phone/',import.meta.url));
const names=['package.json','server.mjs','service.mjs','rpc.mjs','storage.mjs','tools.mjs','README.md','NOTICE'];
const files=names.map(name=>{const b=fs.readFileSync(path.join(source,name));return {name,base64:b.toString('base64'),sha256:createHash('sha256').update(b).digest('hex')}});
const manifest=Object.fromEntries(files.map(f=>[f.name,f.sha256]));
const server={id:'lingxi',label:'灵犀知识库（手机本地）',transport:'stdio',command:'node',args:['$DSH_HOME/extensions/mcp/lingxi-phone/server.mjs','--home','$DSH_HOME'],cwd:'$DSH_HOME/extensions/mcp/lingxi-phone',enabled:true,scope:'*',readOnlyTools:READ_ONLY};
const same=(a,b)=>Object.keys(b).every(k=>JSON.stringify(a[k])===JSON.stringify(b[k]));
let c;
try{
  c=await connect(device);const before=await c.manage('mcp-manager','status'),old=before.servers.find(s=>s.id==='lingxi');
  if(old&&!same(old,server))throw Error('已有同名 MCP 的配置不同，拒绝覆盖');
  const deployed=JSON.parse(phoneNode(device,`
    import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
    const home=process.env.DSH_HOME,files=${JSON.stringify(files)},manifest=${JSON.stringify(manifest)},target=path.join(home,'extensions/mcp/lingxi-phone');
    const hash=b=>createHash('sha256').update(b).digest('hex');
    if(fs.existsSync(target)){
      if(fs.lstatSync(target).isSymbolicLink())throw Error('扩展目录不能是链接');
      const existing=JSON.parse(fs.readFileSync(path.join(target,'manifest.json'),'utf8'));
      if(JSON.stringify(existing)!==JSON.stringify(manifest))throw Error('已有不同版本代码，拒绝覆盖');
      for(const [p,h]of Object.entries(manifest))if(fs.lstatSync(path.join(target,p)).isSymbolicLink()||hash(fs.readFileSync(path.join(target,p)))!==h)throw Error('既有代码校验不一致');
      console.log(JSON.stringify({reused:true,files:files.length,manifest}));
    }else{
      let dir=home;for(const p of ['extensions','mcp']){dir=path.join(dir,p);fs.mkdirSync(dir,{recursive:true,mode:0o700});if(fs.lstatSync(dir).isSymbolicLink())throw Error('扩展父目录不能是链接')}
      const stage=path.join(dir,'.lingxi-stage-'+randomUUID());fs.mkdirSync(stage,{mode:0o700});
      try{for(const f of files){const b=Buffer.from(f.base64,'base64');if(hash(b)!==f.sha256)throw Error('输入校验失败');fs.writeFileSync(path.join(stage,f.name),b,{flag:'wx',mode:0o600});if(hash(fs.readFileSync(path.join(stage,f.name)))!==f.sha256)throw Error('落盘校验失败')}
        fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify(manifest),{flag:'wx',mode:0o600});
        if(fs.existsSync(target))throw Error('扩展目录被并发创建');fs.renameSync(stage,target);
      }finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true})}
      console.log(JSON.stringify({reused:false,files:files.length,manifest}));
    }
  `));
  const status=old?.status==='connected'?before:await c.manage('mcp-manager','save',{revision:before.revision,server});
  const added=status.servers.find(s=>s.id==='lingxi');if(added?.status!=='connected'||added.tools.length!==15)throw Error('灵犀工具发现未通过，保留代码供排障；未重启服务');
  for(const original of before.servers){const current=status.servers.find(s=>s.id===original.id);if(!current||!original.tools.every(t=>current.tools.some(x=>x.name===t.name)))throw Error('原 MCP 工具清单发生变化，请检查');}
  console.log(JSON.stringify({deployed:true,device:device.serial,restarted:false,apkChanged:false,extension:deployed,tools:added.tools.map(t=>t.name),originalMcpPreserved:true}));
}finally{c?.close()}
