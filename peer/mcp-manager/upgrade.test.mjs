import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { stdioLaunch, stdioEnvironment } from './launch.mjs';
import { preserveMcpExtensions } from './upgrade.mjs';

function fixture(t) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-mcp-upgrade-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const args={home:path.join(base,'dsh-home'),oldTree:path.join(base,'tree'),newTree:path.join(base,'next'),newProfile:path.join(base,'profile-next')};
  for(const dir of Object.values(args))fs.mkdirSync(dir,{recursive:true});
  const file=path.join(args.home,'storage/mcp-manager/config.json');
  const save=servers=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({version:1,revision:7,servers,pricing:{keep:'untouched'}}));};
  return {...args,file,save,load:()=>JSON.parse(fs.readFileSync(file))};
}
test('Android node follows current install; Termux, other apps and desktop commands retain their identity',()=>{
  const android={execPath:'/data/app/~~new/com.dshphone-current/lib/arm64/libnode.so',env:{DSH_PHONE_ANDROID:'1'}};
  const old='/data/app/~~old/com.dshphone-old/lib/arm64/libnode.so';
  assert.equal(stdioLaunch({command:old},'/home',android).command,android.execPath);
  assert.equal(stdioLaunch({command:'node'},'/home',android).command,android.execPath);
  for(const command of ['/data/data/com.termux/files/usr/bin/node','/data/app/other-app/lib/arm64/libnode.so'])assert.equal(stdioLaunch({command},'/home',android).command,command);
  assert.equal(stdioLaunch({command:old},'/home',{env:{}}).command,old);
  assert.deepEqual(stdioLaunch({command:'node',args:['$DSH_HOME/extensions/a.mjs','${DSH_HOME}/input','$(touch x)'],cwd:'$DSH_HOME'},'/actual',{env:{}}),{command:'node',args:['/actual/extensions/a.mjs','/actual/input','$(touch x)'],cwd:'/actual'});
});
test('saved stale Android loader directory cannot override current native libs; other configuration is retained',()=>{
  const current='/data/app/~~new/com.dshphone-current/lib/arm64',old='/data/app/~~old/com.dshphone-old/lib/arm64';
  const runtime={execPath:current+'/libnode.so',env:{DSH_PHONE_ANDROID:'1'}};
  const row={command:'node',args:['$DSH_HOME/server.mjs'],cwd:'$DSH_HOME/work'},launch=stdioLaunch(row,'/home',runtime);
  const parent={LD_LIBRARY_PATH:current,HOME:'/home'},explicit={LD_LIBRARY_PATH:old+':/custom/libs:/data/app/another.pkg-old/lib/arm64',MEDIA_API_KEY:'fixture-only',HTTP_PROXY:'http://localhost:9'};
  const snapshot=structuredClone(explicit),env=stdioEnvironment(launch,parent,explicit,runtime);
  assert.equal(env.LD_LIBRARY_PATH,current+':/custom/libs:/data/app/another.pkg-old/lib/arm64');
  assert.equal(env.MEDIA_API_KEY,'fixture-only');assert.equal(env.HTTP_PROXY,explicit.HTTP_PROXY);assert.equal(launch.cwd,'/home/work');assert.deepEqual(explicit,snapshot);
  assert.deepEqual(stdioEnvironment({command:'/data/data/com.termux/files/usr/bin/node'},parent,explicit,runtime),{...parent,...explicit});
  assert.deepEqual(stdioEnvironment(launch,parent,explicit,{env:{}}),{...parent,...explicit});
  assert.equal(stdioEnvironment(launch,{}, {},runtime).LD_LIBRARY_PATH,current);
  assert.equal(stdioEnvironment(launch,parent,{LD_LIBRARY_PATH:current+':'+old},runtime).LD_LIBRARY_PATH,current);
});
test('independent stdio service and relative files work after deleting the entire old runtime',async t=>{
  const f=fixture(t),root=path.join(f.oldTree,'node_modules/media-service');fs.mkdirSync(root,{recursive:true});
  const fixtureSource=fs.readFileSync(new URL('./stdio-fixture.mjs',import.meta.url),'utf8');
  fs.writeFileSync(path.join(root,'server.mjs'),"import {suffix} from './sibling.mjs';\n"+fixtureSource.replace('String(q.params.arguments.value)','String(q.params.arguments.value)+suffix'));
  fs.writeFileSync(path.join(root,'sibling.mjs'),"export const suffix=':relative-file-survived';");
  fs.mkdirSync(path.join(f.newTree,'node_modules'),{recursive:true});
  const server={id:'media',transport:'stdio',command:process.execPath,args:[path.join(root,'server.mjs')],cwd:f.oldTree};
  f.save([server]);const report=preserveMcpExtensions(f);assert.equal(report.migrated.length,1);assert.equal(f.load().revision,8);
  fs.rmSync(f.oldTree,{recursive:true});fs.renameSync(f.newTree,f.oldTree);
  const row=f.load().servers[0], launch=stdioLaunch(row,f.home);assert.ok(row.args[0].startsWith('$DSH_HOME/extensions/mcp/'));
  const client=new Client({name:'upgrade-test',version:'1'},{capabilities:{}});await client.connect(new StdioClientTransport({...launch,stderr:'pipe'}));
  t.after(()=>client.close());assert.equal((await client.listTools()).tools[0].name,'echo');
  assert.equal((await client.callTool({name:'echo',arguments:{value:'after-update'}})).content[0].text,'after-update:relative-file-survived');
  assert.deepEqual(f.load().pricing,{keep:'untouched'});
  assert.equal(preserveMcpExtensions({...f,newTree:f.oldTree}).migrated.length,0);
});
test('custom profile packages and external services stay at their original durable location',t=>{
  const f=fixture(t),dir=path.join(f.home,'profiles/phone/node_modules/custom');fs.mkdirSync(dir,{recursive:true});const script=path.join(dir,'server.mjs');fs.writeFileSync(script,'original');
  f.save([{id:'custom',transport:'stdio',command:'node',args:[script]}, {id:'http',transport:'streamable-http',url:'https://example.invalid/mcp'}]);
  const before=fs.readFileSync(f.file);assert.equal(preserveMcpExtensions(f).migrated.length,0);assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(fs.readFileSync(script,'utf8'),'original');
});
test('relative entry arguments resolve from the configured startup directory',t=>{
  const f=fixture(t),root=path.join(f.oldTree,'media');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'server.mjs'),'fixture');
  f.save([{id:'media',transport:'stdio',command:'node',args:['media/server.mjs','--mode','text'],cwd:f.oldTree}]);
  assert.equal(preserveMcpExtensions(f).migrated.length,1);
  assert.ok(f.load().servers[0].args[0].startsWith('$DSH_HOME/extensions/'));
  assert.deepEqual(f.load().servers[0].args.slice(1),['--mode','text']);
});
test('failed closed-directory migration preserves config and sources without a partial extension',t=>{
  const f=fixture(t),root=path.join(f.oldTree,'media');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'server.mjs'),'original');fs.symlinkSync('/etc',path.join(root,'external'));
  f.save([{id:'media',transport:'stdio',command:'node',args:[path.join(root,'server.mjs')]}]);const before=fs.readFileSync(f.file);
  assert.throws(()=>preserveMcpExtensions(f),/目录外链接/);assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(fs.readFileSync(path.join(root,'server.mjs'),'utf8'),'original');
  const serviceDir=path.join(f.home,'extensions/mcp/media');assert.equal(fs.readdirSync(serviceDir).length,0);
  fs.unlinkSync(path.join(root,'external'));assert.equal(preserveMcpExtensions(f).migrated.length,1);
});
test('standalone edited SDK files are not transplanted into a newer core',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.oldTree,'patch.mjs'),'custom patch');f.save([{id:'patch',transport:'stdio',command:'node',args:[path.join(f.oldTree,'patch.mjs')]}]);const before=fs.readFileSync(f.file);
  assert.throws(()=>preserveMcpExtensions(f),/单文件补丁/);assert.deepEqual(fs.readFileSync(f.file),before);assert.ok(fs.existsSync(path.join(f.oldTree,'patch.mjs')));
});
