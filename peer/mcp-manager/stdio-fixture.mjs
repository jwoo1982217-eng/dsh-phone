// Test-only server: no user files, network access or model calls.
import readline from 'node:readline';
const input=readline.createInterface({input:process.stdin});
for await(const line of input) {
  const q=JSON.parse(line); if(q.id===undefined)continue;let result,error;
  if(q.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  else if(q.method==='tools/list')result={tools:[{name:'echo',description:'fixture echo',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{value:{type:'string'}},additionalProperties:false}}]};
  else if(q.method==='tools/call')result={content:[{type:'text',text:String(q.params.arguments.value)}]};
  else if(q.method==='ping')result={};
  else error={code:-32601,message:'Method not found'};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,...(error?{error}:{result})})+'\n');
}
