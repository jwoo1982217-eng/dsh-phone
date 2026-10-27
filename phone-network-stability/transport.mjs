// Keep the existing routing, TLS policy, body, abort and dispatch ownership.
// No automatic replay: the regular adapter retains its retry policy.
export function installHttp1Only({getGlobalDispatcher,setGlobalDispatcher}) {
  const previous=getGlobalDispatcher();
  if(typeof previous?.compose!=='function')throw Error('当前网络调度器不支持协议适配，保留原配置');
  const installed=previous.compose(dispatch=>(options,handler)=>dispatch({...options,allowH2:false},handler));
  setGlobalDispatcher(installed);
  let disposed=false;
  return ()=>{
    if(disposed)return;disposed=true;
    if(getGlobalDispatcher()===installed)setGlobalDispatcher(previous);
    // The launcher owns the underlying pools; never close another plugin's agent.
  };
}
