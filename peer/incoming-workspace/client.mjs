/** Register through the real Client services; never inspect React internals or select an old composer. */
export function installIncomingSessionBridge(ctx,{window:target=globalThis.window}={}) {
 const trusted=()=>{try{const u=new URL(target.location.href);return target.top===target&&u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port==='3080'&&!u.username&&!u.password;}catch{return false;}};
 if(!trusted()||typeof ctx?.inject!=='function')return;
 return ctx.inject(['sessions','uiWorkspace'],services=>ctx.effect(()=>{
  let disposed=false,generation=0,pending=null;
  const onHide=()=>{generation++;};
  const open=sessionId=>{
   if(!trusted()||disposed)return Promise.reject(Error('来件页面已关闭或失效'));
   if(typeof sessionId!=='string'||!/^session-incoming-[a-f0-9]{32}$/.test(sessionId))return Promise.reject(Error('来件会话 ID 无效'));
   if(pending)return pending.id===sessionId?pending.promise:Promise.reject(Error('另一个来件导航正在进行，请稍后重试'));
   const request={id:sessionId,generation,cancelled:false,timer:null};
   const valid=()=>!disposed&&!request.cancelled&&trusted()&&generation===request.generation&&target.__dshPhoneOpenIncomingSession===open;
   const work=(async()=>{await services.sessions.refresh();if(!valid())throw Error('来件页面已失效，请重新打开');services.uiWorkspace.openSession(sessionId);return {sessionId};})();
   const expiry=new Promise((_,reject)=>{request.timer=setTimeout(()=>{request.cancelled=true;reject(Error('来件会话导航超时，请重试'));},15000);request.timer?.unref?.();});
   request.promise=Promise.race([work,expiry]).finally(()=>{clearTimeout(request.timer);if(pending===request)pending=null;});
   pending=request;return request.promise;
  };
  Object.defineProperty(target,'__dshPhoneOpenIncomingSession',{value:open,configurable:true});
  target.addEventListener('pagehide',onHide);
  return ()=>{disposed=true;generation++;if(target.__dshPhoneOpenIncomingSession===open)delete target.__dshPhoneOpenIncomingSession;target.removeEventListener('pagehide',onHide);};
 }));
}
