import {describe,it,expect} from 'vitest'
import {ZcodeAdapter} from '../../src/zcode-adapter.js'
import {ZCODE_STANDARD_MODELS} from '../../src/zcode-plan-models.js'
import {organizationFailure,streamZcodeOrganization} from '../../src/zcode-source-stream.js'
import {credentialRef} from '@deepseek-ai/dsh-credentials'
function catalogFixture(){let source='individual';const disabled=new Set<string>();const pool={listAccountsByProvider:()=>[{enabled:true,zcodeSource:source}],disabledModelsFor:()=>disabled,hasLoggedInAccount:async()=>true};const adapter=new ZcodeAdapter({credentialRef:credentialRef('test'),accountPool:pool as any,isReady:async()=>true,resolveCredential:async()=>({zcode_jwt:'fixture'}),refresh:async()=>{}});return {adapter,disabled,source:(v:string)=>{source=v}};}
describe('ZCode Plan routes and catalog',()=>{
 it('switching source changes both selectable and unfiltered model catalogs',async()=>{const f=catalogFixture();const personal=await f.adapter.listModels('zcode');expect(personal.map(m=>m.id)).toEqual(['GLM-5.3-Flash','GLM-5.3']);f.source('organization-flow:org:project');const ordinary=await f.adapter.listModels('zcode');expect(ordinary).toHaveLength(24);expect(ordinary.some(m=>m.id==='GLM-4.7-Flash')).toBe(true);expect(f.adapter.listAllModels()).toHaveLength(24);f.source('individual');expect(await f.adapter.listModels('zcode')).toHaveLength(2);expect(f.adapter.listAllModels()).toHaveLength(2);});
 it('ordinary API metadata and thinking choices come from the official catalog; disabled IDs stay disabled',async()=>{const f=catalogFixture();f.source('organization-flow:o:p');f.disabled.add('GLM-4.7-Flash');expect((await f.adapter.listModels('zcode')).some(m=>m.id==='GLM-4.7-Flash')).toBe(false);expect(f.adapter.listAllModels().some(m=>m.id==='GLM-4.7-Flash')).toBe(true);const info=await f.adapter.resolveModel('zcode','glm-5.3-flash');expect(info.context?.contextWindow).toBe(1000000);expect(info.reasoning?.efforts.map(x=>x.id)).toEqual(['low','high','max']);expect(info.inputModalities).toContain('image');expect(ZCODE_STANDARD_MODELS.some(m=>m.id==='GLM-4-Flash-250414')).toBe(true);});
 it('quota, rate and auth failures remain distinct and never expose secrets',()=>{
   const quota=organizationFailure(429,JSON.stringify({error:{code:'1113',message:'secret-abc 余额不足'}}));
   expect(quota.code).toBe('QUOTA_EXCEEDED');expect(quota.message).toContain('1113');expect(quota.message).toContain('不会改扣');expect(quota.message).not.toContain('secret-abc');
   const rate=organizationFailure(429,JSON.stringify({error:{code:1005,message:'user concurrency limit exceeded'}}));expect(rate.code).toBe('RATE_LIMIT');
   const auth=organizationFailure(401,JSON.stringify({error:{code:'1113',message:'余额不足'}}));expect(auth.code).toBe('AUTH');
   expect(organizationFailure(503,'<h1>1005</h1>').code).toBe('SERVER');
 });
 it('ordinary requests keep exact project and thinking effort, one failure never changes billing plans',async()=>{const seen:any[]=[];const c={source_selection:{id:'org',kind:'organization-flow',key:'org-only',url:'https://open.bigmodel.cn/api/paas/v4/chat/completions',organizationId:'o',projectId:'p'}} as any;const fetcher=async(url:any,init:any)=>{seen.push({url,headers:new Headers(init.headers),body:JSON.parse(init.body)});return new Response(JSON.stringify({error:{code:'1113',message:'余额不足'}}),{status:429});};await expect(async()=>{for await(const _ of streamZcodeOrganization({model:'GLM-5.3-Flash',reasoningEffort:'low',messages:[]} as any,c,new Map(),fetcher as any)){};}).rejects.toThrow('1113');expect(seen).toHaveLength(1);expect(seen[0].headers.get('bigmodel-project')).toBe('p');expect(seen[0].headers.get('authorization')).toBe('Bearer org-only');expect(seen[0].body.thinking).toEqual({type:'enabled'});expect(seen[0].body.reasoning_effort).toBe('low');});
 it('switching away from ordinary API refuses an old ordinary-only model before HTTP',async()=>{
   let calls=0;const adapter=new ZcodeAdapter({credentialRef:credentialRef('test'),resolveCredential:async()=>({source_selection:{id:'individual',kind:'individual',key:'coding-only',url:'https://open.bigmodel.cn/api/anthropic/v1/messages'}} as any),refresh:async()=>{},fetchImpl:(async()=>{calls++;throw Error('Must not dispatch');}) as any});
   await expect(async()=>{for await(const _ of adapter.stream({model:'GLM-4.7-Flash',messages:[]} as any)){};}).rejects.toThrow('当前所选 Plan');expect(calls).toBe(0);
 });

 it('model overload is distinct from account rate and generic invalid arguments do not imply a thinking error',()=>{
   expect(organizationFailure(429,JSON.stringify({error:{code:'1305',message:'该模型当前访问量过大'}})).message).toContain('模型当前访问量过大');
   expect(organizationFailure(400,JSON.stringify({error:{code:'1210',message:'max_tokens参数有误'}})).message).not.toContain('思考档位');
   expect(organizationFailure(400,JSON.stringify({error:{code:'1210',message:'该模型不支持关闭思考'}})).message).toContain('思考档位');
 });

});
