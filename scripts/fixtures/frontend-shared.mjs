import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

/** Expose the shipped frontend's real builtins, stopping before its application boot. */
export async function frontendShared(dist) {
  const files = (await readdir(path.join(dist,'assets'))).filter(name=>/^index-[\w-]+\.js$/.test(name));
  assert.equal(files.length,1,'one shipped frontend entry is required');
  const frontend = await readFile(path.join(dist,'assets',files[0]),'utf8');
  const boot = /\bconst [\w$]+=globalThis\.dshDesktopBoot/.exec(frontend);
  assert(boot && boot.index>0,'shipped frontend application boundary');
  const factories = [...frontend.matchAll(/function ([\w$]+)\(\)\{return\{react:([^{}]+)\}\}/g)]
    .filter(match=>match[2].includes('"react-dom/client"')&&match[2].includes('"@deepseek-ai/dsh-client-ui-slots"'));
  assert.equal(factories.length,1,'one real shared-builtin factory is required');
  const cssFiles=(await readdir(path.join(dist,'assets'))).filter(name=>/^index-[\w-]+\.css$/.test(name));
  assert.equal(cssFiles.length,1,'one shipped stylesheet entry is required');
  const css=await readFile(path.join(dist,'assets',cssFiles[0]),'utf8');
  return {frontend,css,entry:files[0],shared:frontend.slice(0,boot.index)+'window.__TEST_SHARED__='+factories[0][1]+'();\n'};
}
