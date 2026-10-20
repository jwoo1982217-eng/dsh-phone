import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const root=new URL('../',import.meta.url),require=createRequire(new URL('../package.json',import.meta.url));
const {transpileModule,ScriptTarget,ModuleKind}=require('typescript');
const fixtures="const LOOMY_API_BASE='https://business.invalid', LOOMY_ACCOUNT_BASE='https://accounts.invalid';\n";
for(const [name,path,kind]of[
 ['vendor source','vendor/dsh-codearts-auth/src/loomy-product.ts','ts'],
 ['packed source','our-free-model/vendor/channel-pack/src/loomy-product.ts','ts'],
 ['vendor runtime','vendor/dsh-codearts-auth/lib/loomy-product.js','js'],
 ['channel bundle','our-free-model/vendor/channel-pack/pack.js','bundle'],
 ['standalone bundle','our-free-model/packages/standalone/channels/business.mjs','bundle']
])test(name+' imports without credentials and reads only explicit nonblank configuration',async()=>{
 let code=await fs.readFile(new URL(path,root),'utf8');
 if(kind==='bundle'){const marker='// vendor/channel-pack/src/loomy-product.ts',a=code.indexOf(marker),b=code.indexOf('\n// ',a+marker.length);assert(a>=0&&b>a);code=fixtures+code.slice(a,b)+'\nexport {LOOMY};';}
 else{if(kind==='ts')code=transpileModule(code,{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.ESNext}}).outputText;code=code.replace(/import \{ LOOMY_ACCOUNT_BASE, LOOMY_API_BASE \} from ['"]\.\/loomy\.js['"];?/,fixtures);}
 const keys=['CMDC_PAK_LOOMY_ACCESS_KEY_ID','CMDC_PAK_LOOMY_ACCESS_KEY_SECRET'],before=keys.map(k=>process.env[k]);
 try{for(const k of keys)delete process.env[k];const {LOOMY}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));assert.equal(LOOMY.id,'loomy');assert(LOOMY.fallbackModels.length>0);for(const field of ['accessKeyId','accessKeySecret'])assert.throws(()=>LOOMY[field],/CMDC_PAK_LOOMY_ACCESS_KEY_/);for(const k of keys)process.env[k]='  ';assert.throws(()=>LOOMY.accessKeySecret,/CMDC_PAK_LOOMY_ACCESS_KEY_SECRET/);process.env[keys[0]]=' fixture-id ';process.env[keys[1]]=' fixture-secret ';assert.equal(LOOMY.accessKeyId,'fixture-id');assert.equal(LOOMY.accessKeySecret,'fixture-secret');delete process.env[keys[1]];assert.throws(()=>LOOMY.accessKeySecret,/CMDC_PAK_LOOMY_ACCESS_KEY_SECRET/);assert.equal(LOOMY.apiBase,'https://business.invalid');}
 finally{keys.forEach((k,i)=>{if(before[i]===undefined)delete process.env[k];else process.env[k]=before[i];});}
});
