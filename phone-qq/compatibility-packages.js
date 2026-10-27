import {readFile,readdir,lstat,realpath,symlink,mkdir,chmod} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {contained,snapshot,syncDirectory,safeRelative} from './core-transaction.js';
import {inventoryKey,validateFiles,stageVerifiedFiles} from './private-sdk-v2.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
export const inventoryDigest=rows=>sha(inventoryKey(rows));
export const compatibilityActionDigest=(replacements,removals=[])=>sha(JSON.stringify({replacements:inventoryKey(replacements),removals:[...removals].sort((a,b)=>a.relative<b.relative?-1:a.relative>b.relative?1:0).map(r=>[r.relative,r.beforeSha256])}));
/** Inspect the complete installed package, never follow its SDK link. No code
 * from this package is imported. Runtime/private extras are retained byte-for-byte
 * and never copied into the public distribution. */
async function inventoryPackage(root,tree){
 const rows=[],directories=[];let moduleLink=false,total=0;
 async function visit(dir,prefix){for(const name of(await readdir(dir)).sort()){
  const relative=prefix?prefix+'/'+name:name,file=path.join(dir,name),stat=await lstat(file);
  if(stat.isSymbolicLink()){
   if(relative!=='node_modules'||await realpath(file)!==await realpath(path.join(tree,'node_modules')))throw Error('Unrecognized compatibility package link: '+relative);
   moduleLink=true;continue;
  }
  if(stat.isDirectory()){if(relative==='node_modules')throw Error('Unrecognized compatibility dependency directory');if(directories.length>=100000)throw Error('Compatibility package exceeds directory limit');directories.push({relative,mode:stat.mode&0o777});await visit(file,relative);}
  else if(stat.isFile()){total+=stat.size;if(rows.length>=100000||total>512*1024*1024)throw Error('Compatibility package exceeds code size limit');rows.push({relative,sha256:sha(await readFile(file)),bytes:stat.size});}
  else throw Error('Unrecognized compatibility package special file');
 }}
 await visit(root,'');return{rows,moduleLink,directories};
}
export async function prepareCompatibilityPackages(tree,home,plan,backup){
 const rows=[];if(plan?.version!==2||plan.compatibilityPackages===undefined)return rows;
 if(!Array.isArray(plan.compatibilityPackages)||plan.compatibilityPackages.length>8)throw Error('Invalid compatibility package plan');
 const core=JSON.parse(await readFile(path.join(tree,'node_modules/@deepseek-ai/dsh/package.json'),'utf8'));
 if(plan.sdkVersion!==core.version)throw Error('Compatibility package core version mismatch');
 for(const p of plan.compatibilityPackages){
  if(p.mode!=='preserve-installed-with-replacements-v1'||! /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(p.name)||p.target!=='profiles/phone/node_modules/'+p.name||!Array.isArray(p.baselines)||typeof p.version!=='string')throw Error('Invalid conditional compatibility package');
  const target=await contained(home,p.target);let stat;try{stat=await lstat(target);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unrecognized compatibility package directory');
  validateFiles(p.replacements);
  const removals=p.removals??[];if(!Array.isArray(removals)||removals.length>10000)throw Error('Invalid compatibility removals');const removalNames=new Set();for(const r of removals){safeRelative(r.relative);if(!/^[a-f0-9]{64}$/.test(r.beforeSha256)||removalNames.has(r.relative)||p.replacements.some(v=>v.relative===r.relative))throw Error('Invalid compatibility removal');removalNames.add(r.relative);}
  const before=await snapshot(target);
  const actual=await inventoryPackage(target,tree),digest=inventoryDigest(actual.rows),replacementDigest=compatibilityActionDigest(p.replacements,removals);
  for(const b of p.baselines)if(!/^[a-f0-9]{64}$/.test(b.beforeSha256)||!/^[a-f0-9]{64}$/.test(b.afterSha256)||b.boundActionSha256!==replacementDigest||!Number.isSafeInteger(b.filesBefore)||!Number.isSafeInteger(b.filesAfter))throw Error('Invalid compatibility baseline fingerprint');
  if(p.baselines.some(b=>b.afterSha256===digest&&b.filesAfter===actual.rows.length))continue;
  const baseline=p.baselines.find(b=>b.beforeSha256===digest&&b.filesBefore===actual.rows.length);
  if(!baseline)throw Error('Unrecognized community compatibility package edit; originals retained');
  const files=new Map(actual.rows.map(r=>[r.relative,{...r,source:'installed:'+r.relative}]));
  for(const r of removals){if(files.get(r.relative)?.sha256!==r.beforeSha256)throw Error('Unrecognized compatibility removed file');files.delete(r.relative);}
  for(const replacement of p.replacements)files.set(replacement.relative,replacement);
  if(inventoryDigest([...files.values()])!==baseline.afterSha256||files.size!==baseline.filesAfter)throw Error('Compatibility replacement plan does not match its complete target fingerprint');
  const stageRelative='stage/compatibility-'+sha(p.name).slice(0,16);
  const stage=await stageVerifiedFiles(tree,home,path.join(tree,'node_modules/dsh-phone-qq'),[...files.values()],backup,stageRelative,target);
  const metadata=JSON.parse(await readFile(path.join(stage,'package.json'),'utf8'));if(metadata.name!==p.name||metadata.version!==p.version)throw Error('Compatibility package identity mismatch');
  for(const dir of actual.directories)await mkdir(path.join(stage,dir.relative),{recursive:true,mode:0o700});
  for(const dir of [...actual.directories].reverse()){await chmod(path.join(stage,dir.relative),dir.mode);await syncDirectory(path.join(stage,dir.relative));}
  if(actual.moduleLink)await symlink(path.join(tree,'node_modules'),path.join(stage,'node_modules'),'dir');
  await syncDirectory(stage);
  rows.push({target:p.target,saved:p.target,stage:stageRelative,before,after:await snapshot(stage)});
 }
 return rows;
}
