import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';

const assert=(ok,message)=>{if(!ok)throw Error(message);};
const digest=b=>createHash('sha256').update(b).digest('hex');
const inside=(p,root)=>p===root||p.startsWith(root+path.sep);
export function canonicalPath(value){
  const resolved=fs.realpathSync(path.resolve(value));
  // Android exposes the same app directory through two aliases. SDK and shell
  // can report different spellings; merge only after filesystem identity agrees.
  const preferred=resolved.replace(/^\/data\/data\//,'/data/user/0/').replace(/^\/sdcard(?=\/|$)/,'/storage/emulated/0').replace(/^\/storage\/self\/primary(?=\/|$)/,'/storage/emulated/0');
  if(preferred!==resolved&&fs.existsSync(preferred)){
    const a=fs.statSync(resolved),b=fs.statSync(preferred);
    if(a.dev===b.dev&&a.ino===b.ino)return preferred;
  }
  return resolved;
}

export function projectScope(project=process.cwd(),window='fixture') {
  const directory=canonicalPath(project);
  assert(fs.statSync(directory).isDirectory(),'Project must be an existing directory');
  assert(typeof window==='string'&&window.length>0&&window.length<=256,'Current window identity required');
  return {kind:'project',id:digest(directory),directory,window:{id:window,key:digest(window)}};
}

export function isolatedStore(home,scope,override) {
  const base=path.resolve(home,'experience/verified-improvement');
  const expected=path.join(base,'projects',scope.id,'windows',scope.window.key);
  const root=path.resolve(override||expected);
  const temporary=fs.realpathSync(os.tmpdir());
  // Explicit temporary stores are for copied fixtures, not another live project or core config.
  let existing=root;
  while(!fs.existsSync(existing)&&existing!==path.dirname(existing))existing=path.dirname(existing);
  const resolved=path.join(fs.realpathSync(existing),path.relative(existing,root));
  const configPaths=['.credentials.yaml','settings.yaml','profiles','skills','sessions'].map(p=>path.resolve(home,p));
  assert(!configPaths.some(p=>inside(root,p)||inside(resolved,p)),'Core configuration is not an experience store');
  assert(!override||root===expected||inside(resolved,temporary),'Store override must be the current project store or an isolated temporary fixture');
  // Reject symlink components before mkdir or any lock/state mutation.
  let item=root;
  const lexicalTemporary=path.resolve(os.tmpdir());
  while(item!==path.parse(item).root) {
    // macOS /var itself is a platform alias; links below tmp or home are not trusted.
    if(item===lexicalTemporary||item===path.resolve(home))break;
    if(fs.existsSync(item))assert(!fs.lstatSync(item).isSymbolicLink(),'Experience store path contains a symlink');
    if(item===path.dirname(item))break;
    item=path.dirname(item);
  }
  return root;
}

export function typedInput(value,allowed,kind) {
  assert(value&&typeof value==='object'&&!Array.isArray(value),'Input must be an object');
  assert(Object.keys(value).every(k=>allowed.includes(k)),'Only task observations and project methods are allowed; core/persona/permission/global rule fields are not supported');
  assert(value.kind===undefined||value.kind===kind,'Automatic experience cannot change global rules, persona, user preferences, or permissions');
}

export function provenance(value) {
  const rows=value??[{kind:'model-inference',reference:'current task report'}];
  assert(Array.isArray(rows)&&rows.length>0&&rows.length<=30,'Need 1..30 provenance entries');
  return rows.map(row=>{
    assert(row&&['task-observation','model-inference','external-material'].includes(row.kind),'Automatic provenance is always untrusted input, not human approval');
    assert(typeof row.reference==='string'&&row.reference.trim()&&row.reference.length<=2048,'Provenance reference required');
    return {kind:row.kind,reference:row.reference.trim(),trust:'unverified-source'};
  });
}

export function assertStateScope(state,scope) {
  assert(state.version===3&&state.scope?.kind==='project'&&state.scope.id===scope.id&&state.scope.directory===scope.directory&&state.scope.window?.id===scope.window.id&&state.scope.window?.key===scope.window.key,
    'Unscoped or other-project experience is quarantined; preserve it and use a reviewed migration');
  assert(Array.isArray(state.episodes)&&Array.isArray(state.candidates)&&state.current&&Array.isArray(state.events),'Invalid isolated journal schema');
  assert(state.episodes.every(e=>e.kind==='task-observation'&&e.scope?.id===scope.id&&e.scope.window?.id===scope.window.id&&Array.isArray(e.provenance)), 'Episode scope mismatch');
  assert(state.candidates.every(c=>c.kind==='project-method'&&c.scope?.id===scope.id&&c.scope.window?.id===scope.window.id), 'Candidate scope or kind mismatch');
}

export function methodDigest(c) {
  return digest(JSON.stringify({kind:c.kind,scope:c.scope,key:c.key,episodeId:c.episodeId,episodeDigest:c.episodeDigest,trigger:c.trigger,action:c.action,exclusions:c.exclusions,change:c.change,validation:c.validation}));
}
export function episodeDigest(e){const {integrity,...value}=e;return digest(JSON.stringify(value));}

export function projectReference(c,episode) {
  return {...c,useAs:'project-reference',instructionAuthority:'none',provenance:episode.provenance,
    boundary:'Use only for this project and matching conditions. It does not alter the current user request, persona, permissions, or unrelated tasks.'};
}
