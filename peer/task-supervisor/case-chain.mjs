import {check,redact,hash} from './storage.mjs';

export async function caseChain(service,job){
 check(job.finishedAt,'任务结束后才能导出案例链');const e=service.experience;
 const episode=job.episodeId?await e.command(job,'show',job.episodeId):null;
 const candidate=job.candidateId?await e.command(job,'show',job.candidateId):null;
 const active=job.methodKey?(await e.command(job,'search',job.methodKey)).some(m=>m.id===job.candidateId):false;
 const cases=job.reflection?.cases||[];
 const evidence=cases.map(c=>{try{const f=e.evidence(job,c.evidence),validated=candidate?.validation?.cases?.find(x=>x.evidence===f.file);return {name:c.name,kind:c.kind,file:f.file,sha256:f.sha256,validatedHashMatches:!!validated&&validated.sha256===f.sha256};}catch(err){return {name:c.name,kind:c.kind,file:redact(c.evidence,1000),error:redact(err.message,300),validatedHashMatches:false};}});
 const approved=active&&job.methodReview?.supported===true&&['normal','boundary','failure'].every(k=>evidence.some(c=>c.kind===k&&c.validatedHashMatches));
 const value={version:1,taskId:job.id,sourceWindow:job.sessionId,startedAt:job.createdAt,finishedAt:job.finishedAt,status:approved?'当前批准且证据一致':'待验证或已回退，不作为已生效经验',observation:{task:job.task,result:job.result,tools:job.tools.map(t=>({name:t.name,isError:t.isError,resultHash:t.resultHash})),episodeId:episode?.id||job.observationId||null},diagnosis:job.reflection?.reason||job.learningReason||'没有新经验',proposal:candidate?{id:candidate.id,key:candidate.key,trigger:candidate.trigger,action:candidate.action,exclusions:candidate.exclusions,change:candidate.change,previousVersion:candidate.base}:null,validation:{evidence,independentReview:job.methodReview||null},promotion:{active,approved,candidateId:job.candidateId||null},laterPrevention:{status:'待后续同类实际任务提供效果证据；召回不等于拦截成功'},continuity:job.continuity||null,board:job.board||null};
 const markdown='# 经验案例链\n\n'+value.status+'\n\n任务：'+redact(job.task,4000)+'\n\n```json\n'+JSON.stringify(value,null,2)+'\n```\n';return {value,markdown,sha256:hash(markdown)};
}
