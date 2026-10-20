/** Explicit UI save; text remains user-submitted reference data, never an approved method. */
export function humanMemoryService(manager){return {available:()=>manager.resolveConfig().enabled===true,async remember({text,sessionId,eventSeq,project}){
 if(typeof text!=='string'||!text.trim()||text.length>100000||!sessionId||!project||!Number.isSafeInteger(eventSeq))throw Error('Invalid human memory source');
 const result=await manager.call('noema_remember',{text,tags:['conversation-saved','event:'+eventSeq],accept:true},{source:'interface',provenance:{window:sessionId,project}});
 if(result.isError)throw Error('记忆服务拒绝保存，请到记忆管理核对');
 let value;try{value=JSON.parse(result.text);}catch{throw Error('记忆返回无有效回执，请到记忆管理核对');}
 if(value.outcome!=='accepted'||typeof value.memory_id!=='string')throw Error('记忆尚未确认保存，请到记忆管理核对');
 return {saved:true,id:value.memory_id};
}};}
