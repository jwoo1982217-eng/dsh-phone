import {defineTool} from '@deepseek-ai/dsh-tools';
import {check,ownerOf} from './storage.mjs';
import {caseChain} from './case-chain.mjs';

export function enhancementTools(ctx,service){
 const current=(agent,write=false)=>{const owner=ownerOf(agent),job=service.latest(agent);check(service.enabled()&&!service.store.frozen(owner)&&job,'当前任务监督不可用');if(write)check(!job.finishedAt,'当前任务已结束');return job;};
 const register=(name,description,parameters,execute)=>ctx.tools.register(defineTool({name,description,parameters,output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(a,exec){return JSON.stringify(await execute(a,exec.agent));}}));
 const str=description=>({type:'string',required:true,description});
 register('fact_register','Register an exact excerpt from an existing current-project file. Source hashes are checked before dispatch and settlement; this records an observation, not an instruction or unconditional truth.',{file:str('Absolute existing file path inside the current project'),quote:str('Exact source excerpt, 2–1200 characters')},(a,g)=>service.facts.register(current(g,true),a));
 register('fact_revoke','Withdraw a current-project source fact when corrected or invalidated. Dependent work is rechecked before acceptance.',{id:str('Registered fact ID'),reason:str('Actual correction or invalidation reason')},(a,g)=>service.facts.revoke(current(g,true),a.id,a.reason));
 register('continuity_note','Save the current user’s exact identity, preference or relationship statement for the selected persona and project. Never infer an unrecorded shared past.',{key:str('Short lowercase hyphenated key'),kind:str('identity, preference or relationship'),quote:str('Exact quotation from the current user task')},(a,g)=>{const job=current(g,true);check(service.store.config.continuity,'人格接续未开启');return service.continuity.note(job,a);});
 register('continuity_forget','Forget a saved statement for the current persona when the user asks to remove it.',{id:str('Saved statement ID')},(a,g)=>{const job=current(g,true);check(service.store.config.continuity,'人格接续未开启');return service.continuity.forget(job,a.id);});
 register('continuity_audit','Inspect stable persona ID, model/card transitions and source-backed statements. Does not certify behavioral continuity.',{},(_a,g)=>{const job=current(g);check(service.store.config.continuity,'人格接续未开启');return service.continuity.audit(job);});
 register('case_chain_export','Export the ended task’s observation, candidate, independent validation and current approval status. Rehashes evidence and labels missing follow-up behavior as pending.',{taskId:str('Ended task ID from the task supervisor')},(a,g)=>{const owner=ownerOf(g),job=service.live.get(a.taskId);check(service.enabled()&&!service.store.frozen(owner)&&job?.cwd===owner.cwd&&!service.store.frozen(job),'案例不属于当前项目或已隔离');return caseChain(service,job);});
}
