import {randomUUID} from 'node:crypto';
import {collectConversationEdits, deletionOnly} from '@deepseek-ai/dsh-session/conversation-edit';
const fail = (ok, message) => {if (!ok) throw Error(message);};
const idle = agent => agent.status === 'idle' && (agent.phase?.kind ?? 'idle') === 'idle' && !agent.inbox?.hasPending;
const ordinary = id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/^(qq-|cloud-)/.test(id);
const userFacing = e => e.surfaceOp === 'append' && (e.type === 'assistant/message' || e.type === 'user/message' && e.data.source?.kind === 'user');
const messageOf = e => e.type === 'user/message' ? e.data : e.data.message;
const textOf = m => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
const info = '从显示和后续模型上下文移除所选内容，不会连删后面的消息。原始审计日志/备份仍保留；独立记忆、项目文件、附件文件和已执行的工具操作不受影响。';
export class ConversationActions {
 constructor(ctx) {this.ctx=ctx;this.tokens=new Map();this.queue=Promise.resolve();this.pending=new Map();}
 async resolve(id, writable=false) {
  fail(ordinary(id),'仅支持普通聊天');
  const pending=this.pending.get(id); if(pending){fail(!writable,'聊天有尚未落盘的修改，请先重试保存');return pending.agent;}
  const found=await this.ctx.sessionController.agents.resolveAgent(id);if(found.error)throw found.error;
  const agent=found.agent; fail(agent.session.header.cwd && agent.session.header.origin !== 'subagent' && !agent.session.header.delegationDepth,'不能修改其他服务或子聊天持有的记录');
  if(writable){fail(this.ctx.sessionController.agents.ownedHandles.has(agent.id),'聊天由其他服务持有，不能修改');fail(idle(agent),'请等当前任务结束，或先停止再修改');}return agent;
 }
 rows(agent) {return agent.session.snapshotEvents().filter(userFacing).flatMap(e=>{const message=agent.session.deriveEventMessage(e);return message?[{seq:e.seq,role:message.role,turn:e.data.turn,step:e.data.step,preview:textOf(message).slice(0,1500),hasText:message.content.some(b=>b.type==='text'||b.type==='reasoning')}]:[];});}
 detail(agent,seq) {fail(Number.isSafeInteger(seq),'消息编号无效');const event=agent.session.eventAt(seq);fail(event&&userFacing(event),'所选记录不是可操作的消息');const message=agent.session.deriveEventMessage(event);fail(message,'消息已删除');const blocks=message.content.flatMap((b,blockIndex)=>['text','reasoning'].includes(b.type)?[{blockIndex,type:b.type,text:b.text}]:[]);fail(blocks.reduce((n,b)=>n+b.text.length,0)<=1048576,'消息过大，请先导出后处理');return {seq,role:message.role,blocks,text:textOf(message),attachmentCount:message.content.filter(b=>!['text','reasoning','tool-call'].includes(b.type)).length};}
 prune(){for(const [token,p]of this.tokens)if(p.expires<Date.now()&&(!p.appended||p.result))this.tokens.delete(token);fail(this.tokens.size<100,'确认请求过多，请稍后重试');}
 async preview(payload) {
  this.prune();const agent=await this.resolve(payload.sessionId,true),session=agent.session;fail(session.seq===payload.expectedSeq,'聊天已变化，请刷新后重新选择');
  const events=session.snapshotEvents(),rows=this.rows(agent),available=new Set(rows.map(r=>r.seq));let selected=payload.selected??[];
  fail(Array.isArray(selected)&&selected.length<=10000,'选择数量无效');
  if(payload.range){fail(Array.isArray(payload.range)&&payload.range.length===2&&payload.range.every(n=>available.has(n)),'范围端点无效');const [a,b]=[...payload.range].sort((a,b)=>a-b);selected=rows.filter(r=>r.seq>=a&&r.seq<=b).map(r=>r.seq);}
  const deleted=new Set(selected);fail(selected.every(n=>available.has(n)),'消息已变化或不可删除');
  const changes=payload.textChanges??[];fail(Array.isArray(changes)&&changes.length<=1000,'局部修改无效');
  for(const c of changes){fail(available.has(c.seq)&&!deleted.has(c.seq),'局部修改目标无效');const d=this.detail(agent,c.seq),block=d.blocks.find(b=>b.blockIndex===c.blockIndex);fail(block&&deletionOnly(block.text,c.text),'只允许删除已有文字，不允许添加或替换');}
  // Empty textual messages must not become invalid empty inputs for providers.
  for(const n of new Set(changes.map(c=>c.seq))){const m=session.deriveEventMessage(events[n]);const kept=m.content.some((b,i)=>!['text','reasoning'].includes(b.type)||String(changes.find(c=>c.seq===n&&c.blockIndex===i)?.text??b.text).trim());if(!kept)deleted.add(n);}
  const existing=collectConversationEdits(events),calls=new Set(),steps=new Set();
  for(const n of deleted){const e=events[n];if(e.type==='assistant/message')steps.add(e.data.turn+':'+e.data.step);for(const b of messageOf(e).content)if(b.type==='tool-call')calls.add(e.data.turn+':'+e.data.step+':'+b.id);}
  // Remove the entire assistant tool bundle, including failed attempts for that step.
  for(const e of events){if(existing.deleted.has(e.seq))continue;const key=e.data?.turn+':'+e.data?.step,call=e.data?.callId??e.data?.message?.toolCallId??e.data?.message?.source?.callId;
   if((['assistant/attempt','llm/retry','llm/retry-started'].includes(e.type)&&steps.has(key)) || (['tool/call','tool/result','tool/ptc-dispatch','tool/ptc-dispatch-start'].includes(e.type)&&calls.has(key+':'+call)))deleted.add(e.seq);
  }
  const textChanges=changes.filter(c=>!deleted.has(c.seq)).map(c=>({seq:c.seq,blockIndex:c.blockIndex,text:c.text})),deleteSeqs=[...deleted].sort((a,b)=>a-b),affected=new Set([...deleted,...textChanges.map(c=>c.seq)]);let summaries=0;
  for(const e of events)if(e.surfaceOp&&e.surfaceOp!=='append'&&(e.sourceEventSeqs??[]).some(s=>affected.has(s))){affected.add(e.seq);summaries++;}
  fail(deleteSeqs.length+textChanges.length>0,'请选择要删除的内容');
  const token=randomUUID(),decision={version:1,operationId:randomUUID(),deleteSeqs,textChanges};
  collectConversationEdits(events,{type:'conversation/edit',seq:session.seq,data:decision});
  this.tokens.set(token,{kind:'edit',token,sessionId:session.id,expectedSeq:session.seq,decision,expires:Date.now()+120000});
  return {token,messages:deleteSeqs.filter(n=>available.has(n)).length,linked:deleteSeqs.filter(n=>!available.has(n)).length,textBlocks:textChanges.length,summaries,description:info};
 }
 serialize(fn){const task=this.queue.then(fn);this.queue=task.catch(()=>{});return task;}
 async commit(payload){return this.serialize(async()=>{
  const p=this.tokens.get(payload.token);fail(p?.kind==='edit','确认无效，请重新选择');if(p.result)return p.result;
  let agent;if(!p.appended){fail(p.expires>Date.now(),'确认已过期');agent=await this.resolve(p.sessionId,true);fail(agent.session.seq===p.expectedSeq&&idle(agent),'聊天已变化或仍在运行，请重新预览');
   this.ctx.sessionController.agents.assertAvailable(p.sessionId);fail(this.ctx.sessionController.agents.ownedHandles.has(agent.id),'聊天已关闭，请重新打开');
   this.ctx.sessionController.agents.editingIds.add(p.sessionId);this.pending.set(p.sessionId,{agent,p});
   try{agent.session.append('conversation/edit',p.decision);p.appended=true;}catch(e){this.pending.delete(p.sessionId);this.ctx.sessionController.agents.editingIds.delete(p.sessionId);throw e;}
  }else agent=this.pending.get(p.sessionId)?.agent;
  fail(agent,'保存状态已失效，请重新打开聊天检查');
  // Keep prompt admission blocked on failed barriers. Retrying never appends twice.
  await this.ctx.sessionPersistence.flush();
  this.pending.delete(p.sessionId);this.ctx.sessionController.agents.editingIds.delete(p.sessionId);
  p.result={saved:true,seq:agent.session.seq};return p.result;
 });}
 async memoryPreview(payload){this.prune();const agent=await this.resolve(payload.sessionId);const detail=this.detail(agent,payload.seq);fail(detail.text.trim(),'没有可保存的正文');fail(detail.text.length<=100000,'正文太长，请先局部整理');const service=this.ctx.get('dshNoemaHumanMemory');fail(service&&(!service.available||service.available()),'记忆服务尚未启用，请先到设置开启 Noema');
  const token=randomUUID(),header=agent.session.header;this.tokens.set(token,{kind:'memory',sessionId:header.id,expectedSeq:agent.session.seq,text:detail.text,seq:payload.seq,project:header.cwd,expires:Date.now()+120000});return {token,text:detail.text,project:header.cwd,description:'手动存入 Noema 共享记忆库，附上当前项目、会话和消息来源。可在记忆管理中查看/删除；其他窗口按共享召回设置可能读取。不会把 AI 回答标为已验证事实。'};}
 async memoryCommit(payload){return this.serialize(async()=>{const p=this.tokens.get(payload.token);fail(p?.kind==='memory'&&p.expires>Date.now(),'确认已过期');if(p.result)return p.result;fail(!p.attempted,'上次保存结果不确定，请到记忆管理核对，避免重复保存');const agent=await this.resolve(p.sessionId);fail(agent.session.seq===p.expectedSeq,'聊天已变化，请重新预览记忆');p.attempted=true;const service=this.ctx.get('dshNoemaHumanMemory');fail(service,'记忆服务不可用');await service.remember({text:p.text,sessionId:p.sessionId,eventSeq:p.seq,project:p.project});p.result={saved:true};return p.result;});}
 async manage(payload){fail(payload&&typeof payload==='object','请求无效');
  if(payload.action==='preview')return this.preview(payload);if(payload.action==='commit')return this.commit(payload);if(payload.action==='memory-preview')return this.memoryPreview(payload);if(payload.action==='memory-commit')return this.memoryCommit(payload);
  const agent=await this.resolve(payload.sessionId);if(payload.action==='detail')return {...this.detail(agent,payload.seq),revision:agent.session.seq,pendingToken:this.pending.get(agent.id)?.p.token};
  fail(payload.action==='list','操作无效');let rows=this.rows(agent);if(payload.before!==undefined){fail(Number.isSafeInteger(payload.before),'分页无效');rows=rows.filter(r=>r.seq<payload.before);}return {revision:agent.session.seq,running:agent.status!=='idle',pendingSave:this.pending.has(agent.id),pendingToken:this.pending.get(agent.id)?.p.token,hasMore:rows.length>80,items:rows.slice(-80)};
 }
}
export function applyConversationActions(ctx){ctx.inject(['sessionController','sessionPersistence'],c=>{
 const manager=new ConversationActions(c);c.connection.rpc.handle('/conversation-actions',async(method,payload)=>{try{fail(method==='manage','请求无效');return {ok:true,value:await manager.manage(payload)};}catch(e){return {ok:false,error:{code:'conversation-actions/failed',message:e.message,details:{}}};}},{authority:'loopback'});
});}
