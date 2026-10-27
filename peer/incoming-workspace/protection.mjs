import path from 'node:path';
const within=(root,candidate)=>typeof candidate==='string'&&(candidate===root||candidate.startsWith(root+path.sep));
function references(value,paths,depth=0){
 if(depth>30)return true;
 if(typeof value==='string'){
  if(paths.some(p=>value.includes(p)||value.includes(encodeURIComponent(p))))return true;
  if(value.length<=1048576){try{const parsed=JSON.parse(value);if(parsed!==value&&references(parsed,paths,depth+1))return true;}catch{}try{const decoded=decodeURIComponent(value);if(decoded!==value&&references(decoded,paths,depth+1))return true;}catch{}}
  return false;
 }
 if(Array.isArray(value))return value.some(x=>references(x,paths,depth+1));
 if(value&&typeof value==='object')return Object.values(value).some(x=>references(x,paths,depth+1));
 return false;
}
export function protectedBatch(manifest,workspacePath,snapshot){
 if(!snapshot||!Array.isArray(snapshot.headers)||!Array.isArray(snapshot.workspaces)||!Array.isArray(snapshot.pinnedIds)||!Array.isArray(snapshot.events))return 'protection-unavailable';
 if(snapshot.active)return 'active-work';
 if(snapshot.pinnedIds.includes(manifest.sessionId))return 'pinned-session';
 if(snapshot.headers.some(h=>h.id===manifest.sessionId||within(workspacePath,h.cwd)))return 'durable-session';
 if(snapshot.workspaces.some(w=>within(workspacePath,w.path)||w.id===manifest.workspaceId))return 'registered-workspace';
 const paths=[workspacePath,...manifest.files.map(f=>path.join(workspacePath,f.name))];
 return references(snapshot.events,paths)?'referenced-file':null;
}
/** Pinned alpha.1 services: reads only, no Agent resume, prompt or history mutation. */
export function incomingServices(ctx){return {
 ensureWorkspace:(directory,title)=>ctx.workspaceRegistry.create(directory,title),
 async createSession(input){
  const existing=ctx.sessions?.get(input.sessionId)?.header??(await ctx.sessionPersistence.stat(input.sessionId))?.header;
  if(existing){const workspace=ctx.workspaceRegistry.get(input.workspaceId);if(!workspace||existing.cwd!==workspace.path)throw Error('来件会话路径冲突');await workspace.attachSession(input.sessionId);await ctx.sessionPersistence.flush();return {sessionId:input.sessionId};}
  const result=await ctx.sessionController.create(input);await ctx.sessionPersistence.flush();if(result?.sessionId!==input.sessionId)throw Error('核心未返回预期的来件会话，未重复附加文件');return result;
 },
 async findSession(id){return ctx.sessions?.get(id)?.header??(await ctx.sessionPersistence.stat(id))?.header;},
 async protection(){const listing=await ctx.sessionController.list({});if(!Array.isArray(listing?.items))throw Error('会话状态不可读');const rows=await ctx.sessionQuery.listSessions();const events=[];for(const row of rows)events.push((await ctx.sessionQuery.readSession(row.header.id)).events);return {active:listing.items.some(s=>s.running===true),headers:rows.map(x=>x.header),pinnedIds:[...ctx.workspaceRegistry.pinnedSessionIds],workspaces:ctx.workspaceRegistry.list().map(w=>({id:w.id,path:w.path})),events};}
};}
