import path from 'node:path';
const abortable = async (work, signal) => {
 if (!signal) return work(); signal.throwIfAborted();
 let abort; try { return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]); } finally { signal.removeEventListener('abort',abort); }
};

/** Combine local history with approved cross-agent memories, without copying stores. */
export function withSharedRecall(memory, resolveShared) {
 return {
  status: () => memory.status(), update: (...args) => memory.update(...args),
  async search(query, lexical, options = {}) {
   let shared;try{shared = options.shared?.enabled && options.shared.sources?.length && options.mode !== 'off' ? resolveShared() : undefined;}catch{}
   const results = await Promise.allSettled([
    memory.status().index.indexed ? memory.search(query, lexical, options) : Promise.resolve([]),
    shared ? abortable(()=>shared.recall({query, mode:options.mode, cwd:options.cwd, shared:options.shared, signal:options.signal}), options.signal) : Promise.resolve([]),
   ]);
   options.signal?.throwIfAborted();
   const local = (results[0].status === 'fulfilled' ? results[0].value : []).filter(row=>!memory.home||row.sid||(typeof row.file==='string'&&(row.file===memory.home||row.file.startsWith(memory.home+path.sep))));
   const accepted = results[1].status === 'fulfilled' ? results[1].value : [];
   if (results.every(r=>r.status==='rejected')) throw results[0].reason;
   // Keep room for both existing history and shared memories in the small budget.
   return [...accepted.slice(0,2), ...local, ...accepted.slice(2)].slice(0, options.top || 60);
  }
 };
}
