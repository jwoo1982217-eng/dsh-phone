import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';
import {installDesktopPeer} from './install-desktop-peer.mjs';

test('fresh peer install resolves MCP dependencies and keeps isolation modules on reinstall',async t=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'dsh-peer-mcp-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
  const profile=path.join(temporary,'profile');await mkdir(profile);
  await writeFile(path.join(profile,'package.json'),JSON.stringify({dependencies:{},dsh:{profile:{bundles:[]}}}));
  await writeFile(path.join(profile,'user-settings-marker'),'unchanged');
  const modules=path.resolve('desktop-runtime/node_modules');
  for(let i=0;i<2;i++){
    const result=await installDesktopPeer(profile,modules);
    const peer=await import(pathToFileURL(path.join(result.plugin,'index.mjs'))+'?install='+i);
    assert.ok(peer.inject.includes('tools'));
    assert.match(await readFile(path.join(result.plugin,'mcp-manager/router.mjs'),'utf8'),/name: 'reuse'/);
    assert.match(await readFile(path.join(result.plugin,'memory-isolation/index.mjs'),'utf8'),/applyMemoryIsolation/);
    assert.equal(await readFile(path.join(profile,'user-settings-marker'),'utf8'),'unchanged');
  }
});
