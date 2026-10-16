import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const source=fileURLToPath(new URL('../vendor/dsh-purge-community',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function installPurge(home,name,sdk,{failBeforeCommit=false}={}){
 if(!path.isAbsolute(home)||!path.isAbsolute(sdk)||!/^[-a-z0-9]+$/.test(name))throw Error('Use an explicit absolute DSH home, profile name and SDK node_modules');
 const profile=path.join(home,'profiles',name),manifestFile=path.join(profile,'package.json'),patchFile=path.join(profile,'cordis.patch.yml');
 if(fs.realpathSync(home)!==home||fs.realpathSync(profile)!==profile)throw Error('DSH home and profile must be physical directories');
 if(JSON.parse(fs.readFileSync(path.join(sdk,'@deepseek-ai/dsh/package.json'))).version!=='0.2.1-alpha.1')throw Error('This adapter requires the validated 0.2.1-alpha.1 SDK');
 const {withFileLock}=await import(pathToFileURL(path.join(sdk,'@deepseek-ai/dsh-atomic-write/lib/index.js')).href);
 return withFileLock(manifestFile,async()=>{
  const before=fs.readFileSync(manifestFile),patchBefore=fs.readFileSync(patchFile),manifest=JSON.parse(before);
  if(!Array.isArray(manifest.dsh?.profile?.bundles))throw Error('Select an existing initialized DSH profile');
  const owner=path.join(profile,'.dsh-purge-runtime/current.json');
  if(fs.existsSync(owner)){
   const state=JSON.parse(fs.readFileSync(owner));
   if(state.phase!=='restored')throw Error('Revert the existing private overlay with its matching adapter before upgrading');
  }
  const token=randomUUID(),target=path.join(profile,'node_modules/dsh-purge'),stage=target+'.stage-'+token,backupDir=path.join(profile,'.purge-install-backups',token);
  if(fs.realpathSync(path.dirname(target))!==path.dirname(target))throw Error('Profile node_modules must be a physical directory');
  const previous=manifest.dependencies?.['dsh-purge'];
  if(fs.existsSync(target)||previous)throw Error('An existing Purge installation needs an explicit upgrade/revert path; it will not be overwritten');
  fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(backupDir,'package.json.before'),before,{mode:0o600});fs.writeFileSync(path.join(backupDir,'cordis.patch.yml.before'),patchBefore,{mode:0o600});
  fs.cpSync(source,stage,{recursive:true,filter:file=>!file.split(path.sep).includes('node_modules')});
  fs.symlinkSync(sdk,path.join(stage,'node_modules'),'dir');
  let moved=false,committed=false;
  try{
   if(failBeforeCommit)throw Error('injected pre-commit failure');
   if(!fs.readFileSync(manifestFile).equals(before)||!fs.readFileSync(patchFile).equals(patchBefore))throw Error('Profile changed during preparation; retry from current state');
   fs.renameSync(stage,target);moved=true;
   manifest.dependencies={...manifest.dependencies,'dsh-purge':'file:./node_modules/dsh-purge'};
   manifest.dsh.profile.bundles.push('dsh-purge');
   const next=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),temporary=manifestFile+'.'+token;
   fs.writeFileSync(temporary,next,{mode:0o600});fs.renameSync(temporary,manifestFile);committed=true;
   const receipt={version:JSON.parse(fs.readFileSync(path.join(target,'package.json'))).version,home,profile:name,target,backupDir,manifestBefore:sha(before),manifestAfter:sha(next),profilePatchUnchanged:fs.readFileSync(patchFile).equals(patchBefore),requiresRestart:true,autoApply:false};
   fs.writeFileSync(path.join(backupDir,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});return receipt;
  }catch(error){
   if(committed){const current=JSON.parse(fs.readFileSync(manifestFile));if(current.dependencies?.['dsh-purge']==='file:./node_modules/dsh-purge'){delete current.dependencies['dsh-purge'];current.dsh.profile.bundles=current.dsh.profile.bundles.filter(x=>x!=='dsh-purge');fs.writeFileSync(manifestFile,JSON.stringify(current,null,2)+'\n',{mode:0o600});}}
   if(moved)fs.rmSync(target,{recursive:true,force:true});throw error;
  }finally{fs.rmSync(stage,{recursive:true,force:true});}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(process.argv.length!==5)throw Error('Usage: node install-dsh-purge.mjs <DSH_HOME> <profile> <SDK_node_modules>');console.log(JSON.stringify(await installPurge(...process.argv.slice(2))));}
