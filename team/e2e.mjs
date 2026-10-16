import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {installDesktopTeam} from '../scripts/install-desktop-team.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const report = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'dsh-team-e2e'));
await fs.mkdir(report, {recursive: true});
const home = path.join(report, 'home'), profile = path.join(home, 'profiles/web'), modules = path.join(root, 'desktop-runtime/node_modules');
await fs.mkdir(profile, {recursive: true});
const fixturePath = path.join(profile, 'node_modules/team-test-fixture');
await fs.mkdir(fixturePath, {recursive: true});
const fixture = `
import fs from 'node:fs'; import path from 'node:path';
import {LlmAdapter, createUserMessage} from '@deepseek-ai/dsh-llm';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {applyAgentCards} from ${JSON.stringify(pathToFileURL(path.join(root,'peer/agent-cards/index.mjs')).href)};
import {applyOnDemandTools} from ${JSON.stringify(pathToFileURL(path.join(root,'peer/on-demand-tools/index.mjs')).href)};
export const name='team-test-fixture'; export const inject=['llm','tools','skills','systemPrompt','sessionController','connection','credentials','webServer'];
export async function apply(ctx){
 const project=path.join(process.env.DSH_HOME,'workspaces/team'); fs.mkdirSync(project,{recursive:true});
 const capture=path.join(process.env.DSH_HOME,'fixture-requests.jsonl'), stages=new Map();
 class Fixture extends LlmAdapter {
  listModels(provider){return Promise.resolve([{provider,id:'team-test',name:'Local team fixture'}]);}
  resolveModel(provider,model){return Promise.resolve({provider,id:model,name:model,contextWindow:262144,maxTokens:2048,inputModalities:['text']});}
  async *stream(options){
   const all=JSON.stringify(options.messages), owner=/You are (Chief|协作工程师|普通助手独有设定), a Bot/.exec(all)?.[1]??(all.includes('# Group chat relay')?'relay':'ordinary');
   fs.appendFileSync(capture,JSON.stringify({owner,tools:(options.tools??[]).map(t=>t.name),messages:options.messages})+'\\n');
   let action;
   if(owner==='relay'){const n=stages.get('relay')??0;stages.set('relay',n+1);if(n===0)action=['group_relay',{}];}
   else if(owner==='Chief'&&all.includes('TEAM_DELEGATE')){const n=stages.get('chief')??0;stages.set('chief',n+1);if(n===0)action=['message_bot',{to:'协作工程师',message:'TEAM_WRITE：写入隔离证据，然后读取共享技能。'}];}
   else if(owner==='协作工程师'&&all.includes('TEAM_WRITE')){
    const n=stages.get('engineer')??0;stages.set('engineer',n+1);
    action=[['tool_search',{query:'fixture_write'}],['tool_load',{names:['fixture_write']}],['fixture_write',{}],['skill',{name:'team-fixture-skill'}]][n];
   }
   if(action){yield{type:'tool-call-delta',index:0,id:'fixture-'+Date.now(),name:action[0],argumentsDelta:JSON.stringify(action[1])};yield{type:'finish',reason:{kind:'tool-calls'}};}
   else{yield{type:'text-delta',index:0,text:owner==='协作工程师'?'已完成隔离证据和技能读取。':'已收到并汇总。'};yield{type:'finish',reason:{kind:'stop'}};}
  }
 }
 ctx.llm.registerAdapter(['fixture'],new Fixture());
 await applyAgentCards(ctx); applyOnDemandTools(ctx);
 ctx.skills.register({name:'team-fixture-skill',description:'团队隔离验证技能',source:'fixture',content:'SKILL_BODY_PROOF'});
 ctx.tools.register(defineTool({name:'fixture_write',description:'Write a proof only in this isolated test workspace',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:(_args,exec)=>{exec.signal.throwIfAborted();if(exec.agent.session.header.cwd!==project)throw Error('outside test workspace');fs.writeFileSync(path.join(project,'team-proof.txt'),'TEAM_EXECUTED');return 'TEAM_EXECUTED';}}));
 ctx.connection.fetch.register({path:'/api/team-test',methods:['POST'],requestBody:'buffered',fetch:async request=>{
  try{const body=await request.json();let result;
   if(body.action==='ordinary')result=await ctx.sessionController.create({cwd:project});
   else{const found=await ctx.sessionController.resolveAgent(body.sessionId);if(found.error)throw Error(found.error.message);const agent=found.agent;
    if(body.action==='send'){agent.followup(createUserMessage({content:[{type:'text',text:body.text}],source:{kind:'user'}}));result={sent:true};}
    else if(body.action==='inspect'){result={status:agent.status,events:agent.session.snapshotEvents(),prompt:await ctx.systemPrompt.assemble({agent}),cwd:agent.session.header.cwd};}
    else throw Error('unknown fixture action');
   }return Response.json({ok:true,value:result});
  }catch(e){return Response.json({ok:false,error:e.message});}
 }});
}
`;
await fs.writeFile(path.join(fixturePath, 'index.mjs'), fixture);
await fs.writeFile(path.join(fixturePath, 'package.json'), JSON.stringify({name:'team-test-fixture',type:'module',main:'index.mjs',dsh:{bundle:{patch:'./cordis.patch.yml'}}}));
await fs.writeFile(path.join(fixturePath,'cordis.patch.yml'),'- insert:\n    - id: team-test-fixture\n      name: team-test-fixture\n');
await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({name:'team-e2e',private:true,dependencies:{'team-test-fixture':'file:./node_modules/team-test-fixture'},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','team-test-fixture']}}},null,2));
for(const name of ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']){
 const target=path.join(profile,'node_modules',name);await fs.mkdir(path.dirname(target),{recursive:true});try{await fs.symlink(await fs.realpath(path.join(modules,name)),target);}catch(e){if(e.code!=='EEXIST')throw e;}
}
await fs.writeFile(path.join(profile,'cordis.yml'),'[]\n');
await fs.writeFile(path.join(profile,'cordis.patch.yml'),'- id: agent-default-model\n  config:\n    provider: fixture\n    model: team-test\n- id: dsh-team\n  config:\n    memoryReview: false\n- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n');
await installDesktopTeam(profile, modules);
const {chromium}=await import(pathToFileURL(process.env.DSH_PLAYWRIGHT_MODULE??path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
const env={...process.env,DSH_HOME:home};for(const key of Object.keys(env))if(/API_KEY|ACCESS_TOKEN|AUTH_TOKEN/.test(key))delete env[key];
let child, logs='', url;
async function start(){
 logs='';url=undefined;
 child=spawn(process.execPath,['--import',path.join(root,'scripts/desktop-test-imports.mjs'),path.join(modules,'@deepseek-ai/dsh/lib/bin.js'),'--profile','web','--no-open','--port','0'],{cwd:report,env,stdio:['ignore','pipe','pipe']});
 const capture=data=>{logs+=String(data);url??=/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/.exec(logs)?.[1];};child.stdout.on('data',capture);child.stderr.on('data',capture);
 for(let n=0;n<150&&!url;n++){if(child.exitCode!==null)throw Error('Isolated DSH failed: '+logs.replace(/token=[^\s]+/g,'token=[redacted]'));await delay(100);}
 if(!url)throw Error('Isolated DSH did not start: '+logs.slice(-3000));
}
async function stop(){if(!child||child.exitCode!==null)return;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await Promise.race([exited,delay(5000)]);if(child.exitCode===null){child.kill('SIGKILL');await exited;}}
const browser=await chromium.launch({headless:true,executablePath:process.env.DSH_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results={},errors=[];let page;
async function post(route,body){return page.evaluate(async({route,body})=>{const r=await fetch(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return r.json();},{route,body});}
const bot=async(endpoint,payload={})=>{const result=await post('/api/bot',{endpoint,payload});assert(result.ok,JSON.stringify(result));return result.value;};
const driver=async body=>{const result=await post('/api/team-test',body);assert(result.ok,JSON.stringify(result));return result.value;};
const cards=async payload=>{const result=await post('/agent-cards/manage',{type:'client-request',rpcId:crypto.randomUUID(),method:'manage',payload});assert(result.result?.ok,JSON.stringify(result));return result.result.value;};
try{
 await start();
 const context=await browser.newContext({viewport:{width:1280,height:900}});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);await page.goto(url);
 await page.locator('[data-dsh-team-switch]').waitFor();await page.getByRole('dialog',{name:'预览版说明'}).waitFor({timeout:3000}).then(()=>page.getByRole('button',{name:'继续',exact:true}).click()).catch(()=>{});assert.equal(await page.locator('html').getAttribute('data-dsh-team-mode'),'agent');results.firstUseOrdinary=true;
 const ordinary=await driver({action:'ordinary'});
 const state=await bot('state'),chief=state.bots.find(b=>b.id===state.mainBotId);
 await bot('update-bot',{id:chief.id,model:'fixture/team-test'});
 const engineer=await bot('create-bot',{name:'协作工程师',role:'开发',instructions:'只负责自己的任务。',model:'fixture/team-test'});
 let cardState=await cards({action:'status'});
 cardState=await cards({action:'card.save',revision:cardState.revision,card:{name:'普通助手独有设定',kind:'main',content:'ORDINARY_PERSONA_ONLY'}});
 cardState=await cards({action:'selection.apply',revision:cardState.revision,selection:{mainId:cardState.cards[0].id,subIds:[]}});
 const beforeSelection=structuredClone(cardState.selection);
 const copied=await cards({action:'team.create',id:cardState.cards[0].id,revision:cardState.revision});assert(copied.id);
 assert.deepEqual((await cards({action:'status'})).selection,beforeSelection);results.cardCopyPreservesSelection=true;
 const ordinaryPrompt=JSON.stringify((await driver({action:'inspect',sessionId:ordinary.sessionId})).prompt),botPrompt=JSON.stringify((await driver({action:'inspect',sessionId:engineer.id})).prompt);
 assert(ordinaryPrompt.includes('ORDINARY_PERSONA_ONLY'));assert(!botPrompt.includes('ORDINARY_PERSONA_ONLY'));assert(botPrompt.includes('message_bot'));assert(!botPrompt.includes('fixture_write'));results.roleAndLazyToolsIsolated=true;
 await driver({action:'send',sessionId:chief.id,text:'TEAM_DELEGATE：请工程师完成隔离任务，再汇总结果。'});
 let proof,chiefView;
 for(let n=0;n<200;n++){proof=await fs.readFile(path.join(home,'workspaces/team/team-proof.txt'),'utf8').catch(()=>null);chiefView=await driver({action:'inspect',sessionId:chief.id});if(proof==='TEAM_EXECUTED'&&JSON.stringify(chiefView.events).includes('[Reply from 协作工程师]')&&chiefView.status==='idle')break;await delay(100);}
 assert.equal(proof,'TEAM_EXECUTED');assert(JSON.stringify(chiefView.events).includes('[Reply from 协作工程师]'));
 const requests=(await fs.readFile(path.join(home,'fixture-requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert(requests.some(r=>r.owner==='协作工程师'&&JSON.stringify(r.messages).includes('SKILL_BODY_PROOF')));results.realDelegationExecutionReplyAndSkill=true;
 const room=await bot('create-room',{members:[chief.id,engineer.id],name:'验证项目群',admin:chief.id});
 await driver({action:'send',sessionId:room.id,text:'请汇报当前任务。'});
 for(let n=0;n<120;n++){const view=await bot('state');if((view.rooms.find(r=>r.id===room.id)?.preview??'').includes('已收到'))break;await delay(100);}
 const groupView=await bot('state');assert(groupView.rooms.some(r=>r.id===room.id));
 const persistedGroup=JSON.parse(await fs.readFile(path.join(home,'bot/state.json'),'utf8')).rooms[room.id];
 assert(persistedGroup.log.some(line=>line.who==='Chief'&&line.text.includes('已收到')));
 const hidden=persistedGroup.sessions[chief.id];assert(hidden&&hidden!==chief.id);
 const groupPrompt=JSON.stringify((await driver({action:'inspect',sessionId:hidden})).prompt);assert(groupPrompt.includes('message_bot'));assert(!groupPrompt.includes('ORDINARY_PERSONA_ONLY'));results.realGroupRelay=true;
 await page.getByRole('button',{name:'团队协作',exact:true}).click();await page.getByRole('button',{name:'普通聊天',exact:true}).waitFor();await page.getByRole('button',{name:'普通聊天',exact:true}).click();assert.equal(await page.locator('html').getAttribute('data-dsh-team-mode'),'agent');results.modeRoundTrip=true;
 const persisted=await fs.readFile(path.join(home,'bot/state.json'),'utf8');await context.close();await stop();await start();
 const second=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true});page=await second.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);await page.goto(url);await page.locator('[data-dsh-team-switch]').waitFor();await page.getByRole('dialog',{name:'预览版说明'}).waitFor({timeout:3000}).then(()=>page.getByRole('button',{name:'继续',exact:true}).click()).catch(()=>{});await page.screenshot({path:path.join(report,'phone-start.png'),fullPage:true});
 const restored=await bot('state');assert(restored.bots.some(b=>b.id===engineer.id));assert(restored.rooms.some(r=>r.id===room.id));assert.deepEqual((await cards({action:'status'})).selection,beforeSelection);assert.equal(await fs.readFile(path.join(home,'workspaces/team/team-proof.txt'),'utf8'),'TEAM_EXECUTED');results.restartRestoresTeamAndSelection=true;
 await page.getByRole('button',{name:'团队协作',exact:true}).click();await page.getByRole('button',{name:'普通聊天',exact:true}).waitFor();await page.screenshot({path:path.join(report,'phone-team.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);results.phoneWidthFits=true;await second.close();
 assert.equal(errors.length,0,JSON.stringify(errors));
 await fs.writeFile(path.join(report,'verification.json'),JSON.stringify({results,errors,upstream:'ds-bot@0.1.5',sdk:'0.2.1-alpha.1',localModelFixture:true,cloudRequests:0},null,2)+'\n');console.log(JSON.stringify({results,errors}));
}catch(e){await fs.writeFile(path.join(report,'failure.log'),logs.replace(/token=[^\s]+/g,'token=[redacted]'));if(page&&!page.isClosed()){await page.screenshot({path:path.join(report,'failure.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(report,'failure-dom.html'),await page.content()).catch(()=>{});}throw e;}finally{await browser.close();await stop();}
