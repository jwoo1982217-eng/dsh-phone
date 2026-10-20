/** Required, append-only human edits. Original audit events are never mutated. */
export const CONVERSATION_EDIT = 'conversation/edit';
const editable = new Set(['user/message','assistant/message','tool/result','assistant/attempt','tool/call','llm/retry','llm/retry-started','tool/ptc-dispatch','tool/ptc-dispatch-start']);
const messageOf = event => event?.type === 'user/message' ? event.data : event?.data?.message;
const check = (value,message) => {if(!value)throw new Error('conversation/edit: '+message);};
const earliest = values => {let n=Infinity;for(const v of values)if(v<n)n=v;return n;};
const seq = value => Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
export function deletionOnly(before,after) {
  if(typeof before!=='string'||typeof after!=='string'||after.length>before.length)return false;
  const wanted=[...after];let n=0;for(const char of before)if(char===wanted[n])n++;return n===wanted.length;
}
export function collectConversationEdits(events, candidate) {
  const deleted=new Set(),texts=new Map(),affected=new Set(),versions=new Map();
  const all=candidate?[...events,candidate]:events;
  for(const event of all){
    if(event.type!==CONVERSATION_EDIT)continue;
    const d=event.data;
    check(event.ignorable!==true,'edit must be a required event');
    check(d?.version===1&&typeof d.operationId==='string'&&d.operationId.length>0&&d.operationId.length<=100,'invalid decision');
    check(Array.isArray(d.deleteSeqs)&&Array.isArray(d.textChanges)&&d.deleteSeqs.length+d.textChanges.length>0&&d.deleteSeqs.length+d.textChanges.length<=20000,'invalid targets');
    check(new Set(d.deleteSeqs).size===d.deleteSeqs.length,'duplicate targets');
    for(const target of d.deleteSeqs){
      const original=events[target];
      check(seq(target)&&target<event.seq&&original?.seq===target&&editable.has(original.type),'protected or absent deletion target');
      check(!deleted.has(target),'message already deleted');deleted.add(target);affected.add(target);versions.set(target,event.seq);
    }
    const seen=new Set();
    for(const change of d.textChanges){
      const original=events[change.seq],message=messageOf(original),key=change.seq+':'+change.blockIndex;
      check(seq(change.seq)&&change.seq<event.seq&&!deleted.has(change.seq)&&['user/message','assistant/message'].includes(original?.type),'invalid text target');
      check(original.surfaceOp==='append'&&seq(change.blockIndex)&&!seen.has(key),'invalid text block');seen.add(key);
      const block=message?.content?.[change.blockIndex];
      check(['text','reasoning'].includes(block?.type)&&typeof change.text==='string','only human-visible text is editable');
      check(deletionOnly(texts.get(key)??block.text,change.text),'only deletion is allowed');
      texts.set(key,change.text);affected.add(change.seq);versions.set(change.seq,event.seq);
    }
  }
  return {deleted,texts,affected,versions};
}
function changedMessage(event,texts,invalidateReplay=false) {
  const message=messageOf(event);if(!message?.content)return null;
  let changed=false;
  let source=message.source;
  if(invalidateReplay&&message.role==='assistant'&&source?.replayState!==undefined){const {replayState,...rest}=source;source=Object.freeze(rest);changed=true;}
  const content=message.content.map((block,index)=>{const text=texts.get(event.seq+':'+index);if(text===undefined||text===block.text)return block;changed=true;return Object.freeze({...block,text});});
  return changed?Object.freeze({...message,source,content:Object.freeze(content)}):null;
}
export function conversationEditPlan(state,event,events,baseSeq,projections,createState,applyEvent) {
  check(baseSeq===0,'complete history is required');
  const prefix=events.filter(e=>e.seq<event.seq),edit=collectConversationEdits(prefix,event),next=createState(),tainted=new Map(edit.versions),firstAffected=earliest(edit.affected);
  for(const old of prefix){
    if(old.type===CONVERSATION_EDIT)continue;
    const sources=old.sourceEventSeqs??[];
    const changedAt=sources.reduce((n,seq)=>Math.max(n,tainted.get(seq)??-1),-1);
    if(old.surfaceOp&&old.surfaceOp!=='append'&&changedAt>old.seq){tainted.set(old.seq,changedAt);continue;}
    if(edit.deleted.has(old.seq))continue;
    // An offloaded image may refer to a summary invalidated by this edit.
    if(old.type==='image/offload'){const targets=old.data.targets?.filter(t=>!edit.deleted.has(t.seq)&&next.nodes.includes(t.seq));if(targets?.length!==old.data.targets?.length){if(targets?.length)applyEvent(next,{...old,data:{targets}},old.seq,prefix,0,projections);continue;}}
    applyEvent(next,old,old.seq,prefix,0,projections);
    const current=next.projectedMessages.get(old.seq);const source=current?{...old,data:old.type==='user/message'?current:{...old.data,message:current}}:old;const message=changedMessage(source,edit.texts,old.seq>=firstAffected);if(message)next.projectedMessages.set(old.seq,message);
  }
  // Never allow deletion to leave a surviving tool result without its call (or vice versa).
  const removedCalls=new Set(prefix.filter(e=>edit.deleted.has(e.seq)&&e.type==='assistant/message').flatMap(e=>e.data.message.content.filter(b=>b.type==='tool-call').map(b=>e.data.turn+':'+e.data.step+':'+b.id)));
  const owners=new Map();for(const a of prefix)if(a.type==='assistant/message')for(const b of a.data.message.content)if(b.type==='tool-call')owners.set(a.data.turn+':'+a.data.step+':'+b.id,a.seq);
  for(const old of prefix)if(old.type==='tool/result'){
    const call=old.data.turn+':'+old.data.step+':'+(old.data.message.toolCallId??old.data.message.source?.callId);
    if(removedCalls.has(call))check(edit.deleted.has(old.seq),'tool call/result must be deleted together');
    if(edit.deleted.has(old.seq)&&owners.has(call))check(edit.deleted.has(owners.get(call)),'tool result/call must be deleted together');
  }
  return {kind:'conversation-edit',next,deleted:edit.deleted};
}
/** Pure browser transcript projection, including older windows prepended after the edit. */
export function projectConversationEntries(entries) {
  const events=entries.map(e=>e.event),decisions=events.filter(e=>e.type===CONVERSATION_EDIT),deleted=new Set(),texts=new Map(),versions=new Map();
  for(const event of decisions){for(const n of event.data.deleteSeqs){deleted.add(n);versions.set(n,event.seq);}for(const c of event.data.textChanges){texts.set(c.seq+':'+c.blockIndex,c.text);versions.set(c.seq,event.seq);}}
  const tainted=new Map(versions),summaries=new Set();
  for(const event of events){
    const summaryAt=(event.data.shadowedSeqs??[]).reduce((n,seq)=>Math.max(n,tainted.get(seq)??-1),-1);
    if(event.type==='compaction/summary'&&summaryAt>event.seq){tainted.set(event.seq,summaryAt);deleted.add(event.seq);summaries.add(event.data.compactionId);}
    const replacementAt=(event.sourceEventSeqs??[]).reduce((n,seq)=>Math.max(n,tainted.get(seq)??-1),-1);
    if(event.surfaceOp&&event.surfaceOp!=='append'&&replacementAt>event.seq){tainted.set(event.seq,replacementAt);deleted.add(event.seq);}
  }
  for(const event of events)if(['compaction/start','compaction/end'].includes(event.type)&&summaries.has(event.data.compactionId))deleted.add(event.seq);
  const firstAffected=earliest(tainted.keys()),lastEdit=decisions.at(-1)?.seq??-1;
  return entries.map(entry=>{
    const event=entry.event;
    if(deleted.has(event.seq))return {...entry,event:{type:'conversation/hidden',seq:event.seq,time:event.time,data:{},ignorable:true}};
    const message=changedMessage(event,texts,event.seq>=firstAffected&&event.seq<lastEdit);if(!message)return entry;
    return {...entry,event:{...event,conversationEdited:true,data:event.type==='user/message'?message:{...event.data,message,stream:[]}}};
  });
}
